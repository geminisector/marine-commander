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
  // Kept for backwards compatibility; the map picker uses `maps` below.
  mapUrl: 'assets/maps/cortez.scene.json',
  // `ppg` is the UVTT pixels-per-grid. `stairs` coordinates are in grid squares.
  // Give a stair a matching return stair on the destination map to connect the
  // two decks. `group`/`level` only affect the labels in the map picker.
  maps: [
    {
      id: 'cortez',
      name: 'Cortez',
      subtitle: 'Deck plan',
      scene: 'assets/maps/cortez.scene.json',
      ppg: 16
    },
    {
      id: 'kamekh2',
      name: 'Kamekh',
      subtitle: 'Kamekh II',
      scene: 'assets/maps/kamekh2.scene.json',
      ppg: 32
    },
    {
      id: 'dorkir',
      name: 'Dorkir',
      scene: 'assets/maps/dorkir.scene.json',
      ppg: 20
    },
    {
      id: 'dorkathi_bottom',
      name: 'Dorkathi',
      subtitle: 'Lower deck',
      group: 'dorkathi',
      level: 'Lower deck',
      scene: 'assets/maps/dorkathi_bottom.scene.json',
      ppg: 30,
      stairs: [
        {
          id: 'ladder-up',
          name: 'Central ladder · up',
          x: 13.5, y: 20,
          to: 'dorkathi_top',
          tx: 13.5, ty: 20
        }
      ]
    },
    {
      id: 'dorkathi_top',
      name: 'Dorkathi',
      subtitle: 'Upper deck',
      group: 'dorkathi',
      level: 'Upper deck',
      scene: 'assets/maps/dorkathi_top.scene.json',
      ppg: 30,
      stairs: [
        {
          id: 'ladder-down',
          name: 'Central ladder · down',
          x: 13.5, y: 20,
          to: 'dorkathi_bottom',
          tx: 13.5, ty: 20
        }
      ]
    },
    {
      id: 'lumbari_top',
      name: 'Lumbari',
      subtitle: 'Command deck',
      group: 'lumbari',
      level: 'Command deck',
      scene: 'assets/maps/lumbari_deck1_command_v2.scene.json',
      ppg: 70,
      stairs: [
        {
          id: 'forward-ladder-down',
          name: 'Forward ladder · down',
          x: 6.6, y: 10,
          to: 'lumbari_bottom',
          tx: 6.6, ty: 10
        },
        {
          id: 'aft-ladder-down',
          name: 'Aft ladder · down',
          x: 42.9, y: 10,
          to: 'lumbari_bottom',
          tx: 42.9, ty: 10
        }
      ]
    },
    {
      id: 'lumbari_bottom',
      name: 'Lumbari',
      subtitle: 'Engineering deck',
      group: 'lumbari',
      level: 'Engineering deck',
      scene: 'assets/maps/lumbari_deck2_engineering_v2.scene.json',
      ppg: 70,
      stairs: [
        {
          id: 'forward-ladder-up',
          name: 'Forward ladder · up',
          x: 6.6, y: 10,
          to: 'lumbari_top',
          tx: 6.6, ty: 10
        },
        {
          id: 'aft-ladder-up',
          name: 'Aft ladder · up',
          x: 42.9, y: 10,
          to: 'lumbari_top',
          tx: 42.9, ty: 10
        }
      ]
    },
    {
      id: 'kcomm_upper',
      name: 'Kilrathi Comm Station',
      subtitle: 'Upper deck',
      group: 'kcomm',
      level: 'Upper deck',
      scene: 'assets/maps/kilrathi_comm_station_deck1_upper.scene.json',
      ppg: 70,
      stairs: [
        {
          id: 'turbolift-down',
          name: 'Central turbolift · down',
          x: 50, y: 15,
          to: 'kcomm_middle',
          tx: 48, ty: 14,
          dir: 'down'
        }
      ]
    },
    {
      id: 'kcomm_middle',
      name: 'Kilrathi Comm Station',
      subtitle: 'Middle deck',
      group: 'kcomm',
      level: 'Middle deck',
      scene: 'assets/maps/kilrathi_comm_station_deck2_middle.scene.json',
      ppg: 70,
      stairs: [
        {
          id: 'turbolift-up',
          name: 'Central turbolift · up',
          x: 48, y: 14,
          to: 'kcomm_upper',
          tx: 50, ty: 15,
          dir: 'up'
        },
        {
          id: 'turbolift-down',
          name: 'Central turbolift · down',
          x: 52, y: 16,
          to: 'kcomm_lower',
          tx: 50, ty: 15,
          dir: 'down'
        }
      ]
    },
    {
      id: 'kcomm_lower',
      name: 'Kilrathi Comm Station',
      subtitle: 'Lower deck',
      group: 'kcomm',
      level: 'Lower deck',
      scene: 'assets/maps/kilrathi_comm_station_deck3_lower.scene.json',
      ppg: 70,
      stairs: [
        {
          id: 'turbolift-up',
          name: 'Central turbolift · up',
          x: 50, y: 15,
          to: 'kcomm_middle',
          tx: 52, ty: 16,
          dir: 'up'
        }
      ]
    }
  ],
  // Lightweight UX gate for the GM buttons; this is not security.
  // Set to '' to disable the prompt.
  hostPassword: 'marine-commander',
  heartbeatMs: 8000,      // host presence refresh
  playerPingMs: 10000,    // player presence refresh
  hostTimeoutMs: 32000,   // players consider the host gone after this
  maxPlayers: 16,
  maxClients: 64,          // player + spectator roster cap; extra joiners spectate
  medkitHeal: 5,           // HP restored by one Medkit
  snapshotRetain: true
};
