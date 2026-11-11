# Marine-Commander
Combat based on the Gemini Sector engine

A host-run battlemap for the Cortez, Kamekh, Dorkir and Dorkathi deck plans. The
GM picks the map, opens doors, runs the hostiles, assigns turns, edits HP and
inventory, and keeps the table in sync. Each player joins with a code, controls
one character, moves and attacks on their turn, and has their own HP bar,
inventory, combat stats and weapon.

The app is **static** — no build step, no server, no environment variables — so
it can be deployed directly to Vercel (or any static host) and still play live.

## Run it locally

```bash
python3 -m http.server 4173
# open http://127.0.0.1:4173
```

Open a second browser or incognito window to test a player. Live sync needs a
secure context, so use `http://localhost`/`127.0.0.1` or HTTPS.

## Deploy to Vercel

From this directory:

```bash
npx vercel
```

Use the defaults (framework preset: **Other**, no build command, output
directory: `.`). Or push the folder to a Git repository and import it in
Vercel. `index.html` is the entry point.

## How live sync works

- The host's browser is authoritative. It publishes an encrypted snapshot of
  the whole table (tokens, doors, lights, turns, roster, log) to an MQTT topic.
- Players subscribe to that topic and send small action messages back
  (`move`, `hp`, `inventory`, `useItem`, `requestDoor`, `chat`, `join`).
  The host validates ownership and turn order, applies the action, and
  publishes a fresh snapshot.
- Messages are encrypted end-to-end with AES-GCM. The key is derived from the
  session code, so the public relay only sees ciphertext.
- The latest snapshot is **retained** by the broker, so late joiners get the
  current table immediately. The host also publishes a presence heartbeat and
  players detect when the GM goes offline.
- The default relay is the free public EMQX WebSocket broker. No account or
  API key is required. It is fine for a home game, but it is a public service:
  share the code/invite only with your table.

### Using your own broker

Edit [`js/config.js`](js/config.js) and point `brokerUrls` at any
MQTT-over-WebSocket broker you control (for example Mosquitto with
`listener 8084` + websockets + TLS). If you want a private table, this is the
recommended upgrade. The only requirement is that the broker accepts browser
WebSocket connections and retained messages.

```js
window.MC_CONFIG = {
  brokerUrls: ['wss://mqtt.example.com:8084/mqtt'],
  ...
};
```

## The table

### Host / GM

1. Enter a display name and choose **Host a session**.
2. Share the code or press **Copy invite**.
3. Pick the deck from the **Map** selector in the header. Every player follows
   the host's map choice; tokens stay on the deck where they were left.
4. Assign characters from the **Live session** roster (players are auto-seated
   into a free player token when they join).
5. Use **Turns** to give a token the turn, or **Next turn** to cycle through
   everyone alive. Set a per-turn movement limit if you want one.
6. Click a door to open/close it, click a bulb to cycle its light, drag tokens
   (shift-drag ignores walls), edit HP/status/inventory, add hostiles, and roll
   the table log. Player door requests appear in the log.
7. Keep the tab open — the host is the server. A refresh offers **Resume last
   hosted session** from local storage.

### Maps and decks

The map picker lists the built-in scenes in `assets/maps/`. Each map is a UVTT
scene file plus its PNG, so selecting a map is a small JSON fetch and never
sends the image through the live session.

Dorkathi is split into **Lower deck** and **Upper deck**, grouped together in
the picker. The two decks are connected at the **Central ladder** marker near
the middle of the ship:

- The GM selects a token and clicks the ladder marker to send that token to the
  other deck. With no token selected, the same click just switches decks.
- A player whose token is standing on the marker can click it to travel. The
  host validates the move and switches everyone to the destination deck.
- A stair link is declared in `js/config.js` with `x`/`y` on the current map and
  `to`/`tx`/`ty` for the destination. Both directions need an entry (one on each
  map) to make the connection two-way:

```js
{
  id: 'dorkathi_bottom',
  name: 'Dorkathi', subtitle: 'Lower deck',
  group: 'dorkathi', level: 'Lower deck',
  scene: 'assets/maps/dorkathi_bottom.scene.json', ppg: 30,
  stairs: [{
    id: 'ladder-up', name: 'Central ladder · up',
    x: 19.5, y: 20, to: 'dorkathi_top', tx: 19.5, ty: 20
  }]
}
```

To add another stair, give both maps an entry; the ids only need to be unique
within a map. Coordinates are grid squares; `ppg` must match the scene's
pixels-per-grid.

To add a new `.dd2vtt` file, extract its image once and register the scene in
`js/config.js` (the `.dd2vtt` keeps the image inline, which is too large to sync
through MQTT on every snapshot):

```python
import base64, io, json
from PIL import Image
src = 'assets/maps/newmap.dd2vtt'
d = json.load(open(src))
Image.open(io.BytesIO(base64.b64decode(d['image']))).save('assets/maps/newmap.png')
d['image'] = 'newmap.png'
json.dump(d, open('assets/maps/newmap.scene.json', 'w'), separators=(',', ':'))
```

### The Cortez boarding party

The built-in scene starts with the four heroes and a ten-strong hostile
boarding party drawn from `assets/tokens/human/`:

| Hero | Callsign | Portrait | Weapon |
| --- | --- | --- | --- |
| Leni Henari | Killmeister | `killmeister.webp` | Laser rifle |
| Keyan Steele | Enforcer | `enforcer-head.png` | Laser rifle |
| Cyric Karde | Talon | `talon.jpg` | Laser rifle |
| Derek Miles | Tinman | `tinman.webp` | Laser rifle |

| Hostile role | Count | Weapon | Starting area |
| --- | --- | --- | --- |
| Pilot | 4 | Laser | Major fighter bay |
| Grunt | 2 | Rifle | Hangar centre aisle |
| Navigator | 2 | Knife | Bridge / navigation corridor |
| Medic | 1 | Stun rod | Landing pad |
| Engineer | 1 | Club | Engines |

The token `img` field points at the portrait file (for example
`assets/tokens/human/pilot.png`) instead of embedding base64. The browser
loads the portrait directly, so solo saves and host checkpoints stay small;
portraits are centre-cropped to fill the round token. The layout lives in
`defaultTokens()` in [`js/app.js`](js/app.js); edit the `hero(...)` and
`hostile(...)` lists there to change names, stats, weapons, starting squares or
portraits. Hero names are fixed: assigning a seat does not rename the character.

To place a token by hand, set its name, colour and size and press **Add
hostile**; it appears at the centre of the current view. Drag it to position it
(**Shift-drag** ignores walls), or press **Img** in its roster row to upload a
portrait. Placement is part of the table state: Solo GM autosaves to
`localStorage`, a host writes a checkpoint after every change and offers
**Resume**, and live players receive the host's layout. **Reset scene** restores
the preset above and clears the table, including tokens on other decks; an
existing solo save is restored when you re-enter, so use **Reset scene** (or
clear the `cortez-solo-v4` key) to pick up a changed preset. Saves remember the
selected map and door/light state for every deck in the map list.

### Player

1. Enter a display name, choose **Join with a code**, and enter the GM's code
   (or open the invite link).
2. Wait for the GM to assign a character (or ask for one from the sheet).
3. On your turn, drag your token to move. Click a door to ask the GM to open or
   close it. Use items or edit your own HP and inventory from **Your
   character**. The table log has chat.

## Combat

Combat is a browser port of the supplied `melee.py` rules.

- Each token has **Melee**, **Martial Arts**, **Dance** and **Athletic** stats plus a
  weapon. The GM can edit these for players and hostiles from the token row's
  **Combat stats** disclosure.
- Derived values: `Melee skill = max(Melee, Martial Arts, Dance × 0.66)`,
  `Damage = round(skill / 2)` (minimum 1), and `Max HP = Athletic × 2 + skill`.
  Changing a stat recalculates max HP while preserving damage already taken.
- Weapons: knife, stick, club, sword and stun rod are melee; **laser, laser
  rifle, mass driver and rifle are ranged**. Ranged attacks have no range limit. Melee
  attacks need the tokens to be within `(attacker size + target size) / 2 + 0.5`
  squares; otherwise the Attack button explains that the target is out of reach.
- On a turn a token can move and make **one attack**. The active token gets an
  **Attack** button. Choose Strike, Grapple or Counter; the matrix is
  Strike → Grapple → Counter → Strike. Strike vs strike trades damage, grapple
  vs grapple compares current HP, and so on.
- When a hostile defends, its reaction is chosen by the enemy AI using the
  original d20 behaviour: nat 1 = caught unaware (critical sucker-punch),
  2–9 = the losing move, 10–15 = a random move, 16–20 = the winning move.
  Players never choose a hostile's stance; attacking players always get a random
  enemy reaction.
- When a hostile attacks a player, the player's **Choose your stance** pop-up
  asks them to pick Strike, Grapple or Counter. The attack resolves on the host
  after their answer. If they do not answer within 30 seconds, a random stance
  is used so the game cannot stall.
- Hits disarm the defender (as in `melee.py`), damage applies, and stagger /
  bloodied / victory messages go to the table log.
- Players attack hostiles from their sheet; the action is validated by the host
  and the result is synced to everyone. The GM can attack with any token whose
  turn is active.
- HP bars are drawn below every token on the map and under each HP row in the
  token list. In the GM view every hostile shows its bar; players show hostile
  bars when **Players see hostile health** is on (default on).

## Files

```
index.html                 app shell and controls
css/app.css                all presentation
js/config.js               broker URLs, heartbeat/timeout, map catalog and stairs
js/net.js                  MQTT transport, room crypto, presence
js/app.js                  map renderer, rules, turn/roster/state UI
assets/maps/*.scene.json        extracted UVTT geometry for each deck (image path, no base64)
assets/maps/*.png               extracted map images
assets/maps/*.dd2vtt            original source maps
vendor/mqtt.min.js              MQTT.js 5.10.1 browser bundle (MIT)
marine_commander.html           original single-file version, kept for reference
vtt/cortez.dd2vtt               original map file supplied with the project
```

The single-file original embedded the map JSON and its PNG as base64. This
version separates them: the map is a normal PNG plus a small JSON scene file,
and the game/UI lives in `js/` and `css/`. Other `.dd2vtt` files can still be
loaded in **Solo GM** mode.

## Notes and limits

- Live sessions require the GM's tab to stay open. If it closes, players see
  **GM offline** and the table pauses until the GM resumes/reopens.
- Custom `.dd2vtt` maps are solo-only. Live sessions use the built-in maps in
  `js/config.js` so every client can load the same scene.
- The session code is the access boundary. Anyone with it can join the lobby,
  and a malicious participant could spam actions (the host rate-limits them).
  Use a private broker if you need stronger isolation.
- Saves: solo state is in `localStorage`; host checkpoints are in `localStorage`
  keyed separately; players do not persist the table.
- HP/inventory are cooperative: players can edit their own character, while the
  host can edit anyone. The host remains authoritative for all state.

