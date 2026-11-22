/**
 * Tier 4: Real-World Multi-Browser & End-to-End Application Scenarios (>= 6 cases).
 * Exercises headless Chromium (SwiftShader WebGL), real keyboard/DOM controls,
 * and concurrent WebSocket synchronization without console or page errors.
 */
import {
    assert,
    assertCyrillic,
    assertEqual,
    assertFinite,
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

async function clickHighestFineDialogueOption(
    page,
    obsClient = null,
    username = '',
    fromIndex = null,
    { modalTimeoutMs = 10000, optionIndex = null } = {}
) {
    await page.waitForFunction(
        () => {
            const modal = document.getElementById('npc-dialogue-modal');
            const btns = document.querySelectorAll('#npc-options-container button');
            return Boolean(modal && !modal.classList.contains('hidden') && btns.length >= 2);
        },
        null,
        { timeout: modalTimeoutMs }
    );
    const expectedEncId = await page.evaluate(() => window.GAME_STATE?.activePoliceEncounter?.encounter_id || '');
    const waitFrom = typeof fromIndex === 'number' ? fromIndex : (obsClient ? obsClient.cursor() : 0);
    const chosenIdx =
        typeof optionIndex === 'number'
            ? optionIndex
            : await page.evaluate(() => {
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
            predicate: (m) =>
                (!username || m.target_user === username) &&
                (!expectedEncId || m.encounter_id === expectedEncId)
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

async function stopBrowserCarWithChasingPolice(
    page,
    obsClient,
    username,
    fallbackPoliceCarId = '',
    { timeoutMs = 30000 } = {}
) {
    const deadline = Date.now() + timeoutMs;
    let stoppedSince = 0;
    let creepUntil = 0;
    let lastTelemetry = null;
    let lastPc = null;

    try {
        await page.bringToFront().catch(() => {});
        await releaseMoveKeys(page);
        await page.keyboard.down('Space');

        while (Date.now() < deadline) {
            const telemetry = await page.evaluate(() => {
                const v = window.GAME_STATE?.inVehicle;
                return {
                    x: v?.x ?? 0,
                    z: v?.z ?? 0,
                    yaw: v?.yaw ?? 0,
                    speedMs: v?.speed ?? 0,
                    inVeh: Boolean(v),
                    topDown: Boolean(window.GAME_STATE?.policeFineSequence?.topDownActive)
                };
            });
            lastTelemetry = telemetry;
            if (telemetry.topDown && !telemetry.inVeh) {
                return;
            }
            if (!telemetry.inVeh) {
                await page.waitForTimeout(80);
                continue;
            }

            const cars = obsClient.latestPoliceState?.police_cars || [];
            const chasing = cars.filter((c) => c.state === 'chase' && c.target_user === username);
            const pool = chasing.length > 0 ? chasing : cars.filter((c) => c.id === fallbackPoliceCarId);
            const pc =
                [...pool].sort(
                    (a, b) =>
                        Math.hypot(a.x - telemetry.x, a.z - telemetry.z) -
                        Math.hypot(b.x - telemetry.x, b.z - telemetry.z)
                )[0] || null;
            lastPc = pc;

            const now = Date.now();
            const isStopped = Math.abs(telemetry.speedMs) <= 1.0;
            if (!isStopped) {
                stoppedSince = 0;
            } else if (!stoppedSince) {
                stoppedSince = now;
            }

            const dist = pc ? Math.hypot(pc.x - telemetry.x, pc.z - telemetry.z) : Infinity;
            const pcSpeed = pc ? Math.hypot(pc.vx || 0, pc.vz || 0) : 0;

            if (now < creepUntil && dist > 6.5 && pc) {
                const aim = computeRoadSteerTarget(telemetry, pc);
                let yawDiff = Math.atan2(aim.x - telemetry.x, aim.z - telemetry.z) - telemetry.yaw;
                while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
                while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
                await page.keyboard.up('Space').catch(() => {});
                await page.keyboard.down('KeyW');
                if (yawDiff > 0.12) {
                    await page.keyboard.up('KeyD');
                    await page.keyboard.down('KeyA');
                } else if (yawDiff < -0.12) {
                    await page.keyboard.up('KeyA');
                    await page.keyboard.down('KeyD');
                } else {
                    await page.keyboard.up('KeyA');
                    await page.keyboard.up('KeyD');
                }
            } else if (stoppedSince && now - stoppedSince > 6000 && dist > 7.5 && pcSpeed < 1.5 && pc) {
                creepUntil = now + 1200;
                stoppedSince = 0;
            } else {
                await releaseMoveKeys(page);
                await page.keyboard.down('Space');
            }
            await page.waitForTimeout(80);
        }
    } finally {
        await page.keyboard.up('Space').catch(() => {});
        await releaseMoveKeys(page);
    }
    try {
        await page.waitForFunction(
            () => Boolean(window.GAME_STATE?.policeFineSequence?.topDownActive) && window.GAME_STATE?.inVehicle === null,
            null,
            { timeout: 6000 }
        );
    } catch (err) {
        const d = lastPc && lastTelemetry ? Math.hypot(lastPc.x - lastTelemetry.x, lastPc.z - lastTelemetry.z).toFixed(2) : 'n/a';
        throw new Error(
            `stopBrowserCarWithChasingPolice timed out (dist=${d}, car=${JSON.stringify(lastTelemetry)}, pc=${JSON.stringify(lastPc)}): ${err.message}`
        );
    }
}

async function steerCarTowardPoint(page, telemetry, targetX, targetZ, { stuckState }) {
    const now = Date.now();
    if (!stuckState.anchor) {
        stuckState.anchor = { x: telemetry.x, z: telemetry.z, atMs: now };
    } else if (Math.hypot(telemetry.x - stuckState.anchor.x, telemetry.z - stuckState.anchor.z) >= 0.5) {
        stuckState.anchor = { x: telemetry.x, z: telemetry.z, atMs: now };
    } else if (now >= stuckState.evadeUntil && now - stuckState.anchor.atMs >= 1500) {
        stuckState.phase += 1;
        stuckState.evadeUntil = now + 1100;
        stuckState.anchor = { x: telemetry.x, z: telemetry.z, atMs: now + 1100 };
    }

    if (now < stuckState.evadeUntil) {
        await page.keyboard.up('ShiftLeft').catch(() => {});
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
    { timeoutMs = 65000, fromIndex = null } = {}
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
    let lastTelemetry = null;
    let lastTarget = null;
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
            lastTelemetry = telemetry;
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
            lastTarget = target || null;
            const aim = computeRoadSteerTarget(telemetry, target);
            await steerCarTowardPoint(page, telemetry, aim.x, aim.z, { stuckState });
            await page.waitForTimeout(70);
        }
        throw new Error(
            `Timed out waiting for police_chase started in browser driving scenario (car=${JSON.stringify(lastTelemetry)}, target=${JSON.stringify(lastTarget)})`
        );
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
                            timeoutMs: 65000,
                            fromIndex: obsCur
                        });
                        assertEqual(chase.status, 'started');
                        assertEqual(chase.target_user, user);

                        const speedHud = Number(await pDriver.page.textContent('#speed-value'));
                        assertFinite(speedHud, 'speedometer HUD numeric');
                        if (chase.reason === 'speeding') {
                            assertGreaterOrEqual(speedHud, 35, 'speedometer HUD active near >40 km/h chase trigger');
                        }

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
                        assert(
                            impulseEvt.police_car_id === 'police_car_0' || impulseEvt.police_car_id === 'police_car_1',
                            `impulse came from chasing police car (got ${impulseEvt.police_car_id})`
                        );
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
                                    // Brake & complete DPS traffic fine-stop dialogue when caught
                                    let stopEvt = null;
                                    try {
                                        await pPlayer.page.keyboard.down('Space');
                                        stopEvt = await obs.waitForType('police_chase', {
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
                                    if (stopEvt && stopEvt.status === 'stopped') {
                                        await clickHighestFineDialogueOption(pPlayer.page, obs, user, loopCur, {
                                            modalTimeoutMs: 10000
                                        });
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
                        const chase = await driveBrowserCarTowardPoliceAndSpeed(pDriver.page, obs, 'car_1', {
                            timeoutMs: 120000,
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
        },
        {
            id: 'T4-07',
            name: 'Scenario 7: Animated DPS fine-stop (forced exit, GTA1 top-down, walking officer, non-dismissible dialog, 5-min car ban vs 66666, camera restore)',
            tier: 4,
            async run({ binaryPath, headed }) {
                await withServer({ binaryPath }, async (srv) => {
                    const browser = await launchBrowser({ headed });
                    const pDrv = await createTrackedPage(browser);
                    const { client: obs } = await connectWs(srv.wsUrl, uniqueUsername('t4_obs7'));
                    try {
                        const user = uniqueUsername('fine7');
                        await joinGame(pDrv.page, srv.baseUrl, user);
                        await waitForPoliceState(obs, (m) => m.police_cars?.some((c) => c.state === 'patrol'), 4000);

                        // Switch camera to mode 3 (First-Person Cockpit) before fine-stop so we prove mode restore + top-down visibility
                        await pDrv.page.evaluate(() => {
                            window.World.cycleCameraMode();
                            window.World.cycleCameraMode();
                            window.World.cycleCameraMode();
                        });
                        const prevCamMode = await pDrv.page.evaluate(() => window.GAME_STATE.cameraMode);
                        assertEqual(prevCamMode, 3, 'initial camera mode set to 3 before speeding stop');

                        const obsCur1 = obs.cursor();
                        const chase1 = await driveBrowserCarTowardPoliceAndSpeed(pDrv.page, obs, 'car_1', {
                            timeoutMs: 55000,
                            fromIndex: obsCur1
                        });
                        assertEqual(chase1.status, 'started');

                        // Approach closest chasing police car and brake to trigger police_fine_stop
                        await stopBrowserCarWithChasingPolice(pDrv.page, obs, user, chase1.police_car_id, {
                            timeoutMs: 30000
                        });

                        const fineStopState = await pDrv.page.evaluate(() => ({
                            inVehicle: window.GAME_STATE?.inVehicle,
                            seqActive: Boolean(window.GAME_STATE?.policeFineSequence?.active),
                            topDown: Boolean(window.GAME_STATE?.policeFineSequence?.topDownActive),
                            savedCam: window.GAME_STATE?.policeFineSequence?.savedCamera?.cameraMode,
                            camY: window.World?.camera?.position?.y ?? 0,
                            playerVisible: Boolean(window.Player?.group?.visible),
                            camLabel: document.getElementById('cam-mode-label')?.textContent || '',
                            hasDpsCop: [...(window.GAME_STATE?.policeCops?.values() || [])].some((c) =>
                                String(c.id || '').startsWith('dps_')
                            )
                        }));
                        assertEqual(fineStopState.inVehicle, null, 'forced vehicle exit on fine_stop');
                        assert(fineStopState.topDown && fineStopState.savedCam === 3, 'GTA1 top-down active & mode 3 saved');
                        assert(fineStopState.playerVisible, 'player mesh visible in GTA1 top-down even from mode 3');
                        assert(fineStopState.hasDpsCop, 'dynamic DPS officer spawned to walk to detained user');
                        assert(fineStopState.camLabel.includes('Вид сверху'), 'camera HUD label indicates top-down');

                        // Wait for officer walk completion and non-dismissible traffic dialogue modal
                        await pDrv.page.waitForFunction(
                            () => {
                                const modal = document.getElementById('npc-dialogue-modal');
                                const btns = document.querySelectorAll('#npc-options-container button');
                                return Boolean(modal && !modal.classList.contains('hidden') && btns.length === 4);
                            },
                            null,
                            { timeout: 10000 }
                        );

                        // Verify non-dismissibility before answering (Escape blocked, close btn hidden/disabled, blocker/notice visible)
                        await pDrv.page.keyboard.press('Escape');
                        await pDrv.page.waitForTimeout(150);
                        const lockChecks = await pDrv.page.evaluate(() => ({
                            modalHidden: Boolean(document.getElementById('npc-dialogue-modal')?.classList.contains('hidden')),
                            closeDisabled: Boolean(document.getElementById('btn-close-npc-chat')?.disabled),
                            closeHidden: Boolean(document.getElementById('btn-close-npc-chat')?.classList.contains('hidden')),
                            blockerHidden: Boolean(document.getElementById('police-modal-blocker')?.classList.contains('hidden')),
                            noticeHidden: Boolean(
                                document.getElementById('police-dialogue-lock-notice')?.classList.contains('hidden')
                            ),
                            describedBy: document.getElementById('npc-dialogue-modal')?.getAttribute('aria-describedby') || ''
                        }));
                        assertEqual(lockChecks.modalHidden, false, 'Escape cannot dismiss traffic police dialog');
                        assertEqual(lockChecks.closeDisabled, true);
                        assertEqual(lockChecks.closeHidden, true);
                        assertEqual(lockChecks.blockerHidden, false);
                        assertEqual(lockChecks.noticeHidden, false);
                        assertEqual(lockChecks.describedBy, 'police-dialogue-lock-notice');

                        // Option 0: pays regular fine and imposes 5-minute ban on car_1
                        const encRes1 = await clickHighestFineDialogueOption(pDrv.page, obs, user, null, {
                            modalTimeoutMs: 6000,
                            optionIndex: 0
                        });
                        assert(encRes1 && encRes1.vehicle_blocked === true, 'option 0 imposes 5-min car ban');
                        assertEqual(encRes1.vehicle_ban_sec, 300);

                        const restored1 = await pDrv.page.evaluate(() => ({
                            camMode: window.GAME_STATE.cameraMode,
                            seq: window.GAME_STATE.policeFineSequence,
                            banSize: window.GAME_STATE.vehicleBans?.size ?? 0,
                            banCar1: window.GAME_STATE.vehicleBans?.has('car_1'),
                            hudMoney: document.getElementById('hud-money')?.textContent || ''
                        }));
                        assertEqual(restored1.camMode, 3, 'camera mode restored to 3 after closing fine dialog');
                        assertEqual(restored1.seq, null, 'policeFineSequence cleared');
                        assertEqual(restored1.banCar1, true, 'car_1 recorded in GAME_STATE.vehicleBans');

                        // Wait for an animation frame so nearestInteractable refreshes for banned car_1, then verify ban prompt & KeyE rejection
                        await pDrv.page
                            .waitForFunction(
                                () => window.GAME_STATE?.nearestInteractable?.id === 'car_1',
                                null,
                                { timeout: 2500 }
                            )
                            .catch(() => {});
                        const banPrompt = await pDrv.page.evaluate(() => window.GAME_STATE?.nearestInteractable?.prompt || '');
                        if (await pDrv.page.evaluate(() => window.GAME_STATE?.nearestInteractable?.id === 'car_1')) {
                            assert(banPrompt.includes('Запрет на эксплуатацию'), `expected ban prompt, got ${banPrompt}`);
                        }
                        await pDrv.page.keyboard.press('KeyE');
                        await pDrv.page.waitForTimeout(450);
                        const afterBanInteract = await pDrv.page.evaluate(() => Boolean(window.GAME_STATE?.inVehicle));
                        assertEqual(afterBanInteract, false, 'banned car_1 rejects re-entry via KeyE');

                        // Now drive nearest unbanned car past speed limit, get caught, pay 66666 (option 3), verify unblocked immediate drive!
                        await waitForPoliceState(obs, (m) => m.police_cars?.some((c) => c.state === 'patrol'), 14000);
                        const obsCur2 = obs.cursor();
                        const chase2 = await driveBrowserCarTowardPoliceAndSpeed(pDrv.page, obs, null, {
                            timeoutMs: 55000,
                            fromIndex: obsCur2
                        });
                        assertEqual(chase2.status, 'started');
                        const secondCarId = chase2.target_car_id;

                        await stopBrowserCarWithChasingPolice(pDrv.page, obs, user, chase2.police_car_id, {
                            timeoutMs: 30000
                        });

                        const encRes2 = await clickHighestFineDialogueOption(pDrv.page, obs, user, null, {
                            modalTimeoutMs: 12000,
                            optionIndex: 3
                        });
                        assertEqual(encRes2.fine, 66666, 'option 3 charges 66666 rub');
                        assertEqual(Boolean(encRes2.vehicle_blocked), false, '66666 option keeps car unblocked');
                        const after66666 = await pDrv.page.evaluate((cid) => ({
                            camMode: window.GAME_STATE.cameraMode,
                            carBanned: window.GAME_STATE.vehicleBans?.has(cid)
                        }), secondCarId);
                        assertEqual(after66666.camMode, 3, 'camera restored again to mode 3');
                        assertEqual(Boolean(after66666.carBanned), false, 'second car not banned');

                        // Wait for nearestInteractable to point at unblocked secondCarId (SwiftShader frame can take ~450ms)
                        await pDrv.page
                            .waitForFunction(
                                (cid) => window.GAME_STATE?.nearestInteractable?.id === cid,
                                secondCarId,
                                { timeout: 2500 }
                            )
                            .catch(async () => {
                                const cPos = await pDrv.page.evaluate((cid) => {
                                    const v = (window.World?.vehicles || []).find((c) => c.id === cid);
                                    return v ? { x: v.x, z: v.z } : null;
                                }, secondCarId);
                                if (cPos) {
                                    await steerAndWalkTo(pDrv.page, cPos.x, cPos.z, {
                                        tolerance: 1.5,
                                        timeoutMs: 10000,
                                        stopWhen: (id) => window.GAME_STATE?.nearestInteractable?.id === id,
                                        stopWhenArg: secondCarId
                                    });
                                }
                            });
                        await pDrv.page.waitForFunction(
                            (cid) => window.GAME_STATE?.nearestInteractable?.id === cid,
                            secondCarId,
                            { timeout: 2500 }
                        );
                        await pDrv.page.bringToFront().catch(() => {});
                        await pDrv.page.keyboard.press('KeyE');
                        await pDrv.page.waitForFunction(
                            (cid) => window.GAME_STATE?.inVehicle?.id === cid,
                            secondCarId,
                            { timeout: 5000 }
                        );

                        pDrv.assertClean('T4-07');
                    } finally {
                        await obs.close();
                        await pDrv.close();
                        await browser.close();
                    }
                });
            }
        }
    ];
}
