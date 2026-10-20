import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT_DIR = resolve(import.meta.dir, '..');
const STATIC_DIR = join(ROOT_DIR, 'static');
const EDITOR_DIR = join(ROOT_DIR, 'editor');
const MODELS_DIR = join(STATIC_DIR, 'models');
const WORLD_MAP_PATH = join(STATIC_DIR, 'data', 'world_map.json');

mkdirSync(MODELS_DIR, { recursive: true });

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.glb': 'model/gltf-binary',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ogg': 'audio/ogg'
};

const isBatchExport = process.argv.includes('--export-models');
const PORT = Number(process.env.EDITOR_PORT || (isBatchExport ? 0 : 8090));
const HOSTNAME = process.env.EDITOR_HOST || '127.0.0.1';

let browserProc = null;

const server = Bun.serve({
    hostname: HOSTNAME,
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        const pathname = decodeURIComponent(url.pathname);

        // API: list available .glb models
        if (pathname === '/api/models' && req.method === 'GET') {
            const files = existsSync(MODELS_DIR)
                ? readdirSync(MODELS_DIR).filter(f => f.endsWith('.glb')).sort()
                : [];
            return Response.json({ models: files.map(f => `models/${f}`) });
        }

        // API: save a .glb model into static/models/<name>.glb
        if (pathname.startsWith('/api/models/') && req.method === 'PUT') {
            const rawName = pathname.slice('/api/models/'.length).replace(/[^a-zA-Z0-9._-]/g, '');
            const fileName = rawName.endsWith('.glb') ? rawName : `${rawName}.glb`;
            if (!fileName || fileName === '.glb' || fileName.includes('..')) {
                return new Response('Invalid model name', { status: 400 });
            }
            const buf = new Uint8Array(await req.arrayBuffer());
            const targetPath = join(MODELS_DIR, fileName);
            writeFileSync(targetPath, buf);
            return Response.json({ ok: true, path: `models/${fileName}`, bytes: buf.byteLength });
        }

        // API: batch export completion callback
        if (pathname === '/api/export-done' && req.method === 'POST') {
            const info = await req.json().catch(() => ({}));
            console.log(`Exported ${info.saved || 0}/${info.total || 0} .glb models to static/models/`);
            if (isBatchExport) {
                setTimeout(() => {
                    if (browserProc) browserProc.kill('SIGTERM');
                    server.stop();
                    process.exit(0);
                }, 100);
            }
            return Response.json({ ok: true });
        }

        // API: save static/data/world_map.json
        if (pathname === '/api/world-map' && req.method === 'PUT') {
            const bodyText = await req.text();
            let parsed;
            try {
                parsed = JSON.parse(bodyText);
            } catch (err) {
                return new Response(`Invalid JSON: ${err.message}`, { status: 400 });
            }
            const formatted = JSON.stringify(parsed, null, 2) + '\n';
            writeFileSync(WORLD_MAP_PATH, formatted, 'utf8');
            return Response.json({ ok: true, bytes: formatted.length });
        }

        // Redirect root to /editor/index.html
        if (pathname === '/' || pathname === '/editor' || pathname === '/editor/') {
            return Response.redirect(`${url.origin}/editor/index.html`, 302);
        }

        // Serve /editor/* from editor/ directory
        let filePath = null;
        if (pathname.startsWith('/editor/')) {
            const rel = pathname.slice('/editor/'.length);
            const candidate = resolve(EDITOR_DIR, rel);
            if (candidate.startsWith(EDITOR_DIR) && existsSync(candidate)) {
                filePath = candidate;
            } else {
                const staticCandidate = resolve(STATIC_DIR, rel);
                if (staticCandidate.startsWith(STATIC_DIR) && existsSync(staticCandidate)) {
                    filePath = staticCandidate;
                }
            }
        } else if (pathname.startsWith('/static/')) {
            const rel = pathname.slice('/static/'.length);
            const candidate = resolve(STATIC_DIR, rel);
            if (candidate.startsWith(STATIC_DIR)) {
                filePath = candidate;
            }
        } else {
            // Serve /* from static/ directory
            const rel = pathname.replace(/^\/+/, '');
            const candidate = resolve(STATIC_DIR, rel);
            if (candidate.startsWith(STATIC_DIR)) {
                filePath = candidate;
            }
        }

        if (!filePath || !existsSync(filePath)) {
            return new Response('Not found', { status: 404 });
        }

        try {
            const data = readFileSync(filePath);
            const ext = extname(filePath).toLowerCase();
            return new Response(data, {
                headers: {
                    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
                    'Cache-Control': 'no-store'
                }
            });
        } catch {
            return new Response('Not found', { status: 404 });
        }
    }
});

if (isBatchExport) {
    const targetUrl = `http://127.0.0.1:${server.port}/editor/index.html?exportAll=1`;
    console.log(`Running headless GLB export via ${targetUrl}...`);
    browserProc = spawn('chromium', [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--remote-debugging-port=0',
        targetUrl
    ], {
        stdio: 'ignore'
    });
    setTimeout(() => {
        console.error('Timed out waiting for headless GLB export');
        if (browserProc) browserProc.kill('SIGKILL');
        process.exit(1);
    }, 30000);
} else {
    console.log(`Nabka Standalone World & Model Editor running at http://${HOSTNAME}:${server.port}/editor/index.html`);
}
