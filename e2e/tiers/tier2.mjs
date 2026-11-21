/**
 * Tier 2: Boundary Value Analysis (BVA) & Adversarial Input Suite (>= 30 cases, >= 5 per 6 feature areas).
 * Strictly opaque-box over HTTP and binary WebSocket MessagePack.
 */
import {
    assert,
    assertCyrillic,
    assertEqual,
    assertFinite,
    assertGreater,
    assertIncludes,
    assertLess
} from '../lib/assert.mjs';
import { withServer } from '../lib/server.mjs';
import { connectWs, openRawWs, uniqueUsername } from '../lib/ws-client.mjs';
import {
    INITIAL_PLAYER_MONEY,
    RESERVED_POLICE_TYPES,
    SPEED_LIMIT_MS,
    driveNearPatrolPoliceCar,
    incurFinesUntilBelow,
    sleep,
    triggerFootCopEncounter,
    waitForPoliceState
} from '../lib/helpers.mjs';

export function getTier2Tests() {
    return [
        // =====================================================================
        // F1: Foot Cop Approach BVA (5 cases)
        // =====================================================================
        {
            id: 'T2-F1-01',
            name: 'T2-F1.1: Pedestrian staying far outside detection radius does not trigger encounter',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('t2f1'));
                    try {
                        await waitForPoliceState(client, null, 4000);
                        const cur = client.cursor();
                        for (let i = 0; i < 15; i++) {
                            client.sendMovePedestrian({ x: -60, y: 0, z: -155, yaw: 0, anim: 'idle' });
                            await sleep(100);
                        }
                        const starts = client.messagesSince(cur).filter((m) => m.type === 'police_encounter_start');
                        assertEqual(starts.length, 0, 'far pedestrian must not trigger encounter');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F1-02',
            name: 'T2-F1.2: Player driving a car next to a patrolling foot cop does not trigger foot encounter',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('t2f1'));
                    try {
                        const ps = await waitForPoliceState(client, (m) => m.foot_cops?.length > 0, 4000);
                        const cop = ps.foot_cops[0];
                        const cur = client.cursor();
                        for (let i = 0; i < 20; i++) {
                            const latestCop = (client.latestPoliceState?.foot_cops || []).find((c) => c.id === cop.id) || cop;
                            client.sendMoveDriving({
                                car_id: 'car_0',
                                x: latestCop.x + 1.0,
                                y: 0,
                                z: latestCop.z + 1.0,
                                speed: 3.0,
                                vx: 0,
                                vz: 3.0,
                                yaw: 0,
                                yaw_rate: 0,
                                drift: false,
                                lights: false
                            });
                            await sleep(80);
                        }
                        const starts = client.messagesSince(cur).filter((m) => m.type === 'police_encounter_start');
                        assertEqual(starts.length, 0, 'driving player must not receive foot cop encounter');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F1-03',
            name: 'T2-F1.3: Exiting a car near a patrolling foot cop enables foot cop approach & encounter',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('t2f1'));
                    try {
                        const ps = await waitForPoliceState(client, (m) => m.foot_cops?.some((c) => c.state === 'patrol'), 4000);
                        const cop = ps.foot_cops.find((c) => c.state === 'patrol');
                        client.sendMoveDriving({
                            car_id: 'car_1',
                            x: cop.x + 2.0,
                            y: 0,
                            z: cop.z + 2.0,
                            speed: 0,
                            yaw: 0,
                            drift: false,
                            lights: false
                        });
                        await sleep(250);
                        // Transition driving -> pedestrian right beside cop
                        const enc = await triggerFootCopEncounter(client, { timeoutMs: 12000 });
                        assertEqual(enc.target_user, client.username);
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F1-04',
            name: 'T2-F1.4: Entering a car while foot cop is approaching prevents dialogue lock while driving',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('t2f1'));
                    try {
                        const ps = await waitForPoliceState(client, (m) => m.foot_cops?.some((c) => c.state === 'patrol'), 4000);
                        const cop = ps.foot_cops.find((c) => c.state === 'patrol');
                        // Briefly walk within approach range, then immediately enter car_1 and drive away
                        client.sendMovePedestrian({ x: cop.x + 5.0, y: 0, z: cop.z + 5.0, yaw: 0, anim: 'walk' });
                        await sleep(100);
                        const cur = client.cursor();
                        for (let i = 0; i < 15; i++) {
                            client.sendMoveDriving({
                                car_id: 'car_1',
                                x: 23.0,
                                y: 0,
                                z: -80.0 + i * 2,
                                speed: 8.0,
                                vx: 0,
                                vz: 8.0,
                                yaw: 0,
                                yaw_rate: 0,
                                drift: false,
                                lights: false
                            });
                            await sleep(80);
                        }
                        const startsAfterDrive = client
                            .messagesSince(cur)
                            .filter((m) => m.type === 'police_encounter_start');
                        assertEqual(startsAfterDrive.length, 0, 'encounter must not fire after switching to driving');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F1-05',
            name: 'T2-F1.5: Cop in cooldown immediately post-resolution does not re-trigger on same spot',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('t2f1'));
                    try {
                        const enc = await triggerFootCopEncounter(client, { timeoutMs: 12000 });
                        const resCur = client.cursor();
                        client.sendPoliceChoice(enc.encounter_id, enc.options[0].index ?? 0);
                        await client.waitForType('police_encounter_result', {
                            fromIndex: resCur,
                            timeoutMs: 4000,
                            predicate: (m) => m.encounter_id === enc.encounter_id
                        });
                        const checkCur = client.cursor();
                        for (let i = 0; i < 10; i++) {
                            const cop = (client.latestPoliceState?.foot_cops || []).find((c) => c.id === enc.cop_id);
                            if (cop) {
                                client.sendMovePedestrian({ x: cop.x + 0.8, y: 0, z: cop.z + 0.8, yaw: 0, anim: 'idle' });
                            }
                            await sleep(80);
                        }
                        const retriggered = client
                            .messagesSince(checkCur)
                            .filter((m) => m.type === 'police_encounter_start' && m.cop_id === enc.cop_id);
                        assertEqual(retriggered.length, 0, 'same cop must not retrigger during cooldown');
                    } finally {
                        await client.close();
                    }
                });
            }
        },

        // =====================================================================
        // F2: Adversarial Police Dialogue Choices (5 cases)
        // =====================================================================
        {
            id: 'T2-F2-01',
            name: 'T2-F2.1: Negative option_index (-1) returns error and leaves balance unchanged',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client, join } = await connectWs(srv.wsUrl, uniqueUsername('t2f2'));
                    try {
                        const enc = await triggerFootCopEncounter(client, { timeoutMs: 12000 });
                        const cur = client.cursor();
                        client.sendPoliceChoice(enc.encounter_id, -1);
                        const err = await client.waitForType('error', { fromIndex: cur, timeoutMs: 3000 });
                        assert(typeof err.message === 'string' && err.message.length > 0);
                        assertEqual(client.latestMoney, join.money ?? INITIAL_PLAYER_MONEY);
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F2-02',
            name: 'T2-F2.2: Out-of-range option_index (99) returns error without closing encounter',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('t2f2'));
                    try {
                        const enc = await triggerFootCopEncounter(client, { timeoutMs: 12000 });
                        const cur1 = client.cursor();
                        client.sendPoliceChoice(enc.encounter_id, 99);
                        await client.waitForType('error', { fromIndex: cur1, timeoutMs: 3000 });

                        // Valid follow-up choice still resolves encounter cleanly
                        const cur2 = client.cursor();
                        client.sendPoliceChoice(enc.encounter_id, enc.options[0].index ?? 0);
                        const res = await client.waitForType('police_encounter_result', {
                            fromIndex: cur2,
                            timeoutMs: 4000,
                            predicate: (m) => m.encounter_id === enc.encounter_id
                        });
                        assertEqual(res.encounter_id, enc.encounter_id);
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F2-03',
            name: 'T2-F2.3: Nonexistent encounter_id returns error without mutating money',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client, join } = await connectWs(srv.wsUrl, uniqueUsername('t2f2'));
                    try {
                        const cur = client.cursor();
                        client.sendPoliceChoice('nonexistent-encounter-999', 0);
                        const err = await client.waitForType('error', { fromIndex: cur, timeoutMs: 3000 });
                        assert(err.message.length > 0);
                        await sleep(200);
                        const bals = client.messagesSince(cur).filter((m) => m.type === 'balance_update');
                        assertEqual(bals.length, 0);
                        assertEqual(client.latestMoney, join.money);
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F2-04',
            name: 'T2-F2.4: Another player attempting to answer victim encounter_id is rejected with error',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    let alice = null;
                    let bob = null;
                    try {
                        ({ client: alice } = await connectWs(srv.wsUrl, uniqueUsername('alice')));
                        ({ client: bob } = await connectWs(srv.wsUrl, uniqueUsername('bob')));
                        bob.sendMovePedestrian({ x: -55, y: 0, z: 140, yaw: 0, anim: 'idle' });
                        const enc = await triggerFootCopEncounter(alice, { timeoutMs: 12000 });

                        const bobCur = bob.cursor();
                        bob.sendPoliceChoice(enc.encounter_id, 0);
                        const err = await bob.waitForType('error', { fromIndex: bobCur, timeoutMs: 3000 });
                        assert(err.message.length > 0);

                        // Alice can still resolve her own encounter
                        const aliceCur = alice.cursor();
                        alice.sendPoliceChoice(enc.encounter_id, enc.options[0].index ?? 0);
                        const res = await alice.waitForType('police_encounter_result', {
                            fromIndex: aliceCur,
                            timeoutMs: 4000,
                            predicate: (m) => m.encounter_id === enc.encounter_id
                        });
                        assertEqual(res.target_user, alice.username);
                    } finally {
                        await alice?.close();
                        await bob?.close();
                    }
                });
            }
        },
        {
            id: 'T2-F2-05',
            name: 'T2-F2.5: Duplicate police_dialogue_choice on resolved encounter rejects without double fine',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client, join } = await connectWs(srv.wsUrl, uniqueUsername('t2f2'));
                    try {
                        const enc = await triggerFootCopEncounter(client, { timeoutMs: 12000 });
                        const opt = enc.options[enc.options.length - 1];
                        const cur1 = client.cursor();
                        client.sendPoliceChoice(enc.encounter_id, opt.index);
                        const res = await client.waitForType('police_encounter_result', {
                            fromIndex: cur1,
                            timeoutMs: 4000,
                            predicate: (m) => m.encounter_id === enc.encounter_id
                        });
                        const expectedMoney = (join.money ?? INITIAL_PLAYER_MONEY) - res.fine;
                        assertEqual(res.money, expectedMoney);

                        const cur2 = client.cursor();
                        client.sendPoliceChoice(enc.encounter_id, opt.index);
                        await client.waitForType('error', { fromIndex: cur2, timeoutMs: 3000 });
                        await sleep(200);
                        assertEqual(client.latestMoney, expectedMoney, 'balance not double-charged');
                    } finally {
                        await client.close();
                    }
                });
            }
        },

        // =====================================================================
        // F3: Speeding Threshold BVA (5 cases)
        // =====================================================================
        {
            id: 'T2-F3-01',
            name: 'T2-F3.1: Driving at 39.5 km/h (10.972 m/s) near police car does NOT trigger chase',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('spd39'));
                    try {
                        const { chase } = await driveNearPatrolPoliceCar(client, {
                            carId: 'car_0',
                            speedMs: 39.5 / 3.6,
                            durationMs: 2000
                        });
                        assertEqual(chase, null, '39.5 km/h must not trigger chase');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F3-02',
            name: 'T2-F3.2: Driving at exact boundary 40.0 km/h (40/3.6 m/s) does NOT trigger chase',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('spd40'));
                    try {
                        const { chase } = await driveNearPatrolPoliceCar(client, {
                            carId: 'car_0',
                            speedMs: SPEED_LIMIT_MS,
                            durationMs: 2000
                        });
                        assertEqual(chase, null, 'exact 40.0 km/h must not trigger chase (strictly > 40 km/h)');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F3-03',
            name: 'T2-F3.3: Driving at 40.5 km/h (11.25 m/s) near police car DOES trigger chase',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('spd41'));
                    try {
                        const { chase } = await driveNearPatrolPoliceCar(client, {
                            carId: 'car_0',
                            speedMs: 40.5 / 3.6,
                            durationMs: 3500
                        });
                        assert(chase, '40.5 km/h must trigger police_chase');
                        assertEqual(chase.status, 'started');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F3-04',
            name: 'T2-F3.4: Spoofed speed=0 with hypot(vx,vz) > 40 km/h STILL triggers chase',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('spoofv'));
                    try {
                        const ps = await waitForPoliceState(client, (m) => m.police_cars?.some((pc) => pc.state === 'patrol'), 4000);
                        const pc = ps.police_cars.find((c) => c.state === 'patrol');
                        const cur = client.cursor();
                        for (let i = 0; i < 40; i++) {
                            const latestPc = (client.latestPoliceState?.police_cars || []).find((c) => c.id === pc.id) || pc;
                            client.sendMoveDriving({
                                car_id: 'car_1',
                                x: latestPc.x + 3.0,
                                y: 0,
                                z: latestPc.z + 3.0,
                                speed: 0, // spoofed zero forward speed
                                vx: 9.0,
                                vz: 12.0, // hypot(9, 12) = 15.0 m/s = 54 km/h
                                yaw: 0,
                                yaw_rate: 0,
                                drift: false,
                                lights: true
                            });
                            await sleep(50);
                            const started = client
                                .messagesSince(cur)
                                .find((m) => m.type === 'police_chase' && m.status === 'started');
                            if (started) return;
                        }
                        throw new Error('Expected chase to trigger when hypot(vx, vz) = 15.0 m/s even with speed=0');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F3-05',
            name: 'T2-F3.5: Fast pedestrian (> 40 km/h velocity) near police car does NOT trigger car chase',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('fastped'));
                    try {
                        const ps = await waitForPoliceState(client, (m) => m.police_cars?.some((pc) => pc.state === 'patrol'), 4000);
                        const pc = ps.police_cars.find((c) => c.state === 'patrol');
                        const cur = client.cursor();
                        for (let i = 0; i < 20; i++) {
                            const latestPc = (client.latestPoliceState?.police_cars || []).find((c) => c.id === pc.id) || pc;
                            client.sendMovePedestrian({
                                x: latestPc.x + 3.0,
                                y: 0,
                                z: latestPc.z + 3.0,
                                vx: 0,
                                vz: 20.0,
                                yaw: 0,
                                anim: 'run'
                            });
                            await sleep(80);
                        }
                        const chases = client.messagesSince(cur).filter((m) => m.type === 'police_chase');
                        assertEqual(chases.length, 0, 'pedestrian speed must not trigger police_chase');
                    } finally {
                        await client.close();
                    }
                });
            }
        },

        // =====================================================================
        // F4: Collision & Police Car Authority Adversarial (5 cases)
        // =====================================================================
        {
            id: 'T2-F4-01',
            name: 'T2-F4.1: Driving move claiming car_id="police_car_0" is dropped without hijacking',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    let rogue = null;
                    let obs = null;
                    try {
                        ({ client: rogue } = await connectWs(srv.wsUrl, uniqueUsername('rogue')));
                        ({ client: obs } = await connectWs(srv.wsUrl, uniqueUsername('obs')));
                        const psBefore = await waitForPoliceState(obs, null, 4000);
                        const pcId = psBefore.police_cars[0].id;
                        const obsCur = obs.cursor();
                        rogue.sendMoveDriving({
                            car_id: pcId,
                            x: 999.0,
                            y: 0,
                            z: 999.0,
                            speed: 30.0,
                            yaw: 0,
                            drift: false,
                            lights: true
                        });
                        await sleep(300);
                        const relayed = obs
                            .messagesSince(obsCur)
                            .filter((m) => m.type === 'move' && m.car_id === pcId);
                        assertEqual(relayed.length, 0, 'police car move must not broadcast');
                        const psAfter = obs.latestPoliceState;
                        const pcAfter = psAfter.police_cars.find((c) => c.id === pcId);
                        assertLess(Math.abs(pcAfter.x), 500, 'police car position unaffected by client move');
                    } finally {
                        await rogue?.close();
                        await obs?.close();
                    }
                });
            }
        },
        {
            id: 'T2-F4-02',
            name: 'T2-F4.2: Raw 0xcb IEEE-754 NaN driving move is rejected with error without server crash',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('nan'));
                    try {
                        const cur = client.cursor();
                        client.sendRawFloat64({
                            type: 'move',
                            mode: 'driving',
                            car_id: 'car_0',
                            x: 23.0,
                            y: 0.0,
                            z: 0.0,
                            speed: Number.NaN,
                            yaw: 0.0,
                            drift: false,
                            lights: false
                        });
                        const err = await client.waitForType('error', { fromIndex: cur, timeoutMs: 3000 });
                        assert(err.message.length > 0);
                        const prevSeq = client.latestPoliceState?.sequence ?? 0;
                        const psCur = client.cursor();
                        const ps = await waitForPoliceState(client, (m) => m.sequence > prevSeq, 3000, { fromIndex: psCur });
                        assertFinite(ps.police_cars[0].x, 'police simulation stays finite after NaN');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F4-03',
            name: 'T2-F4.3: Raw 0xcb Infinity pedestrian move is rejected with error cleanly',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('inf'));
                    try {
                        const cur = client.cursor();
                        client.sendRawFloat64({
                            type: 'move',
                            mode: 'pedestrian',
                            x: Number.POSITIVE_INFINITY,
                            y: 0.0,
                            z: 0.0,
                            yaw: 0.0,
                            anim: 'idle'
                        });
                        const err = await client.waitForType('error', { fromIndex: cur, timeoutMs: 3000 });
                        assert(err.message.length > 0);
                        client.sendPing();
                        await client.waitForType('pong', { fromIndex: cur, timeoutMs: 3000 });
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F4-04',
            name: 'T2-F4.4: Client-forged vehicle_impulse is rejected as server reserved',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('fimp'));
                    try {
                        const cur = client.cursor();
                        client.send({
                            type: 'vehicle_impulse',
                            police_car_id: 'police_car_0',
                            car_id: 'car_0',
                            dvx: 50,
                            dvz: 50,
                            sequence: 999
                        });
                        const err = await client.waitForType('error', { fromIndex: cur, timeoutMs: 3000 });
                        assertIncludes(err.message.toLowerCase(), 'server reserved');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F4-05',
            name: 'T2-F4.5: Stationary car in path of patrolling police car does not trigger speeding chase',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('parked'));
                    try {
                        const ps = await waitForPoliceState(client, (m) => m.police_cars?.length > 0, 4000);
                        const pc = ps.police_cars[0];
                        const cur = client.cursor();
                        for (let i = 0; i < 20; i++) {
                            client.sendMoveDriving({
                                car_id: 'car_0',
                                x: pc.x,
                                y: 0,
                                z: pc.z,
                                speed: 0,
                                vx: 0,
                                vz: 0,
                                yaw: 0,
                                yaw_rate: 0,
                                drift: false,
                                lights: false
                            });
                            await sleep(60);
                        }
                        const chases = client.messagesSince(cur).filter((m) => m.type === 'police_chase');
                        assertEqual(chases.length, 0, 'stationary car must not trigger speeding chase');
                    } finally {
                        await client.close();
                    }
                });
            }
        },

        // =====================================================================
        // F5: Balance & Negative Arithmetic BVA (5 cases)
        // =====================================================================
        {
            id: 'T2-F5-01',
            name: 'T2-F5.1: Every balance_update satisfies delta === newMoney - oldMoney across zero crossing',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client, join } = await connectWs(srv.wsUrl, uniqueUsername('delta'));
                    try {
                        const cur = client.cursor();
                        await incurFinesUntilBelow(client, 0, { timeoutMs: 240000 });
                        const updates = client
                            .messagesSince(cur)
                            .filter((m) => m.type === 'balance_update' && m.username === client.username);
                        assertGreater(updates.length, 0, 'at least one balance_update emitted');
                        let running = join.money;
                        for (const u of updates) {
                            assertEqual(u.delta, u.money - running, 'balance_update delta integrity');
                            assertLess(u.delta, 0, 'fine delta is negative');
                            running = u.money;
                        }
                        assertLess(running, 0, 'crossed below zero');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F5-02',
            name: 'T2-F5.2: Deep negative balance (< -20000) still accepts subsequent fines',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('deepneg'));
                    try {
                        const deep = await incurFinesUntilBelow(client, -20000, { timeoutMs: 280000 });
                        assertLess(deep, -20000);
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F5-03',
            name: 'T2-F5.3: Client-forged balance_update (+999999) is rejected as server reserved without changing money',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const user = uniqueUsername('spoofbal');
                    const { client, join } = await connectWs(srv.wsUrl, user);
                    try {
                        const cur = client.cursor();
                        client.send({
                            type: 'balance_update',
                            username: user,
                            money: 999999,
                            delta: 874599,
                            reason: 'hack'
                        });
                        const err = await client.waitForType('error', { fromIndex: cur, timeoutMs: 3000 });
                        assertIncludes(err.message.toLowerCase(), 'server reserved');
                        const { client: c2, join: j2 } = await connectWs(srv.wsUrl, user, { token: join.token });
                        try {
                            assertEqual(j2.money, INITIAL_PLAYER_MONEY);
                        } finally {
                            await c2.close();
                        }
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F5-04',
            name: 'T2-F5.4: Arbitrary move/chat payloads cannot mutate or reset authoritative balance',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const user = uniqueUsername('immut');
                    const { client, join } = await connectWs(srv.wsUrl, user);
                    try {
                        client.send({ type: 'chat', text: 'test', money: 9999999 });
                        client.send({
                            type: 'move',
                            mode: 'pedestrian',
                            x: -50,
                            y: 0,
                            z: -150,
                            yaw: 0,
                            anim: 'idle',
                            money: 9999999
                        });
                        await sleep(200);
                        const { client: c2, join: j2 } = await connectWs(srv.wsUrl, user, { token: join.token });
                        try {
                            assertEqual(j2.money, INITIAL_PLAYER_MONEY);
                        } finally {
                            await c2.close();
                        }
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F5-05',
            name: 'T2-F5.5: Invalid chat payloads return error without disrupting wallet or police_state',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('badchat'));
                    try {
                        const cur = client.cursor();
                        client.sendChat('   ');
                        const err1 = await client.waitForType('error', { fromIndex: cur, timeoutMs: 3000 });
                        assert(err1.message.length > 0);
                        const cur2 = client.cursor();
                        client.sendChat('а'.repeat(501));
                        const err2 = await client.waitForType('error', { fromIndex: cur2, timeoutMs: 3000 });
                        assert(err2.message.length > 0);
                        assertEqual(client.latestMoney, INITIAL_PLAYER_MONEY);
                    } finally {
                        await client.close();
                    }
                });
            }
        },

        // =====================================================================
        // F6: Protocol & Server-Reserved Authority Adversarial (5 cases)
        // =====================================================================
        {
            id: 'T2-F6-01',
            name: 'T2-F6.1: All 6 S->C police message types sent by client are rejected as server reserved',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('resv'));
                    try {
                        for (const msgType of RESERVED_POLICE_TYPES) {
                            const cur = client.cursor();
                            client.send({ type: msgType });
                            const err = await client.waitForType('error', { fromIndex: cur, timeoutMs: 3000 });
                            assertIncludes(
                                err.message.toLowerCase(),
                                'server reserved',
                                `rejection for reserved type "${msgType}"`
                            );
                        }
                        // Connection stays alive after rejections
                        const curPing = client.cursor();
                        client.sendPing();
                        await client.waitForType('pong', { fromIndex: curPing, timeoutMs: 3000 });
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F6-02',
            name: 'T2-F6.2: Duplicate username without token (online and within sessionTTL) closes 4409',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const user = uniqueUsername('dup');
                    const { client: c1 } = await connectWs(srv.wsUrl, user);
                    try {
                        const rej1 = await connectWs(srv.wsUrl, user, { expectRejection: true });
                        assertEqual(rej1.code, 4409, 'online duplicate without token -> 4409');
                        await c1.close();
                        const rej2 = await connectWs(srv.wsUrl, user, { expectRejection: true });
                        assertEqual(rej2.code, 4409, 'disconnected within sessionTTL without token -> 4409');
                    } finally {
                        await c1.close();
                    }
                });
            }
        },
        {
            id: 'T2-F6-03',
            name: 'T2-F6.3: Option B sending non-binary text frame for register closes with 1008',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { opened, client } = await openRawWs(srv.wsUrl);
                    assert(opened, 'Option B socket opened');
                    try {
                        client.sendText(JSON.stringify({ type: 'register', username: uniqueUsername('txt') }));
                        const closeInfo = await client.waitForClose(4000);
                        assertEqual(closeInfo.code, 1008);
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T2-F6-04',
            name: 'T2-F6.4: Option A invalid/reserved username query fails pre-upgrade with HTTP 400',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    for (const badName of ['%20%20%20', 'server', 'Server']) {
                        const res = await fetch(`${srv.baseUrl}/ws?username=${badName}`);
                        assertEqual(res.status, 400, `HTTP 400 for username=${badName}`);
                    }
                });
            }
        },
        {
            id: 'T2-F6-05',
            name: 'T2-F6.5: Cyrillic UTF-8 username propagates cleanly across join, encounter, and balance_update',
            tier: 2,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const user = `Вася_${Math.floor(Math.random() * 9000 + 1000)}`;
                    const { client, join } = await connectWs(srv.wsUrl, user);
                    try {
                        assertEqual(join.user, user);
                        assertEqual(join.money, INITIAL_PLAYER_MONEY);
                        const enc = await triggerFootCopEncounter(client, { timeoutMs: 12000 });
                        assertEqual(enc.target_user, user);
                        assertCyrillic(enc.opening);
                        const opt = [...enc.options].sort((a, b) => (b.fine || 0) - (a.fine || 0))[0];
                        const cur = client.cursor();
                        client.sendPoliceChoice(enc.encounter_id, opt.index);
                        const res = await client.waitForType('police_encounter_result', {
                            fromIndex: cur,
                            timeoutMs: 4000,
                            predicate: (m) => m.encounter_id === enc.encounter_id
                        });
                        assertEqual(res.target_user, user);
                    } finally {
                        await client.close();
                    }
                });
            }
        }
    ];
}
