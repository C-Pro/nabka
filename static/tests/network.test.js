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

test('Session token management persists and attaches token to connection URL', () => {
    const client = Object.create(MultiplayerClient);
    client.sessionTokens = {};

    expect(client.getSessionToken('alice')).toBe('');

    client.setSessionToken('alice', 'tok_abc123');
    expect(client.getSessionToken('alice')).toBe('tok_abc123');

    client.clearSessionToken('alice');
    expect(client.getSessionToken('alice')).toBe('');
});

test('handleServerMessage saves session token on self-join', () => {
    const client = Object.assign(Object.create(MultiplayerClient), {
        sessionTokens: {},
        onlineUsers: new Set(),
        updateOnlineRosterUI() {},
        sendMoveSnapshot() {},
    });
    GAME_STATE.username = 'alice';

    // 1. Join event with token for self
    client.handleServerMessage({
        type: 'join',
        user: 'alice',
        token: 'sess_tok_999'
    });
    expect(client.getSessionToken('alice')).toBe('sess_tok_999');

    // 2. Updated join event with new token for self
    client.handleServerMessage({
        type: 'join',
        user: 'alice',
        token: 'sess_tok_fresh'
    });
    expect(client.getSessionToken('alice')).toBe('sess_tok_fresh');
});

test('Unexpected socket.onclose triggers auto-reconnect without kicking user to login screen', () => {
    const client = Object.assign(Object.create(MultiplayerClient), {
        serverUrl: 'ws://localhost:8080/ws',
        sessionTokens: { alice: 'saved_tok' },
        reconnectAttempts: 0,
        maxReconnectAttempts: 5,
        isReconnecting: false,
        stopLocalBridgeMode() {},
        hideLoginError() {},
        setConnectingUI() {},
        activateSessionUI() {},
        checkServerVersion() {},
    });

    let createdSocket = null;
    const fakeWindow = {
        WebSocket: class FakeWebSocket {
            constructor(url) {
                this.url = url;
                this.readyState = 1;
                createdSocket = this;
            }
            send() {}
            close() {}
        }
    };
    const overlayClasses = new Set(['hidden']);
    const fakeDoc = {
        getElementById(id) {
            if (id === 'net-status-dot') return { className: '' };
            if (id === 'mp-login-overlay') {
                return {
                    classList: {
                        contains: (c) => overlayClasses.has(c),
                        add: (c) => overlayClasses.add(c),
                        remove: (c) => overlayClasses.delete(c),
                    }
                };
            }
            return null;
        }
    };

    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    globalThis.window = fakeWindow;
    globalThis.document = fakeDoc;

    try {
        // Connect initially
        client.connect('alice');
        expect(createdSocket).not.toBeNull();
        expect(createdSocket.url).toContain('token=saved_tok');

        // Socket opens successfully
        createdSocket.onopen();

        // Simulate sudden network drop (code 1006 abnormal closure)
        createdSocket.onclose({ code: 1006, reason: 'abnormal closure' });

        // Verify client initiated auto-reconnect
        expect(client.isReconnecting).toBe(true);
        expect(client.reconnectAttempts).toBe(1);
        expect(client.reconnectTimer).not.toBeNull();

        // Login overlay MUST NOT be shown (user stays in game!)
        expect(overlayClasses.has('hidden')).toBe(true);

        clearTimeout(client.reconnectTimer);
    } finally {
        globalThis.window = prevWindow;
        globalThis.document = prevDocument;
    }
});

test('Socket.onclose with 4409 clears session token and halts auto-reconnect', () => {
    const client = Object.assign(Object.create(MultiplayerClient), {
        serverUrl: 'ws://localhost:8080/ws',
        sessionTokens: { bob: 'invalid_tok' },
        reconnectAttempts: 0,
        maxReconnectAttempts: 5,
        isReconnecting: false,
        stopLocalBridgeMode() {},
        hideLoginError() {},
        setConnectingUI() {},
        showLoginError() {},
        cleanupOnDisconnect() {},
        checkServerVersion() {},
    });

    let createdSocket = null;
    const fakeWindow = {
        WebSocket: class FakeWebSocket {
            constructor(url) {
                this.url = url;
                this.readyState = 1;
                createdSocket = this;
            }
            send() {}
            close() {}
        }
    };

    const prevWindow = globalThis.window;
    globalThis.window = fakeWindow;

    try {
        client.connect('bob');
        createdSocket.onclose({ code: 4409, reason: 'username already taken' });

        // Token should be cleared so user can try another name or fresh login
        expect(client.getSessionToken('bob')).toBe('');
        expect(client.isReconnecting).toBe(false);
        expect(client.reconnectAttempts).toBe(0);
        expect(client.reconnectTimer).toBeNull();
    } finally {
        globalThis.window = prevWindow;
    }
});

test('Socket.onclose with 4408 halts auto-reconnect and cleans up UI on session replacement', () => {
    let cleanedUp = false;
    let loginErrorShown = false;
    const client = Object.assign(Object.create(MultiplayerClient), {
        serverUrl: 'ws://localhost:8080/ws',
        sessionTokens: { alice: 'valid_tok' },
        reconnectAttempts: 1,
        isReconnecting: true,
        stopLocalBridgeMode() {},
        hideLoginError() {},
        setConnectingUI() {},
        showLoginError() { loginErrorShown = true; },
        cleanupOnDisconnect() { cleanedUp = true; },
        checkServerVersion() {},
    });

    let createdSocket = null;
    const fakeWindow = {
        WebSocket: class FakeWebSocket {
            constructor(url) {
                this.url = url;
                createdSocket = this;
            }
            send() {}
            close() {}
        }
    };

    const prevWindow = globalThis.window;
    globalThis.window = fakeWindow;

    try {
        client.connect('alice');
        createdSocket.onclose({ code: 4408, reason: 'session replaced from another connection' });

        expect(client.isReconnecting).toBe(false);
        expect(client.reconnectAttempts).toBe(0);
        expect(cleanedUp).toBe(true);
        expect(loginErrorShown).toBe(true);
    } finally {
        globalThis.window = prevWindow;
    }
});

test('handleServerMessage join reconciles roster and removes departed players', () => {
    const removed = [];
    const client = Object.assign(Object.create(MultiplayerClient), {
        sessionTokens: {},
        onlineUsers: new Set(['alice', 'bob', 'charlie']),
        remotePlayers: new Map([
            ['bob', { username: 'bob' }],
            ['charlie', { username: 'charlie' }]
        ]),
        updateOnlineRosterUI() {},
        removeRemotePlayer(user) {
            removed.push(user);
            this.remotePlayers.delete(user);
        },
        sendMoveSnapshot() {},
    });
    GAME_STATE.username = 'alice';

    // Alice joins and receives roster with only ['alice', 'charlie'] (bob left during outage)
    client.handleServerMessage({
        type: 'join',
        user: 'alice',
        token: 'tok_reconcile',
        roster: ['alice', 'charlie']
    });

    // Bob should have been pruned
    expect(removed).toContain('bob');
    expect(client.remotePlayers.has('bob')).toBe(false);
    expect(client.remotePlayers.has('charlie')).toBe(true);
    expect(client.onlineUsers.has('bob')).toBe(false);
    expect(client.onlineUsers.has('charlie')).toBe(true);
});

test('WebSocket constructor failure with exhausted retries invokes cleanupOnDisconnect', () => {
    let cleanedUp = false;
    let loginErrorShown = false;
    const client = Object.assign(Object.create(MultiplayerClient), {
        serverUrl: 'ws://localhost:8080/ws',
        reconnectAttempts: 10,
        maxReconnectAttempts: 10,
        isReconnecting: true,
        stopLocalBridgeMode() {},
        hideLoginError() {},
        setConnectingUI() {},
        showLoginError() { loginErrorShown = true; },
        cleanupOnDisconnect() { cleanedUp = true; },
        checkServerVersion() {},
    });

    const fakeWindow = {
        WebSocket: class ThrowingWebSocket {
            constructor() {
                throw new Error('SecurityError: WebSocket blocked by CSP');
            }
        }
    };

    const prevWindow = globalThis.window;
    globalThis.window = fakeWindow;

    try {
        client.connect('alice', false, true);

        expect(client.isReconnecting).toBe(false);
        expect(client.reconnectAttempts).toBe(0);
        expect(cleanedUp).toBe(true);
        expect(loginErrorShown).toBe(true);
    } finally {
        globalThis.window = prevWindow;
    }
});
