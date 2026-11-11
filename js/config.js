/* Runtime configuration for the live table.
 * Everything here is public; no keys or accounts are required.
 * The default broker is a free, public MQTT-over-WebSocket service.
 * Change these values to point at your own broker if you prefer.
 */
window.MC_CONFIG = {
  brokerUrls: [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ],
  topicPrefix: 'marine-commander/v1',
  mapUrl: 'assets/maps/cortez.scene.json',
  heartbeatMs: 8000,      // host presence refresh
  playerPingMs: 10000,    // player presence refresh
  hostTimeoutMs: 32000,   // players consider the host gone after this
  maxPlayers: 8,
  snapshotRetain: true
};
