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
- **To the newly connected client**: Contains the authoritative `token`.
- **To other clients**: `token` is omitted for security.

```json
{
  "type": "join",
  "user": "vasya",
  "token": "4f8a12bc...",
  "roster": ["vasya", "dunya"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | `"join"` |
| `user` | `string` | The registered username |
| `token` | `string` | *(Optional, sent only to the newcomer)* Unique session token for reconnections |
| `roster` | `[]string` | *(Optional, sent only to the newcomer)* Current online roster for reconciliation |

---

### 3.2. Initial World State Synchronization (Server -> Newly Joined Client)

Immediately following the `join` broadcast, the server synchronizes the current world state by transmitting tracked vehicle and player positions directly to the newly joined client:

1. **Tracked Vehicles**: For each vehicle that has been moved or driven in the world, the server sends a driving movement message (`mode: "driving"`, `car_id`, `x`, `y`, `z`, `yaw`, `speed`, `drift`, `lights`):
   - **Parked vehicle**: `username` is empty (`""`), `speed` is `0`, and `drift` is `false`. The client updates the parked vehicle's world transform without attaching a remote driver.
   - **Occupied vehicle**: `username` contains the active driver's username.
2. **Active Players**: For each other connected client, their last known state is transmitted:
   - **Pedestrian**: Outbound pedestrian movement message (`mode: "pedestrian"`, `anim`, `vx`, `vz`, `yaw`, etc.).
   - **Driving**: Outbound driving movement message (`mode: "driving"`, `car_id`, etc.).

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
| `anim` | `string` | Yes | Animation state: `"idle"`, `"walk"`, `"run"`, `"jump"`, or `"emote"` |

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
100 ms. Long gaps and teleports reset history. Remote cars act as kinematic
obstacles in local collision resolution: local bodies respond, remote poses and
velocities are never modified. This remains client-driven vehicle simulation;
server-authoritative collision outcomes are not implemented by this change.

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
| `speed` | `float64` | Yes | Current speed (m/s or km/h) |
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

