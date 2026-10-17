# Nabka Multiplayer WebSocket Server API

High-performance WebSocket backend for real-time multiplayer browser games built in Go with `fasthttp`, `fasthttp/websocket`, and MessagePack (`msgpack`).

## 1. Connection & Authentication

- **Endpoint**: `/ws`
- **Protocol**: WebSocket (`ws://` or `wss://`)
- **Payload Format**: Binary MessagePack (`msgpack`)
- **CORS**: All origins allowed (`*`)

### Handshake & Registration

Clients can register their username in one of two ways:

#### Option A: URL Query Parameter (Recommended)
Connect directly with the username in the connection URL:
```
ws://localhost:8080/ws?username=vasya
```
- If the username is valid and available, the connection is upgraded.
- If the username query parameter is provided but invalid (e.g. whitespace, control characters, >32 chars): HTTP `400 Bad Request`.
- If the username is already connected: WebSocket close code `4409` with reason `"username already taken"`.

#### Option B: Initial Binary Message
Connect to `/ws` without query parameters. The connection upgrades, and the client must immediately send a registration message within 5 seconds:
```json
{
  "type": "register",
  "username": "vasya"
}
```
*(Encoded as MsgPack map)*
- If registration succeeds, the client receives its own join broadcast.
- If registration message is not sent within 5 seconds, malformed, or invalid: the socket is closed.
- If the username is already connected: WebSocket close code `4409` with reason `"username already taken"`.

### Username Rules
- Length: 1–32 characters
- UTF-8 encoded (supports Latin, Cyrillic, etc.)
- Stripped of leading/trailing whitespace
- Control characters (ASCII < 32 or 127) are rejected
- Duplicate active usernames are strictly rejected

---

## 2. Inactivity Timeout

- **Deadline**: 30 seconds of inactivity.
- **Rule**: A client is kicked if it does not send a valid application message (`move`, `chat`, or `ping`) within 30 seconds.
- **Heartbeat Ping**: Active browser clients send an application-level `{"type": "ping"}` every 10 seconds while the page tab is open, refreshing the 30-second deadline. The server responds with `{"type": "pong"}`.
- **Protocol Frames**: WebSocket protocol-level Ping/Pong frames do **not** refresh the 30-second application inactivity deadline to prevent idling clients from staying connected indefinitely.
- **Broadcast on Kick**: Remaining clients receive a leave broadcast with reason `"kicked for 30s inactivity"`.
- **Reconnection**: The username is immediately freed for reconnection upon timeout or disconnect.

---

## 3. Message Specifications (MessagePack)

All messages are encoded as MessagePack maps (`fixmap` / `map`).

### 3.1. Join Event (Server -> Clients)

Broadcast to all connected clients (including the newcomer) upon successful registration:

```json
{
  "type": "join",
  "user": "vasya"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | `"join"` |
| `user` | `string` | The registered username |

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

## 4. HTTP Static File Server

The server embeds all assets in the `static/` directory directly into the compiled Go binary using Go standard library `embed.FS` (`//go:embed all:static`), requiring zero external filesystem assets at runtime.

- **Root Endpoint**: `GET /` automatically serves `static/index.html`.
- **Direct Asset Requests**: Any file under `static/` is served at its relative path (e.g., `GET /index.html`, `GET /css/...`, `GET /js/...`).
- **HTTP Methods**: Supports `GET` and `HEAD`.
- **Byte Ranges**: Supports `Accept-Ranges: bytes` with `206 Partial Content` responses.
- **Content Types**: Standard MIME types (e.g., `text/html; charset=utf-8` for HTML) are automatically inferred and populated.
- **Routing**: Requests to `/ws` are routed to the WebSocket upgrader; all other paths are handled by the embedded static file server. Nonexistent paths return HTTP `404 Not Found`.

