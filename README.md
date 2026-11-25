# Marine Commander
Combat based on the Gemini Sector engine

Marine Commander is a host-run battlemap for the Cortez, Kamekh, Dorkir,
Dorkathi, Lumbari, Kilrathi Comm Station and TCS Rakshasha deck plans. The GM
picks the map, opens doors, runs the hostiles,
assigns turns, edits HP and inventory, and keeps the table in sync. Each player
joins with a code, controls one character, moves and attacks on their turn, and
has their own HP bar, inventory, combat stats and weapon.

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
  the whole table (tokens, zones, drops, effects, doors, lights, turns, roster,
  log) to an MQTT topic.
- Players subscribe to that topic and send small action messages back
  (`move`, `hp`, `inventory`, `useItem`, `useMedkit`, `throwGrenade`, `loot`,
  `requestDoor`, `chat`, `join`). The host validates ownership and turn order,
  applies the action, and publishes a fresh snapshot.
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

**Host a session**, **Solo GM** and **Resume hosted session** ask for the GM
password first. The default is `marine-commander`; change `hostPassword` in
[`js/config.js`](js/config.js), or set it to `''` to remove the prompt. This is
a quick UX gate so players do not wander into the GM controls — it is not
security, because the password ships in the static client.

1. Enter a display name and choose **Host a session**.
2. Share the code or press **Copy invite**.
3. Pick the deck from the **Map** selector in the header. Every player follows
   the host's map choice; tokens stay on the deck where they were left.
4. Spawn the player characters taking part from **Setup → Spawn player
   character**, then assign them from the **Live session** roster. Player
   characters do not spawn automatically; a player who joins while every
   spawned character is already assigned sits at the table as a spectator.
5. Use **Turns** to give a token the turn, or **Next turn** to cycle through
   everyone alive. Set **AP per turn** (default 24). The AP pool pays for
   movement (1 AP per square) and actions; action costs are fixed percentages of
   the pool, rounded up. At 24 AP: **pick up 7**, **aimed shot 13**, **snap shot
   9**, **melee 9**, **use 13**. Each player refills to the full pool at the
   start of their turn. Leftover AP stays available for reflex shots until their
   next turn. Players see current/max **AP** on their character sheet and in an
   on-map meter, and can press **End turn** there; the host only accepts that for
   the player whose turn is actually active.
6. Click a door to open/close it, click a bulb to cycle its light, drag tokens
   (shift-drag ignores walls), edit HP/status/inventory, add hostiles, and roll
   the table log. **Clear all hostiles** in the Tokens section removes every GM
   token at once. Player door and light requests open a GM pop-up with the
   target glowing on the map; approve or deny with a reason that is sent
   back to the player and recorded in the log.
7. Keep the tab open — the host is the server. A refresh offers **Resume last
   hosted session** from local storage.

### Setup phase

Every new session starts in **Setup** mode. Players can join and be assigned
characters while the GM prepares the table, but they cannot move, attack or use
stairs yet. The Map selector chooses the deck being prepared.

- Pick a unit in the **Setup** section and press **Place on this deck** to move
  it from another deck to the current one. Drag it to its spawn square.
- **Spawn player character** creates the selected imported or built-in hero on
  the current deck. Player characters are never placed automatically; spawn
  only the party taking part, and spawn more later if a spectator joins and a
  character becomes available. A joining player takes a free spawned character
  automatically; if every spawned character is already assigned, they join as a
  spectator.
- **Move players here** moves every player character from other decks onto the
  current deck in a loose formation, ready to be dragged into position.
- **Spawn enemies** creates any number of preset Pilots, Grunts, Navigators,
  Medics or Engineers on the current deck, numbered automatically (for example
  `Pilot 5`, `Pilot 6`, `Grunt 3`). The Kilrathi group adds the named character
  presets: Kal Shintar Kalra, Dejjar, First Fang Bhurj, Least Claw Bhurj, First
  Fang Ga'Ree, Third Claw Jorn, Second Fang Kalluss, Second Claw L'urr and a
  generic Kilrathi Scientist.
- New generic units still come from **Tokens → Add player token / Add hostile**;
  they spawn on the current deck.
- The updated Cortez hostile placements in `defaultTokens()` remain the default
  whenever the Cortez scene is reset or a new table starts. No player character
  tokens are created by default.
- Press **Begin mission** when ready. This starts the mission log; setup moves
  and placement are not counted as part of the mission.

Players only see hostiles when their own living character is on the deck, the
hostile is inside the character's line of sight, and its square is lit. If
spawned enemies seem invisible, move a player character to that deck, open the
room's door, or switch **Lighting** to **All lights on**. Setup mode lights every
room automatically; normal door/lighting rules resume after **Begin mission**.
Spawning also warns when no player character is on the current deck or when every
room is unlit.

### Grenades

Grenades are inventory items. Press **Throw** on a grenade, then click the target
square; press **Esc** to cancel. The GM can throw with any token, while a player
can only throw their own grenade on their own turn. A throw uses the **Use**
action (13 AP at the default 24). Its maximum range is 2 squares per point of
the thrower's **Athletic** stat, and the target must be in clear line of sight:
walls, closed doors and smoke block the throw. Added item names autocomplete
from the inventory list, and the GM can also add grenades from a token's
inventory.

- **Flashbang** — 3-square radius. Every token in the area is **Blinded** for 3
  of its own turns. A blinded character's sight range drops to 1 square.
- **Smoke grenade** — 3-square radius, lasting 5 player turns. The cloud blocks
  line of sight through and into it.
- **Fire grenade** — 3-square radius, lasting 5 player turns. A token standing in
  the fire takes 2 damage at the start of each of its turns.
- **Frag grenade** — 4-square radius. Every token in the area immediately takes
  5 damage, including friendly tokens.
- **Boron silicate grenade** — 3-square radius, lasting 5 player turns. The cloud
  harms no one. It neutralises all laser weaponry: a laser fired by a character
  inside the cloud, at a target inside it, or along a path that crosses it deals
  no damage.

Durations count unit turns, not the table's global turn counter: blindness
counts down at the end of the affected unit's turns, while fire, smoke and
boron silicate clouds last for five player-character turns. Fire damage on the
fifth player turn still applies before the zone expires.

### Medkits

Pressing **Heal** on a Medkit opens a target picker. On their own turn, a
character can heal themselves or any character within adjacent reach. Each
Medkit restores 5 HP (configurable with `medkitHeal` in
[`js/config.js`](js/config.js)). Using it costs the **Use** action (13 AP at the
default 24). Healing a downed character above 0 HP revives them; characters
marked **Dead** cannot be revived this way.

### Looting

A character that is disarmed drops their weapon on the square where they were
hit. Going down or dying also drops the equipped weapon, and a downed or dead
character's remaining inventory stays on their token and can be looted. Living
characters see **Loot** buttons for nearby dropped weapons and downed/dead
tokens within melee reach.

Looting costs the **Pick up** action (7 AP at the default 24), not an attack.
Looted inventory stacks merge into the looter's inventory. Picking up a dropped
weapon equips it and drops the looter's previous weapon at their current square.
Players can loot with their own living character on their turn; the GM can loot
with any living token. Because AP, not a once-per-turn attack budget, limits
actions, a character with AP left can pick something up and still attack.

### Visual feedback

Combat and looting play short synced effects on the battle map: ranged attacks
draw a tracer from shooter to target, hits show an impact burst and floating
damage, grenades arc through the air before exploding, and dropped or picked-up
weapons flash at their square. The effects are included in live snapshots, so
every connected player sees them.

### Mission reports

When the mission is over, the GM presses **End mission & download log** in the
**Mission** section. It downloads a Markdown report named
`marine-commander-combat-log-<timestamp>.md` containing:

- final status, HP, weapon and controller for every player character and every
  hostile;
- damage dealt and taken, attacks made and suffered, defensive stances, items
  used, stairs used and distance moved for each combatant;
- every combat exchange with the attack, reaction, damage and remaining HP;
- the full chronological mission log, including door, turn, inventory and chat
  events.

The report is also kept in the solo save and host checkpoint, so resuming a
session does not lose the mission history.

### Maps and decks

The map picker lists the built-in scenes in `assets/maps/`, one folder per ship.
Each map is a UVTT scene file plus its PNG, so selecting a map is a small JSON
fetch and never sends the image through the live session.

Kamekh, Dorkir, Lumbari, the Kilrathi Comm Station, all four TCS Rakshasha
decks and both Dorkathi decks have room lights baked into their scene files. In
**Lighting → Follow doors**, opening a door lights that room; **All lights on**
reveals every room at once.

Dorkathi is split into **Lower deck** and **Upper deck**, grouped together in
the picker. The two decks are connected at the **Central ladder** marker near
the middle of the ship. Lumbari is split into **Command deck** and
**Engineering deck**, connected by a **Forward ladder** and an **Aft ladder**
(pairing the two ladder symbols on each deck). The Kilrathi Comm Station has
**Upper**, **Middle** and **Lower** decks, chained together by the **Central
turbolift** marker on each deck. TCS Rakshasha has four decks — **Command**,
**Crew**, **Systems** and **Cargo** — chained together by the **Lift 4S** and
**Lift 4P** markers: 4S goes up toward Command and 4P goes down toward Cargo.

For any pair of connected decks:

- The GM selects a token and clicks the stair marker to send that token to the
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
  scene: 'assets/maps/dorkathi/dorkathi_bottom.scene.json', ppg: 30,
  stairs: [{
    id: 'ladder-up', name: 'Central ladder · up',
    x: 19.5, y: 20, to: 'dorkathi_top', tx: 19.5, ty: 20
  }]
}
```

To add another stair, give both maps an entry; the ids only need to be unique
within a map. Coordinates are grid squares; `ppg` must match the scene's
pixels-per-grid.

#### Adding a new map

This is the developer workflow for adding a map to the built-in catalog. Each
ship gets its own folder under `assets/maps/`. A map has four parts:

- `assets/maps/newmap/newmap.dd2vtt` — the Universal VTT source, kept so the map
  can be edited later;
- `assets/maps/newmap/newmap.scene.json` — the runtime geometry copied from it;
- an extracted image such as `assets/maps/newmap/newmap.png`;
- an entry in the `maps` array in [`js/config.js`](js/config.js).

The app never fetches the `.dd2vtt`. It fetches the scene JSON named in
`js/config.js`, and the scene's `image` field points at the extracted image.
Keeping the image out of the scene file prevents the base64 artwork from being
sent through MQTT in live snapshots.

1. **Add the source file.** Put the `.dd2vtt` in a ship folder such as
   `assets/maps/newmap/`. Use
   [`dd2vtt-editor.html`](dd2vtt-editor.html) if you need to correct walls,
   doors, lights or the map image before importing it.

2. **Generate the runtime pair.** Run the converter from the repository root:

    ```bash
    python3 tools/import_dd2vtt.py assets/maps/newmap/newmap.dd2vtt
    ```

    It extracts the inline image (`newmap.png`, or `.jpg`, `.webp` or `.gif`
    depending on the source), writes `newmap.scene.json` with the UVTT geometry
    and lights, and changes the scene's `image` field to the extracted filename.
    It accepts raw or `data:`-prefixed base64. Pass `--force` to replace an
    existing pair, or `--keep-lights` to keep an existing scene's hand-tuned
    lights.

3. **Register the map** in the `maps` array in
   [`js/config.js`](js/config.js):

    ```js
    {
      id: 'newmap',
      name: 'New map',
      subtitle: 'Deck plan',   // optional
      scene: 'assets/maps/newmap/newmap.scene.json',
      ppg: 32
    }
    ```

    - `id` must be unique and should stay stable: saved games, host
      checkpoints and live snapshots refer to maps by this id.
    - `name` and `subtitle` are the labels shown in the map picker.
    - `scene` is the runtime JSON, never the `.dd2vtt`.
    - `ppg` must match the scene's `resolution.pixels_per_grid` (the app also
      reads that value from the scene, but the two should agree).

4. **Link decks if the map is multi-level.** Give every deck of the same ship
   the same `group`, a distinct `level`, and reciprocal `stairs` entries as
   described above. Stair `x`/`y`, `tx`/`ty` coordinates are grid squares, not
   image pixels. A stair only works in the direction declared on the current
   map, so each end needs its own entry.

5. **Validate the import.** Start the local server with
   `python3 -m http.server 4173`, open <http://127.0.0.1:4173>, and select the
   new map from the picker. Check that walls follow the artwork, doors open in
   the right places, lights cover the right rooms, and both ends of every stair
   arrive at the matching marker. If you want to inspect the raw source before
   generating the pair, use **Solo GM → Load .dd2vtt** as a local preview.

6. **Commit and deploy all four pieces** — the source `.dd2vtt`, the
   `.scene.json`, the extracted image and the `js/config.js` change. Every
   client must be able to fetch the same scene and image; the host's local files
   are not sent to players.

**Updating an existing map**

The scene file is a snapshot. Editing the `.dd2vtt` — for example in
`dd2vtt-editor.html` — does not change the map in the game. After saving the
edited source, refresh the runtime pair:

```bash
# Geometry only: walls, objects, doors and environment; keeps lights and image.
python3 tools/import_dd2vtt.py --geometry-only assets/maps/newmap/newmap.dd2vtt

# Full refresh, including the artwork and UVTT lights.
python3 tools/import_dd2vtt.py --force assets/maps/newmap/newmap.dd2vtt

# Full refresh but keep the scene's existing hand-tuned lights.
python3 tools/import_dd2vtt.py --force --keep-lights assets/maps/newmap/newmap.dd2vtt
```

`--geometry-only` copies `format`, `resolution`, `line_of_sight`,
`objects_line_of_sight`, `portals` and `environment` into the existing scene and
leaves `image` and `lights` alone. A full import replaces the extracted image
and all scene data. Then reload the page and repeat the validation above. The
map picker only reads the `.scene.json`, so deploy both the edited source and
the updated scene.

### The Cortez boarding party

The built-in scene starts with the four heroes below, any imported CombatBot
characters, and a ten-strong hostile boarding party drawn from
`assets/tokens/human/`:

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
clear the `marine-commander-solo-v4` key) to pick up a changed preset. Saves
remember the selected map and door/light state for every deck in the map list.
Saves from before the rename are migrated automatically from the old `cortez-*`
storage keys.

### Player

1. Enter a display name, choose **Join with a code**, and enter the GM's code
   (or open the invite link).
2. Wait for the GM to spawn and assign a character (or ask for one from the
   sheet). If every spawned character is already assigned, you join as a
   spectator until a slot frees up.
3. On your turn, drag your token to move (1 AP per square). The **AP** meter on
   **Your character** and the on-map **AP** indicator show current/max AP and
   the action costs. Attacks, loot pickups and item uses spend AP; the old
   one-attack limit is gone. Leftover AP stays available for **reflex shots**
   when a hostile moves into your sight. Press **End turn** to advance the table
   to the next character. Click a door or light bulb to ask the GM to open/close
   the door or switch the light. Use items, heal yourself or an adjacent
   character with a Medkit, and edit your own HP from **Your character**; only
   the GM can add new inventory items. The table log has chat.

Players cannot add or switch maps during a live session; the host controls the
map and everyone follows. To use a custom map locally, open **Solo GM → Load
.dd2vtt**. Hosts can add a map for the whole table by following [Adding a new
map](#adding-a-new-map).

### Importing CombatBot characters

`tools/import_character.py` reads the newest saved snapshot for a character from
CombatBot's `resources/characters.db`, converts the melee-relevant stats, and
writes them into the browser roster at [`js/characters.js`](js/characters.js).

```bash
python3 tools/import_character.py --img-dir assets/tokens/player \
  Beagle Brightshield Deck Ella Gauge Jukebox Karen Salmon Shark Shredder Tinker
# or point at a database elsewhere:
python3 tools/import_character.py --db ~/git/CombatBot/resources/characters.db Karen
```

The importer uses CombatBot's existing melee mapping: **Athletic** becomes the
Athletic stat, while **Melee**, **Martial Arts** and **Dance** (or **Dancing**)
come from the character's skill list. It also carries over non-credit inventory
items, adds a laser cell/medkit kit, and merges new characters into the existing
generated file instead of replacing them. Re-running a name updates that
character from its latest snapshot.

`--img-dir` matches each character's callsign to a portrait with the same file
name, ignoring extension, so run it against `assets/tokens/player/` whenever
portraits change. Imported characters appear first in the GM's **Spawn player
character** list, followed by the four built-in heroes. The table supports 16
player tokens. Use **Img** in a token row to replace a portrait manually.

## Combat

Combat is a browser port of the supplied `melee.py` rules.

- Each token has **Melee**, **Martial Arts**, **Dance** and **Athletic** stats plus a
  weapon. The GM can edit these for players and hostiles from the token row's
  **Combat stats** disclosure.
- Derived values: `Melee skill = max(Melee, Martial Arts, Dance × 0.66)`,
  `Damage = round(skill / 2)` (minimum 1), and `Max HP = Athletic × 2 + skill`.
  Changing a stat recalculates max HP while preserving damage already taken.
- Weapons: knife, stick, club, sword and stun rod are melee; **laser, laser
  rifle, mass driver and rifle are ranged**. Ranged attacks have no range limit,
  but they need a clear line of sight: walls and closed doors always block a
  shot. Melee attacks need the tokens to be within
  `(attacker size + target size) / 2 + 0.5` squares; otherwise the Attack button
  explains that the target is out of reach.
- **Action economy.** A player turn starts with a full AP pool (24 by default).
  Movement costs 1 AP per square; actions cost a percentage of the pool,
  rounded up: **pick up 26%**, **aimed shot 51%**, **snap shot 34%**,
  **melee 34%**, **use 51%**. At 24 AP that is 7 / 13 / 9 / 9 / 13. The old
  one-attack-per-turn limit is gone: spend AP until it runs out. Hostiles do not
  track AP; the GM runs them.
- The active token gets an **Attack** button. Choose Strike, Grapple or
  Counter; the matrix is Strike → Grapple → Counter → Strike. Strike vs strike
  trades damage, grapple vs grapple compares current HP, and so on. Melee
  attacks cost the melee percentage.
- **Aimed shot** (ranged) uses the same stance exchange and costs 51%. **Snap
  shot** (ranged) costs 34% and also uses the stance exchange, but after the
  exchange says the shot hits, a 50% roll turns that hit into a miss. A miss
  deals no damage from the snap shot, the defender's reaction still applies, and
  the shot tracer is drawn to an empty tile. Friendly fire is not possible.
- **Reflex shots.** When a hostile moves into a player's sight, the move pauses
  at the point where the hostile becomes visible. Every eligible player (ranged
  weapon, at least the snap-shot AP, and an online controller) gets a 15-second
  prompt to spend the snap-shot cost on one reflex snap shot. Unanswered prompts
  hold fire, then the move resumes. A player can react with any leftover AP,
  including before their own turn. Hostiles do not receive reflex shots.
- When a hostile defends, its reaction is chosen by the enemy AI using the
  original d20 behaviour: nat 1 = caught unaware (critical sucker-punch),
  2–9 = the losing move, 10–15 = a random move, 16–20 = the winning move.
  Players never choose a hostile's stance.
- Player attacks are **queued** instead of resolving immediately; the request
  includes whether the shot was aimed or a snap. The host charges the AP when
  the request is queued. The GM sees the request under **Attack queue**, picks
  the hostile's stance (or leaves it on AI random), then presses **Resolve
  attack**. The same picker has **Hostile auto-wins** and **Hostile
  auto-loses** under **GM override**, so the GM can decide the enemy's fate
  without rolling the stance matrix. Cancelling the request refunds the AP and
  lets the player act again.
- The GM's attack dialog has two extra options below the normal moves:
  **Win** makes the attacker win the exchange and damage the defender; **Lose**
  makes the attacker lose and take the defender's damage. These bypass the
  normal stance matrix and any player stance prompt. Forced results, including
  the attack queue's **Hostile auto-wins** and **Hostile auto-loses**, are
  recorded in the log as concrete stances: a win is **Strike/Grapple**, and a
  loss is **Counter/Grapple**.
- If a ranged attacker shoots a target armed only for melee and the distance is
  beyond that target's melee reach, the target automatically loses the exchange.
  The log explains that they had no ranged reply, and no player stance prompt is
  shown because the defender cannot answer at that range.
- When a hostile attacks a player, the player's **Choose your stance** pop-up
  asks them to pick Strike, Grapple or Counter. The attack resolves on the host
  after their answer. If they do not answer within 30 seconds, a random stance
  is used so the game cannot stall.
- Hits disarm the defender (as in `melee.py`), damage applies, and stagger /
  bloodied / victory messages go to the table log. Dropping to 60% or less marks
  the token **Staggered**; dropping to 30% or less replaces that with
  **Bloodied**.
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
js/characters.js           generated roster imported from CombatBot
js/net.js                  MQTT transport, room crypto, presence
js/app.js                  map renderer, rules, turn/roster/state UI
tools/import_character.py  CombatBot characters.db -> Marine Commander importer
tools/import_dd2vtt.py     .dd2vtt -> .scene.json + extracted map image converter
assets/maps/<ship>/*.scene.json extracted UVTT geometry for each deck (image path, no base64)
assets/maps/<ship>/*.png        extracted map images
assets/maps/<ship>/*.dd2vtt     original source maps
assets/tokens/player/*          player character portraits
assets/tokens/human/*           hostile boarding-party portraits
assets/tokens/kilrathi/*        Kilrathi portraits
vendor/mqtt.min.js              MQTT.js 5.10.1 browser bundle (MIT)
marine_commander.html           original single-file version, kept for reference
vtt/cortez.dd2vtt               original map file supplied with the project
```

The single-file original embedded the map JSON and its PNG as base64. This
version separates them: the map is a normal PNG plus a small JSON scene file,
and the game/UI lives in `js/` and `css/`. Other `.dd2vtt` files can still be
loaded in **Solo GM** mode. Embedded map images may be base64-encoded PNG,
JPEG/JPG or WebP (raw base64 or a `data:` URL); the loader detects the format
from the image bytes.

## Notes and limits

- Live sessions require the GM's tab to stay open. If it closes, players see
  **GM offline** and the table pauses until the GM resumes/reopens.
- Custom `.dd2vtt` maps are solo-only; players cannot add maps to a live
  session. Live sessions use the maps registered in `js/config.js` so every
  client can load the same scene (see [Adding a new
  map](#adding-a-new-map)).
- The session code is the access boundary. Anyone with it can join the lobby,
  and a malicious participant could spam actions (the host rate-limits them).
  Use a private broker if you need stronger isolation.
- Saves: solo state is in `localStorage`; host checkpoints are in `localStorage`
  keyed separately; players do not persist the table.
- HP and inventory are cooperative: players can edit their own HP and remove
  their own items, but only the GM can add inventory items. The host remains
  authoritative for all state.

