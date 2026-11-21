/**
 * Zero-env Playwright & Chromium resolver + opaque-box browser gameplay helpers.
 * Compatible with both Node.js and Bun.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function existsFile(p) {
    try {
        return Boolean(p) && fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

export function resolvePlaywrightPath() {
    const candidates = [];

    if (process.env.PLAYWRIGHT_PATH) {
        const p = process.env.PLAYWRIGHT_PATH;
        candidates.push(p.endsWith('.mjs') || p.endsWith('.js') ? p : path.join(p, 'index.mjs'));
    }

    const miseBase = path.join(os.homedir(), '.local/share/mise/installs/playwright');
    if (fs.existsSync(miseBase)) {
        for (const pref of ['latest', '1.65.1']) {
            candidates.push(path.join(miseBase, pref, 'node_modules/playwright/index.mjs'));
        }
        try {
            const entries = fs.readdirSync(miseBase).sort().reverse();
            for (const ent of entries) {
                candidates.push(path.join(miseBase, ent, 'node_modules/playwright/index.mjs'));
            }
        } catch {
            // ignore
        }
    }

    for (const c of candidates) {
        if (existsFile(c)) return c;
    }

    try {
        const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 3000 }).trim();
        if (npmRoot) {
            const g = path.join(npmRoot, 'playwright/index.mjs');
            if (existsFile(g)) return g;
        }
    } catch {
        // ignore
    }

    try {
        const req = createRequire(import.meta.url);
        const resolved = req.resolve('playwright');
        const mjs = path.join(path.dirname(resolved), 'index.mjs');
        const p = existsFile(mjs) ? mjs : resolved;
        if (existsFile(p)) return p;
    } catch {
        // ignore
    }

    throw new Error(`Unable to locate playwright/index.mjs. Checked: ${candidates.join(', ')}`);
}

export function resolveChromiumExecutable() {
    const candidates = [];
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
        candidates.push(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
    }
    candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome');

    const msCache = path.join(os.homedir(), '.cache/ms-playwright');
    if (fs.existsSync(msCache)) {
        try {
            const dirs = fs
                .readdirSync(msCache)
                .filter((d) => d.startsWith('chromium-'))
                .sort()
                .reverse();
            for (const d of dirs) {
                candidates.push(path.join(msCache, d, 'chrome-linux64/chrome'));
                candidates.push(path.join(msCache, d, 'chrome-linux/chrome'));
            }
        } catch {
            // ignore
        }
    }

    for (const c of candidates) {
        if (existsFile(c)) return c;
    }
    throw new Error(`Unable to locate Chromium executable. Checked: ${candidates.join(', ')}`);
}

let cachedPlaywright = null;
export async function loadPlaywright() {
    if (cachedPlaywright) return cachedPlaywright;
    const pwPath = resolvePlaywrightPath();
    const mod = await import(pathToFileURL(pwPath).href);
    cachedPlaywright = mod.default?.chromium ? mod.default : mod;
    return cachedPlaywright;
}

export async function launchBrowser({ headed = false } = {}) {
    const pw = await loadPlaywright();
    const executablePath = resolveChromiumExecutable();
    return pw.chromium.launch({
        executablePath,
        headless: !headed,
        args: [
            '--no-sandbox',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-webgl',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist'
        ]
    });
}

export async function createTrackedPage(browser, { viewport = { width: 1280, height: 720 }, contextOptions = {} } = {}) {
    const context = await browser.newContext({ viewport, ...contextOptions });
    const page = await context.newPage();
    const errors = {
        consoleErrors: [],
        pageErrors: [],
        requestFailures: []
    };

    page.on('console', (msg) => {
        if (msg.type() === 'error') {
            errors.consoleErrors.push(msg.text());
        }
    });
    page.on('pageerror', (err) => {
        errors.pageErrors.push(err?.stack || err?.message || String(err));
    });
    page.on('requestfailed', (req) => {
        const failureText = req.failure()?.errorText || 'failed';
        // Ignore intentionally aborted media/asset requests during page close
        if (failureText === 'net::ERR_ABORTED') return;
        errors.requestFailures.push(`${req.method()} ${req.url()} -> ${failureText}`);
    });

    return {
        context,
        page,
        errors,
        assertClean(label = 'browser') {
            const problems = [];
            if (errors.consoleErrors.length) problems.push(`console.error: ${errors.consoleErrors.join(' | ')}`);
            if (errors.pageErrors.length) problems.push(`pageerror: ${errors.pageErrors.join(' | ')}`);
            if (errors.requestFailures.length) problems.push(`requestfailed: ${errors.requestFailures.join(' | ')}`);
            if (problems.length) {
                throw new Error(`[${label}] Unexpected browser errors: ${problems.join('; ')}`);
            }
        },
        async close() {
            await context.close().catch(() => {});
        }
    };
}

export async function preloadGameScene(page, baseUrl, { timeoutMs = 50000 } = {}) {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForFunction(
        () =>
            Boolean(
                window.World?.renderer &&
                    window.Player?.position &&
                    window.World.vehicles?.length >= 5 &&
                    window.World.npcs?.length >= 14
            ),
        null,
        { timeout: timeoutMs }
    );
}

export async function connectPreloadedGame(page, username, { timeoutMs = 50000 } = {}) {
    await page.fill('#mp-username-input', username);
    await page.click('#mp-connect-btn');
    await page.waitForFunction(
        () =>
            Boolean(window.GAME_STATE?.isConnected) &&
            document.getElementById('mp-login-overlay')?.classList.contains('hidden'),
        null,
        { timeout: timeoutMs }
    );
}

export async function joinGame(page, baseUrl, username, { timeoutMs = 50000 } = {}) {
    await preloadGameScene(page, baseUrl, { timeoutMs });
    await connectPreloadedGame(page, username, { timeoutMs });
}

export function parseMoneyText(text) {
    if (typeof text !== 'string') {
        throw new Error(`parseMoneyText expected string, got ${typeof text}`);
    }
    const normalized = text.replace(/\u2212/g, '-').trim();
    const negative = /(^|\s|₽)-/.test(normalized);
    const digits = normalized.replace(/[^\d]/g, '');
    if (!digits) {
        throw new Error(`Cannot parse money from text: ${JSON.stringify(text)}`);
    }
    const num = Number(digits);
    const signed = negative && num !== 0 ? -num : num;
    if (!Number.isSafeInteger(signed)) {
        throw new Error(`Parsed money is not a safe integer: ${signed} from ${JSON.stringify(text)}`);
    }
    return signed;
}

const ALL_MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'Space'];

export async function releaseMoveKeys(page) {
    for (const k of ALL_MOVE_KEYS) {
        await page.keyboard.up(k).catch(() => {});
    }
}

/**
 * Steers the pedestrian player toward (targetX, targetZ) using real keyboard inputs.
 * Stops early if `stopWhen(stopWhenArg)` returns truthy.
 */
export async function steerAndWalkTo(
    page,
    targetX,
    targetZ,
    {
        tolerance = 2.6,
        timeoutMs = 22000,
        sprint = true,
        stopWhen = null,
        stopWhenArg = null,
        targetFn = null,
        autoResolvePoliceEncounter = false
    } = {}
) {
    const deadline = Date.now() + timeoutMs;
    const held = new Set();
    let progressAnchor = null;
    let evadeUntil = 0;
    let evadePhase = 0;

    const syncKeys = async (desired) => {
        for (const k of [...held]) {
            if (!desired.has(k)) {
                await page.keyboard.up(k);
                held.delete(k);
            }
        }
        for (const k of desired) {
            if (!held.has(k)) {
                await page.keyboard.down(k);
                held.add(k);
            }
        }
    };

    try {
        await page.bringToFront().catch(() => {});
        while (Date.now() < deadline) {
            if (stopWhen) {
                const stopped = await page.evaluate(stopWhen, stopWhenArg);
                if (stopped) {
                    await syncKeys(new Set());
                    return { reached: true, stoppedByCondition: true };
                }
            }

            if (
                autoResolvePoliceEncounter &&
                (await page.evaluate(
                    () =>
                        Boolean(window.GAME_STATE?.activePoliceEncounter) &&
                        !document.getElementById('npc-dialogue-modal')?.classList.contains('hidden')
                ))
            ) {
                await syncKeys(new Set());
                await page.locator('#npc-options-container button:enabled').first().click();
                await page.waitForFunction(
                    () => {
                        const btn = document.getElementById('btn-close-npc-chat');
                        return Boolean(btn && !btn.disabled);
                    },
                    null,
                    { timeout: 5000 }
                );
                await page.locator('#btn-close-npc-chat').click();
                await page.waitForFunction(
                    () => document.getElementById('npc-dialogue-modal')?.classList.contains('hidden'),
                    null,
                    { timeout: 4000 }
                );
                progressAnchor = null;
                continue;
            }

            let curTargetX = targetX;
            let curTargetZ = targetZ;
            if (targetFn) {
                const t = await targetFn();
                if (t && Number.isFinite(t.x) && Number.isFinite(t.z)) {
                    curTargetX = t.x;
                    curTargetZ = t.z;
                }
            }

            const state = await page.evaluate(() => ({
                x: window.Player?.position?.x ?? 0,
                z: window.Player?.position?.z ?? 0,
                yaw: window.GAME_STATE?.cameraYaw ?? 0,
                suspended: Boolean(window.GAME_STATE?.activeNpcChat),
                hasFocus: document.hasFocus()
            }));

            if (!state.hasFocus) {
                await page.bringToFront().catch(() => {});
            }

            if (state.suspended) {
                await syncKeys(new Set());
                return { reached: false, stoppedByCondition: true };
            }

            const dx = curTargetX - state.x;
            const dz = curTargetZ - state.z;
            const dist = Math.hypot(dx, dz);
            if (dist <= tolerance) {
                await syncKeys(new Set());
                return { reached: true, dist };
            }

            // Wall-clock progress checkpoint (>= 1400ms without >= 0.3m progress) so SwiftShader 2.3 FPS never false-triggers
            const now = Date.now();
            if (!progressAnchor) {
                progressAnchor = { x: state.x, z: state.z, atMs: now };
            } else if (Math.hypot(state.x - progressAnchor.x, state.z - progressAnchor.z) >= 0.3) {
                progressAnchor = { x: state.x, z: state.z, atMs: now };
            } else if (now >= evadeUntil && now - progressAnchor.atMs >= 1400) {
                evadePhase += 1;
                evadeUntil = now + 900;
                progressAnchor = { x: state.x, z: state.z, atMs: now + 900 };
            }

            const desired = new Set();
            if (now < evadeUntil) {
                desired.add(evadePhase % 2 === 1 ? 'KeyA' : 'KeyD');
                desired.add('KeyS');
            } else {
                // Camera basis from entities.js:
                // camForward = (-sin(yaw), -cos(yaw)), camRight = (cos(yaw), -sin(yaw))
                const fx = -Math.sin(state.yaw);
                const fz = -Math.cos(state.yaw);
                const rx = Math.cos(state.yaw);
                const rz = -Math.sin(state.yaw);

                const ux = dx / dist;
                const uz = dz / dist;
                const fwdProj = ux * fx + uz * fz;
                const rightProj = ux * rx + uz * rz;

                if (fwdProj > 0.25) desired.add('KeyW');
                else if (fwdProj < -0.25) desired.add('KeyS');
                if (rightProj > 0.25) desired.add('KeyD');
                else if (rightProj < -0.25) desired.add('KeyA');
                if (desired.size === 0) desired.add('KeyW');
                if (sprint && dist > 6) desired.add('ShiftLeft');
            }

            await syncKeys(desired);
            await page.waitForTimeout(80);
        }
        return { reached: false, timedOut: true };
    } finally {
        await syncKeys(new Set());
        await releaseMoveKeys(page);
    }
}

/**
 * Walks to target car (or nearest unoccupied car if carId is null/empty), enters via KeyE,
 * and drives along roadX past targetKmh.
 */
export async function enterCarAndDrivePastSpeed(
    page,
    carId = null,
    targetKmh = 45,
    { timeoutMs = 35000, holdAfterSpeedMs = 1500, roadX = 23, walkTimeoutMs = 120000 } = {}
) {
    const picked = await page.evaluate((requestedId) => {
        const vehicles = window.World?.vehicles || [];
        const px = window.Player?.position?.x ?? 0;
        const pz = window.Player?.position?.z ?? 0;
        if (requestedId) {
            const v = vehicles.find((c) => c.id === requestedId);
            return v ? { id: v.id, x: v.x, z: v.z } : null;
        }
        const avail = vehicles
            .filter((v) => !v.remoteDriver)
            .sort((a, b) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz));
        const nearest = avail[0] || vehicles[0];
        return nearest ? { id: nearest.id, x: nearest.x, z: nearest.z } : null;
    }, carId);

    if (!picked) {
        throw new Error(`Vehicle ${carId || '(nearest)'} not found in World.vehicles`);
    }
    const targetCarId = picked.id;

    const walkRes = await steerAndWalkTo(page, picked.x, picked.z, {
        tolerance: 1.5,
        timeoutMs: walkTimeoutMs,
        stopWhen: (id) => window.GAME_STATE?.nearestInteractable?.id === id,
        stopWhenArg: targetCarId,
        autoResolvePoliceEncounter: true,
        targetFn: async () => {
            const state = await page.evaluate(() => ({
                x: window.Player?.position?.x ?? 0,
                z: window.Player?.position?.z ?? 0
            }));
            if (Math.abs(state.z - picked.z) > 12 && state.x < 14.5) {
                return { x: 16.5, z: state.z };
            }
            if (Math.abs(state.z - picked.z) > 12) {
                return { x: 16.5, z: picked.z };
            }
            return { x: picked.x, z: picked.z };
        }
    });
    if (!walkRes?.reached) {
        throw new Error(`Failed to walk to vehicle ${targetCarId}: ${JSON.stringify(walkRes)}`);
    }

    // Confirm nearestInteractable is the target car before pressing KeyE
    await page
        .waitForFunction(
            (id) => window.GAME_STATE?.nearestInteractable?.id === id,
            targetCarId,
            { timeout: 2500 }
        )
        .catch(async () => {
            const actualId = await page.evaluate(() => window.GAME_STATE?.nearestInteractable?.id || null);
            throw new Error(`Expected nearestInteractable.id === "${targetCarId}", got "${actualId}" before pressing KeyE`);
        });

    await page.bringToFront().catch(() => {});
    await page.keyboard.press('KeyE');
    await page.waitForFunction(
        () =>
            Boolean(window.GAME_STATE?.inVehicle) &&
            !document.getElementById('speedometer-box')?.classList.contains('hidden'),
        null,
        { timeout: 6000 }
    );

    const deadline = Date.now() + timeoutMs;
    let reachedSpeedAt = 0;

    try {
        await page.keyboard.down('KeyW');
        await page.keyboard.down('ShiftLeft');

        while (Date.now() < deadline) {
            const telemetry = await page.evaluate(() => {
                const v = window.GAME_STATE?.inVehicle;
                const spdText = document.getElementById('speed-value')?.textContent || '0';
                return {
                    carId: v?.id || null,
                    x: v?.x ?? 0,
                    z: v?.z ?? 0,
                    yaw: v?.yaw ?? 0,
                    speedMs: v?.speed ?? 0,
                    hudKmh: Number(spdText) || 0,
                    hasFocus: document.hasFocus()
                };
            });
            if (!telemetry.hasFocus) {
                await page.bringToFront().catch(() => {});
            }

            // Steer gently onto roadX (23) heading South (+Z, yaw ~ 0) or North (-Z, yaw ~ PI)
            // Target yaw: head toward +Z (yaw = 0) if z < 80, else -Z (yaw = PI)
            const desiredHeading = telemetry.z < 80 ? 0 : Math.PI;
            const errX = roadX - telemetry.x;
            // Lateral correction angle clamped to +/-0.45 rad
            const corrYaw = Math.max(-0.45, Math.min(0.45, desiredHeading === 0 ? errX * 0.08 : -errX * 0.08));
            const targetYaw = desiredHeading + corrYaw;
            let yawDiff = targetYaw - telemetry.yaw;
            while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
            while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;

            if (yawDiff > 0.08) {
                await page.keyboard.up('KeyD');
                await page.keyboard.down('KeyA');
            } else if (yawDiff < -0.08) {
                await page.keyboard.up('KeyA');
                await page.keyboard.down('KeyD');
            } else {
                await page.keyboard.up('KeyA');
                await page.keyboard.up('KeyD');
            }

            if (telemetry.hudKmh >= targetKmh && !reachedSpeedAt) {
                reachedSpeedAt = Date.now();
            }
            if (reachedSpeedAt && Date.now() - reachedSpeedAt >= holdAfterSpeedMs) {
                return { ...telemetry, carId: telemetry.carId || targetCarId };
            }
            await page.waitForTimeout(60);
        }
        throw new Error(`Timed out driving ${targetCarId} past ${targetKmh} km/h`);
    } finally {
        await releaseMoveKeys(page);
    }
}
