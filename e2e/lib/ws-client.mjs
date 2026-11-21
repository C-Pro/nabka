/**
 * Binary WebSocket MessagePack test client using native global WebSocket
 * and `static/js/msgpack.js`. Includes a raw IEEE-754 float64 encoder for
 * adversarial NaN/Infinity frames (since MsgPackCodec clamps non-finite numbers).
 */
import { MsgPackCodec } from '../../static/js/msgpack.js';

const utf8Encoder = new TextEncoder();

let userCounter = 0;
export function uniqueUsername(prefix = 'e2e') {
    userCounter += 1;
    const rand = Math.random().toString(36).slice(2, 7);
    const name = `${prefix}_${process.pid}_${userCounter}_${rand}`;
    return name.slice(0, 30);
}

/**
 * Raw MessagePack encoder preserving IEEE-754 NaN / +/-Infinity as 0xcb float64.
 */
export function encodeRawFloat64Packet(value) {
    const out = [];
    const writeFloat64 = (n) => {
        out.push(0xcb);
        const buf = new ArrayBuffer(8);
        new DataView(buf).setFloat64(0, n, false);
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < 8; i++) out.push(bytes[i]);
    };
    const writeVal = (v, key) => {
        if (v === null || v === undefined) {
            out.push(0xc0);
            return;
        }
        if (typeof v === 'boolean') {
            out.push(v ? 0xc3 : 0xc2);
            return;
        }
        if (typeof v === 'number') {
            if (key === 'option_index' && Number.isInteger(v) && v >= -32 && v <= 127) {
                out.push(v & 0xff);
                return;
            }
            writeFloat64(v);
            return;
        }
        if (typeof v === 'string') {
            const bytes = utf8Encoder.encode(v);
            const len = bytes.length;
            if (len <= 31) out.push(0xa0 | len);
            else if (len <= 0xff) out.push(0xd9, len);
            else out.push(0xda, (len >> 8) & 0xff, len & 0xff);
            for (let i = 0; i < len; i++) out.push(bytes[i]);
            return;
        }
        if (Array.isArray(v)) {
            const len = v.length;
            if (len <= 15) out.push(0x90 | len);
            else out.push(0xdc, (len >> 8) & 0xff, len & 0xff);
            for (const item of v) writeVal(item, null);
            return;
        }
        if (typeof v === 'object') {
            const keys = Object.keys(v).filter((k) => v[k] !== undefined);
            const len = keys.length;
            if (len <= 15) out.push(0x80 | len);
            else out.push(0xde, (len >> 8) & 0xff, len & 0xff);
            for (const k of keys) {
                writeVal(k, null);
                writeVal(v[k], k);
            }
        }
    };
    writeVal(value, null);
    return new Uint8Array(out).buffer;
}

export class WsClient {
    constructor(ws, { username = '', maxMessages = 15000 } = {}) {
        this.ws = ws;
        this.username = username;
        this.maxMessages = maxMessages;
        this.messages = [];
        this._baseOffset = 0;
        this.waiters = new Set();
        this.closeInfo = null;
        this.latestPoliceState = null;
        this.latestMoney = null;
        this.lastChaseEndedAt = 0;
        this.lastEncounterEndedAt = 0;
        this.lastJoin = null;

        this.closedPromise = new Promise((resolve) => {
            this._resolveClosed = resolve;
        });

        ws.addEventListener('message', (event) => {
            let decoded = null;
            try {
                if (event.data instanceof ArrayBuffer) {
                    decoded = MsgPackCodec.decode(event.data);
                } else if (ArrayBuffer.isView(event.data)) {
                    decoded = MsgPackCodec.decode(event.data);
                } else if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
                    event.data.arrayBuffer().then((buf) => {
                        this._onDecoded(MsgPackCodec.decode(buf));
                    }).catch(() => {});
                    return;
                } else {
                    decoded = { type: '_raw_text', text: String(event.data) };
                }
            } catch (err) {
                decoded = { type: '_decode_error', error: String(err) };
            }
            this._onDecoded(decoded);
        });

        ws.addEventListener('close', (event) => {
            this.closeInfo = {
                code: event.code,
                reason: event.reason || '',
                wasClean: Boolean(event.wasClean)
            };
            this._resolveClosed(this.closeInfo);
            for (const waiter of [...this.waiters]) {
                if (waiter.rejectOnClose) {
                    this.waiters.delete(waiter);
                    clearTimeout(waiter.timer);
                    waiter.reject(
                        new Error(
                            `WebSocket closed (${this.closeInfo.code}: ${this.closeInfo.reason}) while waiting for ${waiter.desc}`
                        )
                    );
                }
            }
        });
    }

    _onDecoded(msg) {
        if (!msg || typeof msg !== 'object') return;
        this.messages.push(msg);

        // Keep memory bounded by pruning from front while preserving logical cursor offsets
        if (this.messages.length > this.maxMessages) {
            const excess = this.messages.length - this.maxMessages;
            this.messages.splice(0, excess);
            this._baseOffset += excess;
        }

        if (msg.type === 'police_state') {
            this.latestPoliceState = msg;
        } else if (msg.type === 'join' && msg.token) {
            this.lastJoin = msg;
            if (typeof msg.money === 'number') this.latestMoney = msg.money;
        } else if (msg.type === 'balance_update' && msg.username === this.username) {
            if (typeof msg.money === 'number') this.latestMoney = msg.money;
        } else if (msg.type === 'police_encounter_result' && msg.target_user === this.username) {
            this.lastEncounterEndedAt = Date.now();
        } else if (
            msg.type === 'police_chase' &&
            msg.target_user === this.username &&
            (msg.status === 'stopped' || msg.status === 'evaded')
        ) {
            this.lastChaseEndedAt = Date.now();
        }

        for (const waiter of [...this.waiters]) {
            let matched = false;
            try {
                matched = Boolean(waiter.predicate(msg));
            } catch {
                matched = false;
            }
            if (matched) {
                this.waiters.delete(waiter);
                clearTimeout(waiter.timer);
                waiter.resolve(msg);
            }
        }
    }

    cursor() {
        return this._baseOffset + this.messages.length;
    }

    messagesSince(cur = 0) {
        return this.messages.slice(Math.max(0, cur - this._baseOffset));
    }

    get isClosed() {
        return this.closeInfo !== null || this.ws.readyState === WebSocket.CLOSED;
    }

    waitForMessage(predicate, { timeoutMs = 5000, fromIndex = 0, desc = 'message', rejectOnClose = true } = {}) {
        const startIdx = Math.max(0, fromIndex - this._baseOffset);
        for (let i = startIdx; i < this.messages.length; i++) {
            const m = this.messages[i];
            if (predicate(m)) return Promise.resolve(m);
        }
        if (this.closeInfo && rejectOnClose) {
            return Promise.reject(
                new Error(`WebSocket already closed (${this.closeInfo.code}: ${this.closeInfo.reason}) waiting for ${desc}`)
            );
        }
        return new Promise((resolve, reject) => {
            const waiter = {
                predicate,
                desc,
                rejectOnClose,
                resolve,
                reject,
                timer: null
            };
            waiter.timer = setTimeout(() => {
                this.waiters.delete(waiter);
                reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${desc}`));
            }, timeoutMs);
            this.waiters.add(waiter);
        });
    }

    waitForType(type, opts = {}) {
        const extra = opts.predicate;
        return this.waitForMessage(
            (m) => m.type === type && (!extra || extra(m)),
            { ...opts, desc: opts.desc || `type="${type}"` }
        );
    }

    async waitForCondition(predicate, { timeoutMs = 6000, pollIntervalMs = 50, desc = 'condition' } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const val = predicate(this);
            if (val) return val;
            await new Promise((r) => setTimeout(r, pollIntervalMs));
        }
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${desc}`);
    }

    async collectFor(durationMs, predicate = null) {
        const start = this.cursor();
        await new Promise((r) => setTimeout(r, durationMs));
        const slice = this.messagesSince(start);
        return predicate ? slice.filter(predicate) : slice;
    }

    waitForClose(timeoutMs = 5000) {
        if (this.closeInfo) return Promise.resolve(this.closeInfo);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Timed out after ${timeoutMs}ms waiting for WebSocket close`));
            }, timeoutMs);
            this.closedPromise.then((info) => {
                clearTimeout(timer);
                resolve(info);
            });
        });
    }

    send(obj) {
        this.ws.send(MsgPackCodec.encode(obj));
    }

    sendRawFloat64(objWithSpecialFloats) {
        this.ws.send(encodeRawFloat64Packet(objWithSpecialFloats));
    }

    sendBytes(uint8OrBuf) {
        this.ws.send(uint8OrBuf);
    }

    sendText(text) {
        this.ws.send(String(text));
    }

    sendMovePedestrian({ x = 0, y = 0, z = 0, yaw = 0, anim = 'idle', vx = 0, vz = 0 } = {}) {
        this.send({
            type: 'move',
            mode: 'pedestrian',
            x,
            y,
            z,
            vx,
            vz,
            yaw,
            anim
        });
    }

    sendMoveDriving({
        car_id = 'car_0',
        x = 0,
        y = 0,
        z = 0,
        speed = 0,
        yaw = 0,
        drift = false,
        lights = false,
        vx,
        vz,
        yaw_rate = 0
    } = {}) {
        const payload = {
            type: 'move',
            mode: 'driving',
            car_id,
            x,
            y,
            z,
            speed,
            yaw,
            drift,
            lights,
            yaw_rate
        };
        if (vx !== undefined) payload.vx = vx;
        if (vz !== undefined) payload.vz = vz;
        this.send(payload);
    }

    sendPoliceChoice(encounter_id, option_index) {
        this.send({
            type: 'police_dialogue_choice',
            encounter_id,
            option_index
        });
    }

    sendChat(text) {
        this.send({ type: 'chat', text });
    }

    sendPing() {
        this.send({ type: 'ping' });
    }

    async close(code = 1000, reason = 'test done') {
        if (this.closeInfo) return this.closeInfo;
        try {
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close(code, reason);
            }
        } catch {
            try {
                this.ws.close();
            } catch {
                // ignore
            }
        }
        return Promise.race([
            this.closedPromise,
            new Promise((r) => setTimeout(() => r(this.closeInfo || { code: 1006, reason: '', wasClean: false }), 1500))
        ]);
    }
}

export async function openRawWs(url, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                try { ws.close(); } catch {}
                reject(new Error(`Timed out opening WebSocket to ${url}`));
            }
        }, timeoutMs);

        const client = new WsClient(ws);
        ws.addEventListener('open', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve({ opened: true, client });
            }
        });
        ws.addEventListener('error', () => {
            // Wait briefly for close so caller gets close code if handshake succeeded or failed
        });
        ws.addEventListener('close', (ev) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve({
                    opened: false,
                    client,
                    closeCode: ev.code,
                    closeReason: ev.reason || ''
                });
            }
        });
    });
}

export async function connectWs(
    wsBaseUrl,
    username,
    { mode = 'A', token = '', timeoutMs = 5000, expectRejection = false } = {}
) {
    const url =
        mode === 'A'
            ? `${wsBaseUrl}?username=${encodeURIComponent(username)}${token ? `&token=${encodeURIComponent(token)}` : ''}`
            : wsBaseUrl;

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const client = new WsClient(ws, { username });

    return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
            if (!done) {
                done = true;
                try { ws.close(); } catch {}
                reject(new Error(`connectWs timeout for ${username} (mode=${mode})`));
            }
        }, timeoutMs);

        ws.addEventListener('open', () => {
            if (mode === 'B') {
                const reg = { type: 'register', username };
                if (token) reg.token = token;
                client.send(reg);
            }
            if (!expectRejection) {
                client
                    .waitForMessage((m) => m.type === 'join' && Boolean(m.token), {
                        timeoutMs,
                        desc: `self join for ${username}`
                    })
                    .then((join) => {
                        if (!done) {
                            done = true;
                            clearTimeout(timer);
                            resolve({ client, join });
                        }
                    })
                    .catch((err) => {
                        if (!done) {
                            done = true;
                            clearTimeout(timer);
                            reject(err);
                        }
                    });
            }
        });

        ws.addEventListener('close', (ev) => {
            if (!done) {
                done = true;
                clearTimeout(timer);
                if (expectRejection) {
                    resolve({
                        rejected: true,
                        code: ev.code,
                        reason: ev.reason || '',
                        client
                    });
                } else {
                    reject(new Error(`WS closed during connect (${ev.code}: ${ev.reason || ''}) for ${username}`));
                }
            }
        });
    });
}
