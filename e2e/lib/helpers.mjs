/**
 * Shared opaque-box protocol helpers for E2E test tiers.
 */
import { assert, assertFinite } from './assert.mjs';

export const SPEED_LIMIT_KMH = 40;
export const SPEED_LIMIT_MS = SPEED_LIMIT_KMH / 3.6; // 11.11111111111111
export const POLICE_CAR_MASS = 4200;
export const STANDARD_MAX_SPEED_MS = 44.44;
export const INITIAL_PLAYER_MONEY = 125400;

export const RESERVED_POLICE_TYPES = [
    'balance_update',
    'police_state',
    'police_encounter_start',
    'police_encounter_result',
    'police_chase',
    'vehicle_impulse'
];

export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function movePedestrianOffPromenade(client) {
    client.sendMovePedestrian({ x: -55, y: 0, z: -150, vx: 0, vz: 0, yaw: 0, anim: 'idle' });
}

export async function waitForPoliceState(client, predicate = null, timeoutMs = 4000, { fromIndex = 0 } = {}) {
    return client.waitForMessage(
        (m) => m.type === 'police_state' && (!predicate || predicate(m)),
        { timeoutMs, fromIndex, desc: 'police_state' }
    );
}

/**
 * Moves pedestrian client toward a patrolling foot cop until police_encounter_start arrives.
 */
export async function triggerFootCopEncounter(
    client,
    { excludeCopIds = new Set(), targetCopId = null, timeoutMs = 20000 } = {}
) {
    if (client.lastEncounterEndedAt > 0) {
        const cdRem = 15300 - (Date.now() - client.lastEncounterEndedAt);
        if (cdRem > 0) {
            client.sendMovePedestrian({ x: -55, y: 0, z: -150, vx: 0, vz: 0, yaw: 0, anim: 'idle' });
            await sleep(cdRem);
        }
    }
    const startCursor = client.cursor();
    const ps = await waitForPoliceState(
        client,
        (m) =>
            Array.isArray(m.foot_cops) &&
            m.foot_cops.some((c) => c.state === 'patrol' && !excludeCopIds.has(c.id) && (!targetCopId || c.id === targetCopId)),
        timeoutMs
    );
    let targetCop =
        (targetCopId ? ps.foot_cops.find((c) => c.id === targetCopId && c.state === 'patrol') : null) ||
        ps.foot_cops.find((c) => c.state === 'patrol' && !excludeCopIds.has(c.id)) ||
        ps.foot_cops[0];
    assert(targetCop, 'Expected at least one foot cop in police_state');

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        // Check if encounter already arrived
        for (const m of client.messagesSince(startCursor)) {
            if (m.type === 'police_encounter_start' && m.target_user === client.username) {
                return m;
            }
        }
        const latest = client.latestPoliceState || ps;
        const otherCop = (latest.foot_cops || []).find(
            (c) => c.id !== targetCop.id && c.target_user === client.username
        );
        if (otherCop) {
            if (!targetCopId && !excludeCopIds.has(otherCop.id)) {
                targetCop = otherCop;
            } else {
                client.sendMovePedestrian({ x: -55, y: 0, z: -150, vx: 0, vz: 0, yaw: 0, anim: 'idle' });
                await sleep(60);
                continue;
            }
        }
        const cop = (latest.foot_cops || []).find((c) => c.id === targetCop.id) || targetCop;
        assertFinite(cop.x, 'cop.x');
        assertFinite(cop.z, 'cop.z');

        // Position pedestrian within immediate approach/dialogue range of the cop
        client.sendMovePedestrian({
            x: cop.x + 1.0,
            y: cop.y || 0,
            z: cop.z + 1.0,
            vx: 0,
            vz: 0,
            yaw: 0,
            anim: 'idle'
        });
        await sleep(60);
    }

    throw new Error(`Timed out after ${timeoutMs}ms waiting for police_encounter_start from cop ${targetCop.id}`);
}

/**
 * Triggers encounters across patrolling cops until a matching scenario_id is seen (or any if null).
 */
export async function triggerEncounterForScenario(
    client,
    preferredScenarioId = null,
    { maxAttempts = 24, resolveNonMatching = true } = {}
) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const ps = await waitForPoliceState(
            client,
            (m) => Array.isArray(m.foot_cops) && m.foot_cops.length > 0,
            20000
        );
        const targetCopId =
            attempt < 8
                ? ps.foot_cops[0].id
                : ps.foot_cops[Math.floor(Math.random() * ps.foot_cops.length)].id;

        const enc = await triggerFootCopEncounter(client, {
            targetCopId,
            timeoutMs: 24000
        });
        if (!preferredScenarioId || enc.scenario_id === preferredScenarioId) {
            return enc;
        }
        if (resolveNonMatching && Array.isArray(enc.options) && enc.options.length > 0) {
            const cur = client.cursor();
            client.sendPoliceChoice(enc.encounter_id, enc.options[0].index ?? 0);
            await client.waitForType('police_encounter_result', {
                fromIndex: cur,
                timeoutMs: 4000,
                predicate: (m) => m.encounter_id === enc.encounter_id
            });
            // Move away from resolved cop during cooldown
            client.sendMovePedestrian({ x: -55, y: 0, z: -150, yaw: 0, anim: 'idle' });
            await sleep(100);
        }
    }
    throw new Error(`Did not observe scenario_id="${preferredScenarioId}" across ${maxAttempts} encounters`);
}

/**
 * Drives a standard car near a patrolling police car at the requested speed to test chase initiation.
 */
export async function driveNearPatrolPoliceCar(
    client,
    { carId = 'car_0', speedMs = 18.0, yaw = 0, durationMs = 2500, offsetDist = 5.0 } = {}
) {
    if (speedMs > SPEED_LIMIT_MS && client.lastChaseEndedAt > 0) {
        const graceRem = 6300 - (Date.now() - client.lastChaseEndedAt);
        if (graceRem > 0) await sleep(graceRem);
    }
    const ps = await waitForPoliceState(
        client,
        (m) => Array.isArray(m.police_cars) && m.police_cars.some((pc) => pc.state === 'patrol'),
        5000
    );
    const pc = ps.police_cars.find((c) => c.state === 'patrol') || ps.police_cars[0];
    assert(pc, 'Expected at least one police car in police_state');

    let x = pc.x + Math.sin(pc.yaw || 0) * offsetDist;
    let z = pc.z + Math.cos(pc.yaw || 0) * offsetDist;
    const carYaw = yaw ?? (pc.yaw || 0);
    const vx = Math.sin(carYaw) * speedMs;
    const vz = Math.cos(carYaw) * speedMs;

    const steps = Math.max(1, Math.floor(durationMs / 50));
    const startCursor = client.cursor();
    for (let i = 0; i < steps; i++) {
        client.sendMoveDriving({
            car_id: carId,
            x,
            y: 0,
            z,
            speed: speedMs,
            vx,
            vz,
            yaw: carYaw,
            yaw_rate: 0,
            drift: false,
            lights: true
        });
        await sleep(50);
        // Keep car within detection orbit of the police car
        const latestPc = (client.latestPoliceState?.police_cars || []).find((c) => c.id === pc.id) || pc;
        x = latestPc.x + Math.sin(carYaw) * offsetDist;
        z = latestPc.z + Math.cos(carYaw) * offsetDist;
        for (const m of client.messagesSince(startCursor)) {
            if (m.type === 'police_chase' && m.target_user === client.username && m.status === 'started') {
                return { chase: m, policeCarId: m.police_car_id || pc.id, x, z };
            }
        }
    }
    return { chase: null, policeCarId: pc.id, x, z };
}

/**
 * Starts a speeding chase and steers player car directly into collision with the pursuing police car.
 */
export async function startChaseAndCollide(client, { carId = 'car_0', timeoutMs = 12000 } = {}) {
    const startCursor = client.cursor();
    const { chase, policeCarId } = await driveNearPatrolPoliceCar(client, {
        carId,
        speedMs: 22.0,
        durationMs: 4000,
        offsetDist: 6.0
    });
    assert(chase, 'Expected police_chase started before collision');

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const m of client.messagesSince(startCursor)) {
            if (m.type === 'vehicle_impulse' && m.car_id === carId) {
                return { chase, impulse: m, policeCarId };
            }
        }
        const pc = (client.latestPoliceState?.police_cars || []).find((c) => c.id === policeCarId);
        if (pc) {
            // Position player car overlapping/approaching police car with non-zero closing velocity
            const approachYaw = Math.atan2(-Math.sin(pc.yaw || 0), -Math.cos(pc.yaw || 0));
            const speed = 18.0;
            const px = pc.x - Math.sin(approachYaw) * 1.8;
            const pz = pc.z - Math.cos(approachYaw) * 1.8;
            client.sendMoveDriving({
                car_id: carId,
                x: px,
                y: 0,
                z: pz,
                speed,
                vx: Math.sin(approachYaw) * speed,
                vz: Math.cos(approachYaw) * speed,
                yaw: approachYaw,
                yaw_rate: 0,
                drift: false,
                lights: true
            });
        }
        await sleep(50);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for vehicle_impulse on ${carId}`);
}

/**
 * Repeatedly incurs genuine police fines (combining foot cops and speeding stops, respecting cooldowns)
 * until client.latestMoney < targetMoney.
 */
export async function incurFinesUntilBelow(client, targetMoney = 0, { timeoutMs = 240000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastFootDoneAt = 0;
    let lastCarStopAt = 0;

    while (Date.now() < deadline) {
        if (typeof client.latestMoney === 'number' && client.latestMoney < targetMoney) {
            if (lastCarStopAt > 0 && Date.now() - lastCarStopAt < 6300) {
                movePedestrianOffPromenade(client);
                await sleep(6300 - (Date.now() - lastCarStopAt));
            }
            return client.latestMoney;
        }
        const ps = client.latestPoliceState || (await waitForPoliceState(client, null, 4000));
        const patrolCop = (ps.foot_cops || []).find((c) => c.state === 'patrol');
        if (patrolCop && Date.now() - lastFootDoneAt >= 15500) {
            try {
                const enc = await triggerFootCopEncounter(client, { timeoutMs: 8000 });
                const bestOpt = [...(enc.options || [])].sort((a, b) => (b.fine || 0) - (a.fine || 0))[0];
                if (bestOpt) {
                    const cur = client.cursor();
                    client.sendPoliceChoice(enc.encounter_id, bestOpt.index ?? 0);
                    await client.waitForType('police_encounter_result', {
                        fromIndex: cur,
                        timeoutMs: 4000,
                        predicate: (m) => m.encounter_id === enc.encounter_id
                    });
                    lastFootDoneAt = Date.now();
                    movePedestrianOffPromenade(client);
                    continue;
                }
            } catch {
                lastFootDoneAt = Date.now() - 12000;
                movePedestrianOffPromenade(client);
            }
        }

        const patrolCar = (ps.police_cars || []).find((pc) => pc.state === 'patrol');
        if (patrolCar && Date.now() - lastCarStopAt >= 6200) {
            try {
                const cur = client.cursor();
                const { chase, policeCarId } = await driveNearPatrolPoliceCar(client, {
                    carId: 'car_0',
                    speedMs: 24.0,
                    durationMs: 3000
                });
                if (chase) {
                    const stopDeadline = Date.now() + 8000;
                    while (Date.now() < stopDeadline) {
                        const ended = client
                            .messagesSince(cur)
                            .find(
                                (m) =>
                                    m.type === 'police_chase' &&
                                    m.target_user === client.username &&
                                    (m.status === 'stopped' || m.status === 'evaded')
                            );
                        if (ended) break;
                        const pc = (client.latestPoliceState?.police_cars || []).find((c) => c.id === policeCarId) || patrolCar;
                        client.sendMoveDriving({
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
                        await sleep(50);
                    }
                    lastCarStopAt = Date.now();
                    movePedestrianOffPromenade(client);
                    continue;
                }
            } catch {
                movePedestrianOffPromenade(client);
            }
        }
        await sleep(150);
    }
    throw new Error(`Did not reach balance < ${targetMoney} within ${timeoutMs}ms (current=${client.latestMoney})`);
}

/**
 * Drains a WS player's balance into [minMoney, maxMoney] (e.g. 1..2500 ₽) without overshooting below minMoney.
 */
export async function drainBalanceToSmallPositive(
    client,
    { minMoney = 1, maxMoney = 2500, timeoutMs = 240000 } = {}
) {
    const deadline = Date.now() + timeoutMs;
    let lastFootDoneAt = 0;
    let lastCarStopAt = 0;

    while (Date.now() < deadline) {
        const money = client.latestMoney;
        if (typeof money === 'number' && money >= minMoney && money <= maxMoney) {
            if (lastCarStopAt > 0 && Date.now() - lastCarStopAt < 6300) {
                movePedestrianOffPromenade(client);
                await sleep(6300 - (Date.now() - lastCarStopAt));
            }
            return money;
        }
        if (typeof money === 'number' && money < minMoney) {
            throw new Error(`Balance overshot below ${minMoney}: current=${money}`);
        }

        const ps = client.latestPoliceState || (await waitForPoliceState(client, null, 4000));

        // Use police car stops (5000 ₽) while safe (> 5000 + minMoney - 1), avoiding 7501..8500 if we can land directly
        const safeCarStop = typeof money === 'number' && money >= 5000 + minMoney && !(money > 7500 && money <= 8500);
        const patrolCar = (ps.police_cars || []).find((pc) => pc.state === 'patrol');
        if (safeCarStop && patrolCar && Date.now() - lastCarStopAt >= 6200) {
            try {
                const cur = client.cursor();
                const { chase, policeCarId } = await driveNearPatrolPoliceCar(client, {
                    carId: 'car_0',
                    speedMs: 24.0,
                    durationMs: 3000
                });
                if (chase) {
                    const stopDeadline = Date.now() + 8000;
                    while (Date.now() < stopDeadline) {
                        const ended = client
                            .messagesSince(cur)
                            .find(
                                (m) =>
                                    m.type === 'police_chase' &&
                                    m.target_user === client.username &&
                                    (m.status === 'stopped' || m.status === 'evaded')
                            );
                        if (ended) break;
                        const pc = (client.latestPoliceState?.police_cars || []).find((c) => c.id === policeCarId) || patrolCar;
                        client.sendMoveDriving({
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
                        await sleep(50);
                    }
                    lastCarStopAt = Date.now();
                    movePedestrianOffPromenade(client);
                    continue;
                }
            } catch {
                movePedestrianOffPromenade(client);
            }
        }

        // Use foot cops when balance > 15000 (max fine 8000), or when fine-tuning 2501..8500 into [minMoney, maxMoney] or [5001, 7500]
        const patrolCop = (ps.foot_cops || []).find((c) => c.state === 'patrol');
        const wantFoot =
            typeof money === 'number' &&
            (money > 15000 || (money > maxMoney && money <= 8500));
        if (wantFoot && patrolCop && Date.now() - lastFootDoneAt >= 15500) {
            try {
                const enc = await triggerFootCopEncounter(client, { timeoutMs: 8000 });
                const opts = [...(enc.options || [])];
                let chosen = null;
                if (money > 15000) {
                    chosen = opts.sort((a, b) => (b.fine || 0) - (a.fine || 0))[0];
                } else {
                    // Prefer the target range, then a car-stop range, then stay above the weed fine threshold.
                    const direct = opts
                        .filter((o) => money - o.fine >= minMoney && money - o.fine <= maxMoney)
                        .sort((a, b) => (b.fine || 0) - (a.fine || 0))[0];
                    const setupCar = opts
                        .filter((o) => money - o.fine >= 5001 && money - o.fine <= 7500)
                        .sort((a, b) => (b.fine || 0) - (a.fine || 0))[0];
                    const safeAboveWeed = opts
                        .filter((o) => money - o.fine >= 3500)
                        .sort((a, b) => (b.fine || 0) - (a.fine || 0))[0];
                    const safeSmall = opts
                        .filter((o) => money - o.fine >= minMoney)
                        .sort((a, b) => (b.fine || 0) - (a.fine || 0))[0];
                    chosen = direct || setupCar || safeAboveWeed || safeSmall || opts[0];
                }
                if (chosen) {
                    const cur = client.cursor();
                    client.sendPoliceChoice(enc.encounter_id, chosen.index ?? 0);
                    await client.waitForType('police_encounter_result', {
                        fromIndex: cur,
                        timeoutMs: 4000,
                        predicate: (m) => m.encounter_id === enc.encounter_id
                    });
                    lastFootDoneAt = Date.now();
                    movePedestrianOffPromenade(client);
                    continue;
                }
            } catch {
                lastFootDoneAt = Date.now() - 12000;
                movePedestrianOffPromenade(client);
            }
        }

        await sleep(150);
    }
    throw new Error(`Did not drain balance into [${minMoney}, ${maxMoney}] within ${timeoutMs}ms (current=${client.latestMoney})`);
}
