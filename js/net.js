/* Live transport for Cortez.
 * Host-authoritative, broker-relayed, end-to-end encrypted with the room code.
 * The only requirement is a websocket MQTT broker; the default is public and
 * needs no account, which keeps the whole app deployable as static files.
 */
(() => {
'use strict';

const CFG = Object.assign({
  brokerUrls: ['wss://broker.emqx.io:8084/mqtt'],
  topicPrefix: 'marine-commander/v1',
  heartbeatMs: 8000,
  playerPingMs: 10000,
  hostTimeoutMs: 32000
}, window.MC_CONFIG || {});
window.MC_CONFIG = CFG;

const TE = new TextEncoder();
const TD = new TextDecoder();
const API = 'marine-commander:v1:';

function bytesB64(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64Bytes(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function randomId(n = 16) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function deriveKey(room) {
  const digest = await crypto.subtle.digest('SHA-256', TE.encode(API + room));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, TE.encode(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, i: bytesB64(iv), d: bytesB64(ct) });
}
async function unseal(key, raw) {
  const box = JSON.parse(raw);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64Bytes(box.i) }, key, b64Bytes(box.d));
  return JSON.parse(TD.decode(pt));
}

function connectOnce(url, options) {
  return new Promise((resolve, reject) => {
    let client = null, settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { if (client) client.end(true); } catch (e) {}
        reject(err);
      } else {
        resolve(client);
      }
    };
    const timer = setTimeout(() => finish(new Error('Timed out connecting to ' + url)), 10000);
    try {
      client = window.mqtt.connect(url, options);
    } catch (err) { finish(err); return; }
    client.once('connect', () => finish(null));
    client.once('error', err => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

class LiveSession {
  constructor(opts) {
    this.role = opts.role;               // 'host' | 'player'
    this.room = opts.room;
    this.clientId = opts.clientId;
    this.name = opts.name || 'Player';
    this.onState = opts.onState || (() => {});
    this.onMeta = opts.onMeta || (() => {});
    this.onAction = opts.onAction || (() => {});
    this.onNotice = opts.onNotice || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onHostState = opts.onHostState || (() => {});
    this.base = `${CFG.topicPrefix}/${this.room}`;
    this.topics = {
      state: `${this.base}/state`,
      meta: `${this.base}/meta`,
      action: `${this.base}/action`,
      notice: `${this.base}/n/${this.clientId}`
    };
    this.key = null;
    this.client = null;
    this.lastMeta = null;
    this._metaWaiters = [];
    this._stateQueue = Promise.resolve();
    this._timers = [];
    this._closed = false;
    this._everConnected = false;
  }

  async connect() {
    this.key = await deriveKey(this.room);
    const baseOptions = {
      clientId: 'mc_' + randomId(8),
      clean: true,
      connectTimeout: 9000,
      reconnectPeriod: 3500,
      keepalive: 30,
      protocolVersion: 4,
      resubscribe: true
    };
    if (this.role === 'host') {
      baseOptions.will = {
        topic: this.topics.meta,
        payload: JSON.stringify(this._metaPayload(false, 0)),
        qos: 0,
        retain: true
      };
    }

    let lastErr = null;
    const urls = CFG.brokerUrls && CFG.brokerUrls.length ? CFG.brokerUrls : ['wss://broker.emqx.io:8084/mqtt'];
    for (const url of urls) {
      try {
        this.client = await connectOnce(url, baseOptions);
        this.brokerUrl = url;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!this.client) throw new Error('Could not reach a live-sync broker. ' + (lastErr ? lastErr.message : ''));

    this.client.on('message', (topic, payload) => this._message(topic, payload));
    this.client.on('connect', () => this._reconnected());
    this.client.on('close', () => { if (!this._closed) this.onStatus('reconnecting'); });
    this.client.on('offline', () => { if (!this._closed) this.onStatus('offline'); });
    this.client.on('error', () => {});
    this._everConnected = true;
    await this._subscribe();
    this.onStatus('live');
    this._startTimers();
    if (this.role === 'host') {
      this.updateMeta({ online: true, host: this.name });
    } else {
      await this.sendAction({ type: 'join', name: this.name });
    }
  }

  _startTimers() {
    this._timers.forEach(clearInterval);
    this._timers = [];
    if (this.role === 'host') {
      this._timers.push(setInterval(() => this.updateMeta({ online: true }), CFG.heartbeatMs));
    } else {
      this._timers.push(setInterval(() => this.sendAction({ type: 'ping' }).catch(() => {}), CFG.playerPingMs));
    }
  }

  _topicsForRole() {
    return this.role === 'host'
      ? [this.topics.action]
      : [this.topics.state, this.topics.meta, this.topics.notice];
  }

  _subscribe() {
    if (!this.client) return Promise.resolve();
    const topics = this._topicsForRole();
    return Promise.all(topics.map(topic => new Promise((resolve, reject) => {
      this.client.subscribe(topic, { qos: 1 }, err => err ? reject(err) : resolve());
    })));
  }

  async _reconnected() {
    if (this._closed) return;
    try {
      await this._subscribe();
      this.onStatus('live');
      if (this.role === 'host') {
        this.updateMeta({ online: true, host: this.name });
      } else {
        await this.sendAction({ type: 'join', name: this.name });
      }
    } catch (e) {
      this.onStatus('offline');
    }
  }

  _message(topic, payload) {
    const text = payload.toString();
    if (topic === this.topics.meta) {
      let meta = null;
      try { meta = JSON.parse(text); } catch (e) { return; }
      if (!meta || meta.v !== 1) return;
      this.lastMeta = meta;
      const waiters = this._metaWaiters.splice(0);
      waiters.forEach(w => w(meta));
      this.onMeta(meta);
      return;
    }
    if (!this.key) return;
    if (topic === this.topics.state) {
      unseal(this.key, text).then(obj => {
        if (this._closed || !obj || obj.v !== 2) return;
        if (this.role === 'player') this.onState(obj);
      }).catch(() => {});
    } else if (topic === this.topics.action) {
      if (this.role !== 'host') return;
      unseal(this.key, text).then(obj => {
        if (this._closed || !obj || obj.v !== 1) return;
        this.onAction(obj);
      }).catch(() => {});
    } else if (topic === this.topics.notice) {
      if (this.role !== 'player') return;
      unseal(this.key, text).then(obj => {
        if (!this._closed && obj && typeof obj.text === 'string') this.onNotice(obj.text);
      }).catch(() => {});
    }
  }

  waitForMeta(timeoutMs = 5000) {
    if (this.lastMeta) return Promise.resolve(this.lastMeta);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this._metaWaiters.push(meta => { clearTimeout(timer); resolve(meta); });
    });
  }

  _metaPayload(online, clients) {
    return { v: 1, online: !!online, host: this.name, ts: Date.now(), clients: clients || 0 };
  }

  updateMeta(patch = {}) {
    if (!this.client || this.role !== 'host') return;
    this._meta = Object.assign(this._meta || {}, patch);
    const payload = this._metaPayload(this._meta.online !== false, this._meta.clients || 0);
    this.client.publish(this.topics.meta, JSON.stringify(payload), { qos: 0, retain: true });
  }

  publishState(snapshot) {
    if (!this.client || !this.key) return Promise.resolve();
    const topic = this.topics.state;
    const key = this.key;
    this._stateQueue = this._stateQueue.then(async () => {
      const payload = await seal(key, snapshot);
      await new Promise(resolve => {
        this.client.publish(topic, payload, { qos: 0, retain: CFG.snapshotRetain !== false }, () => resolve());
      });
    }).catch(() => {});
    return this._stateQueue;
  }

  sendAction(action) {
    if (!this.client || !this.key) return Promise.reject(new Error('Not connected'));
    const key = this.key;
    return seal(key, { v: 1, clientId: this.clientId, name: this.name, ts: Date.now(), action })
      .then(payload => new Promise((resolve, reject) => {
        this.client.publish(this.topics.action, payload, { qos: 1 }, err => err ? reject(err) : resolve());
      }));
  }

  notify(clientId, text) {
    if (this.role !== 'host' || !this.client || !this.key) return;
    seal(this.key, { v: 1, text: String(text).slice(0, 300) })
      .then(payload => {
        this.client.publish(`${this.base}/n/${clientId}`, payload, { qos: 1 });
      }).catch(() => {});
  }

  disconnect(sayGoodbye = true) {
    if (this._closed) return;
    this._closed = true;
    this._timers.forEach(clearInterval);
    this._timers = [];
    if (!this.client) return;
    try {
      if (this.role === 'host') {
        this.client.publish(this.topics.meta, JSON.stringify(this._metaPayload(false, 0)), { qos: 0, retain: true });
      } else if (sayGoodbye) {
        this.sendAction({ type: 'leave' }).catch(() => {});
      }
    } catch (e) {}
    setTimeout(() => { try { this.client.end(true); } catch (e) {} }, 120);
  }
}

window.LiveSession = LiveSession;
window.CortezNet = { deriveKey, seal, unseal, randomId, CFG };
})();
