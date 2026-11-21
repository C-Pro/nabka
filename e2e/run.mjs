/**
 * Nabka Opaque-Box E2E Test Runner (compatible with `node e2e/run.mjs` and `bun e2e/run.mjs`).
 *
 * Flags:
 *   --tier=1|2|3|4|1,2|all   (default: all)
 *   --harness-check          Verify server build/start/stop, WS Option A/B + 4408/4409, and 2x Chromium WebGL
 *   --filter=<substr>        Filter tests by ID or name substring (case-insensitive)
 *   --verbose                Print verbose build/failure diagnostics
 *   --headed                 Launch Chromium with headless: false
 *   --server-bin=<path>      Reuse pre-built server binary instead of running `go build`
 *   --disk-static            Run server with CWD=repoRoot (disk static/) instead of os.tmpdir() (embed.FS)
 */
import { assert, assertEqual, assertGreaterOrEqual } from './lib/assert.mjs';
import { buildServerBinary, withServer } from './lib/server.mjs';
import { connectWs, uniqueUsername } from './lib/ws-client.mjs';
import { createTrackedPage, joinGame, launchBrowser, parseMoneyText } from './lib/playwright.mjs';
import { getTier1Tests } from './tiers/tier1.mjs';
import { getTier2Tests } from './tiers/tier2.mjs';
import { getTier3Tests } from './tiers/tier3.mjs';
import { getTier4Tests } from './tiers/tier4.mjs';

function parseArgs(argv) {
    const opts = {
        tiers: new Set([1, 2, 3, 4]),
        harnessCheck: false,
        filter: '',
        verbose: false,
        headed: false,
        serverBin: '',
        diskStatic: false
    };

    for (const arg of argv) {
        if (arg === '--harness-check') {
            opts.harnessCheck = true;
        } else if (arg === '--verbose' || arg === '-v') {
            opts.verbose = true;
        } else if (arg === '--headed') {
            opts.headed = true;
        } else if (arg === '--disk-static') {
            opts.diskStatic = true;
        } else if (arg.startsWith('--tier=')) {
            const val = arg.slice('--tier='.length).trim().toLowerCase();
            if (val === 'all') {
                opts.tiers = new Set([1, 2, 3, 4]);
            } else {
                const parsed = new Set();
                for (const part of val.split(',')) {
                    const n = Number(part.trim());
                    if (![1, 2, 3, 4].includes(n)) {
                        throw new Error(`Invalid tier "${part}" in ${arg}`);
                    }
                    parsed.add(n);
                }
                opts.tiers = parsed;
            }
        } else if (arg.startsWith('--filter=')) {
            opts.filter = arg.slice('--filter='.length).trim().toLowerCase();
        } else if (arg.startsWith('--server-bin=')) {
            opts.serverBin = arg.slice('--server-bin='.length).trim();
        } else if (arg === '--help' || arg === '-h') {
            console.log(
                'Usage: node e2e/run.mjs [--tier=1|2|3|4|1,2|all] [--harness-check] [--filter=<substr>] [--verbose] [--headed] [--server-bin=<path>] [--disk-static]'
            );
            process.exit(0);
        } else {
            throw new Error(`Unknown CLI argument: ${arg}`);
        }
    }

    return opts;
}

async function runHarnessCheck({ binaryPath, diskStatic, headed }) {
    console.log('[harness-check] Starting compiled server on ephemeral 127.0.0.1 port...');
    await withServer({ binaryPath, diskStatic }, async (srv) => {
        // 1. HTTP /api/version & /
        const verRes = await fetch(`${srv.baseUrl}/api/version`);
        assertEqual(verRes.status, 200, 'GET /api/version status');
        const verJson = await verRes.json();
        assertEqual(verJson.status, 'ok', '/api/version status field');

        const rootRes = await fetch(`${srv.baseUrl}/`);
        assertEqual(rootRes.status, 200, 'GET / status');
        const html = await rootRes.text();
        assert(html.includes('mp-login-form'), 'GET / serves Nabka index.html');
        console.log(`[harness-check] HTTP OK (${srv.baseUrl}, version=${verJson.version})`);

        // 2. WebSocket Option A & Option B + pedestrian/driving move + 4409 + 4408
        const aliceName = uniqueUsername('hc_a');
        const bobName = uniqueUsername('hc_b');
        const { client: alice, join: joinA } = await connectWs(srv.wsUrl, aliceName, { mode: 'A' });
        const { client: bob } = await connectWs(srv.wsUrl, bobName, { mode: 'B' });
        try {
            assert(Boolean(joinA.token), 'Option A received join token');
            assert(Boolean(bob.lastJoin?.token), 'Option B received join token');

            const bobCur = bob.cursor();
            alice.sendMovePedestrian({ x: 1.5, y: 0, z: 10.0, yaw: 0.5, anim: 'walk' });
            const pedEvt = await bob.waitForMessage(
                (m) => m.type === 'move' && m.mode === 'pedestrian' && m.username === aliceName,
                { fromIndex: bobCur, timeoutMs: 3000, desc: 'pedestrian move broadcast' }
            );
            assertEqual(pedEvt.x, 1.5);

            alice.sendMoveDriving({
                car_id: 'car_0',
                x: 23.0,
                y: 0,
                z: 15.0,
                speed: 8.0,
                yaw: 0,
                drift: false,
                lights: true
            });
            const drvEvt = await bob.waitForMessage(
                (m) => m.type === 'move' && m.mode === 'driving' && m.car_id === 'car_0' && m.username === aliceName,
                { fromIndex: bobCur, timeoutMs: 3000, desc: 'driving move broadcast' }
            );
            assertEqual(drvEvt.x, 23.0);

            // Duplicate username without token -> 4409
            const dup = await connectWs(srv.wsUrl, aliceName, { expectRejection: true });
            assertEqual(dup.code, 4409, 'duplicate username rejected with 4409');

            // Reconnect with token -> old socket gets 4408
            const { client: alice2 } = await connectWs(srv.wsUrl, aliceName, { token: joinA.token });
            try {
                const closeA = await alice.waitForClose(3000);
                assertEqual(closeA.code, 4408, 'replaced socket closed with 4408');
            } finally {
                await alice2.close();
            }
            console.log('[harness-check] WebSocket Option A/B, move sync, 4409 & 4408 OK');
        } finally {
            await alice.close();
            await bob.close();
        }

        // 3. Dual headless Chromium + SwiftShader WebGL + #mp-login-form + #hud-money
        const browser = await launchBrowser({ headed });
        const page1 = await createTrackedPage(browser);
        const page2 = await createTrackedPage(browser);
        try {
            const br1 = uniqueUsername('hc_br1');
            const br2 = uniqueUsername('hc_br2');
            await joinGame(page1.page, srv.baseUrl, br1);
            await joinGame(page2.page, srv.baseUrl, br2);
            const [snap1, snap2] = await Promise.all([
                page1.page.evaluate(() => ({
                    hasRenderer: Boolean(window.World?.renderer),
                    vehicles: window.World?.vehicles?.length || 0,
                    npcs: window.World?.npcs?.length || 0,
                    money: document.getElementById('hud-money')?.textContent || ''
                })),
                page2.page.evaluate(() => ({
                    hasRenderer: Boolean(window.World?.renderer),
                    vehicles: window.World?.vehicles?.length || 0,
                    npcs: window.World?.npcs?.length || 0,
                    money: document.getElementById('hud-money')?.textContent || ''
                }))
            ]);
            assert(snap1.hasRenderer && snap2.hasRenderer, 'WebGL renderer initialized in both browsers');
            assertGreaterOrEqual(snap1.vehicles, 5, 'World.vehicles >= 5');
            assertGreaterOrEqual(snap1.npcs, 14, 'World.npcs >= 14');
            assertEqual(parseMoneyText(snap1.money), 125400, 'Browser 1 #hud-money');
            assertEqual(parseMoneyText(snap2.money), 125400, 'Browser 2 #hud-money');
            page1.assertClean('harness-check-p1');
            page2.assertClean('harness-check-p2');
            console.log('[harness-check] Dual headless Chromium SwiftShader WebGL + login + HUD OK');
        } finally {
            await page1.close();
            await page2.close();
            await browser.close();
        }
    });
    console.log('[harness-check] PASSED');
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    let built = null;
    let binaryPath = opts.serverBin;
    if (!binaryPath) {
        if (opts.verbose) console.log('[e2e] Building ./cmd/server binary...');
        built = buildServerBinary({ verbose: opts.verbose });
        binaryPath = built.binaryPath;
    }

    try {
        if (opts.harnessCheck) {
            await runHarnessCheck({
                binaryPath,
                diskStatic: opts.diskStatic,
                headed: opts.headed
            });
            return;
        }

        const allTests = [
            ...(opts.tiers.has(1) ? getTier1Tests() : []),
            ...(opts.tiers.has(2) ? getTier2Tests() : []),
            ...(opts.tiers.has(3) ? getTier3Tests() : []),
            ...(opts.tiers.has(4) ? getTier4Tests() : [])
        ];

        const selected = opts.filter
            ? allTests.filter(
                  (t) => t.id.toLowerCase().includes(opts.filter) || t.name.toLowerCase().includes(opts.filter)
              )
            : allTests;

        if (selected.length === 0) {
            throw new Error('No E2E tests matched selection');
        }

        console.log(
            `[e2e] Running ${selected.length} tests (tiers: ${[...opts.tiers].sort().join(',')}, binary: ${binaryPath})`
        );

        let passed = 0;
        let failed = 0;
        const failures = [];
        const tierStats = new Map();

        for (const t of selected) {
            const stat = tierStats.get(t.tier) || { passed: 0, failed: 0 };
            const startedAt = Date.now();
            try {
                await t.run({
                    binaryPath,
                    diskStatic: opts.diskStatic,
                    headed: opts.headed,
                    verbose: opts.verbose
                });
                const ms = Date.now() - startedAt;
                passed += 1;
                stat.passed += 1;
                console.log(`PASS [${t.id}] ${t.name} (${ms}ms)`);
            } catch (err) {
                const ms = Date.now() - startedAt;
                failed += 1;
                stat.failed += 1;
                const msg = err?.message || String(err);
                failures.push({ id: t.id, name: t.name, tier: t.tier, err });
                console.error(`FAIL [${t.id}] ${t.name} (${ms}ms)\n  -> ${msg}`);
                if (opts.verbose && err?.stack) {
                    console.error(err.stack);
                }
            }
            tierStats.set(t.tier, stat);
        }

        console.log('\n=== E2E Summary ===');
        for (const tierNum of [...tierStats.keys()].sort((a, b) => a - b)) {
            const s = tierStats.get(tierNum);
            console.log(`  Tier ${tierNum}: ${s.passed} passed, ${s.failed} failed`);
        }
        console.log(`  Total:  ${passed} passed, ${failed} failed (of ${selected.length})`);

        if (failed > 0) {
            process.exitCode = 1;
        }
    } finally {
        built?.cleanup();
    }
}

main().catch((err) => {
    console.error(`[e2e] Fatal error: ${err?.stack || err?.message || String(err)}`);
    process.exit(1);
});
