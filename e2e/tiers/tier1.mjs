/**
 * Tier 1: Category-Partition Functional E2E Suite (>= 30 cases, >= 5 per 6 feature areas).
 * Strictly opaque-box over HTTP, binary WebSocket MessagePack, and Playwright/DOM.
 */
import {
    assert,
    assertCyrillic,
    assertEqual,
    assertFinite,
    assertGreater,
    assertGreaterOrEqual,
    assertInSet,
    assertLess,
    assertLessOrEqual
} from '../lib/assert.mjs';
import { withServer } from '../lib/server.mjs';
import { connectWs, uniqueUsername } from '../lib/ws-client.mjs';
import {
    INITIAL_PLAYER_MONEY,
    POLICE_CAR_MASS,
    SPEED_LIMIT_MS,
    STANDARD_MAX_SPEED_MS,
    driveNearPatrolPoliceCar,
    incurFinesUntilBelow,
    sleep,
    startChaseAndCollide,
    triggerEncounterForScenario,
    triggerFootCopEncounter,
    waitForPoliceState
} from '../lib/helpers.mjs';
import { createTrackedPage, joinGame, launchBrowser, parseMoneyText } from '../lib/playwright.mjs';

const VALID_FOOT_COP_STATES = new Set(['patrol', 'approach', 'dialogue', 'cooldown']);
const VALID_POLICE_CAR_STATES = new Set(['patrol', 'chase', 'cooldown']);

export function getTier1Tests() {
    return [
        // =====================================================================
        // F1: Foot Cop Patrol & Unsolicited Approach (5 cases)
        // =====================================================================
        {
            id: 'T1-F1-01',
            name: 'F1.1: police_state baseline includes foot_cops with valid schema',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('t1f1'));
                    try {
                        const ps = await waitForPoliceState(client, null, 4000);
                        assertGreaterOrEqual(ps.sequence, 0, 'police_state.sequence');
                        assertFinite(ps.sample_time_ms, 'police_state.sample_time_ms');
                        assert(Array.isArray(ps.foot_cops), 'foot_cops must be an array');
                        assertGreaterOrEqual(ps.foot_cops.length, 1, 'foot_cops.length');
                        for (const cop of ps.foot_cops) {
                            assert(typeof cop.id === 'string' && cop.id.length > 0, 'cop.id');
                            assert(typeof cop.name === 'string' && cop.name.length > 0, 'cop.name');
                            assertFinite(cop.x, 'cop.x');
                            assertFinite(cop.y, 'cop.y');
                            assertFinite(cop.z, 'cop.z');
                            assertFinite(cop.vx, 'cop.vx');
                            assertFinite(cop.vz, 'cop.vz');
                            assertFinite(cop.yaw, 'cop.yaw');
                            assertInSet(cop.state, VALID_FOOT_COP_STATES, 'cop.state');
                            assert(typeof cop.anim === 'string', 'cop.anim');
                        }
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F1-02',
            name: 'F1.2: Idle foot cops actively patrol promenade without nearby players',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('t1f1'));
                    try {
                        // Place player far away in the sea/corner so no cop is triggered
                        client.sendMovePedestrian({ x: -60, y: 0, z: -150, yaw: 0, anim: 'idle' });
                        const ps1 = await waitForPoliceState(client, null, 4000);
                        const initialPos = new Map(ps1.foot_cops.map((c) => [c.id, { x: c.x, z: c.z }]));
                        await sleep(1200);
                        const cur = client.cursor();
                        const ps2 = await client.waitForType('police_state', { fromIndex: cur, timeoutMs: 3000 });
                        let movedCount = 0;
                        for (const cop of ps2.foot_cops) {
                            assertEqual(cop.state, 'patrol', `idle cop ${cop.id} state`);
                            assertGreaterOrEqual(cop.x, -15, `cop ${cop.id} patrol minX`);
                            assertLessOrEqual(cop.x, 295, `cop ${cop.id} patrol maxX`);
                            assertGreaterOrEqual(cop.z, -170, `cop ${cop.id} patrol minZ`);
                            assertLessOrEqual(cop.z, 170, `cop ${cop.id} patrol maxZ`);
                            const prev = initialPos.get(cop.id);
                            if (prev && Math.hypot(cop.x - prev.x, cop.z - prev.z) > 0.05) {
                                movedCount += 1;
                            }
                        }
                        assertGreaterOrEqual(movedCount, 1, 'at least one idle foot cop displaced while patrolling');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F1-03',
            name: 'F1.3: Pedestrian proximity triggers unsolicited police_encounter_start without interaction request',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('t1f1'));
                    try {
                        const enc = await triggerFootCopEncounter(client, { timeoutMs: 12000 });
                        assert(typeof enc.encounter_id === 'string' && enc.encounter_id.length > 0, 'encounter_id');
                        assert(typeof enc.cop_id === 'string' && enc.cop_id.length > 0, 'cop_id');
                        assert(typeof enc.cop_name === 'string' && enc.cop_name.length > 0, 'cop_name');
                        assert(typeof enc.scenario_id === 'string' && enc.scenario_id.length > 0, 'scenario_id');
                        assertEqual(enc.target_user, client.username, 'target_user');
                        assertCyrillic(enc.opening, 'encounter opening must be Russian');
                        assert(Array.isArray(enc.options) && enc.options.length >= 2, 'encounter options >= 2');
                        const ps = await waitForPoliceState(
                            client,
                            (m) =>
                                (m.foot_cops || []).some(
                                    (c) => c.id === enc.cop_id && (c.state === 'approach' || c.state === 'dialogue')
                                ),
                            2000
                        );
                        const cop = ps?.foot_cops?.find((c) => c.id === enc.cop_id);
                        assert(cop, 'encountering cop present in police_state');
                        assertInSet(cop.state, ['approach', 'dialogue'], 'cop state during encounter');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F1-04',
            name: 'F1.4: Unsolicited police_encounter_start is directed only to approached player',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    let alice = null;
                    let bob = null;
                    try {
                        ({ client: alice } = await connectWs(srv.wsUrl, uniqueUsername('alice')));
                        ({ client: bob } = await connectWs(srv.wsUrl, uniqueUsername('bob')));
                        bob.sendMovePedestrian({ x: -55, y: 0, z: 140, yaw: 0, anim: 'idle' });
                        const bobCursor = bob.cursor();
                        const enc = await triggerFootCopEncounter(alice, { timeoutMs: 20000 });
                        assertEqual(enc.target_user, alice.username, 'encounter targets alice');
                        await sleep(300);
                        const bobStarts = bob
                            .messagesSince(bobCursor)
                            .filter((m) => m.type === 'police_encounter_start');
                        assertEqual(bobStarts.length, 0, 'distant bob must not receive alice police_encounter_start');
                    } finally {
                        await alice?.close();
                        await bob?.close();
                    }
                });
            }
        },
        {
            id: 'T1-F1-05',
            name: 'F1.5: Resolving encounter transitions cop to cooldown and eventually back to patrol',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('t1f1'));
                    try {
                        const enc = await triggerFootCopEncounter(client, { timeoutMs: 12000 });
                        const cur = client.cursor();
                        client.sendPoliceChoice(enc.encounter_id, enc.options[0].index ?? 0);
                        await client.waitForType('police_encounter_result', {
                            fromIndex: cur,
                            timeoutMs: 4000,
                            predicate: (m) => m.encounter_id === enc.encounter_id
                        });
                        // Walk away so cop isn't blocked
                        client.sendMovePedestrian({ x: -45, y: 0, z: 145, yaw: 0, anim: 'idle' });

                        const afterRes = await client.waitForType('police_state', {
                            fromIndex: client.cursor(),
                            timeoutMs: 3000,
                            predicate: (ps) => {
                                const cop = (ps.foot_cops || []).find((c) => c.id === enc.cop_id);
                                return cop && (cop.state === 'cooldown' || cop.state === 'patrol');
                            }
                        });
                        const copAfter = afterRes.foot_cops.find((c) => c.id === enc.cop_id);
                        assertInSet(copAfter.state, ['cooldown', 'patrol'], 'post-resolution cop state');

                        // Wait for cop to return to patrol
                        const resumed = await waitForPoliceState(
                            client,
                            (ps) => (ps.foot_cops || []).some((c) => c.id === enc.cop_id && c.state === 'patrol'),
                            20000
                        );
                        const copResumed = resumed.foot_cops.find((c) => c.id === enc.cop_id);
                        assertEqual(copResumed.state, 'patrol', 'cop returned to patrol after cooldown');
                    } finally {
                        await client.close();
                    }
                });
            }
        },

        // =====================================================================
        // F2: Russian Police Dialogue Scenarios (5 cases)
        // =====================================================================
        {
            id: 'T1-F2-01',
            name: 'F2.1: HTTP /data/police_dialogues.json serves >=4 Russian scenarios with required IDs',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const res = await fetch(`${srv.baseUrl}/data/police_dialogues.json`);
                    assertEqual(res.status, 200, 'police_dialogues.json HTTP status');
                    const data = await res.json();
                    assert(Array.isArray(data.scenarios), 'scenarios must be an array');
                    assertGreaterOrEqual(data.scenarios.length, 4, 'scenarios.length >= 4');
                    const ids = new Set(data.scenarios.map((s) => s.id));
                    for (const reqId of ['person_search', 'weed_shakedown', 'document_check', 'public_order']) {
                        assert(ids.has(reqId), `Missing required scenario "${reqId}"`);
                    }
                    for (const s of data.scenarios) {
                        assertCyrillic(s.title, `${s.id}.title`);
                        assertCyrillic(s.opening, `${s.id}.opening`);
                        assert(Array.isArray(s.options) && s.options.length >= 2, `${s.id}.options`);
                        for (const opt of s.options) {
                            assertCyrillic(opt.text, `${s.id}.opt[${opt.index}].text`);
                            assertCyrillic(opt.reply, `${s.id}.opt[${opt.index}].reply`);
                            assertFinite(opt.fine, `${s.id}.opt[${opt.index}].fine`);
                        }
                    }
                });
            }
        },
        {
            id: 'T1-F2-02',
            name: 'F2.2: weed_shakedown requires payment on every option in data and live encounter',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const res = await fetch(`${srv.baseUrl}/data/police_dialogues.json`);
                    const data = await res.json();
                    const weed = data.scenarios.find((s) => s.id === 'weed_shakedown');
                    assert(weed, 'weed_shakedown scenario exists');
                    assertGreaterOrEqual(weed.options.length, 3, 'weed_shakedown has >= 3 options');
                    for (const opt of weed.options) {
                        assertGreater(opt.fine, 0, `weed_shakedown option ${opt.index} fine > 0`);
                    }

                    // Live-verify EVERY selectable option index (0, 1, 2, ...) via police_dialogue_choice
                    for (const expectedOpt of weed.options) {
                        let client = null;
                        try {
                            let join;
                            ({ client, join } = await connectWs(srv.wsUrl, uniqueUsername(`weed_${expectedOpt.index}`)));
                            const enc = await triggerEncounterForScenario(client, 'weed_shakedown', { maxAttempts: 24 });
                            assertEqual(enc.scenario_id, 'weed_shakedown');
                            assertEqual(enc.options.length, weed.options.length, 'live weed_shakedown option count');
                            for (const liveOpt of enc.options) {
                                assertGreater(liveOpt.fine, 0, `live weed_shakedown option ${liveOpt.index} fine > 0`);
                            }

                            const chosen = enc.options.find((o) => o.index === expectedOpt.index);
                            assert(chosen, `live option index ${expectedOpt.index} present`);
                            assertEqual(chosen.fine, expectedOpt.fine, `option ${expectedOpt.index} fine matches JSON`);

                            const balanceBefore = client.latestMoney ?? join.money;
                            const cur = client.cursor();
                            client.sendPoliceChoice(enc.encounter_id, chosen.index);
                            const [result, bal] = await Promise.all([
                                client.waitForType('police_encounter_result', {
                                    fromIndex: cur,
                                    timeoutMs: 4000,
                                    predicate: (m) => m.encounter_id === enc.encounter_id
                                }),
                                client.waitForType('balance_update', {
                                    fromIndex: cur,
                                    timeoutMs: 4000,
                                    predicate: (m) => m.username === client.username
                                })
                            ]);
                            assertGreater(result.fine, 0, `option ${chosen.index} result.fine > 0`);
                            assertEqual(result.fine, chosen.fine, `option ${chosen.index} result.fine`);
                            assertEqual(result.money, balanceBefore - chosen.fine, `option ${chosen.index} result.money`);
                            assertEqual(bal.delta, -chosen.fine, `option ${chosen.index} balance_update.delta`);
                            assertEqual(bal.money, result.money, `option ${chosen.index} balance_update.money`);
                        } finally {
                            await client?.close();
                        }
                    }
                });
            }
        },
        {
            id: 'T1-F2-03',
            name: 'F2.3: person_search live encounter delivers Russian opening, options, and reply',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('search'));
                    try {
                        const enc = await triggerEncounterForScenario(client, 'person_search', { maxAttempts: 16 });
                        assertEqual(enc.scenario_id, 'person_search');
                        assertCyrillic(enc.title, 'person_search title');
                        assertCyrillic(enc.opening, 'person_search opening');
                        const cur = client.cursor();
                        client.sendPoliceChoice(enc.encounter_id, enc.options[0].index ?? 0);
                        const result = await client.waitForType('police_encounter_result', {
                            fromIndex: cur,
                            timeoutMs: 4000,
                            predicate: (m) => m.encounter_id === enc.encounter_id
                        });
                        assertCyrillic(result.reply_text, 'person_search reply_text');
                        assertGreaterOrEqual(result.fine, 0, 'person_search fine >= 0');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F2-04',
            name: 'F2.4: document_check and public_order scenarios validate Russian options and live choices',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const res = await fetch(`${srv.baseUrl}/data/police_dialogues.json`);
                    const data = await res.json();
                    for (const id of ['document_check', 'public_order']) {
                        const sc = data.scenarios.find((s) => s.id === id);
                        assert(sc, `${id} exists`);
                        sc.options.forEach((opt, i) => {
                            assertEqual(opt.index, i, `${id} sequential index`);
                            assertGreaterOrEqual(opt.fine, 0, `${id} non-negative fine`);
                            assertCyrillic(opt.text, `${id} option text`);
                            assertCyrillic(opt.reply, `${id} option reply`);
                        });

                        let client = null;
                        try {
                            ({ client } = await connectWs(srv.wsUrl, uniqueUsername(id.slice(0, 6))));
                            const enc = await triggerEncounterForScenario(client, id, { maxAttempts: 24 });
                            assertEqual(enc.scenario_id, id, `live scenario matched ${id}`);
                            assertCyrillic(enc.opening, `${id} live opening`);
                            const opt = enc.options[enc.options.length - 1];
                            const cur = client.cursor();
                            client.sendPoliceChoice(enc.encounter_id, opt.index);
                            const result = await client.waitForType('police_encounter_result', {
                                fromIndex: cur,
                                timeoutMs: 4000,
                                predicate: (m) => m.encounter_id === enc.encounter_id
                            });
                            assertEqual(result.scenario_id, id, `${id} result scenario_id`);
                            assertEqual(result.option_index, opt.index, `${id} result option_index`);
                            assertEqual(result.fine, opt.fine, `${id} result fine`);
                            assertCyrillic(result.reply_text, `${id} result reply_text`);
                        } finally {
                            await client?.close();
                        }
                    }
                });
            }
        },
        {
            id: 'T1-F2-05',
            name: 'F2.5: police_dialogue_choice broadcasts police_encounter_result and balance_update to observers',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    let player = null;
                    let obs = null;
                    try {
                        ({ client: player } = await connectWs(srv.wsUrl, uniqueUsername('p1')));
                        ({ client: obs } = await connectWs(srv.wsUrl, uniqueUsername('obs')));
                        obs.sendMovePedestrian({ x: -50, y: 0, z: 140, yaw: 0, anim: 'idle' });
                        const enc = await triggerFootCopEncounter(player, { timeoutMs: 12000 });
                        const finedOpt = [...enc.options].sort((a, b) => (b.fine || 0) - (a.fine || 0))[0];
                        assertGreater(finedOpt.fine, 0, 'selected option must have fine > 0');

                        const pCur = player.cursor();
                        const oCur = obs.cursor();
                        player.sendPoliceChoice(enc.encounter_id, finedOpt.index);

                        const [pRes, oRes, oBal] = await Promise.all([
                            player.waitForType('police_encounter_result', {
                                fromIndex: pCur,
                                timeoutMs: 4000,
                                predicate: (m) => m.encounter_id === enc.encounter_id
                            }),
                            obs.waitForType('police_encounter_result', {
                                fromIndex: oCur,
                                timeoutMs: 4000,
                                predicate: (m) => m.encounter_id === enc.encounter_id
                            }),
                            obs.waitForType('balance_update', {
                                fromIndex: oCur,
                                timeoutMs: 4000,
                                predicate: (m) => m.username === player.username
                            })
                        ]);

                        assertEqual(oRes.target_user, player.username);
                        assertEqual(oRes.fine, pRes.fine);
                        assertEqual(oRes.money, pRes.money);
                        assertEqual(oBal.delta, -finedOpt.fine);
                        assertEqual(oBal.money, pRes.money);
                    } finally {
                        await player?.close();
                        await obs?.close();
                    }
                });
            }
        },

        // =====================================================================
        // F3: Police Car Patrol & Speeding Chase (6 cases)
        // =====================================================================
        {
            id: 'T1-F3-01',
            name: 'F3.1: police_state baseline includes police_cars with mass=4200 and valid schema',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('pc1'));
                    try {
                        const ps = await waitForPoliceState(client, null, 4000);
                        assert(Array.isArray(ps.police_cars) && ps.police_cars.length >= 1, 'police_cars >= 1');
                        for (const pc of ps.police_cars) {
                            assert(typeof pc.id === 'string' && pc.id.length > 0, 'pc.id');
                            assertFinite(pc.x, 'pc.x');
                            assertFinite(pc.y, 'pc.y');
                            assertFinite(pc.z, 'pc.z');
                            assertFinite(pc.vx, 'pc.vx');
                            assertFinite(pc.vz, 'pc.vz');
                            assertFinite(pc.yaw, 'pc.yaw');
                            assertFinite(pc.yaw_rate, 'pc.yaw_rate');
                            assertFinite(pc.speed, 'pc.speed');
                            assertEqual(pc.mass, POLICE_CAR_MASS, 'police car mass');
                            assertInSet(pc.state, VALID_POLICE_CAR_STATES, 'pc.state');
                            assertEqual(typeof pc.siren, 'boolean', 'pc.siren boolean');
                            assertEqual(typeof pc.lights, 'boolean', 'pc.lights boolean');
                        }
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F3-02',
            name: 'F3.2: Idle police cars patrol road coordinates with siren=false',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('pc2'));
                    try {
                        const ps1 = await waitForPoliceState(client, null, 4000);
                        const initial = new Map(ps1.police_cars.map((c) => [c.id, { x: c.x, z: c.z }]));
                        await sleep(1200);
                        const ps2 = await client.waitForType('police_state', { fromIndex: client.cursor(), timeoutMs: 3000 });
                        let moved = 0;
                        for (const pc of ps2.police_cars) {
                            assertEqual(pc.state, 'patrol', `idle ${pc.id} state`);
                            assertEqual(pc.siren, false, `idle ${pc.id} siren false`);
                            const prev = initial.get(pc.id);
                            if (prev && Math.hypot(pc.x - prev.x, pc.z - prev.z) > 0.2) moved += 1;
                        }
                        assertGreaterOrEqual(moved, 1, 'at least one patrolling police car moved');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F3-03',
            name: 'F3.3: Driving > 40 km/h near police car triggers police_chase started and siren=true',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('spd'));
                    try {
                        const { chase, policeCarId } = await driveNearPatrolPoliceCar(client, {
                            carId: 'car_0',
                            speedMs: 18.0, // 64.8 km/h
                            durationMs: 3500
                        });
                        assert(chase, 'police_chase started event received');
                        assertEqual(chase.status, 'started');
                        assertEqual(chase.target_car_id, 'car_0');
                        assertEqual(chase.target_user, client.username);

                        const ps = await waitForPoliceState(
                            client,
                            (m) => (m.police_cars || []).some((c) => c.id === policeCarId && c.state === 'chase'),
                            3000
                        );
                        const chasing = ps.police_cars.find((c) => c.id === policeCarId);
                        assertEqual(chasing.state, 'chase');
                        assertEqual(chasing.siren, true);
                        assertEqual(chasing.lights, true);
                        assertEqual(chasing.target_car_id, 'car_0');
                        assertEqual(chasing.target_user, client.username);
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F3-04',
            name: 'F3.4: Chasing police car accelerates past patrol speed toward target car',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('pursuit'));
                    try {
                        const { chase, policeCarId, x, z } = await driveNearPatrolPoliceCar(client, {
                            carId: 'car_1',
                            speedMs: 22.0,
                            durationMs: 3500,
                            offsetDist: 14.0
                        });
                        assert(chase, 'chase started');
                        const targetX = x + 30;
                        const targetZ = z + 30;
                        let maxChaserSpeed = 0;
                        let prevDist = Infinity;
                        let closedGap = false;

                        for (let i = 0; i < 40; i++) {
                            client.sendMoveDriving({
                                car_id: 'car_1',
                                x: targetX,
                                y: 0,
                                z: targetZ,
                                speed: 15.0,
                                vx: 0,
                                vz: 15.0,
                                yaw: 0,
                                yaw_rate: 0,
                                drift: false,
                                lights: true
                            });
                            await sleep(50);
                            const pc = (client.latestPoliceState?.police_cars || []).find((c) => c.id === policeCarId);
                            if (pc && pc.state === 'chase') {
                                const spd = Math.hypot(pc.vx, pc.vz);
                                maxChaserSpeed = Math.max(maxChaserSpeed, spd, Math.abs(pc.speed));
                                const d = Math.hypot(targetX - pc.x, targetZ - pc.z);
                                if (d < prevDist - 0.5) closedGap = true;
                                prevDist = Math.min(prevDist, d);
                            }
                        }
                        assertGreater(maxChaserSpeed, SPEED_LIMIT_MS, 'chasing police car accelerates past 40 km/h');
                        assertLessOrEqual(maxChaserSpeed, 56.0, 'police car speed stays within vehicle top speed spec');
                        assert(closedGap, 'chasing police car moved closer to target coordinates');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F3-05',
            name: 'F3.5: Stopping near chasing police car ends chase with status=stopped and fine',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client, join } = await connectWs(srv.wsUrl, uniqueUsername('stop'));
                    try {
                        const cur = client.cursor();
                        const { chase, policeCarId } = await driveNearPatrolPoliceCar(client, {
                            carId: 'car_0',
                            speedMs: 22.0,
                            durationMs: 3500
                        });
                        assert(chase, 'chase started');

                        let stoppedEvt = null;
                        const deadline = Date.now() + 10000;
                        while (Date.now() < deadline) {
                            stoppedEvt = client
                                .messagesSince(cur)
                                .find((m) => m.type === 'police_chase' && m.target_user === client.username && m.status === 'stopped');
                            if (stoppedEvt) break;

                            const pc = (client.latestPoliceState?.police_cars || []).find((c) => c.id === policeCarId);
                            if (pc) {
                                client.sendMoveDriving({
                                    car_id: 'car_0',
                                    x: pc.x + 1.2,
                                    y: 0,
                                    z: pc.z + 1.2,
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
                        assert(stoppedEvt, 'expected police_chase status=stopped');
                        assertGreater(stoppedEvt.fine, 0, 'stopped chase applies fine > 0');
                        assertEqual(stoppedEvt.money, (join.money ?? INITIAL_PLAYER_MONEY) - stoppedEvt.fine);

                        const bal = await client.waitForType('balance_update', {
                            fromIndex: cur,
                            timeoutMs: 3000,
                            predicate: (m) => m.username === client.username
                        });
                        assertEqual(bal.delta, -stoppedEvt.fine);
                        assertEqual(bal.money, stoppedEvt.money);
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F3-06',
            name: 'F3.6: Escaping far out of range ends chase with status=evaded and fine=0',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client, join } = await connectWs(srv.wsUrl, uniqueUsername('evade'));
                    try {
                        const { chase, policeCarId } = await driveNearPatrolPoliceCar(client, {
                            carId: 'car_0',
                            speedMs: 24.0,
                            durationMs: 3500
                        });
                        assert(chase, 'chase started');

                        const pc = (client.latestPoliceState?.police_cars || []).find((c) => c.id === policeCarId);
                        const farX = pc && pc.x > 100 ? -12 : 285;
                        const farZ = pc && pc.z > 0 ? -160 : 160;
                        const cur = client.cursor();

                        let evadedEvt = null;
                        const deadline = Date.now() + 20000;
                        while (Date.now() < deadline) {
                            evadedEvt = client
                                .messagesSince(cur)
                                .find((m) => m.type === 'police_chase' && m.target_user === client.username && m.status === 'evaded');
                            if (evadedEvt) break;

                            client.sendMoveDriving({
                                car_id: 'car_0',
                                x: farX,
                                y: 0,
                                z: farZ,
                                speed: 4.0,
                                vx: 0,
                                vz: 4.0,
                                yaw: 0,
                                yaw_rate: 0,
                                drift: false,
                                lights: true
                            });
                            await sleep(100);
                        }
                        assert(evadedEvt, 'expected police_chase status=evaded');
                        assertEqual(evadedEvt.fine, 0, 'evaded chase fine must be 0');
                        assertEqual(evadedEvt.money, join.money ?? INITIAL_PLAYER_MONEY, 'money unchanged on evasion');
                    } finally {
                        await client.close();
                    }
                });
            }
        },

        // =====================================================================
        // F4: Heavy Vehicle Collision & Deflection Physics (5 cases)
        // =====================================================================
        {
            id: 'T1-F4-01',
            name: 'F4.1: Police car mass=4200 (>=2.5x standard cars) and observed chase speed matches CAR_SPECS',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('mass'));
                    try {
                        const ps = await waitForPoliceState(client, null, 4000);
                        const pc0 = ps.police_cars[0];
                        assertEqual(pc0.mass, 4200, 'police car mass');
                        assertGreaterOrEqual(pc0.mass / 1560, 2.5, 'mass ratio vs heaviest standard car >= 2.5x');
                        assertEqual(STANDARD_MAX_SPEED_MS, 44.44, 'standard car maxSpeedForward contract');

                        // Trigger a chase and stay ~15m ahead (<=20m boost threshold) to verify non-boosted pursuit speed capability
                        const { chase, policeCarId } = await driveNearPatrolPoliceCar(client, {
                            carId: 'car_0',
                            speedMs: 22.0,
                            durationMs: 3500,
                            offsetDist: 10.0
                        });
                        assert(chase, 'chase started for speed capability check');

                        let maxObservedSpeed = 0;
                        for (let i = 0; i < 65; i++) {
                            const latestPc = (client.latestPoliceState?.police_cars || []).find((c) => c.id === policeCarId);
                            if (latestPc) {
                                const spd = Math.max(Math.abs(latestPc.speed || 0), Math.hypot(latestPc.vx || 0, latestPc.vz || 0));
                                maxObservedSpeed = Math.max(maxObservedSpeed, spd);
                                const heading = latestPc.yaw || 0;
                                const leadX = Math.max(-10, Math.min(285, latestPc.x + Math.sin(heading) * 15.0));
                                const leadZ = Math.max(-155, Math.min(155, latestPc.z + Math.cos(heading) * 15.0));
                                client.sendMoveDriving({
                                    car_id: 'car_0',
                                    x: leadX,
                                    y: 0,
                                    z: leadZ,
                                    speed: STANDARD_MAX_SPEED_MS,
                                    vx: Math.sin(heading) * STANDARD_MAX_SPEED_MS,
                                    vz: Math.cos(heading) * STANDARD_MAX_SPEED_MS,
                                    yaw: heading,
                                    yaw_rate: 0,
                                    drift: false,
                                    lights: true
                                });
                            }
                            await sleep(50);
                        }
                        assertGreater(maxObservedSpeed, 25.0, 'chasing police car accelerates into standard highway speeds (> 90 km/h)');
                        assertLessOrEqual(
                            maxObservedSpeed,
                            STANDARD_MAX_SPEED_MS + 0.5,
                            'non-boosted police car top speed matches STANDARD_MAX_SPEED_MS (44.44 m/s)'
                        );
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F4-02',
            name: 'F4.2: Colliding with chasing police car emits vehicle_impulse with valid schema',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('imp'));
                    try {
                        const { impulse, policeCarId } = await startChaseAndCollide(client, { carId: 'car_0' });
                        assertEqual(impulse.police_car_id, policeCarId);
                        assertEqual(impulse.car_id, 'car_0');
                        assertEqual(impulse.target_user, client.username);
                        assertFinite(impulse.dvx, 'dvx');
                        assertFinite(impulse.dvz, 'dvz');
                        assertFinite(impulse.dyaw_rate, 'dyaw_rate');
                        assertEqual(impulse.police_mass, 4200);
                        assertGreater(impulse.player_mass, 0);
                        assertLess(impulse.player_mass, impulse.police_mass);
                        assertGreaterOrEqual(impulse.sequence, 1);
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F4-03',
            name: 'F4.3: Heavy collision impulse yields significantly larger player velocity deflection than police car',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('defl'));
                    try {
                        const cur = client.cursor();
                        const { impulse, policeCarId } = await startChaseAndCollide(client, { carId: 'car_1' });
                        const psCur = client.cursor();
                        // Ensure at least one post-impulse police_state snapshot is available
                        await waitForPoliceState(client, null, 2000, { fromIndex: psCur });

                        const msgs = client.messagesSince(cur);
                        const impIdx = msgs.findIndex(
                            (m) => m.type === 'vehicle_impulse' && m.car_id === 'car_1' && m.sequence === impulse.sequence
                        );
                        assertGreaterOrEqual(impIdx, 0, 'impulse event found in message history');

                        let psPre = null;
                        for (let i = impIdx - 1; i >= 0; i--) {
                            if (msgs[i].type === 'police_state') {
                                psPre = msgs[i];
                                break;
                            }
                        }
                        let psPost = null;
                        for (let i = impIdx + 1; i < msgs.length; i++) {
                            if (msgs[i].type === 'police_state') {
                                psPost = msgs[i];
                                break;
                            }
                        }
                        const pcPre = psPre?.police_cars?.find((c) => c.id === policeCarId);
                        const pcPost = psPost?.police_cars?.find((c) => c.id === policeCarId);
                        assert(pcPre && pcPost, 'pre- and post-collision police_state snapshots present');

                        const dvPlayer = Math.hypot(impulse.dvx, impulse.dvz);
                        const dvPolice = Math.hypot(pcPost.vx - pcPre.vx, pcPost.vz - pcPre.vz);
                        assertGreater(dvPlayer, 0.5, 'non-zero player deflection impulse magnitude');
                        const massRatio = impulse.police_mass / impulse.player_mass;
                        assertGreaterOrEqual(massRatio, 2.5, 'police_mass / player_mass >= 2.5x');
                        assertGreater(
                            dvPlayer,
                            dvPolice * 1.5,
                            `player deflection |Δv_player|=${dvPlayer.toFixed(2)} must significantly exceed police |Δv_police|=${dvPolice.toFixed(2)}`
                        );
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F4-04',
            name: 'F4.4: Repeated collisions emit strictly increasing vehicle_impulse.sequence',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('seq'));
                    try {
                        const { impulse: first, policeCarId } = await startChaseAndCollide(client, { carId: 'car_0' });
                        await sleep(250);
                        const cur = client.cursor();
                        let second = null;
                        const deadline = Date.now() + 8000;
                        while (Date.now() < deadline) {
                            second = client
                                .messagesSince(cur)
                                .find((m) => m.type === 'vehicle_impulse' && m.car_id === 'car_0');
                            if (second) break;
                            const pc = (client.latestPoliceState?.police_cars || []).find((c) => c.id === policeCarId);
                            if (pc) {
                                const oppYaw = Math.atan2(-Math.sin(pc.yaw || 0), -Math.cos(pc.yaw || 0));
                                client.sendMoveDriving({
                                    car_id: 'car_0',
                                    x: pc.x - Math.sin(oppYaw) * 1.6,
                                    y: 0,
                                    z: pc.z - Math.cos(oppYaw) * 1.6,
                                    speed: 20.0,
                                    vx: Math.sin(oppYaw) * 20.0,
                                    vz: Math.cos(oppYaw) * 20.0,
                                    yaw: oppYaw,
                                    yaw_rate: 0,
                                    drift: false,
                                    lights: true
                                });
                            }
                            await sleep(50);
                        }
                        assert(second, 'expected second vehicle_impulse');
                        assertGreater(second.sequence, first.sequence, 'impulse sequence must increase');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F4-05',
            name: 'F4.5: Collision deflection keeps car ownership intact and police_state velocities finite',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    let driver = null;
                    let obs = null;
                    try {
                        ({ client: driver } = await connectWs(srv.wsUrl, uniqueUsername('drv')));
                        ({ client: obs } = await connectWs(srv.wsUrl, uniqueUsername('obs')));
                        const { impulse, policeCarId } = await startChaseAndCollide(driver, { carId: 'car_2' });
                        assertEqual(impulse.target_user, driver.username);
                        const ps = await waitForPoliceState(obs, null, 3000);
                        const pc = ps.police_cars.find((c) => c.id === policeCarId);
                        assert(pc, 'police car still present post-collision');
                        assertFinite(pc.vx, 'post-collision pc.vx');
                        assertFinite(pc.vz, 'post-collision pc.vz');
                        assertFinite(pc.x, 'post-collision pc.x');
                        assertFinite(pc.z, 'post-collision pc.z');
                    } finally {
                        await driver?.close();
                        await obs?.close();
                    }
                });
            }
        },

        // =====================================================================
        // F5: Negative-Allowed Player Balance, Fines & HUD (5 cases)
        // =====================================================================
        {
            id: 'T1-F5-01',
            name: 'F5.1: join message initializes player money to 125400',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client, join } = await connectWs(srv.wsUrl, uniqueUsername('bal0'));
                    try {
                        assertEqual(join.money, INITIAL_PLAYER_MONEY, 'initial join.money');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F5-02',
            name: 'F5.2: Foot cop fine deducts from 125400 and emits balance_update with negative delta',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client, join } = await connectWs(srv.wsUrl, uniqueUsername('fine'));
                    try {
                        let enc = await triggerFootCopEncounter(client, { timeoutMs: 12000 });
                        let opt = [...enc.options].sort((a, b) => (b.fine || 0) - (a.fine || 0))[0];
                        if (!opt || opt.fine <= 0) {
                            enc = await triggerEncounterForScenario(client, 'weed_shakedown', { maxAttempts: 16 });
                            opt = enc.options[0];
                        }
                        const cur = client.cursor();
                        client.sendPoliceChoice(enc.encounter_id, opt.index);
                        const bal = await client.waitForType('balance_update', {
                            fromIndex: cur,
                            timeoutMs: 4000,
                            predicate: (m) => m.username === client.username
                        });
                        assertEqual(bal.delta, -opt.fine);
                        assertEqual(bal.money, join.money - opt.fine);
                        assert(typeof bal.reason === 'string' && bal.reason.length > 0, 'balance_update.reason');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F5-03',
            name: 'F5.3: Repeated police fines drive balance below 0 without clamping',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('neg'));
                    try {
                        const finalMoney = await incurFinesUntilBelow(client, 0, { timeoutMs: 240000 });
                        assertLess(finalMoney, 0, 'money went strictly negative');
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F5-04',
            name: 'F5.4: Speeding stop fine deducts balance and can cross from positive/zero to negative',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client } = await connectWs(srv.wsUrl, uniqueUsername('spdfine'));
                    try {
                        const balBeforeZero = await incurFinesUntilBelow(client, 10000, { timeoutMs: 240000 });
                        // Ensure we are driving past a patrolling police car and stop to take fine
                        const ps = await waitForPoliceState(
                            client,
                            (m) => (m.police_cars || []).some((pc) => pc.state === 'patrol'),
                            18000
                        );
                        assert(ps, 'patrol police car available');
                        const cur = client.cursor();
                        const { chase, policeCarId } = await driveNearPatrolPoliceCar(client, {
                            carId: 'car_3',
                            speedMs: 24.0,
                            durationMs: 3500
                        });
                        assert(chase, 'chase started');
                        const deadline = Date.now() + 10000;
                        let stopped = null;
                        while (Date.now() < deadline) {
                            stopped = client
                                .messagesSince(cur)
                                .find((m) => m.type === 'police_chase' && m.status === 'stopped' && m.target_user === client.username);
                            if (stopped) break;
                            const pc = (client.latestPoliceState?.police_cars || []).find((c) => c.id === policeCarId);
                            if (pc) {
                                client.sendMoveDriving({
                                    car_id: 'car_3',
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
                        assert(stopped, 'speeding stop completed');
                        assertGreater(stopped.fine, 0);
                        assertEqual(stopped.money, balBeforeZero - stopped.fine);
                    } finally {
                        await client.close();
                    }
                });
            }
        },
        {
            id: 'T1-F5-05',
            name: 'F5.5: HTTP static endpoints serve police assets and browser #hud-money formats negative balance',
            tier: 1,
            async run({ binaryPath, headed }) {
                await withServer({ binaryPath }, async (srv) => {
                    for (const assetPath of [
                        '/',
                        '/api/version',
                        '/data/police_dialogues.json',
                        '/models/police_officer.glb',
                        '/models/police_car.glb'
                    ]) {
                        const res = await fetch(`${srv.baseUrl}${assetPath}`);
                        assertEqual(res.status, 200, `GET ${assetPath}`);
                    }
                    const user = uniqueUsername('hud');
                    let client = null;
                    let token = '';
                    let negMoney = 0;
                    try {
                        let join;
                        ({ client, join } = await connectWs(srv.wsUrl, user));
                        token = client.lastJoin?.token || join.token;
                        negMoney = await incurFinesUntilBelow(client, 0, { timeoutMs: 240000 });
                    } finally {
                        await client?.close();
                    }

                    const browser = await launchBrowser({ headed });
                    const tracked = await createTrackedPage(browser);
                    try {
                        // Seed token in localStorage before joining so browser reclaims session with negative balance
                        await tracked.page.goto(srv.baseUrl, { waitUntil: 'domcontentloaded' });
                        await tracked.page.evaluate(
                            ({ u, t }) => {
                                localStorage.setItem(`nabka_session_token_${u}`, t);
                            },
                            { u: user, t: token }
                        );
                        await joinGame(tracked.page, srv.baseUrl, user);
                        const hudText = await tracked.page.textContent('#hud-money');
                        assertEqual(parseMoneyText(hudText), negMoney, 'HUD displays exact negative balance');
                        tracked.assertClean('T1-F5-05');
                    } finally {
                        await tracked.close();
                        await browser.close();
                    }
                });
            }
        },

        // =====================================================================
        // F6: Server Authority & Multiplayer / Reconnect Sync (5 cases)
        // =====================================================================
        {
            id: 'T1-F6-01',
            name: 'F6.1: Two WS clients observe identical police_state sequences and coordinates',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    let c1 = null;
                    let c2 = null;
                    try {
                        ({ client: c1 } = await connectWs(srv.wsUrl, uniqueUsername('sync1')));
                        ({ client: c2 } = await connectWs(srv.wsUrl, uniqueUsername('sync2')));
                        const ps1 = await waitForPoliceState(c1, (m) => m.sequence > 1, 4000);
                        const ps2 = await waitForPoliceState(c2, (m) => m.sequence === ps1.sequence, 4000);
                        assertEqual(ps2.foot_cops.length, ps1.foot_cops.length);
                        assertEqual(ps2.police_cars.length, ps1.police_cars.length);
                        assertEqual(ps2.foot_cops[0].x, ps1.foot_cops[0].x);
                        assertEqual(ps2.police_cars[0].x, ps1.police_cars[0].x);
                    } finally {
                        await c1?.close();
                        await c2?.close();
                    }
                });
            }
        },
        {
            id: 'T1-F6-02',
            name: 'F6.2: Late joiner after car movement & fines receives complete authoritative baseline',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const { client: c1 } = await connectWs(srv.wsUrl, uniqueUsername('early'));
                    try {
                        c1.sendMoveDriving({
                            car_id: 'car_4',
                            x: 32.0,
                            y: 0,
                            z: -20.0,
                            speed: 0,
                            yaw: 0,
                            drift: false,
                            lights: true
                        });
                        await sleep(150);
                        c1.sendMovePedestrian({ x: 20.0, y: 0, z: -20.0, yaw: 0, anim: 'idle' });
                        await sleep(150);

                        // Trigger an actual police fine on c1 before late joiner connects
                        const enc = await triggerEncounterForScenario(c1, 'weed_shakedown', { maxAttempts: 24 });
                        const finedOpt = [...enc.options].sort((a, b) => (b.fine || 0) - (a.fine || 0))[0];
                        assertGreater(finedOpt.fine, 0, 'fine option > 0');
                        const fineCur = c1.cursor();
                        c1.sendPoliceChoice(enc.encounter_id, finedOpt.index);
                        const encRes = await c1.waitForType('police_encounter_result', {
                            fromIndex: fineCur,
                            timeoutMs: 4000,
                            predicate: (m) => m.encounter_id === enc.encounter_id
                        });
                        assertLess(encRes.money, INITIAL_PLAYER_MONEY, 'c1 balance decreased after fine');

                        const { client: late, join: lateJoin } = await connectWs(srv.wsUrl, uniqueUsername('late'));
                        try {
                            assertEqual(lateJoin.money, INITIAL_PLAYER_MONEY);
                            const ps = await waitForPoliceState(late, null, 3000);
                            assertGreaterOrEqual(ps.foot_cops.length, 1);
                            assertGreaterOrEqual(ps.police_cars.length, 1);
                            const parkedCar = await late.waitForMessage(
                                (m) => m.type === 'move' && m.mode === 'driving' && m.car_id === 'car_4',
                                { timeoutMs: 3000, desc: 'late joiner car_4 baseline' }
                            );
                            assertEqual(parkedCar.username, '');
                            assertEqual(parkedCar.x, 32.0);
                            assertEqual(parkedCar.z, -20.0);
                        } finally {
                            await late.close();
                        }
                    } finally {
                        await c1.close();
                    }
                });
            }
        },
        {
            id: 'T1-F6-03',
            name: 'F6.3: Option A and Option B registration both receive join.money and police_state baseline',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    let optA = null;
                    let optB = null;
                    try {
                        let joinA, joinB;
                        ({ client: optA, join: joinA } = await connectWs(srv.wsUrl, uniqueUsername('optA'), { mode: 'A' }));
                        ({ client: optB, join: joinB } = await connectWs(srv.wsUrl, uniqueUsername('optB'), { mode: 'B' }));
                        assertEqual(joinA.money, INITIAL_PLAYER_MONEY);
                        assertEqual(joinB.money, INITIAL_PLAYER_MONEY);
                        const [psA, psB] = await Promise.all([
                            waitForPoliceState(optA, null, 3000),
                            waitForPoliceState(optB, null, 3000)
                        ]);
                        assert(Array.isArray(psA.foot_cops), 'Option A police_state');
                        assert(Array.isArray(psB.police_cars), 'Option B police_state');
                    } finally {
                        await optA?.close();
                        await optB?.close();
                    }
                });
            }
        },
        {
            id: 'T1-F6-04',
            name: 'F6.4: Token reconnect (4408 replacement) preserves negative balance and active encounter',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    const user = uniqueUsername('reconn');
                    const { client: c1, join: j1 } = await connectWs(srv.wsUrl, user);
                    try {
                        const negMoney = await incurFinesUntilBelow(c1, 0, { timeoutMs: 240000 });
                        const enc = await triggerFootCopEncounter(c1, { timeoutMs: 20000 });

                        const { client: c2, join: j2 } = await connectWs(srv.wsUrl, user, { token: j1.token });
                        try {
                            const closeInfo = await c1.waitForClose(3000);
                            assertEqual(closeInfo.code, 4408, 'old socket closed with 4408');
                            assertEqual(j2.money, negMoney, 'reconnect preserves negative balance');
                            const restoredEnc = await c2.waitForType('police_encounter_start', { timeoutMs: 4000 });
                            assertEqual(restoredEnc.encounter_id, enc.encounter_id, 'active encounter re-sent on reconnect');
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
            id: 'T1-F6-05',
            name: 'F6.5: police_chase and balance_update broadcast consistently to all connected clients',
            tier: 1,
            async run({ binaryPath }) {
                await withServer({ binaryPath }, async (srv) => {
                    let driver = null;
                    let obs = null;
                    try {
                        ({ client: driver } = await connectWs(srv.wsUrl, uniqueUsername('drv')));
                        ({ client: obs } = await connectWs(srv.wsUrl, uniqueUsername('obs')));
                        const obsCur = obs.cursor();
                        const { chase, policeCarId } = await driveNearPatrolPoliceCar(driver, {
                            carId: 'car_0',
                            speedMs: 22.0,
                            durationMs: 3500
                        });
                        assert(chase, 'driver got chase started');
                        const obsChase = await obs.waitForType('police_chase', {
                            fromIndex: obsCur,
                            timeoutMs: 4000,
                            predicate: (m) => m.target_user === driver.username && m.status === 'started'
                        });
                        assertEqual(obsChase.police_car_id, policeCarId);

                        // Stop to trigger fine broadcast
                        const deadline = Date.now() + 10000;
                        let obsBal = null;
                        while (Date.now() < deadline) {
                            obsBal = obs
                                .messagesSince(obsCur)
                                .find((m) => m.type === 'balance_update' && m.username === driver.username);
                            if (obsBal) break;
                            const pc = (driver.latestPoliceState?.police_cars || []).find((c) => c.id === policeCarId);
                            if (pc) {
                                driver.sendMoveDriving({
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
                        assert(obsBal, 'observer received balance_update on speeding fine');
                        assertLess(obsBal.delta, 0);
                    } finally {
                        await driver?.close();
                        await obs?.close();
                    }
                });
            }
        }
    ];
}
