/**
 * Self-contained Binary MessagePack (msgpack) codec tailored for Go server interoperability.
 * Explicitly encodes floating-point coordinates/telemetry as IEEE-754 float64 (0xcb)
 * and decodes all MessagePack map, string, float32/float64, int/uint, bool, and array types.
 */
export const MsgPackCodec = {
    utf8Encoder: new TextEncoder(),
    utf8Decoder: new TextDecoder('utf-8'),

    encode(obj, floatKeys = new Set(['x', 'y', 'z', 'vx', 'vz', 'yaw', 'speed', 'yaw_rate', 'sample_time_ms'])) {
        const bytes = [];
        this._encodeValue(obj, bytes, null, floatKeys);
        return new Uint8Array(bytes).buffer;
    },

    _encodeValue(val, out, currentKey, floatKeys) {
        if (val === null || val === undefined) {
            out.push(0xc0);
            return;
        }
        if (typeof val === 'boolean') {
            out.push(val ? 0xc3 : 0xc2);
            return;
        }
        if (typeof val === 'number') {
            const forceFloat = currentKey && floatKeys.has(currentKey);
            if (!forceFloat && Number.isInteger(val) && val >= -32 && val <= 127) {
                out.push(val & 0xff);
                return;
            }
            // Encode as IEEE-754 float64 (0xcb) so Go float64 fields always unmarshal cleanly
            out.push(0xcb);
            const buf = new ArrayBuffer(8);
            const view = new DataView(buf);
            view.setFloat64(0, Number.isFinite(val) ? val : 0.0, false);
            for (let i = 0; i < 8; i++) out.push(view.getUint8(i));
            return;
        }
        if (typeof val === 'string') {
            const strBytes = this.utf8Encoder.encode(val);
            const len = strBytes.length;
            if (len <= 31) {
                out.push(0xa0 | len);
            } else if (len <= 0xff) {
                out.push(0xd9, len);
            } else if (len <= 0xffff) {
                out.push(0xda, (len >> 8) & 0xff, len & 0xff);
            } else {
                out.push(0xdb, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
            }
            for (let i = 0; i < len; i++) out.push(strBytes[i]);
            return;
        }
        if (Array.isArray(val)) {
            const len = val.length;
            if (len <= 15) {
                out.push(0x90 | len);
            } else if (len <= 0xffff) {
                out.push(0xdc, (len >> 8) & 0xff, len & 0xff);
            } else {
                out.push(0xdd, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
            }
            for (let i = 0; i < len; i++) this._encodeValue(val[i], out, null, floatKeys);
            return;
        }
        if (typeof val === 'object') {
            const keys = Object.keys(val).filter(k => val[k] !== undefined);
            const len = keys.length;
            if (len <= 15) {
                out.push(0x80 | len);
            } else if (len <= 0xffff) {
                out.push(0xde, (len >> 8) & 0xff, len & 0xff);
            } else {
                out.push(0xdf, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
            }
            for (const k of keys) {
                this._encodeValue(k, out, null, floatKeys);
                this._encodeValue(val[k], out, k, floatKeys);
            }
        }
    },

    decode(arrayBuffer) {
        const buf = arrayBuffer instanceof Uint8Array
            ? arrayBuffer.buffer.slice(arrayBuffer.byteOffset, arrayBuffer.byteOffset + arrayBuffer.byteLength)
            : arrayBuffer;
        const view = new DataView(buf);
        const bytes = new Uint8Array(buf);
        const state = { offset: 0 };
        return this._decodeAt(view, bytes, state);
    },

    _decodeAt(view, bytes, state) {
        const b = view.getUint8(state.offset++);

        // Positive fixint (0x00 - 0x7f)
        if (b <= 0x7f) return b;
        // Fixmap (0x80 - 0x8f)
        if (b >= 0x80 && b <= 0x8f) return this._readMap(b & 0x0f, view, bytes, state);
        // Fixarray (0x90 - 0x9f)
        if (b >= 0x90 && b <= 0x9f) return this._readArray(b & 0x0f, view, bytes, state);
        // Fixstr (0xa0 - 0xbf)
        if (b >= 0xa0 && b <= 0xbf) return this._readStr(b & 0x1f, bytes, state);
        // Negative fixint (0xe0 - 0xff)
        if (b >= 0xe0) return b - 256;

        switch (b) {
            case 0xc0: return null;
            case 0xc2: return false;
            case 0xc3: return true;
            case 0xca: {
                const v = view.getFloat32(state.offset, false);
                state.offset += 4;
                return v;
            }
            case 0xcb: {
                const v = view.getFloat64(state.offset, false);
                state.offset += 8;
                return v;
            }
            case 0xcc: return view.getUint8(state.offset++);
            case 0xcd: {
                const v = view.getUint16(state.offset, false);
                state.offset += 2;
                return v;
            }
            case 0xce: {
                const v = view.getUint32(state.offset, false);
                state.offset += 4;
                return v;
            }
            case 0xcf: {
                const hi = view.getUint32(state.offset, false);
                const lo = view.getUint32(state.offset + 4, false);
                state.offset += 8;
                return hi * 4294967296 + lo;
            }
            case 0xd0: return view.getInt8(state.offset++);
            case 0xd1: {
                const v = view.getInt16(state.offset, false);
                state.offset += 2;
                return v;
            }
            case 0xd2: {
                const v = view.getInt32(state.offset, false);
                state.offset += 4;
                return v;
            }
            case 0xd3: {
                const hi = view.getInt32(state.offset, false);
                const lo = view.getUint32(state.offset + 4, false);
                state.offset += 8;
                return hi * 4294967296 + lo;
            }
            case 0xd9: {
                const len = view.getUint8(state.offset++);
                return this._readStr(len, bytes, state);
            }
            case 0xda: {
                const len = view.getUint16(state.offset, false);
                state.offset += 2;
                return this._readStr(len, bytes, state);
            }
            case 0xdb: {
                const len = view.getUint32(state.offset, false);
                state.offset += 4;
                return this._readStr(len, bytes, state);
            }
            case 0xdc: {
                const len = view.getUint16(state.offset, false);
                state.offset += 2;
                return this._readArray(len, view, bytes, state);
            }
            case 0xdd: {
                const len = view.getUint32(state.offset, false);
                state.offset += 4;
                return this._readArray(len, view, bytes, state);
            }
            case 0xde: {
                const len = view.getUint16(state.offset, false);
                state.offset += 2;
                return this._readMap(len, view, bytes, state);
            }
            case 0xdf: {
                const len = view.getUint32(state.offset, false);
                state.offset += 4;
                return this._readMap(len, view, bytes, state);
            }
            default:
                return null;
        }
    },

    _readStr(len, bytes, state) {
        const sub = bytes.subarray(state.offset, state.offset + len);
        state.offset += len;
        return this.utf8Decoder.decode(sub);
    },

    _readArray(len, view, bytes, state) {
        const arr = new Array(len);
        for (let i = 0; i < len; i++) {
            arr[i] = this._decodeAt(view, bytes, state);
        }
        return arr;
    },

    _readMap(len, view, bytes, state) {
        const obj = {};
        for (let i = 0; i < len; i++) {
            const k = this._decodeAt(view, bytes, state);
            const v = this._decodeAt(view, bytes, state);
            obj[k] = v;
        }
        return obj;
    }
};
