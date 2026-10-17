# Nabka agent guide

## Project purpose

Nabka is a work-in-progress multiplayer browser game set on Sportivnaya Embankment in Vladivostok. Its identity includes a recognizable waterfront, Russian-language local flavor, third-person exploration, right-hand-drive Japanese cars, and desktop and touch controls.

The development direction is a consistent shared world managed by a stateful Go backend and a modular, testable browser frontend. Apply these principles to the work in scope; this guide is not a request to implement every architectural change at once.

## Repository navigation

- `cmd/server/main.go`: executable entry point, environment configuration, and process lifecycle.
- `pkg/game/server.go`: HTTP routing, WebSocket registration, server configuration, and shutdown.
- `pkg/game/client.go`: connection reads and writes, message handling, and connection lifecycle.
- `pkg/game/hub.go`: multiplayer coordination and state access.
- `pkg/game/types.go`: MessagePack types, parsing, and validation.
- `pkg/game/messages_test.go` and `pkg/game/server_test.go`: protocol validation and server integration tests.
- `static/`: browser application and assets; `static/index.html` is the page entry point.
  - `static/css/`: stylesheets (`main.css`, `tailwind.css`).
  - `static/data/`: shared world map (`world_map.json`) and NPC dialogue data (`npc_dialogues.json`).
  - `static/js/`: ES modules (`main.js`, `msgpack.js`, `physics.js`, `state.js`, `network.js`, `world.js`, `entities.js`, `ui.js`, `input.js`, `audio.js`, `textures.js`).
  - `static/tests/`: Bun unit tests (`*.test.js`).
- `static.go` and `static_test.go`: embedded browser assets and their tests.
- `API.md`: wire protocol documentation; update it with protocol changes.
- `go.mod`, `go.sum`, and `vendor/`: Go toolchain and dependencies.
- `Dockerfile`: multi-stage offline build (`-mod=vendor`) and minimal `FROM scratch` runtime packaging.

`vladivostok_nabka_multiplayer_project_context.md` provides background about the setting and gameplay. Use the code and tests to establish actual behavior, and this guide to direct architectural decisions. Background descriptions are not requirements to preserve an implementation. Keep this guide accurate as files and responsibilities change.

## Shared-world ownership

- The server is authoritative for gameplay state and rules. Clients send intent or requests; the server validates them, applies accepted transitions, and publishes the resulting state.
- Give shared entities stable IDs. Define their initial state and lifecycle on the server, including creation, ownership, updates, and removal.
- Keep gameplay-relevant world definitions, spawn data, and collision rules consistent between server simulation and client presentation. Use an explicit shared data contract where both sides need the same definitions.
- Make state transitions atomic within the world owner. Vehicle entry, exit, and transfer must enforce exclusive occupancy and leave player and vehicle state consistent.
- Joining and reconnecting must establish a complete authoritative baseline, then apply ordered updates. A newcomer must see the same world as existing players without depending on another player taking an action.
- Make snapshot and update ordering explicit, using sequence numbers, ticks, or another documented mechanism when necessary. Handle stale updates and entity removal consistently.
- Cover voluntary disconnects, timeouts, slow consumers, and shutdown with consistent cleanup rules. An old connection must not remove or mutate a replacement session.
- Keep camera, input preferences, interface state, and cosmetic effects in the browser. Prediction and interpolation may improve responsiveness, but must reconcile with authoritative state and must not decide gameplay outcomes.
- Track moved entities (vehicles and players) in the server world state. When a player leaves a vehicle or disconnects, transition the vehicle to parked (`driver = ""`, `speed = 0`) at its current coordinates so subsequent joiners see its persistent location.
- Document the lifetime of server state. In-memory authority does not imply persistence across process restarts; add durable storage only when the task requires it.

## Backend design

- Separate world simulation and game rules from WebSocket transport, serialization, and HTTP serving. Keep domain transitions testable without opening a socket.
- Establish clear ownership of mutable state. Route mutations through the owning loop or a documented synchronization boundary; expose copies or immutable snapshots to readers.
- Keep network writes and other blocking I/O outside the world update path. Bound queues and define backpressure behavior, including recovery when a client cannot receive a complete baseline or required update.
- Use explicit time steps and injectable clocks or random sources for simulation that depends on time or randomness. Keep domain behavior reproducible in tests.
- Treat client messages as untrusted. Validate message shape, size, numeric finiteness, bounds, entity existence, action permissions, and legal transitions before mutating state.
- Derive player identity from the registered connection. A display name is not proof of account ownership; do not trust identity fields supplied in gameplay messages.
- Maintain clear cancellation, channel ownership, and shutdown behavior. Avoid goroutine leaks, duplicate cleanup, and sends to closed channels.

## Frontend design

- Organize JavaScript into modules with explicit imports and exports and focused responsibilities. Useful boundaries include protocol encoding, connection lifecycle, replicated state, input, rendering, camera, audio, and interface components.
- Keep the application entry point focused on composition and startup. Keep HTML and CSS focused on structure and presentation.
- Keep protocol decoding and state transitions independent of Three.js and DOM objects. Render the client state through adapters so state behavior can be tested without WebGL.
- Prefer small functions and explicit dependencies to ambient globals and cross-module mutation. Extract cohesive responsibilities rather than splitting files solely by line count.
- Keep world data and gameplay configuration separate from rendering code. Define coordinate conventions, units, and entity identifiers wherever they cross module or protocol boundaries.
- Manage event listeners, timers, sockets, audio resources, and GPU resources through explicit setup and disposal. Reconnects and repeated initialization must not duplicate work.
- Maintain keyboard, pointer, and touch usability. Chat and modal focus must prevent unintended gameplay input; simultaneous touch actions must remain independent.
- Keep endpoint selection configurable and support connecting the locally served browser application to the local server. Account for `ws` versus `wss` when deriving a same-origin endpoint.
- All frontend assets must reside inside `static/` and be embeddable via `embed.FS` (`static.go`). Modularized JS and assets must use paths resolvable by the embedded HTTP file server.
- Choose additional frontend tooling to meet concrete development and testing needs. Document reproducible commands and ensure browser assets are available to Go embedding and container builds.

## Protocol and rendering safety

- The transport uses binary WebSocket MessagePack messages. Change protocol types, browser encoding/decoding, server handling, tests, and `API.md` together.
- Make cross-language field names, optional fields, numeric representations, units, and ordering semantics explicit. Test JavaScript/Go interoperability, including zero values and Unicode.
- Define recovery behavior for invalid messages, lost connections, rejected actions, and incompatible protocol versions. Coordinate breaking changes between client and server; document any temporary compatibility path and its removal condition.
- Render usernames, chat, and other untrusted text with `textContent` or equivalent text bindings.
- Keep connection liveness and gameplay activity semantics explicit and consistent across server, browser, and documentation.

## Development and validation

Run commands from the repository root. Use the Go version declared in `go.mod`; dependencies are vendored. Frontend unit tests use `bun test` (without `npm` or `node_modules`).

```sh
go run -mod=vendor ./cmd/server
go test -mod=vendor ./...
go test -mod=vendor -race ./...
go vet -mod=vendor ./...
bun test
go build -mod=vendor -o /tmp/nabka-server ./cmd/server
docker build -t nabka:latest .
docker save nabka:latest | gzip > nabka.tar.gz
```

The server defaults to port `8080`; set `PORT` to override it. Open `http://localhost:8080/` for the application and use `/ws` for its WebSocket endpoint. Browser assets are embedded at Go compile time, so restart/rebuild the Go program after changing them. Container builds must rely exclusively on vendored dependencies (`-mod=vendor`) without network access in the build stage.

- Format changed Go files with `gofmt`. Run relevant tests for each change; run the race detector for concurrency or state-ownership changes and build checks for packaging changes.
- Add focused tests for game rules and state transitions. Use controlled time and randomness; prefer synchronization and bounded deadlines over arbitrary sleeps.
- Test multiplayer behavior with multiple clients: a late join after world changes, reconnect, conflicting actions on one entity, rejected input without state mutation, and cleanup after disconnect or eviction.
- For synchronization changes, assert that clients converge on authoritative state and that baseline/update ordering cannot lose a transition.
- Add frontend tests alongside extracted logic and new behavior. Prioritize codec interoperability, replicated-state updates, connection lifecycle, and input handling. Document the chosen runner and commands when introducing them.
- When adding browser modules or assets, verify that their URLs, MIME types, and imports work through the embedded HTTP server and that missing paths return appropriate errors.
- For user-visible gameplay changes, smoke-test two independent browser sessions against a local server, including relevant keyboard and touch interactions. State clearly when browser checks were unavailable.

## Working practices

- Inspect the relevant code, tests, and working tree before editing. Preserve unrelated work and local artifacts.
- Keep changes scoped and reviewable. When moving code, distinguish extraction from intentional behavior changes and cover the resulting boundaries with meaningful tests.
- Update documentation when behavior, layout, commands, or protocol contracts change. Tests should encode intended behavior and invariants.
- Update dependencies through their manifests and regenerate vendored content as needed; do not hand-edit third-party source. Keep generated binaries, logs, and archives out of source changes.
- Report what changed, the checks actually run, and any remaining limitations. Distinguish architectural targets from behavior already implemented.
