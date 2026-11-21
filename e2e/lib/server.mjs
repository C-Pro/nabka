/**
 * Server binary builder, ephemeral port allocator, and process lifecycle manager.
 * Exercises the compiled Go server (`./cmd/server`) on an isolated 127.0.0.1 port.
 */
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '../..');

export function buildServerBinary({ repoRoot = REPO_ROOT, verbose = false } = {}) {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const binaryPath = path.join(os.tmpdir(), `nabka-e2e-server-${suffix}`);
    const res = spawnSync('go', ['build', '-mod=vendor', '-o', binaryPath, './cmd/server'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe']
    });
    if (res.status !== 0) {
        const errText = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
        throw new Error(`go build failed (exit ${res.status}): ${errText}`);
    }
    return {
        binaryPath,
        cleanup() {
            try {
                fs.rmSync(binaryPath, { force: true });
            } catch {
                // ignore cleanup errors
            }
        }
    };
}

export function allocatePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close((err) => {
                if (err) reject(err);
                else if (!port) reject(new Error('Failed to allocate ephemeral port'));
                else resolve(port);
            });
        });
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startServer({
    binaryPath,
    diskStatic = false,
    repoRoot = REPO_ROOT,
    buildId = '',
    readyTimeoutMs = 15000,
    maxBindRetries = 3
} = {}) {
    if (!binaryPath) {
        throw new Error('startServer requires binaryPath');
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= maxBindRetries; attempt++) {
        const port = await allocatePort();
        const cwd = diskStatic ? repoRoot : os.tmpdir();
        const env = { ...process.env, PORT: String(port) };
        if (buildId) env.BUILD_ID = buildId;

        const logLines = [];
        const pushLines = (chunk, stream) => {
            const text = String(chunk);
            for (const line of text.split(/\r?\n/)) {
                if (!line) continue;
                logLines.push(`[${stream}] ${line}`);
                if (logLines.length > 200) logLines.shift();
            }
        };

        const child = spawn(binaryPath, [], {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let exited = false;
        let exitCode = null;
        let exitSignal = null;
        let spawnError = null;
        const exitPromise = new Promise((resolve) => {
            child.once('error', (err) => {
                spawnError = err;
                exited = true;
                resolve({ code: null, signal: null, error: err });
            });
            child.once('exit', (code, signal) => {
                exited = true;
                exitCode = code;
                exitSignal = signal;
                resolve({ code, signal, error: null });
            });
        });

        child.stdout?.on('data', (d) => pushLines(d, 'stdout'));
        child.stderr?.on('data', (d) => pushLines(d, 'stderr'));

        const baseUrl = `http://127.0.0.1:${port}`;
        const wsUrl = `ws://127.0.0.1:${port}/ws`;
        const deadline = Date.now() + readyTimeoutMs;

        let ready = false;
        while (Date.now() < deadline) {
            if (exited) break;
            try {
                const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1000) });
                if (res.status === 200) {
                    const data = await res.json();
                    if (data && data.status === 'ok') {
                        ready = true;
                        break;
                    }
                }
            } catch {
                // server not listening yet
            }
            await sleep(40);
        }

        if (ready) {
            return {
                port,
                baseUrl,
                wsUrl,
                pid: child.pid,
                getLogs() {
                    return logLines.join('\n');
                },
                isRunning() {
                    return !exited;
                },
                async stop() {
                    if (exited) return;
                    try {
                        child.kill('SIGTERM');
                    } catch {
                        // ignore
                    }
                    const killer = setTimeout(() => {
                        if (!exited) {
                            try {
                                child.kill('SIGKILL');
                            } catch {
                                // ignore
                            }
                        }
                    }, 3000);
                    try {
                        await exitPromise;
                    } finally {
                        clearTimeout(killer);
                        child.stdout?.destroy();
                        child.stderr?.destroy();
                    }
                }
            };
        }

        if (spawnError) {
            throw new Error(`Failed to spawn server binary "${binaryPath}": ${spawnError.message}`);
        }
        // Not ready or exited early: ensure cleanup and retry if bind failed
        if (!exited) {
            try {
                child.kill('SIGKILL');
            } catch {
                // ignore
            }
            await exitPromise;
        }
        lastErr = new Error(
            `Server failed to become ready on port ${port} (attempt ${attempt}/${maxBindRetries}, exit=${exitCode}, signal=${exitSignal}):\n${logLines.join('\n')}`
        );
    }

    throw lastErr || new Error('Server failed to start');
}

export async function withServer(opts, fn) {
    const srv = await startServer(opts);
    try {
        return await fn(srv);
    } catch (err) {
        const logs = srv.getLogs();
        if (logs && err && typeof err.message === 'string' && !err.message.includes('--- server logs ---')) {
            err.message += `\n--- server logs ---\n${logs}`;
        }
        throw err;
    } finally {
        await srv.stop();
    }
}
