import { describe, test, expect } from 'bun:test';
import { MsgPackCodec } from '../js/msgpack.js';

describe('MsgPackCodec', () => {
    test('encodes and decodes register message', () => {
        const msg = { type: 'register', username: 'Костян-с-Луговой' };
        const buf = MsgPackCodec.encode(msg);
        expect(buf).toBeInstanceOf(ArrayBuffer);
        const decoded = MsgPackCodec.decode(buf);
        expect(decoded).toEqual(msg);
    });

    test('encodes and decodes pedestrian move with IEEE-754 float64 coordinates', () => {
        const msg = {
            type: 'move',
            username: 'Костян-с-Луговой',
            mode: 'pedestrian',
            x: 12.345,
            y: 0,
            z: -32.125,
            vx: 4.5,
            vz: -9.8,
            yaw: 3.14159,
            anim: 'run'
        };
        const buf = MsgPackCodec.encode(msg);
        const bytes = new Uint8Array(buf);
        // Verify 0xcb (float64) is present in the binary stream even for integer 0 coordinate y
        expect(bytes.includes(0xcb)).toBe(true);

        const decoded = MsgPackCodec.decode(buf);
        expect(decoded.type).toBe('move');
        expect(decoded.mode).toBe('pedestrian');
        expect(decoded.x).toBeCloseTo(12.345, 5);
        expect(decoded.y).toBe(0);
        expect(decoded.z).toBeCloseTo(-32.125, 5);
        expect(decoded.vx).toBeCloseTo(4.5, 5);
        expect(decoded.vz).toBeCloseTo(-9.8, 5);
        expect(decoded.yaw).toBeCloseTo(3.14159, 5);
        expect(decoded.anim).toBe('run');
    });

    test('encodes and decodes driving move with booleans and car_id', () => {
        const msg = {
            type: 'move',
            username: 'vvo_drifter',
            mode: 'driving',
            car_id: 'car_1',
            x: 19.5,
            y: 0.02,
            z: 14.0,
            speed: 24.5,
            yaw: 1.57,
            drift: true,
            lights: false
        };
        const decoded = MsgPackCodec.decode(MsgPackCodec.encode(msg));
        expect(decoded).toEqual(msg);
    });

    test('encodes and decodes Russian UTF-8 and emoji chat messages', () => {
        const msg = {
            type: 'chat',
            from: 'alisa_25rus',
            text: 'Салют на Спортивной набережной! 🌊🦀🏎️💨 Пян-се горячий!'
        };
        const buf = MsgPackCodec.encode(msg);
        const decoded = MsgPackCodec.decode(buf);
        expect(decoded).toEqual(msg);
    });

    test('supports decoding from a Uint8Array sub-view with non-zero byteOffset', () => {
        const msg = { type: 'join', user: 'newcomer_vvo' };
        const raw = new Uint8Array(MsgPackCodec.encode(msg));
        const padded = new Uint8Array(raw.length + 10);
        padded.set(raw, 4);
        const subView = padded.subarray(4, 4 + raw.length);

        const decoded = MsgPackCodec.decode(subView);
        expect(decoded).toEqual(msg);
    });

    test('handles nested arrays, negative integers, booleans, and null values', () => {
        const payload = {
            arr: [1, -5, -40, -500, 300, 70000, true, false, null, 'Владивосток'],
            nested: { ok: true }
        };
        const decoded = MsgPackCodec.decode(MsgPackCodec.encode(payload));
        expect(decoded).toEqual(payload);
    });
});
