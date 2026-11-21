# Nabka Multiplayer WebSocket Server API

High-performance WebSocket backend for real-time multiplayer browser games built in Go with `fasthttp`, `fasthttp/websocket`, and MessagePack (`msgpack`).

## 1. Connection & Authentication

- **Endpoint**: `/ws`
- **Browser default**: The page's origin, using `ws` for HTTP and `wss` for HTTPS. Opening `http://localhost:8080/` connects to `ws://localhost:8080/ws` without needing `?localhost=true`. Pages opened directly via `file:` fall back to the public server.
- **Protocol**: WebSocket (`ws://` or `wss://`)
- **Payload Format**: Binary MessagePack (`msgpack`)
- **CORS**: All origins allowed (`*`)

### Handshake & Registration

Clients can register their username in one of two ways:

#### Option A: URL Query Parameter (Recommended)
Connect directly with the username (and optional session token for reconnecting) in the connection URL:
```
ws://localhost:8080/ws?username=vasya
ws://localhost:8080/ws?username=vasya&token=4f8a12bc...
```
- If the username is valid and available (or matching the active session token), the connection is upgraded.
- If the username query parameter is provided but invalid (e.g. whitespace, control characters, >32 chars): HTTP `400 Bad Request`.
- If the username is already connected by another player (or token mismatch): WebSocket close code `4409` with reason `"username already taken"`.
- If the username has an active connection and the provided `token` matches the session token, the server atomically replaces the old connection without 4409 error and preserves the player's world/vehicle state. The old connection is closed with WebSocket close code `4408` and reason `"session replaced from another connection"`, which instructs the replaced client to stop auto-reconnecting.

#### Option B: Initial Binary Message
Connect to `/ws` without query parameters. The connection upgrades, and the client must immediately send a registration message within 5 seconds:
```json
{
  "type": "register",
  "username": "vasya",
  "token": "4f8a12bc..."
}
```
*(Encoded as MsgPack map; `token` is optional)*
- If registration succeeds, the client receives its own join message containing its unique session token.
- If registration message is not sent within 5 seconds, malformed, or invalid: the socket is closed.
- If the username is already connected by another player (or token mismatch): WebSocket close code `4409` with reason `"username already taken"`.
- If the username has an active connection and the provided `token` matches the session token, the server atomically replaces the old connection without 4409 error. The replaced client is sent close code `4408` (`"session replaced from another connection"`).

### Session Tokens & Reconnection
- **Token Issuance**: When a user connects, the server assigns a cryptographically unique session token transmitted directly in the user's `join` event (`token` field).
- **Privacy**: The session token is sent only to the authenticated user and is stripped from join broadcasts sent to other players.
- **Roster Baseline**: The newcomer's `join` event also delivers `roster` (a list of currently online usernames) directly to the user to synchronize client rosters and prune remote avatars that departed during network hiccups.
- **Seamless Reconnect**: If a client connection drops (network hiccup, sleep/wake, tab reload), the client immediately attempts automatic reconnection providing its saved session token. The server recognizes the token, closes the dangling connection with code `4408`, and restores the session without locking the username for 30s.
- **Session Lifetime (TTL)**: Disconnected sessions are retained on the server for 5 minutes of inactivity (`sessionTTL`). If a player reconnects within 5 minutes, their token reclaims the session. After 5 minutes, inactive session tokens expire and the username is freed for any newcomer.

### Username Rules
- Length: 1–32 characters
- UTF-8 encoded (supports Latin, Cyrillic, etc.)
- Stripped of leading/trailing whitespace
- Control characters (ASCII < 32 or 127) are rejected
- Duplicate active usernames without matching session tokens are strictly rejected

---

## 2. Connection Liveness

- **Deadline**: 30 seconds without a valid application message or WebSocket protocol pong (configured by `InactivityTimeout`). This checks connection health, not player activity; idle players with healthy connections stay connected.
- **Server Heartbeat**: The server sends WebSocket protocol pings every one-third of the deadline (10 seconds by default). Browser network stacks automatically return pongs, even when game rendering or JavaScript heartbeat timers are paused or throttled. Each pong refreshes the deadline.
- **Application Activity & Heartbeat**: Browser clients send MessagePack `{"type": "ping"}` every 8 seconds when active, and re-ping immediately upon window focus/visibility restoration. Any incoming WebSocket frame resets the server's read deadline.
- **Broadcast on Timeout**: Remaining clients receive a leave broadcast with the legacy reason `"kicked for 30s inactivity"`. This denotes failed connection liveness, not an AFK policy.
- **Reconnection**: The username is freed for reconnection upon timeout or disconnect, and can be reclaimed immediately with the session token even before the timeout expires.

For disconnect diagnosis, expand **Детали соединения** in the browser's login error to see the WebSocket close code, reason, and endpoint. Server logs record `WebSocket connection ended` with the first failing read/write operation and its underlying error. Code `1006` means no close frame was received; by itself it does not establish an inactivity timeout.

---

## 3. Message Specifications (MessagePack)

All messages are encoded as MessagePack maps (`fixmap` / `map`).

### 3.1. Join Event (Server -> Clients)

Broadcast upon successful registration:
- **To the newly connected client**: Contains the authoritative `token`, `roster`, and `money`.
- **To other clients**: `token`, `roster`, and `money` are omitted for security and privacy.

```json
{
  "type": "join",
  "user": "vasya",
  "token": "4f8a12bc...",
  "roster": ["vasya", "dunya"],
  "money": 125400
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | `"join"` |
| `user` | `string` | The registered username |
| `token` | `string` | *(Optional, sent only to the newcomer)* Unique session token for reconnections |
| `roster` | `[]string` | *(Optional, sent only to the newcomer)* Current online roster for reconciliation |
| `money` | `int64` | *(Optional, sent only to the newcomer; always present on self-join including `0` or negative)* Authoritative wallet balance (default `125400`, negative allowed) |

---

### 3.2. Initial World State Synchronization (Server -> Newly Joined Client)

Immediately following the `join` broadcast, the server synchronizes the current world state by transmitting tracked vehicle, player, and police state directly to the newly joined client in order:

1. **Tracked Vehicles**: For each vehicle that has been moved or driven in the world, the server sends a driving movement message (`mode: "driving"`, `car_id`, `x`, `y`, `z`, `yaw`, `speed`, `drift`, `lights`):
   - **Parked vehicle**: `username` is empty (`""`), `speed` is `0`, and `drift` is `false`. The client updates the parked vehicle's world transform without attaching a remote driver.
   - **Occupied vehicle**: `username` contains the active driver's username.
2. **Active Players**: For each other connected client, their last known state is transmitted:
   - **Pedestrian**: Outbound pedestrian movement message (`mode: "pedestrian"`, `anim`, `vx`, `vz`, `yaw`, etc.).
   - **Driving**: Outbound driving movement message (`mode: "driving"`, `car_id`, etc.).
3. **Police World State**: A `police_state` snapshot containing current `foot_cops` and `police_cars` positions, velocities, states, and siren/light states.
4. **Active Police Encounter (Reconnect / `4408` replacement)**: If the reconnecting player has an unresolved `police_encounter_start`, the server re-sends it immediately after `police_state`.

Vehicles that have not been moved remain at their default client-side spawn positions.

---

### 3.3. Leave Event (Server -> Remaining Clients)

Broadcast to all remaining clients when a user disconnects or is evicted:

```json
{
  "type": "leave",
  "user": "vasya",
  "reason": "left"
}
```

```json
{
  "type": "leave",
  "user": "vasya",
  "reason": "kicked for 30s inactivity"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | `"leave"` |
| `user` | `string` | The departing username |
| `reason` | `string` | `"left"`, `"kicked for 30s inactivity"`, or `"slow consumer"` |

---

### 3.4. Pedestrian Movement (15–20 Hz)

Sent by clients to synchronize character position, velocity, orientation, and animation state for 60 FPS client-side dead-reckoning.

#### Inbound (Client -> Server):
```json
{
  "type": "move",
  "mode": "pedestrian",
  "x": 0.5,
  "y": 0.0,
  "z": 18.2,
  "vx": 0.0,
  "vz": 8.2,
  "yaw": 3.14,
  "anim": "run"
}
```

#### Outbound (Server -> All other clients):
```json
{
  "username": "vasya",
  "type": "move",
  "mode": "pedestrian",
  "x": 0.5,
  "y": 0.0,
  "z": 18.2,
  "vx": 0.0,
  "vz": 8.2,
  "yaw": 3.14,
  "anim": "run"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | `string` | Server only | Enforced by the server from connection identity |
| `type` | `string` | Yes | `"move"` |
| `mode` | `string` | Yes | `"pedestrian"` |
| `x` | `float64` | Yes | World X position (finite number) |
| `y` | `float64` | Yes | World Y position (elevation, finite number) |
| `z` | `float64` | Yes | World Z position (finite number) |
| `vx` | `float64` | No | Velocity along X axis (for dead-reckoning) |
| `vz` | `float64` | No | Velocity along Z axis (for dead-reckoning) |
| `yaw` | `float64` | Yes | Heading/rotation angle in radians (finite number) |
| `anim` | `string` | Yes | Animation state: `"idle"`, `"walk"`, `"run"`, `"jump"`, `"swim"`, or `"emote"` |

---

### 3.5. Driving Movement (15–20 Hz)

Driving messages additionally carry `vx`, `vz` (world-space units/second) and
`yaw_rate` (radians/second). Heading is measured from +Z toward +X; velocity is
independent of heading during a drift. All three fields must be finite numbers.
They are optional inbound during migration: missing velocity components are
inferred from heading and signed forward `speed`; missing yaw rate is zero.
Outbound driving messages always include them, including zero values.

The hub assigns accepted driving updates a global increasing `sequence` (uint64)
and `sample_time_ms` (float64 milliseconds since this server world's creation).
Client-supplied sequence/timing is ignored. Baselines and occupancy rejection
responses retain the stored update's metadata; parking retains that metadata but
sets all velocities and speed to zero and clears the driver. These counters reset
on server restart; clients clear snapshot history on reconnect or ownership change.
Parking is a lifecycle transition, applied immediately in WebSocket order, rather
than an interpolated driving sample. Duplicate/out-of-order driving samples are
ignored within a driver's stream.

Local physics runs at 60 Hz and renders between its previous/current poses (up to
one simulation tick of presentation delay). Outgoing snapshots use simulation
coordinates, not the interpolated mesh. Remote cars render 100 ms behind the
server sample timeline; extrapolation uses world velocity/yaw rate and stops after
100 ms. Long gaps and teleports reset history. Remote player cars act as kinematic
obstacles in local collision resolution; police cars (`4200 kg` mass vs `1280–1560 kg`
standard player cars) are simulated authoritatively by the server and broadcast
`vehicle_impulse` velocity/yaw deflections upon 3-circle vehicle collisions. Client
attempts to drive any `police_car*` ID via `mode: "driving"` are rejected with an
`error` message (`op: "move"`).

Older clients ignore extra outbound fields. New clients can use arrival timestamps
and heading-based velocity for older servers. Remove these migration fallbacks
only with a coordinated protocol-version bump requiring the new motion fields.


Sent by clients to synchronize vehicle telemetry, visual state, and world position.

#### Inbound (Client -> Server):
```json
{
  "type": "move",
  "mode": "driving",
  "car_id": "car_0",
  "x": 19.5,
  "y": 0.02,
  "z": 14.0,
  "speed": 22.4,
  "yaw": 1.57,
  "drift": true,
  "lights": true
}
```

#### Outbound (Server -> All other clients):
```json
{
  "username": "vasya",
  "type": "move",
  "mode": "driving",
  "car_id": "car_0",
  "x": 19.5,
  "y": 0.02,
  "z": 14.0,
  "speed": 22.4,
  "yaw": 1.57,
  "drift": true,
  "lights": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | `string` | Server only | Enforced by the server from connection identity |
| `type` | `string` | Yes | `"move"` |
| `mode` | `string` | Yes | `"driving"` |
| `car_id` | `string` | Yes | Unique identifier of the vehicle being driven |
| `x` | `float64` | Yes | World X position |
| `y` | `float64` | Yes | World Y position |
| `z` | `float64` | Yes | World Z position |
| `speed` | `float64` | Yes | Current forward speed in **m/s** (`km/h = |speed| * 3.6`; police speeding threshold `40 km/h = 11.1111... m/s`) |
| `yaw` | `float64` | Yes | Vehicle yaw angle in radians |
| `drift` | `bool` | Yes | Whether tire smoke / drift particles should trigger |
| `lights` | `bool` | Yes | Headlights active state |

---

### 3.6. Chat Messages

#### Inbound (Client -> Server):
```json
{
  "type": "chat",
  "text": "Го дрифтить у фонтана!"
}
```

#### Outbound (Server -> All clients, including sender):
```json
{
  "username": "vasya",
  "type": "chat",
  "from": "vasya",
  "text": "Го дрифтить у фонтана!"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `username` | `string` | Verified sender username |
| `type` | `string` | `"chat"` |
| `from` | `string` | Verified sender username (for speech bubble anchoring) |
| `text` | `string` | Valid UTF-8 chat message (1–500 characters, whitespace-trimmed) |

*Security & Rendering Note: Chat text is validated, whitespace-trimmed, and forwarded as plain text. Browser clients must render chat using safe DOM properties such as `element.textContent` or framework text bindings (e.g. React/Vue text nodes) rather than `innerHTML` to prevent Cross-Site Scripting (XSS).*

*Broadcast Scope: Chat messages are sent to all clients (including the sender) so the sender displays confirmed speech bubbles and chat history with matching server-validated attribution.*

---

### 3.7. Error Message (Server -> Client)

Delivered directly to a client when a recoverable validation or protocol error occurs:

```json
{
  "type": "error",
  "message": "invalid anim \"fly\": must be idle, walk, run, jump, or emote"
}
```

---

### 3.8. Ping & Pong Keepalive (Bidirectional)

Used by active browser clients to maintain continuous connection while the tab is open:

```json
{
  "type": "ping"
}
```

Server replies with:
```json
{
  "type": "pong"
}
```

Receiving `ping` refreshes the 30-second application inactivity deadline on the server.

---

### 3.9. Cannon Events

#### Inbound: Cannon Fire Request (Client -> Server)
Sent by a client to fire the ceremonial artillery gun at Vladivostok Fortress:
```json
{
  "type": "cannon_fire"
}
```
Validation rules:
- Sender connection must be registered.
- Sender must have established an authoritative pedestrian world position (`mode: "pedestrian"`); driving clients cannot fire.
- Distance from player position to Vladivostok Fortress (`(127.87, -124.43)`) must be within the interaction tolerance ($\le 7.5\text{ m}$, based on the map's $6.0\text{ m}$ radius).
- Cooldown: 2 seconds per player account (retained across reconnections and connection replacements).
- If rejected, server replies directly with `type: "error"`.

*Scope note: The server validates physical presence, mode, and rate limiting, but clients own their quest progression. Ability consumption is confirmed upon receiving the matching outbound event.*

#### Outbound: Cannon Shot Event (Server -> All Clients)
Broadcast when a cannon shot is confirmed, or at daily noon:
```json
{
  "type": "cannon_shot",
  "user": "vasya",
  "reason": "fortress"
}
```
| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | `"cannon_shot"` |
| `user` | `string` | *(Optional)* Username of the player who fired, or empty string for server-scheduled events |
| `reason` | `string` | `"fortress"` (player fired fortress cannon) or `"noon"` (12:00 Vladivostok tradition) |

- When `reason === "fortress"`: all connected clients hear the cannon sound and experience camera shake. The firing player reconciles their one-time quest ability and displays celebration speech/toast. Other players see attribution toast/chat.
- When `reason === "noon"`: the server broadcasts at exactly 12:00 Vladivostok time (02:00:00 UTC) with a 60-second grace window on restart. All connected clients play the cannon sound and display the traditional noon announcement.

---

### 3.10. Police Simulation, Encounters, Chases & Economy

The server runs a fixed-timestep (`20 Hz`, `dt = 0.05s`) authoritative police simulation governing foot policemen (`cop_0..cop_3`), police patrol cars (`police_car_0`, `police_car_1`), speeding chases (`> 40 km/h` = `40 / 3.6` m/s), 3-circle heavy vehicle collisions (`4200 kg` police car mass), unsolicited Russian-language encounters, and persistent per-session player wallets (`accounts`, default `125400`, negative `int64` balances allowed).

#### Balance Update (`balance_update`, Server -> Clients)
Broadcast whenever a player's authoritative wallet changes (e.g., dialogue fine or speeding ticket):
```json
{
  "type": "balance_update",
  "username": "vasya",
  "money": -2600,
  "delta": -5000,
  "reason": "speeding_fine",
  "source_id": "police_car_0"
}
```
| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | `"balance_update"` |
| `username` | `string` | Target player username |
| `money` | `int64` | New authoritative balance (always serialized, including `0` and negative values) |
| `delta` | `int64` | Signed balance change (negative for fines; always serialized) |
| `reason` | `string` | Change reason (`"police_fine"`, `"speeding_fine"`) |
| `source_id` | `string` | *(Optional)* Originating cop or police car ID |

#### Police World State (`police_state`, Server -> Clients)
Sent on join baseline and broadcast at `20 Hz` to all connected clients:
```json
{
  "type": "police_state",
  "sequence": 42,
  "sample_time_ms": 2100,
  "foot_cops": [
    {
      "id": "cop_0",
      "name": "Сержант ППС Дробышев",
      "x": -5.0,
      "y": 0.0,
      "z": 5.0,
      "vx": 0.0,
      "vz": -1.6,
      "yaw": 3.14159,
      "state": "patrol",
      "anim": "walk",
      "target_user": ""
    }
  ],
  "police_cars": [
    {
      "id": "police_car_0",
      "x": 23.0,
      "y": 0.0,
      "z": 10.0,
      "vx": 0.0,
      "vz": 9.0,
      "yaw": 0.0,
      "yaw_rate": 0.0,
      "speed": 9.0,
      "mass": 4200.0,
      "state": "patrol",
      "target_car_id": "",
      "target_user": "",
      "siren": false,
      "lights": false
    }
  ]
}
```
- `foot_cops[].state`: `"patrol" | "approach" | "dialogue" | "cooldown"`
- `police_cars[].state`: `"patrol" | "chase" | "cooldown"`
- `foot_cops` and `police_cars` are always encoded as MsgPack arrays (never `null`). All numeric and boolean fields are always present.

#### Unsolicited Police Encounter Start (`police_encounter_start`, Server -> Target Client)
Sent directly to `target_user` when an approaching foot policeman reaches talking distance (`<= 2.4 m`), and re-sent on `4408` connection replacement if still unresolved:
```json
{
  "type": "police_encounter_start",
  "encounter_id": "enc_1",
  "cop_id": "cop_0",
  "cop_name": "Сержант ППС Дробышев",
  "scenario_id": "weed_shakedown",
  "title": "Личный досмотр у набережной",
  "opening": "Так, гражданин, стоять, руки из карманов! ...",
  "options": [
    { "index": 0, "text": "...", "fine": 5000 },
    { "index": 1, "text": "...", "fine": 3500 },
    { "index": 2, "text": "...", "fine": 8000 }
  ],
  "target_user": "vasya"
}
```

#### Police Dialogue Choice (`police_dialogue_choice`, Client -> Server)
Sent by the target player to select an option in an active encounter:
```json
{
  "type": "police_dialogue_choice",
  "encounter_id": "enc_1",
  "option_index": 0
}
```
Validation rules:
- Must be a MsgPack map with no trailing bytes and `type == "police_dialogue_choice"`.
- `encounter_id`: required valid UTF-8 string, whitespace-trimmed length `1..64` runes, no ASCII control characters (`< 32` or `127`).
- `option_index`: required integer in `0..15` (fixint-safe in `msgpack.js`), and must be a valid option index for the active scenario.
- Connection identity (`c.Username`) must match `encounter.target_user`. Invalid/unauthorized requests return `type: "error"` with `op: "police_dialogue_choice"` without mutating state.

#### Police Encounter Result (`police_encounter_result`, Server -> Clients)
Broadcast upon valid choice resolution:
```json
{
  "type": "police_encounter_result",
  "encounter_id": "enc_1",
  "cop_id": "cop_0",
  "cop_name": "Сержант ППС Дробышев",
  "scenario_id": "weed_shakedown",
  "target_user": "vasya",
  "option_index": 0,
  "reply_text": "...",
  "fine": 5000,
  "money": 120400
}
```

#### Police Chase Event (`police_chase`, Server -> Clients)
Broadcast when a patrolling police car starts a chase (`max(|speed|, hypot(vx, vz)) > 40 / 3.6` m/s within `45 m`), stops & fines the target (`dist <= 7.5 m` and `speed <= 3.0 m/s` sustained `0.5s`, fine `5000`), or ends in evasion (`dist > 90 m` for `5s`, `45s` max duration, target exits vehicle, or disconnects):
```json
{
  "type": "police_chase",
  "police_car_id": "police_car_0",
  "target_car_id": "car_0",
  "target_user": "vasya",
  "status": "stopped",
  "reason": "fined",
  "fine": 5000,
  "money": -2600
}
```
- `status`: `"started" | "stopped" | "evaded"`

#### Vehicle Impulse (`vehicle_impulse`, Server -> Clients)
Broadcast when a 3-circle heavy rigid-body collision (`4200 kg` police car vs `1280–1560 kg` player car) produces a non-trivial velocity or angular-velocity deflection (subject to a `300 ms` per-pair cooldown):
```json
{
  "type": "vehicle_impulse",
  "police_car_id": "police_car_0",
  "car_id": "car_0",
  "target_user": "vasya",
  "dvx": -8.4,
  "dvz": 2.1,
  "dyaw_rate": 0.45,
  "police_mass": 4200.0,
  "player_mass": 1470.0,
  "sequence": 128
}
```

#### Server-Reserved Message Types
Clients are strictly prohibited from sending server-originated message types. Sending any of `join`, `leave`, `cannon_shot`, `balance_update`, `police_state`, `police_encounter_start`, `police_encounter_result`, `police_chase`, or `vehicle_impulse` from a client returns `type: "error"` containing `"server reserved"` without mutating world state.

#### Non-Driveable Police Vehicles
Police car IDs (`police_car_*`) are excluded from `world_map.json` `vehicles[]` and `Hub.allowedCars`. Any client `move` (`mode: "driving"`) targeting `police_car*` is rejected with `type: "error"` (`op: "move"`, `"cannot drive police vehicle"`).

---

## 4. HTTP Static File Server & Versioning

The server embeds all assets in the `static/` directory directly into the compiled Go binary using Go standard library `embed.FS` (`//go:embed all:static`), requiring zero external filesystem assets at runtime.

- **Root Endpoint**: `GET /` automatically serves `static/index.html`.
- **Direct Asset Requests**: Any file under `static/` is served at its relative path (e.g., `GET /index.html`, `GET /css/...`, `GET /js/...`).
- **Favicons**: Serves `GET /favicon.ico` (`image/x-icon`) and `GET /favicon.svg` (`image/svg+xml`).
- **Audio Assets**: Serves `GET /audio/*.mp3` (`audio/mpeg`) with `Accept-Ranges: bytes` supporting streaming and Web Audio decoding for Nabka ambience loops, randomized short/long seagull calls, and throttle engine sounds.
- **Service Worker Neutralizer**: Serves `GET /sw.js` (`application/javascript`) with self-unregistering logic to immediately purge legacy caches in users' browsers.
- **Version Endpoint**: `GET /api/version` (or `/version`) returns JSON `{"version": "<build-id>", "status": "ok"}` used for client auto-update checks.
- **Cache-Control & Anti-Staleness**: All static endpoints send aggressive anti-caching headers (`Cache-Control: no-cache, no-store, must-revalidate, max-age=0, s-maxage=0`, `Pragma: no-cache`, `Expires: 0`, `CDN-Cache-Control: no-store`, `Cloudflare-CDN-Cache-Control: no-store`, `X-Nabka-Version: <build-id>`) while stripping `Last-Modified` and `ETag` to prevent heuristic stale caching across reverse proxies, CDNs, and browsers after image deployments.
- **HTTP Methods**: Supports `GET` and `HEAD`.
- **Byte Ranges**: Supports `Accept-Ranges: bytes` with `206 Partial Content` responses.
- **Content Types**: Standard MIME types (e.g., `text/html; charset=utf-8` for HTML, `image/x-icon` for `.ico`, `audio/mpeg` for `.mp3`) are automatically inferred and populated.
- **Routing**: Requests to `/ws` are routed to the WebSocket upgrader; `/api/version` returns build metadata; all other paths are handled by the embedded static file server. Nonexistent paths return HTTP `404 Not Found`.

