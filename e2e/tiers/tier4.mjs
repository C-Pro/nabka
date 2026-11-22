/**
 * Tier 4: Real-World Multi-Browser & End-to-End Application Scenarios (>= 6 cases).
 * Exercises headless Chromium (SwiftShader WebGL), real keyboard/DOM controls,
 * and concurrent WebSocket synchronization without console or page errors.
 */
import {
    assert,
    assertCyrillic,
    assertEqual,
    assertGreater,
    assertGreaterOrEqual,
    assertLess,
    assertLessOrEqual
} from '../lib/assert.mjs';
import { withServer } from '../lib/server.mjs';
import { connectWs, uniqueUsername } from '../lib/ws-client.mjs';
import {
    INITIAL_PLAYER_MONEY,
    drainBalanceToSmallPositive,
    incurFinesUntilBelow,
    sleep,
    waitForPoliceState
} from '../lib/helpers.mjs';
import {
    connectPreloadedGame,
    createTrackedPage,
    enterCarAndDrivePastSpeed,
    joinGame,
    launchBrowser,
    parseMoneyText,
    preloadGameScene,
    releaseMoveKeys,
    steerAndWalkTo
} from '../lib/playwright.mjs';

async function walkBrowserToNearestPatrolCop(page, obsClient, { timeoutMs = 40000, username = '' } = {}) {
    return steerAndWalkTo(page, 0, 0, {
        tolerance: 0.2,
        timeoutMs,
        sprint: true,
        stopWhen: () => {
            const modal = document.getElementById('npc-dialogue-modal');
            return Boolean(modal && !modal.classList.contains('hidden'));
        },
        targetFn: async () => {
            const pos = await page.evaluate(() => ({
                x: window.Player?.position?.x ?? 0,
                z: window.Player?.position?.z ?? 0
            }));
            const cops = (obsClient.latestPoliceState?.foot_cops || []).filter(
                (c) =>
                    c.state === 'patrol' ||
                    (c.state === 'approach' && (!username || !c.target_user || c.target_user === username))
            );
            if (cops.length === 0) return null;
            cops.sort((a, b) => Math.hypot(a.x - pos.x, a.z - pos.z) - Math.hypot(b.x - pos.x, b.z - pos.z));
            return { x: cops[0].x, z: cops[0].z };
        }
    });
}

async function clickHighestFineDialogueOption(page, obsClient = null, username = '', fromIndex = null) {
    await page.waitForFunction(
        () => {
            const modal = document.getElementById('npc-dialogue-modal');
            const btns = document.querySelectorAll('#npc-options-container button');
            return Boolean(modal && !modal.classList.contains('hidden') && btns.length >= 2);
        },
        null,
        { timeout: 6000 }
    );
    const waitFrom = typeof fromIndex === 'number' ? fromIndex : (obsClient ? obsClient.cursor() : 0);
    const chosenIdx = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('#npc-options-container button')];
        let bestIdx = btns.length - 1;
        let bestFine = -1;
        btns.forEach((btn, idx) => {
            const txt = btn.textContent || '';
            const m = txt.match(/(\d[\d\s\u00a0]*)\s*₽/);
            if (m) {
                const val = Number(m[1].replace(/[^\d]/g, ''));
                if (val > bestFine) {
                    bestFine = val;
                    bestIdx = idx;
                }
            }
        });
        return bestIdx;
    });
    const buttons = page.locator('#npc-options-container button');
    await buttons.nth(chosenIdx).click();

    let encRes = null;
    if (obsClient) {
        encRes = await obsClient.waitForType('police_encounter_result', {
            fromIndex: waitFrom,
            timeoutMs: 6000,
            predicate: (m) => !username || m.target_user === username
        });
    }

    // Wait for close button to unlock after resolution, then close and wait for modal to hide
    await page
        .waitForFunction(
            () => {
                const modal = document.getElementById('npc-dialogue-modal');
                if (!modal || modal.classList.contains('hidden')) return true;
                const btn = document.getElementById('btn-close-npc-chat');
                return Boolean(btn && !btn.disabled);
            },
            null,
            { timeout: 5000 }
        )
        .catch(() => {});

    const stillOpen = await page.evaluate(() => !document.getElementById('npc-dialogue-modal')?.classList.contains('hidden'));
    if (stillOpen) {
        await page.locator('#btn-close-npc-chat').click().catch(() => {});
        await page
            .waitForFunction(
                () => document.getElementById('npc-dialogue-modal')?.classList.contains('hidden'),
                null,
                { timeout: 4000 }
            )
            .catch(() => {});
    }
    return encRes;
}

const ROAD_CROSS_Z = [-80, -38, 82];

function computeRoadSteerTarget(telemetry, policeCar) {
    if (!policeCar) return { x: 23, z: telemetry.z < 80 ? telemetry.z + 30 : telemetry.z - 30 };
    // Stay on X=23 coastal road until aligned with a cross-road junction if policeCar is on eastern roads
    if (Math.abs(policeCar.x - 23) > 18 && Math.abs(telemetry.x - 23) < 14) {
        const bestCrossZ = [...ROAD_CROSS_Z].sort(
            (a, b) => Math.abs(a - policeCar.z) - Math.abs(b - policeCar.z)
        )[0];
        if (Math.abs(telemetry.z - bestCrossZ) > 12) {
            return { x: 23, z: bestCrossZ };
        }
    }
    return { x: policeCar.x, z: policeCar.z };
}

async function steerCarTowardPoint(page, telemetry, targetX, targetZ, { stuckState }) {
    const now = Date.now();
    if (!stuckState.anchor) {
        stuckState.anchor = { x: telemetry.x, z: telemetry.z, atMs: now };
    } else if (Math.hypot(telemetry.x - stuckState.anchor.x, telemetry.z - stuckState.anchor.z) >= 0.5) {
        stuckState.anchor = { x: telemetry.x, z: telemetry.z, atMs: now };
    } else if (now >= stuckState.evadeUntil && now - stuckState.anchor.atMs >= 1500) {
        stuckState.phase += 1;
        stuckState.evadeUntil = now + 750;
        stuckState.anchor = { x: telemetry.x, z: telemetry.z, atMs: now + 750 };
    }

    if (now < stuckState.evadeUntil) {
        await page.keyboard.up('KeyW');
        await page.keyboard.down('KeyS');
        if (stuckState.phase % 2 === 1) {
            await page.keyboard.up('KeyD');
            await page.keyboard.down('KeyA');
        } else {
            await page.keyboard.up('KeyA');
            await page.keyboard.down('KeyD');
        }
        return;
    }

    await page.keyboard.up('KeyS');
    await page.keyboard.down('KeyW');

    const distToTarget = Math.hypot(targetX - telemetry.x, targetZ - telemetry.z);
    const desiredYaw = Math.atan2(targetX - telemetry.x, targetZ - telemetry.z);
    let yawDiff = desiredYaw - telemetry.yaw;
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
    if (distToTarget > 22 && Math.abs(yawDiff) < 0.35) {
        await page.keyboard.down('ShiftLeft');
    } else {
        await page.keyboard.up('ShiftLeft');
    }
    if (yawDiff > 0.1) {
        await page.keyboard.up('KeyD');
        await page.keyboard.down('KeyA');
    } else if (yawDiff < -0.1) {
        await page.keyboard.up('KeyA');
        await page.keyboard.down('KeyD');
    } else {
        await page.keyboard.up('KeyA');
        await page.keyboard.up('KeyD');
    }
}

async function driveBrowserCarTowardPoliceAndSpeed(
    page,
    obsClient,
    carId = null,
    { timeoutMs = 45000, fromIndex = null } = {}
) {
    const msgCur = typeof fromIndex === 'number' ? fromIndex : obsClient.cursor();
    const enterInfo = await enterCarAndDrivePastSpeed(page, carId, 44, {
        timeoutMs: 35000,
        holdAfterSpeedMs: 100,
        walkTimeoutMs: 120000
    });
    const actualCarId = enterInfo.carId || carId;

    const deadline = Date.now() + timeoutMs;
    const stuckState = { anchor: null, evadeUntil: 0, phase: 0 };
    try {
        await page.bringToFront().catch(() => {});
        await page.keyboard.down('KeyW');
        await page.keyboard.down('ShiftLeft');
        while (Date.now() < deadline) {
            const chaseStarted = obsClient
                .messagesSince(msgCur)
                .find((m) => m.type === 'police_chase' && m.target_car_id === actualCarId && m.status === 'started');
            if (chaseStarted) return chaseStarted;

            const telemetry = await page.evaluate(() => {
                const v = window.GAME_STATE?.inVehicle;
                return {
                    x: v?.x ?? 0,
                    z: v?.z ?? 0,
                    yaw: v?.yaw ?? 0,
                    speedMs: v?.speed ?? 0,
                    hasFocus: document.hasFocus()
                };
            });
            if (!telemetry.hasFocus) {
                await page.bringToFront().catch(() => {});
            }

            const cars = [...(obsClient.latestPoliceState?.police_cars || [])];
            // Prefer police car near X=23 or closest overall
            cars.sort((a, b) => {
                const scoreA = Math.hypot(a.x - telemetry.x, a.z - telemetry.z) + (Math.abs(a.x - 23) < 15 ? 0 : 40);
                const scoreB = Math.hypot(b.x - telemetry.x, b.z - telemetry.z) + (Math.abs(b.x - 23) < 15 ? 0 : 40);
                return scoreA - scoreB;
            });
            const target = cars[0];
            const aim = computeRoadSteerTarget(telemetry, target);
            await steerCarTowardPoint(page, telemetry, aim.x, aim.z, { stuckState });
            await page.waitForTimeout(70);
        }
        throw new Error('Timed out waiting for police_chase started in browser driving scenario');
    } finally {
        await releaseMoveKeys(page);
    }
}

export function getTier4Tests() {
    return [
        {
            id: 'T4-01',
            name: 'Scenario 1: Dual headless Chromium browsers join, render WebGL world & patrolling police',
            tier: 4,
            async run({ binaryPath, headed }) {
                await withServer({ binaryPath }, async (srv) => {
                    const browser = await launchBrowser({ headed });
                    const pA = await createTrackedPage(browser);
                    const pB = await createTrackedPage(browser);
                    const { client: obs } = await connectWs(srv.wsUrl, uniqueUsername('t4_obs1'));
                    try {
                        const userA = uniqueUsername('brA');
                        const userB = uniqueUsername('brB');
                        await joinGame(pA.page, srv.baseUrl, userA);
                        await joinGame(pB.page, srv.baseUrl, userB);

                        const ps1 = await waitForPoliceState(obs, null, 4000);
                        assertGreaterOrEqual(ps1.foot_cops.length, 1);
                        assertGreaterOrEqual(ps1.police_cars.length, 1);

                        await sleep(900);
                        const [hudA, hudB, canvasCheckA, canvasCheckB] = await Promise.all([
                            pA.page.textContent('#hud-money'),
                            pB.page.textContent('#hud-money'),
                            pA.page.evaluate(() => {
                                const c = document.getElementById('three-canvas');
                                return Boolean(c && c.width > 0 && c.height > 0 && window.World?.scene);
                            }),
                            pB.page.evaluate(() => {
                                const c = document.getElementById('three-canvas');
                                return Boolean(c && c.width > 0 && c.height > 0 && window.World?.scene);
                            })
                        ]);

                        assert(canvasCheckA && canvasCheckB, 'WebGL canvas rendered on both browsers');
                        assertEqual(parseMoneyText(hudA), INITIAL_PLAYER_MONEY);
                        assertEqual(parseMoneyText(hudB), INITIAL_PLAYER_MONEY);
                        pA.assertClean('T4-01-A');
                        pB.assertClean('T4-01-B');
                    } finally {
                        await obs.close();
                        await pA.close();
                        await pB.close();
                        await browser.close();
                    }
                });
            }
        },
        {
            id: 'T4-02',
            name: 'Scenario 2: Browser pedestrian walks to foot cop -> unsolicited Russian dialogue opens, locks movement, choice deducts #hud-money',
            tier: 4,
            async run({ binaryPath, headed }) {
                await withServer({ binaryPath }, async (srv) => {
                    const browser = await launchBrowser({ headed });
                    const pA = await createTrackedPage(browser);
                    const { client: obs } = await connectWs(srv.wsUrl, uniqueUsername('t4_obs2'));
                    try {
                        const userA = uniqueUsername('walkA');
                        await joinGame(pA.page, srv.baseUrl, userA);
                        await waitForPoliceState(obs, (m) => m.foot_cops?.some((c) => c.state === 'patrol'), 4000);

                        await walkBrowserToNearestPatrolCop(pA.page, obs, { timeoutMs: 40000 });
                        await pA.page.waitForFunction(
                            () => !document.getElementById('npc-dialogue-modal')?.classList.contains('hidden'),
                            null,
                            { timeout: 6000 }
                        );

                        // Wait up to 400ms for residual sprint velocity to damp below 0.15 m/s before measuring KeyW lock
                        await pA.page
                            .waitForFunction(
                                () => Math.hypot(window.Player?.velocity?.x ?? 0, window.Player?.velocity?.z ?? 0) < 0.15,
                                null,
                                { timeout: 400 }
                            )
                            .catch(() => {});

                        const modalText = await pA.page.evaluate(() => ({
                            title: document.getElementById('npc-modal-name')?.textContent || '',
                            history: document.getElementById('npc-chat-history')?.textContent || '',
                            posX: window.Player?.position?.x ?? 0,
                            posZ: window.Player?.position?.z ?? 0
                        }));
                        assertCyrillic(modalText.title + ' ' + modalText.history, 'modal shows Russian police text');

                        // Movement input must be blocked while modal is open
                        await pA.page.keyboard.down('KeyW');
                        await pA.page.waitForTimeout(350);
                        await pA.page.keyboard.up('KeyW');
                        const afterKeyW = await pA.page.evaluate(() => ({
                            x: window.Player?.position?.x ?? 0,
                            z: window.Player?.position?.z ?? 0,
                            keyW: Boolean(window.GAME_STATE?.keys?.w)
                        }));
                        assertLess(
                            Math.hypot(afterKeyW.x - modalText.posX, afterKeyW.z - modalText.posZ),
                            0.25,
                            'KeyW movement blocked while police dialogue modal is open'
                        );
                        assertEqual(afterKeyW.keyW, false, 'GAME_STATE.keys.w remains false while dialogue modal is open');

                        const obsCur = obs.cursor();
                        const encRes = await clickHighestFineDialogueOption(pA.page, obs, userA, obsCur);
                        assert(encRes, 'received police_encounter_result');
                        const hudMoney = parseMoneyText(await pA.page.textContent('#hud-money'));
                        assertEqual(hudMoney, encRes.money, '#hud-money matches server police_encounter_result.money');
                        pA.assertClean('T4-02');
                    } finally {
                        await obs.close();
                        await pA.close();
                        await browser.close();
                    }
                });
            }
        },
        {
            id: 'T4-03',
            name: 'Scenario 3: Browser driver enters car_1 via KeyE, exceeds 40 km/h -> police chase, siren & heavy collision deflection',
            tier: 4,
            async run({ binaryPath, headed }) {
                await withServer({ binaryPath }, async (srv) => {
                    const browser = await launchBrowser({ headed });
                    const pDriver = await createTrackedPage(browser);
                    const { client: obs } = await connectWs(srv.wsUrl, uniqueUsername('t4_obs3'));
                    try {
                        const user = uniqueUsername('drvA');
                        await joinGame(pDriver.page, srv.baseUrl, user);
                        await waitForPoliceState(obs, (m) => m.police_cars?.some((c) => c.state === 'patrol'), 4000);

                        const obsCur = obs.cursor();
                        const chase = await driveBrowserCarTowardPoliceAndSpeed(pDriver.page, obs, 'car_1', {
                            timeoutMs: 45000,
                            fromIndex: obsCur
                        });
                        assertEqual(chase.status, 'started');
                        assertEqual(chase.target_user, user);

                        const speedHud = Number(await pDriver.page.textContent('#speed-value'));
                        assertGreater(speedHud, 40, 'speedometer HUD exceeded 40 km/h');

                        const pursuitVisible = await pDriver.page.evaluate(
                            () => !document.getElementById('police-pursuit-banner')?.classList.contains('hidden')
                        );
                        assert(pursuitVisible, '#police-pursuit-banner visible during active chase');

                        const ps = await waitForPoliceState(
                            obs,
                            (m) => (m.police_cars || []).some((pc) => pc.id === chase.police_car_id && pc.state === 'chase'),
                            4000
                        );
                        const chasingCar = ps.police_cars.find((pc) => pc.id === chase.police_car_id);
                        assertEqual(chasingCar.siren, true);

                        // Steer along road toward chasing police car to verify genuine heavy collision deflection
                        let impulseEvt = null;
                        let strongestImpulseEvt = null;
                        const collideDeadline = Date.now() + 28000;
                        const stuckState = { anchor: null, evadeUntil: 0, phase: 0 };
                        try {
                            await pDriver.page.bringToFront().catch(() => {});
                            while (Date.now() < collideDeadline) {
                                for (const m of obs.messagesSince(obsCur)) {
                                    if (m.type !== 'vehicle_impulse' || m.car_id !== 'car_1' || m.target_user !== user) {
                                        continue;
                                    }
                                    const magnitude = Math.hypot(m.dvx, m.dvz);
                                    if (
                                        !strongestImpulseEvt ||
                                        magnitude > Math.hypot(strongestImpulseEvt.dvx, strongestImpulseEvt.dvz)
                                    ) {
                                        strongestImpulseEvt = m;
                                    }
                                    if (magnitude > 0.1) {
                                        impulseEvt = m;
                                        break;
                                    }
                                }
                                if (impulseEvt) break;

                                const telemetry = await pDriver.page.evaluate(() => {
                                    const v = window.GAME_STATE?.inVehicle;
                                    return {
                                        x: v?.x ?? 0,
                                        z: v?.z ?? 0,
                                        yaw: v?.yaw ?? 0,
                                        speedMs: v?.speed ?? 0,
                                        hasFocus: document.hasFocus()
                                    };
                                });
                                if (!telemetry.hasFocus) {
                                    await pDriver.page.bringToFront().catch(() => {});
                                }

                                const pc =
                                    (obs.latestPoliceState?.police_cars || []).find(
                                        (c) => c.id === chase.police_car_id
                                    ) || chasingCar;
                                const aim = computeRoadSteerTarget(telemetry, pc);
                                await steerCarTowardPoint(pDriver.page, telemetry, aim.x, aim.z, { stuckState });
                                await pDriver.page.waitForTimeout(70);
                            }
                        } finally {
                            await releaseMoveKeys(pDriver.page);
                        }
                        impulseEvt ||= strongestImpulseEvt;

                        assert(impulseEvt, 'received vehicle_impulse from browser heavy police collision');
                        assertEqual(impulseEvt.police_car_id, chase.police_car_id);
                        assertEqual(impulseEvt.police_mass, 4200, 'police car mass = 4200 kg');
                        assertLess(impulseEvt.player_mass, 2000, 'player car mass < 2000 kg');
                        assertGreater(
                            Math.hypot(impulseEvt.dvx, impulseEvt.dvz),
                            0.05,
                            'heavy police collision produced non-zero player deflection impulse'
                        );

                        pDriver.assertClean('T4-03');
                    } finally {
                        await obs.close();
                        await pDriver.close();
                        await browser.close();
                    }
                });
            }
        },
        {
            id: 'T4-04',
            name: 'Scenario 4: Pre-drained small positive balance crosses < 0 ₽ via real browser police fines in #hud-money',
            tier: 4,
            async run({ binaryPath, headed }) {
                await withServer({ binaryPath }, async (srv) => {
                    const user = uniqueUsername('negBr');
                    let wsPre = null;
                    let preToken = '';
                    let preMoney = 0;
                    try {
                        let join;
                        ({ client: wsPre, join } = await connectWs(srv.wsUrl, user));
                        preToken = join.token;
                        preMoney = await drainBalanceToSmallPositive(wsPre, {
                            minMoney: 1,
                            maxMoney: 2500,
                            timeoutMs: 240000
                        });
                    } finally {
                        await wsPre?.close();
                    }
                    assertGreater(preMoney, 0, 'pre-drained balance remains > 0 before browser session');
                    assertLessOrEqual(preMoney, 2500, 'pre-drained balance <= 2500 ₽');

                    const browser = await launchBrowser({ headed });
                    const pPlayer = await createTrackedPage(browser);
                    const { client: obs } = await connectWs(srv.wsUrl, uniqueUsername('t4_obs4'));
                    try {
                        // Seed saved token so Chromium resumes the small positive balance session
                        await pPlayer.page.goto(srv.baseUrl, { waitUntil: 'domcontentloaded' });
                        await pPlayer.page.evaluate(
                            ({ u, t }) => localStorage.setItem(`nabka_session_token_${u}`, t),
                            { u: user, t: preToken }
                        );
                        await joinGame(pPlayer.page, srv.baseUrl, user);
                        assertEqual(
                            parseMoneyText(await pPlayer.page.textContent('#hud-money')),
                            preMoney,
                            '#hud-money starts at small positive pre-drained balance'
                        );

                        const deadline = Date.now() + 90000;
                        while (Date.now() < deadline) {
                            const curMoney = parseMoneyText(await pPlayer.page.textContent('#hud-money'));
                            if (curMoney < 0) break;

                            const loopCur = obs.cursor();
                            const ps = obs.latestPoliceState || (await waitForPoliceState(obs, null, 4000));
                            const inVeh = await pPlayer.page.evaluate(() => Boolean(window.GAME_STATE?.inVehicle));
                            if (inVeh) {
                                await pPlayer.page.keyboard.press('KeyE');
                                await pPlayer.page.waitForTimeout(200);
                            }

                            const patrolCop = (ps.foot_cops || []).find((c) => c.state === 'patrol');
                            if (patrolCop) {
                                try {
                                    await walkBrowserToNearestPatrolCop(pPlayer.page, obs, { timeoutMs: 35000 });
                                    await clickHighestFineDialogueOption(pPlayer.page, obs, user, loopCur);
                                    continue;
                                } catch {
                                    // fallback to speeding fine
                                }
                            }

                            const patrolCar = (ps.police_cars || []).find((c) => c.state === 'patrol');
                            if (patrolCar) {
                                try {
                                    const chase = await driveBrowserCarTowardPoliceAndSpeed(pPlayer.page, obs, null, {
                                        timeoutMs: 35000,
                                        fromIndex: loopCur
                                    });
                                    // Brake & wait for stop fine
                                    try {
                                        await pPlayer.page.keyboard.down('Space');
                                        await obs.waitForType('police_chase', {
                                            fromIndex: loopCur,
                                            timeoutMs: 12000,
                                            predicate: (m) =>
                                                m.target_user === user &&
                                                m.police_car_id === chase.police_car_id &&
                                                (m.status === 'stopped' || m.status === 'evaded')
                                        });
                                    } finally {
                                        await pPlayer.page.keyboard.up('Space').catch(() => {});
                                        await releaseMoveKeys(pPlayer.page);
                                    }
                                    continue;
                                } catch {
                                    await releaseMoveKeys(pPlayer.page);
                                }
                            }
                            await sleep(300);
                        }

                        const rawText = (await pPlayer.page.textContent('#hud-money')) || '';
                        const finalMoney = parseMoneyText(rawText);
                        assertLess(finalMoney, 0, `#hud-money went negative (text=${JSON.stringify(rawText)})`);
                        assert(/[-−]/.test(rawText), 'negative sign rendered in #hud-money');
                        pPlayer.assertClean('T4-04');
                    } finally {
                        await obs.close();
                        await pPlayer.close();
                        await browser.close();
                    }
                });
            }
        },
        {
            id: 'T4-05',
            name: 'Scenario 5: Browser reconnect with saved token (4408 replacement) restores negative #hud-money',
            tier: 4,
            async run({ binaryPath, headed }) {
                await withServer({ binaryPath }, async (srv) => {
                    const user = uniqueUsername('t4_rec');
                    let wsPre = null;
                    let browser = null;
                    let p1 = null;
                    let p2 = null;
                    try {
                        let join;
                        ({ client: wsPre, join } = await connectWs(srv.wsUrl, user));
                        const negMoney = await incurFinesUntilBelow(wsPre, 0, { timeoutMs: 240000 });
                        assertLess(negMoney, 0, 'precondition negative money');

                        browser = await launchBrowser({ headed });
                        p1 = await createTrackedPage(browser);
                        p2 = await createTrackedPage(browser);

                        // Browser 1 replaces WS with saved token (4408)
                        await p1.page.goto(srv.baseUrl, { waitUntil: 'domcontentloaded' });
                        await p1.page.evaluate(
                            ({ u, t }) => localStorage.setItem(`nabka_session_token_${u}`, t),
                            { u: user, t: join.token }
                        );
                        await joinGame(p1.page, srv.baseUrl, user);
                        const closeInfo = await wsPre.waitForClose(4000);
                        assertEqual(closeInfo.code, 4408);
                        assertEqual(parseMoneyText(await p1.page.textContent('#hud-money')), negMoney);

                        // Browser 2 replaces Browser 1 with same token -> restores exact negative balance
                        const p1Token = await p1.page.evaluate((u) => localStorage.getItem(`nabka_session_token_${u}`), user);
                        await p2.page.goto(srv.baseUrl, { waitUntil: 'domcontentloaded' });
                        await p2.page.evaluate(
                            ({ u, t }) => localStorage.setItem(`nabka_session_token_${u}`, t),
                            { u: user, t: p1Token }
                        );
                        await joinGame(p2.page, srv.baseUrl, user);
                        assertEqual(parseMoneyText(await p2.page.textContent('#hud-money')), negMoney);
                        p1.assertClean('T4-05-p1');
                        p2.assertClean('T4-05-p2');
                    } finally {
                        await wsPre?.close();
                        await p1?.close();
                        await p2?.close();
                        await browser?.close();
                    }
                });
            }
        },
        {
            id: 'T4-06',
            name: 'Scenario 6: Concurrent two-browser session (foot encounter + car speeding chase) with zero errors',
            tier: 4,
            async run({ binaryPath, headed }) {
                await withServer({ binaryPath }, async (srv) => {
                    const browser = await launchBrowser({ headed });
                    const pWalker = await createTrackedPage(browser);
                    const pDriver = await createTrackedPage(browser);
                    const { client: obs } = await connectWs(srv.wsUrl, uniqueUsername('t4_obs6'));
                    try {
                        const walkerName = uniqueUsername('wlk6');
                        const driverName = uniqueUsername('drv6');
                        await preloadGameScene(pWalker.page, srv.baseUrl);
                        await preloadGameScene(pDriver.page, srv.baseUrl);
                        await connectPreloadedGame(pWalker.page, walkerName);
                        await connectPreloadedGame(pDriver.page, driverName);
                        await waitForPoliceState(obs, (m) => m.foot_cops?.length > 0 && m.police_cars?.length > 0, 4000);

                        const obsCur = obs.cursor();
                        // Run foot encounter in Browser 1 and car speeding chase in Browser 2 sequentially on same live session
                        // (bringing each page to front cleanly so Chromium focus/keyboard never conflict)
                        await pWalker.page.bringToFront();
                        await walkBrowserToNearestPatrolCop(pWalker.page, obs, { timeoutMs: 35000, username: walkerName });
                        const encRes = await clickHighestFineDialogueOption(pWalker.page, obs, walkerName, obsCur);
                        assert(encRes, 'walker police_encounter_result observed');
                        assertEqual(encRes.target_user, walkerName);

                        await pDriver.page.bringToFront();
                        const chaseCur = obs.cursor();
                        const chase = await driveBrowserCarTowardPoliceAndSpeed(pDriver.page, obs, null, {
                            timeoutMs: 45000,
                            fromIndex: chaseCur
                        });
                        assertEqual(chase.target_user, driverName);

                        pWalker.assertClean('T4-06-walker');
                        pDriver.assertClean('T4-06-driver');
                    } finally {
                        await obs.close();
                        await pWalker.close();
                        await pDriver.close();
                        await browser.close();
                    }
                });
            }
        }
    ];
}
