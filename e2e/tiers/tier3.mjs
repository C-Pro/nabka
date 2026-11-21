/**
 * Tier 3: Pairwise Cross-Feature Combinatorial Suite (>= 8 cases).
 * Exercises interactions between police patrols, chases, heavy collisions,
 * Russian dialogues, negative balances, reconnects, and server authority.
 */
import {
    assert,
    assertCyrillic,
    assertEqual,
    assertGreater,
    assertIncludes,
    assertLess
} from '../lib/assert.mjs';
import { withServer } from '../lib/server.mjs';
import { connectWs, uniqueUsername } from '../lib/ws-client.mjs';
import {
    INITIAL_PLAYER_MONEY,
    RESERVED_POLICE_TYPES,
    driveNearPatrolPoliceCar,
    incurFinesUntilBelow,
    sleep,
    startChaseAndCollide,
    triggerEncounterForScenario,
    triggerFootCopEncounter,
    waitForPoliceState
} from '../lib/helpers.mjs';

export function getTier3Tests() {
    return [
        {
            id: 'T3-01',
            name: 'Pairwise: Speeding chase + 4200kg collision + stop fine + negative balance + observer sync',
            tier: 3,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    let driver = null;
                    let obs = null;
                    try {
                        ({ client: driver } = await connectWs(srv.wsUrl, uniqueUsername('t3_drv')));
                        ({ client: obs } = await connectWs(srv.wsUrl, uniqueUsername('t3_obs')));
                        // Drive driver near/below zero first so stop fine pushes further negative
                        await incurFinesUntilBelow(driver, 0, { timeoutMs: 240000 });
                        const balBefore = driver.latestMoney;

                        await waitForPoliceState(
                            driver,
                            (m) => (m.police_cars || []).some((pc) => pc.state === 'patrol'),
                            18000
                        );
                        const obsCur = obs.cursor();
                        const drvCur = driver.cursor();
                        const { impulse, policeCarId } = await startChaseAndCollide(driver, { carId: 'car_1' });
                        assertEqual(impulse.police_mass, 4200);
                        assertGreater(Math.hypot(impulse.dvx, impulse.dvz), 0.1);

                        // Stop to take fine while already negative
                        let stopped = null;
                        const deadline = Date.now() + 10000;
                        while (Date.now() < deadline) {
                            stopped = driver
                                .messagesSince(drvCur)
                                .find((m) => m.type === 'police_chase' && m.status === 'stopped' && m.target_user === driver.username);
                            if (stopped) break;
                            const pc = (driver.latestPoliceState?.police_cars || []).find((c) => c.id === policeCarId);
                            if (pc) {
                                driver.sendMoveDriving({
                                    car_id: 'car_1',
                                    x: pc.x + 1.0,
                                    y: 0,
                                    z: pc.z + 1.0,
                                    speed: 0,
                                    vx: 0,
                                    vz: 0,
                                    yaw: 0,
                                    yaw_rate: 0,
                                    drift: false,
                                    lights: true
                                });
                            }
                            await sleep(50);
                        }
                        assert(stopped, 'chase stopped');
                        assertGreater(stopped.fine, 0);
                        assertEqual(stopped.money, balBefore - stopped.fine);
                        assertLess(stopped.money, 0);

                        const obsStopped = await obs.waitForType('police_chase', {
                            fromIndex: obsCur,
                            timeoutMs: 4000,
                            predicate: (m) => m.target_user === driver.username && m.status === 'stopped'
                        });
                        assertEqual(obsStopped.money, stopped.money);
                    } finally {
                        await driver?.close();
                        await obs?.close();
                    }
                });
            }
        },
        {
            id: 'T3-02',
            name: 'Pairwise: weed_shakedown dialogue + fine broadcast + late joiner baseline sync',
            tier: 3,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    let p1 = null;
                    let obs = null;
                    try {
                        let j1;
                        ({ client: p1, join: j1 } = await connectWs(srv.wsUrl, uniqueUsername('t3_p1')));
                        ({ client: obs } = await connectWs(srv.wsUrl, uniqueUsername('t3_obs')));
                        obs.sendMovePedestrian({ x: -55, y: 0, z: 145, yaw: 0, anim: 'idle' });
                        // Also park car_2 so late joiner sees tracked vehicle baseline
                        p1.sendMoveDriving({
                            car_id: 'car_2',
                            x: 32.0,
                            y: 0,
                            z: 10.0,
                            speed: 0,
                            yaw: 0,
                            drift: false,
                            lights: false
                        });
                        await sleep(100);
                        p1.sendMovePedestrian({ x: 0, y: 0, z: 0, yaw: 0, anim: 'idle' });

                        const enc = await triggerEncounterForScenario(p1, 'weed_shakedown', { maxAttempts: 24 });
                        const balBefore = p1.latestMoney ?? j1.money;
                        const opt = enc.options[0];
                        assertGreater(opt.fine, 0);

                        const obsCur = obs.cursor();
                        p1.sendPoliceChoice(enc.encounter_id, opt.index);
                        const obsRes = await obs.waitForType('police_encounter_result', {
                            fromIndex: obsCur,
                            timeoutMs: 4000,
                            predicate: (m) => m.encounter_id === enc.encounter_id
                        });
                        assertEqual(obsRes.money, balBefore - opt.fine);

                        const { client: late } = await connectWs(srv.wsUrl, uniqueUsername('t3_late'));
                        try {
                            const ps = await waitForPoliceState(late, null, 3000);
                            assert(ps.foot_cops.length >= 1 && ps.police_cars.length >= 1);
                            const car2 = await late.waitForMessage(
                                (m) => m.type === 'move' && m.mode === 'driving' && m.car_id === 'car_2',
                                { timeoutMs: 3000, desc: 'late joiner car_2 baseline' }
                            );
                            assertEqual(car2.username, '');
                            assertEqual(car2.x, 32.0);
                            assertEqual(car2.z, 10.0);
                        } finally {
                            await late.close();
                        }
                    } finally {
                        await p1?.close();
                        await obs?.close();
                    }
                });
            }
        },
        {
            id: 'T3-03',
            name: 'Pairwise: Negative balance + active encounter -> 4408 replacement restores both -> further fine',
            tier: 3,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const user = uniqueUsername('t3_rep');
                    const { client: c1, join: j1 } = await connectWs(srv.wsUrl, user);
                    try {
                        const negMoney = await incurFinesUntilBelow(c1, 0, { timeoutMs: 240000 });
                        const enc = await triggerFootCopEncounter(c1, { timeoutMs: 20000 });

                        const { client: c2, join: j2 } = await connectWs(srv.wsUrl, user, { token: j1.token });
                        try {
                            const closed = await c1.waitForClose(3000);
                            assertEqual(closed.code, 4408);
                            assertEqual(j2.money, negMoney);
                            const restored = await c2.waitForType('police_encounter_start', { timeoutMs: 4000 });
                            assertEqual(restored.encounter_id, enc.encounter_id);

                            const opt = [...restored.options].sort((a, b) => (b.fine || 0) - (a.fine || 0))[0];
                            const cur = c2.cursor();
                            c2.sendPoliceChoice(restored.encounter_id, opt.index);
                            const res = await c2.waitForType('police_encounter_result', {
                                fromIndex: cur,
                                timeoutMs: 4000,
                                predicate: (m) => m.encounter_id === restored.encounter_id
                            });
                            assertEqual(res.money, negMoney - opt.fine);
                        } finally {
                            await c2.close();
                        }
                    } finally {
                        await c1.close();
                    }
                });
            }
        },
        {
            id: 'T3-04',
            name: 'Pairwise: Disconnect after negative balance + token rejoin restores wallet + speeding fine',
            tier: 3,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const user = uniqueUsername('t3_rejoin');
                    let c1 = null;
                    let c2 = null;
                    let j1 = null;
                    let negMoney = 0;
                    try {
                        ({ client: c1, join: j1 } = await connectWs(srv.wsUrl, user));
                        negMoney = await incurFinesUntilBelow(c1, 0, { timeoutMs: 240000 });
                    } finally {
                        await c1?.close();
                    }
                    await sleep(150);

                    try {
                        let j2;
                        ({ client: c2, join: j2 } = await connectWs(srv.wsUrl, user, { token: j1.token }));
                        assertEqual(j2.money, negMoney);
                        await waitForPoliceState(
                            c2,
                            (m) => (m.police_cars || []).some((pc) => pc.state === 'patrol'),
                            18000
                        );
                        const cur = c2.cursor();
                        const { chase, policeCarId } = await driveNearPatrolPoliceCar(c2, {
                            carId: 'car_0',
                            speedMs: 24.0,
                            durationMs: 3500
                        });
                        assert(chase, 'chase started after rejoin');
                        let stopped = null;
                        const deadline = Date.now() + 10000;
                        while (Date.now() < deadline) {
                            stopped = c2
                                .messagesSince(cur)
                                .find((m) => m.type === 'police_chase' && m.status === 'stopped' && m.target_user === user);
                            if (stopped) break;
                            const pc = (c2.latestPoliceState?.police_cars || []).find((c) => c.id === policeCarId);
                            if (pc) {
                                c2.sendMoveDriving({
                                    car_id: 'car_0',
                                    x: pc.x + 1.0,
                                    y: 0,
                                    z: pc.z + 1.0,
                                    speed: 0,
                                    vx: 0,
                                    vz: 0,
                                    yaw: 0,
                                    yaw_rate: 0,
                                    drift: false,
                                    lights: true
                                });
                            }
                            await sleep(50);
                        }
                        assert(stopped, 'stopped after rejoin');
                        assertLess(stopped.money, negMoney);
                    } finally {
                        await c2?.close();
                    }
                });
            }
        },
        {
            id: 'T3-05',
            name: 'Pairwise: Simultaneous pedestrian foot-cop encounter + speeding car chase converge on observer',
            tier: 3,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    let walker = null;
                    let driver = null;
                    let obs = null;
                    try {
                        ({ client: walker } = await connectWs(srv.wsUrl, uniqueUsername('t3_wlk')));
                        ({ client: driver } = await connectWs(srv.wsUrl, uniqueUsername('t3_drv')));
                        ({ client: obs } = await connectWs(srv.wsUrl, uniqueUsername('t3_obs')));
                        obs.sendMovePedestrian({ x: -55, y: 0, z: 145, yaw: 0, anim: 'idle' });
                        const obsCur = obs.cursor();

                        const [enc, chaseInfo] = await Promise.all([
                            triggerFootCopEncounter(walker, { timeoutMs: 20000 }),
                            driveNearPatrolPoliceCar(driver, { carId: 'car_1', speedMs: 22.0, durationMs: 3500 })
                        ]);
                        assert(chaseInfo.chase, 'driver chase started concurrently');

                        walker.sendPoliceChoice(enc.encounter_id, enc.options[0].index ?? 0);
                        const [obsEncRes, obsChase] = await Promise.all([
                            obs.waitForType('police_encounter_result', {
                                fromIndex: obsCur,
                                timeoutMs: 4000,
                                predicate: (m) => m.target_user === walker.username
                            }),
                            obs.waitForType('police_chase', {
                                fromIndex: obsCur,
                                timeoutMs: 4000,
                                predicate: (m) => m.target_user === driver.username && m.status === 'started'
                            })
                        ]);
                        assertEqual(obsEncRes.encounter_id, enc.encounter_id);
                        assertEqual(obsChase.target_car_id, 'car_1');
                    } finally {
                        await walker?.close();
                        await driver?.close();
                        await obs?.close();
                    }
                });
            }
        },
        {
            id: 'T3-06',
            name: 'Pairwise: Abort foot-cop proximity into car -> evade chase -> exit car -> trigger foot-cop encounter',
            tier: 3,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client, join } = await connectWs(srv.wsUrl, uniqueUsername('t3_mix'));
                    try {
                        const ps = await waitForPoliceState(client, (m) => m.foot_cops?.some((c) => c.state === 'patrol'), 4000);
                        const cop = ps.foot_cops.find((c) => c.state === 'patrol');
                        // Briefly step near foot cop then immediately jump into car_1 and speed
                        client.sendMovePedestrian({ x: cop.x + 5.0, y: 0, z: cop.z + 5.0, yaw: 0, anim: 'walk' });
                        await sleep(80);
                        const { chase, policeCarId } = await driveNearPatrolPoliceCar(client, {
                            carId: 'car_1',
                            speedMs: 22.0,
                            durationMs: 3500
                        });
                        assert(chase, 'speeding chase started');

                        // Evade chase
                        const pc = (client.latestPoliceState?.police_cars || []).find((c) => c.id === policeCarId);
                        const farX = pc && pc.x > 100 ? -10 : 285;
                        const farZ = pc && pc.z > 0 ? -160 : 160;
                        const cur = client.cursor();
                        let evaded = null;
                        const deadline = Date.now() + 20000;
                        while (Date.now() < deadline) {
                            evaded = client
                                .messagesSince(cur)
                                .find((m) => m.type === 'police_chase' && m.status === 'evaded' && m.target_user === client.username);
                            if (evaded) break;
                            client.sendMoveDriving({
                                car_id: 'car_1',
                                x: farX,
                                y: 0,
                                z: farZ,
                                speed: 4.0,
                                vx: 0,
                                vz: 4.0,
                                yaw: 0,
                                yaw_rate: 0,
                                drift: false,
                                lights: false
                            });
                            await sleep(100);
                        }
                        assert(evaded, 'chase evaded');
                        assertEqual(client.latestMoney, join.money ?? INITIAL_PLAYER_MONEY);

                        // Exit car onto promenade and trigger foot cop encounter
                        const enc = await triggerFootCopEncounter(client, { timeoutMs: 20000 });
                        assertCyrillic(enc.opening);
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T3-07',
            name: 'Pairwise: Occupied car hijack attempt during active chase rejected without disrupting chase',
            tier: 3,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    let alice = null;
                    let bob = null;
                    try {
                        ({ client: alice } = await connectWs(srv.wsUrl, uniqueUsername('t3_al')));
                        ({ client: bob } = await connectWs(srv.wsUrl, uniqueUsername('t3_bob')));
                        const { chase, policeCarId } = await driveNearPatrolPoliceCar(alice, {
                            carId: 'car_0',
                            speedMs: 22.0,
                            durationMs: 3500
                        });
                        assert(chase, 'alice chase started');

                        // Capture alice cursor BEFORE bob's hijack attempt so no stop event can be missed
                        const alCur = alice.cursor();

                        // Bob attempts to hijack car_0 mid-chase
                        const bobCur = bob.cursor();
                        bob.sendMoveDriving({
                            car_id: 'car_0',
                            x: 0,
                            y: 0,
                            z: 0,
                            speed: 0,
                            yaw: 0,
                            drift: false,
                            lights: false
                        });
                        const rejectMsg = await bob.waitForMessage(
                            (m) => m.type === 'move' && m.mode === 'driving' && m.car_id === 'car_0' && m.username === alice.username,
                            { fromIndex: bobCur, timeoutMs: 3000, desc: 'hijack rejection for car_0' }
                        );
                        assertEqual(rejectMsg.username, alice.username);

                        // Alice stops and takes fine cleanly
                        let stopped = null;
                        const deadline = Date.now() + 10000;
                        while (Date.now() < deadline) {
                            stopped = alice
                                .messagesSince(alCur)
                                .find((m) => m.type === 'police_chase' && m.status === 'stopped' && m.target_user === alice.username);
                            if (stopped) break;
                            const pc = (alice.latestPoliceState?.police_cars || []).find((c) => c.id === policeCarId);
                            if (pc) {
                                alice.sendMoveDriving({
                                    car_id: 'car_0',
                                    x: pc.x + 1.0,
                                    y: 0,
                                    z: pc.z + 1.0,
                                    speed: 0,
                                    vx: 0,
                                    vz: 0,
                                    yaw: 0,
                                    yaw_rate: 0,
                                    drift: false,
                                    lights: true
                                });
                            }
                            await sleep(50);
                        }
                        assert(stopped, 'alice chase still resolves cleanly with stop fine');
                        assertGreater(stopped.fine, 0);
                    } finally {
                        await alice?.close();
                        await bob?.close();
                    }
                });
            }
        },
        {
            id: 'T3-08',
            name: 'Pairwise: Interleaved reserved police frames, raw NaN, and bad option_index leave valid encounter healthy',
            tier: 3,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client, join } = await connectWs(srv.wsUrl, uniqueUsername('t3_adv'));
                    try {
                        const enc = await triggerFootCopEncounter(client, { timeoutMs: 12000 });
                        const startBal = client.latestMoney ?? join.money;

                        // Send reserved server types
                        for (const t of RESERVED_POLICE_TYPES) {
                            const cur = client.cursor();
                            client.send({ type: t });
                            const err = await client.waitForType('error', { fromIndex: cur, timeoutMs: 3000 });
                            assertIncludes(err.message.toLowerCase(), 'server reserved');
                        }

                        // Send raw NaN move
                        const nanCur = client.cursor();
                        client.sendRawFloat64({
                            type: 'move',
                            mode: 'pedestrian',
                            x: Number.NaN,
                            y: 0,
                            z: 0,
                            yaw: 0,
                            anim: 'idle'
                        });
                        await client.waitForType('error', { fromIndex: nanCur, timeoutMs: 3000 });

                        // Send invalid option_index
                        const optCur = client.cursor();
                        client.sendPoliceChoice(enc.encounter_id, 42);
                        await client.waitForType('error', { fromIndex: optCur, timeoutMs: 3000 });

                        // Valid choice still resolves encounter with exact arithmetic
                        const validOpt = enc.options[enc.options.length - 1];
                        const okCur = client.cursor();
                        client.sendPoliceChoice(enc.encounter_id, validOpt.index);
                        const res = await client.waitForType('police_encounter_result', {
                            fromIndex: okCur,
                            timeoutMs: 4000,
                            predicate: (m) => m.encounter_id === enc.encounter_id
                        });
                        assertEqual(res.money, startBal - validOpt.fine);
                    } finally {
                        await client.close();
                    }
                });
            }
        }
    ];
}
