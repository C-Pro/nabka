# Набка (Nabka) — Vladivostok Waterfront Multiplayer

A 3D open-world multiplayer browser game set on the iconic **Sportivnaya Embankment (Спортивная набережная / «Набка»)** in Vladivostok, Russia.

Explore the waterfront promenade overlooking Amur Bay in third-person view, drive right-hand-drive Japanese cars with realistic drift physics, pet companion animals, chat with local personas using authentic Vladivostok slang, and hang out with other players in real time.

---

## Features

- 🌊 **Sportivnaya Embankment Landmark World**: Amur Bay horizon, sopki hills, central fountain, Ocean cinema, Olympiets complex, Dynamo stadium with night floodlights and accessible gates, Vladivostok Fortress battery, piers, street lamps, and hot pyanse kiosks.
- 🏎️ **Right-Hand-Drive JDM Cars & Drift Physics**:
  - Drivable classics: Toyota Mark II Tourer V, Nissan Skyline GT-R R34, Subaru Forester STI, Toyota Chaser JZX100, Mazda RX-7 FD3S.
  - Realistic physics engine with 160 km/h top speed, punchy straight-line acceleration, tire scrub deceleration, and traction recovery surges when straightening out.
  - Multi-camera modes (`V`): Third-person GTA camera, close action, wide panorama, and first-person right-hand-drive cockpit view.
- 🐾 **Pet Companions**: Explore alongside Maltese dog **Дуня (Dunya)** or cat **Берик (Berik)**. Pets follow the player, hop onto ledges, ride in the passenger seat while driving, and perform tricks or lie down when resting.
- 🗣️ **Local Slang & Branching NPC Dialogue**: Interact with Vladivostok characters (*Дэн с Зелёнки*, *Тётя Роза*, *Капитан Михалыч*, *Синоптик Игорь*, *Алиса с Фокина*, etc.) with authentic multi-stage dialogues and local lore.
- 🌅 **Dynamic Day/Night & Weather**: Real-time Vladivostok time clock (VLAT, UTC+10) with automatic day, sunset, dusk, and night lighting transitions, activating street lights and stadium spotlights.
- 🌐 **Stateful Multiplayer**: Low-latency WebSocket synchronization via binary MessagePack (`msgpack`), client-side dead-reckoning and interpolation, live chat, and server-authoritative vehicle parking.

---

## Tech Stack

- **Backend**: Go 1.24 with `fasthttp`, `fasthttp/websocket`, and `vmihailenco/msgpack/v5`. Stateful in-memory actor model with bounded queues, slow-consumer eviction, and graceful shutdown.
- **Frontend**: Zero-build ES modules in standard modern JavaScript, Three.js r128, HTML5 Canvas procedural texturing, Tailwind CSS, Font Awesome, and binary glTF 2.0 (`.glb`) 3D assets.
- **Audio**: Web Audio API engine with spatial sound, ambient bay surf, seagull calls, engine gear loops, and drift audio.
- **Packaging**: Multi-stage Docker build producing a minimal `FROM scratch` container using vendored dependencies (`-mod=vendor`).

---

## Quickstart

### Prerequisites
- [Go 1.24+](https://go.dev/dl/)
- [Bun](https://bun.sh/) (for running frontend tests and the standalone model editor)

### Running Locally
```sh
# Start the Go game server
go run -mod=vendor ./cmd/server
```
Open [http://localhost:8080/](http://localhost:8080/) in your browser.

To customize the port:
```sh
PORT=9090 go run -mod=vendor ./cmd/server
```

### Running with Docker
```sh
# Build minimal scratch container image
docker build -t nabka:latest .

# Run container
docker run -d -p 8080:8080 --name nabka nabka:latest
```

---

## Controls

### Keyboard & Mouse
| Action | Key / Input |
|---|---|
| **Move / Steer** | `W`, `A`, `S`, `D` / Arrow Keys |
| **Sprint** | `Shift` (unlimited stamina) |
| **Jump** | `Space` |
| **Vehicle Handbrake** | `Space` |
| **Vehicle Nitro / Boost** | `Shift` (up to 200 km/h) |
| **Interact / Enter Vehicle** | `E` |
| **Camera Mode** | `V` (Normal, Action, Panorama, Cockpit) |
| **Pet Trick / Emote** | `F` |
| **Toggle Vehicle Lights** | `L` |
| **Mouse Look** | Right-click drag or click canvas for Pointer Lock (`ESC` to release) |
| **Chat** | `Enter` to open/send, `ESC` to close |

### Touch & Mobile
- Virtual joystick on bottom-left for walking and steering.
- On-screen touch buttons for jumping, accelerating, reversing, handbraking, interactions, and camera toggle.

---

## Testing & Verification

Run all test suites from repository root:

```sh
# Frontend unit tests (141+ tests across 9 test suites)
bun test

# Backend integration and protocol tests with Go race detector
go test -mod=vendor -race ./...

# Static analysis
go vet -mod=vendor ./...
```

---

## Standalone 3D Map & Model Editor

Nabka includes a visual 3D editor for landmarks, vehicles, props, and world colliders:

```sh
# Start editor server on localhost:8090
bun editor/server.js

# Export all Blockbench models to binary .glb
bun editor/server.js --export-models
```
Open [http://localhost:8090/editor/index.html](http://localhost:8090/editor/index.html). *(The editor is standalone and excluded from production Docker builds.)*

---

## License

This project is licensed under the [MIT License](LICENSE).
