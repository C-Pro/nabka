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

    test('encodes police_dialogue_choice option_index 0..15 as positive fixint and roundtrips police payloads', () => {
        for (let idx = 0; idx <= 15; idx++) {
            const msg = {
                type: 'police_dialogue_choice',
                encounter_id: 'enc_42',
                option_index: idx
            };
            const buf = MsgPackCodec.encode(msg);
            const bytes = new Uint8Array(buf);
            // Option index 0..15 must encode as fixint (single byte 0x00..0x0f), never 0xcb float64
            expect(bytes.includes(0xcb)).toBe(false);
            expect(MsgPackCodec.decode(buf)).toEqual(msg);
        }
    });

    test('encodes vehicle_impulse floatKeys as 0xcb float64 even for zero and integer values', () => {
        const msg = {
            type: 'vehicle_impulse',
            police_car_id: 'police_car_0',
            car_id: 'car_0',
            target_user: 'Костян-с-Луговой',
            dvx: 0,
            dvz: -12,
            dyaw_rate: 0,
            police_mass: 4200,
            player_mass: 1450,
            sequence: 7
        };
        const buf = MsgPackCodec.encode(msg);
        const bytes = new Uint8Array(buf);
        // Count 0xcb opcodes: dvx, dvz, dyaw_rate, police_mass, player_mass -> at least 5 occurrences
        let floatCount = 0;
        for (const b of bytes) {
            if (b === 0xcb) floatCount++;
        }
        expect(floatCount).toBeGreaterThanOrEqual(5);
        expect(MsgPackCodec.decode(buf)).toEqual(msg);
    });

    test('roundtrips all M2/M3 police and negative-balance wire messages with Go-parity opcodes', () => {
        const messages = [
            { type: 'join', user: 'Саня-из-Центра', token: 'tok_1', roster: ['Саня-из-Центра'], money: -15400 },
            { type: 'balance_update', username: 'Саня-из-Центра', money: -5000000000, delta: -5000000000, reason: 'police_fine', source_id: 'police_car_0' },
            {
                type: 'police_state',
                sequence: 5000000001,
                sample_time_ms: 1732100000123,
                foot_cops: [{
                    id: 'cop_0',
                    name: 'Сержант Петров',
                    x: 4.5, y: 0, z: -12.25,
                    vx: 0.5, vz: 1.2, yaw: 1.57,
                    state: 'approach', anim: 'walk', target_user: 'Саня-из-Центра'
                }],
                police_cars: [{
                    id: 'police_car_0',
                    x: 23.0, y: 0, z: -40.5,
                    vx: 0, vz: 18.0, yaw: 0, yaw_rate: 0.05, speed: 18.0,
                    mass: 4200, state: 'chase',
                    target_car_id: 'car_0', target_user: 'Саня-из-Центра',
                    siren: true, lights: true
                }]
            },
            {
                type: 'police_encounter_start',
                encounter_id: 'enc_99',
                cop_id: 'cop_0',
                cop_name: 'Сержант Петров',
                scenario_id: 'weed_shakedown',
                title: 'Досмотр на Набке',
                opening: 'Гражданин, что это у нас в кармане?',
                options: [
                    { index: 0, text: 'Решить вопрос на месте', fine: 15000 },
                    { index: 1, text: 'Оформить протокол', fine: 25000 }
                ],
                target_user: 'Саня-из-Центра'
            },
            {
                type: 'police_encounter_result',
                encounter_id: 'enc_99',
                cop_id: 'cop_0',
                cop_name: 'Сержант Петров',
                scenario_id: 'weed_shakedown',
                target_user: 'Саня-из-Центра',
                option_index: 0,
                reply_text: 'Свободен, не попадайся больше.',
                fine: 15000,
                money: -5000
            },
            {
                type: 'police_chase',
                police_car_id: 'police_car_0',
                target_car_id: 'car_0',
                target_user: 'Саня-из-Центра',
                status: 'stopped',
                reason: 'speeding_over_40kmh',
                fine: 5000,
                money: -20000
            }
        ];

        for (const msg of messages) {
            const buf = MsgPackCodec.encode(msg);
            const decoded = MsgPackCodec.decode(buf);
            expect(decoded).toEqual(msg);
        }

        // Explicitly verify Go-style 0xd3 negative int64 and 0xcf uint64 binary decoding
        const raw = [];
        raw.push(0x82); // fixmap(2)
        // key "money"
        raw.push(0xa5, 0x6d, 0x6f, 0x6e, 0x65, 0x79);
        // 0xd3 int64 = -5000000000 (-0x12a05f200 => hi = -2, lo = 0xd5fa0e00)
        raw.push(0xd3, 0xff, 0xff, 0xff, 0xfe, 0xd5, 0xfa, 0x0e, 0x00);
        // key "seq"
        raw.push(0xa3, 0x73, 0x65, 0x71);
        // 0xcf uint64 = 5000000001 (0x00000001 0x2a05f201)
        raw.push(0xcf, 0x00, 0x00, 0x00, 0x01, 0x2a, 0x05, 0xf2, 0x01);

        const decodedRaw = MsgPackCodec.decode(new Uint8Array(raw).buffer);
        expect(decodedRaw.money).toBe(-5000000000);
        expect(decodedRaw.seq).toBe(5000000001);
    });
});
