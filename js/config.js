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
          x: 19.5, y: 20,
          to: 'dorkathi_top',
          tx: 19.5, ty: 20
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
          x: 19.5, y: 20,
          to: 'dorkathi_bottom',
          tx: 19.5, ty: 20
        }
      ]
    }
  ],
  heartbeatMs: 8000,      // host presence refresh
  playerPingMs: 10000,    // player presence refresh
  hostTimeoutMs: 32000,   // players consider the host gone after this
  maxPlayers: 8,
  snapshotRetain: true
};
