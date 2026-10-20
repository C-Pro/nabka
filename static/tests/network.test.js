import { expect, test } from 'bun:test';
import { MultiplayerClient } from '../js/network.js';
import { GAME_STATE } from '../js/state.js';

test('UI initialization connects to the serving origin without a localhost opt-in', () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousUsername = GAME_STATE.username;
    globalThis.document = { getElementById: () => null, addEventListener() {} };
    try {
        for (const [url, expected] of [
            ['http://localhost:8080/', 'ws://localhost:8080/ws'],
            ['http://127.0.0.1:9090/', 'ws://127.0.0.1:9090/ws'],
            ['http://localhost:8080/?localhost=true', 'ws://localhost:8080/ws'],
            ['https://game.example/', 'wss://game.example/ws'],
            ['file:///tmp/index.html', 'wss://nabka.melekhin.me/ws'],
        ]) {
            globalThis.window = { location: new URL(url), addEventListener() {} };
            const client = Object.assign(Object.create(MultiplayerClient), {
                checkServerVersion() {},
            });
            client.initUI();
            expect(client.serverUrl).toBe(expected);
        }
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
        GAME_STATE.username = previousUsername;
    }
});
