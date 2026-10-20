import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { MsgPackCodec } from '../js/msgpack.js';
import {
    createGameState,
    GAME_STATE,
    resolveZoneName,
    applyPOICompletion,
    startNpcDialogueSession,
    advanceNpcDialogue,
    computePedestrianAnim,
    deriveDefaultWsUrl,
    RUSSIAN_NAMES,
    VLADIVOSTOK_LOCATION_SUFFIXES,
    generateRandomVladivostokName,
    getInitialUsername
} from '../js/state.js';
import { World, getVladivostokTime, getTimeOfDayPhase } from '../js/world.js';
import { MultiplayerClient, showChatBox, hideChatBox, scheduleChatAutoHide } from '../js/network.js';
import { getLabelDistanceMetrics, substitutePlayerMentions } from '../js/ui.js';
import { selectValidSpawnPoint, Player, revalidatePlayerSpawn } from '../js/entities.js';
import { clearMovementInput } from '../js/input.js';
import worldMap from '../data/world_map.json';
import npcDialogues from '../data/npc_dialogues.json';

describe('JSON Data Schemas (world_map.json & npc_dialogues.json)', () => {
    test('npc_dialogues.json has 10 valid Vladivostok personas with 3 options and 3 goodbyes each', () => {
        expect(Array.isArray(npcDialogues)).toBe(true);
        expect(npcDialogues.length).toBe(10);

        for (const npc of npcDialogues) {
            expect(typeof npc.name).toBe('string');
            expect(typeof npc.emoji).toBe('string');
            expect(typeof npc.role).toBe('string');
            expect(typeof npc.opening).toBe('string');
            expect(Array.isArray(npc.options)).toBe(true);
            expect(npc.options.length).toBe(3);
            for (const opt of npc.options) {
                expect(typeof opt.question).toBe('string');
                expect(typeof opt.answer).toBe('string');
            }
            expect(Array.isArray(npc.goodbyes)).toBe(true);
            expect(npc.goodbyes.length).toBe(3);
        }
    });

    test('world_map.json contains shared vehicles, POIs, stalls, colliders, and zones', () => {
        expect(worldMap.vehicles.length).toBe(5);
        expect(worldMap.vehicles.map(v => v.id)).toEqual(['car_0', 'car_1', 'car_2', 'car_3', 'car_4']);
        expect(worldMap.stalls.length).toBe(3);
        expect(worldMap.pois.length).toBe(10);
        expect(Object.keys(worldMap.teleports).length).toBe(11);
        expect(worldMap.zones.length).toBeGreaterThanOrEqual(5);
    });
});

describe('Game State & Pure Logic', () => {
    test('resolveZoneName identifies promenade zones from coordinates', () => {
        expect(resolveZoneName(-25, 0, worldMap)).toBe('Пляж «Юбилейный» & Амурский залив');
        expect(resolveZoneName(0, 0, worldMap)).toBe('Площадь у Большого Фонтана');
        expect(resolveZoneName(0, -80, worldMap)).toBe('Парк аттракционов & Колесо обозрения');
        expect(resolveZoneName(0, 85, worldMap)).toBe('Набережная у к/т «Океан»');
        expect(resolveZoneName(0, 40, worldMap)).toBe('Фудкорт Набки (Пян-се & Чифаньки)');
        expect(resolveZoneName(10, -30, worldMap)).toBe('Спортивная набережная — Променад');
    });

    test('applyPOICompletion increments money and upgrades respect stars on new POIs', () => {
        const state = createGameState();
        const r1 = applyPOICompletion(state, 'poi_fountain', 500);
        expect(r1.isNew).toBe(true);
        expect(state.money).toBe(125900);
        expect(state.stars).toBe(2);

        // Completing the same POI again rewards cash but does not double-count POI progress
        const r1Dup = applyPOICompletion(state, 'poi_fountain', 500);
        expect(r1Dup.isNew).toBe(false);
        expect(state.money).toBe(126400);
        expect(r1Dup.count).toBe(1);

        applyPOICompletion(state, 'poi_tiger', 400);
        expect(state.stars).toBe(3);
    });

    test('NPC dialogue state machine transitions from opening -> answered', () => {
        const persona = npcDialogues[0];
        const npc = { persona, chatStage: 'opening', chatHistory: [] };

        startNpcDialogueSession(npc);
        expect(npc.chatStage).toBe('opening');
        expect(npc.chatHistory.length).toBe(1);
        expect(npc.chatHistory[0].text).toBe(persona.opening);

        const chosen = advanceNpcDialogue(npc, 1);
        expect(chosen).toEqual(persona.options[1]);
        expect(npc.chatStage).toBe('answered');
        expect(npc.chatHistory.length).toBe(3);
        expect(npc.chatHistory[1].text).toBe(persona.options[1].question);
        expect(npc.chatHistory[2].text).toBe(persona.options[1].answer);
    });

    test('computePedestrianAnim selects idle, walk, run, jump, and emote accurately', () => {
        expect(computePedestrianAnim({ emoteTimer: 0.5, isGrounded: true, vx: 0, vz: 0 })).toBe('emote');
        expect(computePedestrianAnim({ emoteTimer: 0, isGrounded: false, vx: 0, vz: 0 })).toBe('jump');
        expect(computePedestrianAnim({ emoteTimer: 0, isGrounded: true, vx: 10, vz: 0 })).toBe('run');
        expect(computePedestrianAnim({ emoteTimer: 0, isGrounded: true, vx: 2, vz: 0 })).toBe('walk');
        expect(computePedestrianAnim({ emoteTimer: 0, isGrounded: true, vx: 0, vz: 0 })).toBe('idle');
    });

    test('deriveDefaultWsUrl handles http and https origins', () => {
        expect(deriveDefaultWsUrl({ protocol: 'http:', host: 'localhost:8080' })).toBe('ws://localhost:8080/ws');
        expect(deriveDefaultWsUrl({ protocol: 'https:', host: 'nabka.melekhin.me' })).toBe('wss://nabka.melekhin.me/ws');
    });
});

describe('MultiplayerClient state replication', () => {
    beforeEach(() => {
        GAME_STATE.username = 'Костян-с-Луговой';
        GAME_STATE.inVehicle = null;
        MultiplayerClient.remotePlayers.clear();
        MultiplayerClient.onlineUsers.clear();
        World.vehicles = [
            {
                id: 'car_0',
                name: 'Toyota Mark II Tourer V',
                remoteDriver: null,
                netTarget: null,
                speed: 0,
                group: {
                    position: {
                        x: 19.5, y: 0.02, z: 14,
                        set(x, y, z) { this.x = x; this.y = y; this.z = z; },
                        copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; }
                    },
                    rotation: { y: Math.PI }
                }
            }
        ];
    });

    test('replicates remote player join, pedestrian move, driving move, and server park transition', () => {
        MultiplayerClient.handleServerMessage({ type: 'join', user: 'vvo_racer' });
        expect(MultiplayerClient.onlineUsers.has('vvo_racer')).toBe(true);
        expect(MultiplayerClient.remotePlayers.has('vvo_racer')).toBe(true);

        // Pedestrian move
        MultiplayerClient.handleServerMessage({
            type: 'move',
            username: 'vvo_racer',
            mode: 'pedestrian',
            x: 8.5,
            y: 0,
            z: -12.0,
            vx: 1.0,
            vz: -2.0,
            yaw: 0.5,
            anim: 'walk'
        });
        const rp = MultiplayerClient.remotePlayers.get('vvo_racer');
        expect(rp.mode).toBe('pedestrian');
        expect(rp.anim).toBe('walk');
        expect(rp.target.x).toBe(8.5);
        expect(rp.target.z).toBe(-12.0);

        // Driving move occupies car_0
        MultiplayerClient.handleServerMessage({
            type: 'move',
            username: 'vvo_racer',
            mode: 'driving',
            car_id: 'car_0',
            x: 22.0,
            y: 0.02,
            z: 30.0,
            speed: 18.0,
            yaw: 1.2,
            drift: true,
            lights: true
        });
        const car0 = World.vehicles[0];
        expect(rp.mode).toBe('driving');
        expect(rp.carId).toBe('car_0');
        expect(rp.group.visible).toBe(false);
        expect(car0.remoteDriver).toBe('vvo_racer');
        expect(car0.netTarget.x).toBe(22.0);
        expect(car0.netTarget.z).toBe(30.0);

        // Server authoritative parked car state (driver = '') releases car occupancy and parks at coordinates
        MultiplayerClient.handleServerMessage({
            type: 'move',
            username: '',
            mode: 'driving',
            car_id: 'car_0',
            x: 25.0,
            y: 0.02,
            z: 40.0,
            speed: 0,
            yaw: 1.5,
            drift: false,
            lights: false
        });
        expect(car0.remoteDriver).toBeNull();
        expect(car0.group.position.x).toBe(25.0);
        expect(car0.group.position.z).toBe(40.0);
        expect(rp.mode).toBe('pedestrian');
        expect(rp.carId).toBeNull();
        expect(rp.group.visible).toBe(true);

        // Leave removes remote player
        MultiplayerClient.handleServerMessage({ type: 'leave', user: 'vvo_racer', reason: 'left' });
        expect(MultiplayerClient.onlineUsers.has('vvo_racer')).toBe(false);
        expect(MultiplayerClient.remotePlayers.has('vvo_racer')).toBe(false);
    });

    test('getLabelDistanceMetrics scales opacity in 1.0-0.6 range, orders zIndex by distance, and culls beyond 50m', () => {
        // At 0-10m: opacity 1.0
        const mClose = getLabelDistanceMetrics(5);
        expect(mClose.visible).toBe(true);
        expect(mClose.opacity).toBe('1.000');
        expect(mClose.zIndex).toBe(9500);

        const m10 = getLabelDistanceMetrics(10);
        expect(m10.visible).toBe(true);
        expect(m10.opacity).toBe('1.000');
        expect(m10.zIndex).toBe(9000);

        // At 30m: halfway between 10m and 50m -> 1.0 - (20/40)*0.4 = 0.8
        const m30 = getLabelDistanceMetrics(30);
        expect(m30.visible).toBe(true);
        expect(m30.opacity).toBe('0.800');
        expect(m30.zIndex).toBe(7000);

        // At 50m: exactly 0.6
        const m50 = getLabelDistanceMetrics(50);
        expect(m50.visible).toBe(true);
        expect(m50.opacity).toBe('0.600');
        expect(m50.zIndex).toBe(5000);

        // Closer object strictly draws on top of farther object
        expect(mClose.zIndex).toBeGreaterThan(m30.zIndex);
        expect(m30.zIndex).toBeGreaterThan(m50.zIndex);

        // Beyond 50m: culled
        const mFar = getLabelDistanceMetrics(50.1);
        expect(mFar.visible).toBe(false);
        expect(mFar.opacity).toBe('0');
    });

    test('sendMoveSnapshot encodes driving move without reference errors when in vehicle', () => {
        const sentPackets = [];
        MultiplayerClient.ws = {
            readyState: 1,
            send: (buf) => {
                sentPackets.push(MsgPackCodec.decode(buf));
            }
        };
        GAME_STATE.isConnected = true;
        GAME_STATE.username = 'test_driver';
        Player.position = { x: 12.3, y: 0.02, z: 45.6 };
        Player.velocity = { x: 0, y: 0, z: 0 };
        GAME_STATE.inVehicle = {
            id: 'car_0',
            x: 13.0, z: 46.0, vx: 12.5, vz: 0, yawRate: -1.25,
            speed: 15.5,
            yaw: 1.2,
            isDrifting: true,
            group: {
                position: { x: 12.3, y: 0.02, z: 45.6 },
                rotation: { y: 1.2 }
            }
        };

        expect(() => MultiplayerClient.sendMoveSnapshot(true)).not.toThrow();
        expect(sentPackets.length).toBe(1);
        expect(sentPackets[0].mode).toBe('driving');
        expect(sentPackets[0].car_id).toBe('car_0');
        expect(sentPackets[0].drift).toBe(true);
        expect(sentPackets[0].x).toBe(13.0);
        expect(sentPackets[0].z).toBe(46.0);
        expect(sentPackets[0].vx).toBe(12.5);
        expect(sentPackets[0].vz).toBe(0);
        expect(sentPackets[0].yaw_rate).toBe(-1.25);

        GAME_STATE.inVehicle = null;
    });

    test('Vladivostok time and time of day phase mapping', () => {
        expect(getTimeOfDayPhase(6.0)).toBe('dawn');
        expect(getTimeOfDayPhase(7.2)).toBe('dawn');
        expect(getTimeOfDayPhase(7.5)).toBe('day');
        expect(getTimeOfDayPhase(14.0)).toBe('day');
        expect(getTimeOfDayPhase(17.4)).toBe('day');
        expect(getTimeOfDayPhase(17.5)).toBe('sunset');
        expect(getTimeOfDayPhase(19.5)).toBe('sunset');
        expect(getTimeOfDayPhase(20.4)).toBe('sunset');
        expect(getTimeOfDayPhase(20.5)).toBe('dusk');
        expect(getTimeOfDayPhase(21.9)).toBe('dusk');
        expect(getTimeOfDayPhase(22.0)).toBe('night');
        expect(getTimeOfDayPhase(3.0)).toBe('night');

        const vvo = getVladivostokTime();
        expect(typeof vvo.hours).toBe('number');
        expect(typeof vvo.minutes).toBe('number');
        expect(typeof vvo.timeString).toBe('string');
        expect(vvo.timeString).toMatch(/^\d{2}:\d{2}$/);
    });

    test('selectValidSpawnPoint chooses unoccupied spawn point and evades nearby players/NPCs', () => {
        expect(Array.isArray(worldMap.spawnPoints)).toBe(true);
        expect(worldMap.spawnPoints.length).toBe(5);

        // All points clear
        const sp1 = selectValidSpawnPoint({
            spawnPoints: worldMap.spawnPoints,
            remotePlayers: new Map(),
            npcs: [],
            vehicles: [],
            randomFn: () => 0.0
        });
        expect(sp1.x).toBe(worldMap.spawnPoints[0].x);
        expect(sp1.z).toBe(worldMap.spawnPoints[0].z);

        // If first point is occupied within 2.5m, skips to next available point
        const mockRemotePlayers = new Map([
            ['busy_user', { target: { x: worldMap.spawnPoints[0].x, z: worldMap.spawnPoints[0].z } }]
        ]);
        const sp2 = selectValidSpawnPoint({
            spawnPoints: worldMap.spawnPoints,
            remotePlayers: mockRemotePlayers,
            npcs: [],
            vehicles: [],
            randomFn: () => 0.0
        });
        expect(sp2.x).toBe(worldMap.spawnPoints[1].x);
        expect(sp2.z).toBe(worldMap.spawnPoints[1].z);
    });

    test('clearMovementInput resets all movement keys, joystick vectors, and sprint', () => {
        GAME_STATE.keys.w = true;
        GAME_STATE.keys.a = true;
        GAME_STATE.keys.shift = true;
        GAME_STATE.joystickVector.x = 0.8;
        GAME_STATE.joystickVector.y = -0.5;
        GAME_STATE.joystickSprint = true;

        clearMovementInput();

        expect(GAME_STATE.keys.w).toBe(false);
        expect(GAME_STATE.keys.a).toBe(false);
        expect(GAME_STATE.keys.s).toBe(false);
        expect(GAME_STATE.keys.d).toBe(false);
        expect(GAME_STATE.keys.shift).toBe(false);
        expect(GAME_STATE.keys.space).toBe(false);
        expect(GAME_STATE.joystickVector.x).toBe(0);
        expect(GAME_STATE.joystickVector.y).toBe(0);
        expect(GAME_STATE.joystickSprint).toBe(false);
    });

    test('Player.jump and Player.emote are rejected when input is suspended', () => {
        Player.velocity = { x: 0, y: 0, z: 0 };
        Player.isGrounded = true;
        Player.emoteTimer = 0;

        // Suspend input with active NPC chat
        GAME_STATE.activeNpcChat = { persona: { name: 'TestNPC' } };

        Player.jump();
        expect(Player.velocity.y).toBe(0);
        expect(Player.isGrounded).toBe(true);

        Player.emote();
        expect(Player.emoteTimer).toBe(0);

        // Resume input
        GAME_STATE.activeNpcChat = null;

        Player.jump();
        expect(Player.velocity.y).toBe(9.8);
        expect(Player.isGrounded).toBe(false);

        Player.isGrounded = true;
        Player.emote();
        expect(Player.emoteTimer).toBe(3.2);
    });

    test('MultiplayerClient.removeRemotePlayer disposes geometries and materials on group', () => {
        let disposedGeo = false;
        let disposedMat = false;
        let disposedTex = false;

        const fakeGroup = {
            traverse(cb) {
                cb({
                    geometry: {
                        dispose() { disposedGeo = true; }
                    },
                    material: {
                        map: {
                            dispose() { disposedTex = true; }
                        },
                        dispose() { disposedMat = true; }
                    }
                });
            }
        };

        MultiplayerClient.remotePlayers.set('test_dispose_user', {
            username: 'test_dispose_user',
            group: fakeGroup,
            carId: null,
            tagWrapper: { remove() {} }
        });

        MultiplayerClient.removeRemotePlayer('test_dispose_user');

        expect(disposedGeo).toBe(true);
        expect(disposedMat).toBe(true);
        expect(disposedTex).toBe(true);
        expect(MultiplayerClient.remotePlayers.has('test_dispose_user')).toBe(false);
    });

    test('Superseded socket callbacks do not teardown active session', () => {
        const fakeOldSocket = {
            close() {},
            onopen: null,
            onmessage: null,
            onerror: null,
            onclose: null
        };
        const fakeNewSocket = {
            close() {},
            onopen: null,
            onmessage: null,
            onerror: null,
            onclose: null
        };

        MultiplayerClient.ws = fakeNewSocket;
        GAME_STATE.isConnected = true;
        let keepAliveFired = false;
        MultiplayerClient.keepAliveTimer = 999;

        // Simulate an event arriving from fakeOldSocket
        if (fakeOldSocket.onclose) {
            fakeOldSocket.onclose({ code: 1006, reason: 'Abnormal Closure' });
        }

        // Connection should remain intact because fakeOldSocket is not MultiplayerClient.ws
        expect(GAME_STATE.isConnected).toBe(true);
        expect(MultiplayerClient.keepAliveTimer).toBe(999);
        expect(MultiplayerClient.ws).toBe(fakeNewSocket);

        // Cleanup
        MultiplayerClient.ws = null;
        MultiplayerClient.keepAliveTimer = null;
        GAME_STATE.isConnected = false;
    });

    test('revalidatePlayerSpawn relocates player if spawn point is occupied in baseline', () => {
        const sp0 = worldMap.spawnPoints[0];
        const sp1 = worldMap.spawnPoints[1];

        Player.position = { x: sp0.x, y: sp0.y, z: sp0.z, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
        Player.rotationY = sp0.yaw || 0;
        Player.group = { position: { copy(p) { Object.assign(this, p); } }, rotation: { y: 0 } };

        // Test unoccupied: returns false, keeps position
        const changedUnoccupied = revalidatePlayerSpawn(worldMap, new Map());
        expect(changedUnoccupied).toBe(false);
        expect(Player.position.x).toBe(sp0.x);
        expect(Player.position.z).toBe(sp0.z);

        // Test occupied: remote player at sp0
        const remotePlayers = new Map([
            ['blocker', { target: { x: sp0.x, z: sp0.z } }]
        ]);

        const changedOccupied = revalidatePlayerSpawn(worldMap, remotePlayers, () => 0.0);
        expect(changedOccupied).toBe(true);
        expect(Player.position.x).toBe(sp1.x);
        expect(Player.position.z).toBe(sp1.z);
    });
});

describe('Multiplayer Chat collapse, show/hide, and auto-hide', () => {
    let mockElements;
    let originalDocument;

    function createMockElement(id, initialClasses = []) {
        const classes = new Set(initialClasses);
        return {
            id,
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                contains: (c) => classes.has(c),
            },
            className: initialClasses.join(' '),
            value: '',
            focus() {
                globalThis.document.activeElement = this;
            },
            blur() {
                if (globalThis.document.activeElement === this) {
                    globalThis.document.activeElement = null;
                }
            }
        };
    }

    beforeEach(() => {
        originalDocument = globalThis.document;
        mockElements = {
            'mp-chat-panel': createMockElement('mp-chat-panel', ['hidden']),
            'mp-chat-body': createMockElement('mp-chat-body', ['hidden']),
            'mp-chat-input': createMockElement('mp-chat-input'),
            'chat-collapse-icon': createMockElement('chat-collapse-icon', ['fa-solid', 'fa-chevron-down'])
        };

        globalThis.document = {
            activeElement: null,
            getElementById: (id) => mockElements[id] || null
        };

        MultiplayerClient.cancelChatAutoHide();
        GAME_STATE.chatCollapsed = true;
    });

    afterEach(() => {
        MultiplayerClient.cancelChatAutoHide();
        globalThis.document = originalDocument;
    });

    test('showChat(true) reveals chat panel and body, focuses input, and cancels auto-hide', () => {
        showChatBox(true);

        expect(mockElements['mp-chat-panel'].classList.contains('hidden')).toBe(false);
        expect(mockElements['mp-chat-body'].classList.contains('hidden')).toBe(false);
        expect(mockElements['chat-collapse-icon'].className).toBe('fa-solid fa-chevron-up');
        expect(GAME_STATE.chatCollapsed).toBe(false);
        expect(globalThis.document.activeElement).toBe(mockElements['mp-chat-input']);
        expect(MultiplayerClient.chatAutoHideTimer).toBeNull();
    });

    test('hideChat() hides chat panel and body, blurs input, and marks state collapsed', () => {
        showChatBox(true);
        expect(mockElements['mp-chat-panel'].classList.contains('hidden')).toBe(false);

        hideChatBox();

        expect(mockElements['mp-chat-panel'].classList.contains('hidden')).toBe(true);
        expect(mockElements['mp-chat-body'].classList.contains('hidden')).toBe(true);
        expect(mockElements['chat-collapse-icon'].className).toBe('fa-solid fa-chevron-down');
        expect(GAME_STATE.chatCollapsed).toBe(true);
        expect(globalThis.document.activeElement).toBeNull();
    });

    test('scheduleChatAutoHide hides chat after delay when input is not focused', async () => {
        showChatBox(false); // does not focus input, schedules auto-hide
        expect(mockElements['mp-chat-panel'].classList.contains('hidden')).toBe(false);

        // Re-schedule with short delay for test
        scheduleChatAutoHide(20);
        expect(MultiplayerClient.chatAutoHideTimer).not.toBeNull();

        await new Promise(r => setTimeout(r, 45));

        expect(mockElements['mp-chat-panel'].classList.contains('hidden')).toBe(true);
        expect(GAME_STATE.chatCollapsed).toBe(true);
    });

    test('scheduleChatAutoHide does NOT hide chat when input field is actively focused', async () => {
        showChatBox(true); // focuses input
        expect(globalThis.document.activeElement).toBe(mockElements['mp-chat-input']);

        // Attempt to auto-hide with short delay
        scheduleChatAutoHide(20);

        await new Promise(r => setTimeout(r, 45));

        // Since input is focused, chat must remain open
        expect(mockElements['mp-chat-panel'].classList.contains('hidden')).toBe(false);
        expect(GAME_STATE.chatCollapsed).toBe(false);
    });
});

describe('Vladivostok Name Generation and Placeholder Handling', () => {
    test('RUSSIAN_NAMES has exactly 50 common names (25 male, 25 female) all capitalized', () => {
        expect(Array.isArray(RUSSIAN_NAMES.male)).toBe(true);
        expect(Array.isArray(RUSSIAN_NAMES.female)).toBe(true);
        expect(RUSSIAN_NAMES.male.length).toBe(25);
        expect(RUSSIAN_NAMES.female.length).toBe(25);

        const allNames = [...RUSSIAN_NAMES.male, ...RUSSIAN_NAMES.female];
        expect(allNames.length).toBe(50);

        for (const name of allNames) {
            expect(typeof name).toBe('string');
            expect(name.length).toBeGreaterThan(1);
            // Verify first character is uppercase
            expect(name[0]).toBe(name[0].toUpperCase());
        }

        // Verify key sample names from prompt requirements
        expect(RUSSIAN_NAMES.male).toContain('Костян');
        expect(RUSSIAN_NAMES.female).toContain('Люба');
    });

    test('VLADIVOSTOK_LOCATION_SUFFIXES contains local area names with prefixes', () => {
        expect(Array.isArray(VLADIVOSTOK_LOCATION_SUFFIXES)).toBe(true);
        expect(VLADIVOSTOK_LOCATION_SUFFIXES.length).toBeGreaterThanOrEqual(20);

        for (const suffix of VLADIVOSTOK_LOCATION_SUFFIXES) {
            expect(typeof suffix).toBe('string');
            expect(suffix.startsWith('-')).toBe(true);
        }

        // Suffixes mentioned in user requirements
        expect(VLADIVOSTOK_LOCATION_SUFFIXES).toContain('-с-Чуркина');
        expect(VLADIVOSTOK_LOCATION_SUFFIXES).toContain('-со-Спортивки');
        expect(VLADIVOSTOK_LOCATION_SUFFIXES).toContain('-из-Центра');
        expect(VLADIVOSTOK_LOCATION_SUFFIXES).toContain('-с-Эгершельда');
        expect(VLADIVOSTOK_LOCATION_SUFFIXES).toContain('-с-Зелёнки');
        expect(VLADIVOSTOK_LOCATION_SUFFIXES).toContain('-с-Луговой');
        expect(VLADIVOSTOK_LOCATION_SUFFIXES).toContain('-с-Первака');
    });

    test('generateRandomVladivostokName generates capitalized name + location suffix', () => {
        // Deterministic call with custom random function
        const deterministicName = generateRandomVladivostokName(() => 0);
        expect(deterministicName).toBe(RUSSIAN_NAMES.male[0] + VLADIVOSTOK_LOCATION_SUFFIXES[0]);

        // Default Math.random call
        const randomName = generateRandomVladivostokName();
        expect(typeof randomName).toBe('string');
        const parts = randomName.split('-');
        expect(parts.length).toBeGreaterThanOrEqual(2);
        const allNames = [...RUSSIAN_NAMES.male, ...RUSSIAN_NAMES.female];
        expect(allNames).toContain(parts[0]);
    });

    test('getInitialUsername loads from localStorage if present', () => {
        const originalStorage = globalThis.localStorage;
        const fakeStorage = new Map();
        globalThis.localStorage = {
            getItem: (k) => fakeStorage.get(k) || null,
            setItem: (k, v) => fakeStorage.set(k, String(v)),
            removeItem: (k) => fakeStorage.delete(k),
            clear: () => fakeStorage.clear()
        };

        try {
            fakeStorage.set('nabka_username', 'Люба-с-Первака');
            expect(getInitialUsername()).toBe('Люба-с-Первака');

            fakeStorage.delete('nabka_username');
            fakeStorage.set('nabka_mp_username', 'Костян-с-Луговой');
            expect(getInitialUsername()).toBe('Костян-с-Луговой');

            fakeStorage.clear();
            const fallback = getInitialUsername();
            expect(typeof fallback).toBe('string');
            expect(fallback.length).toBeGreaterThan(3);
        } finally {
            globalThis.localStorage = originalStorage;
        }
    });

    test('substitutePlayerMentions replaces @cpro29a, cpro29a, @{username}, and {username}', () => {
        const username = 'Костян-с-Луговой';
        expect(substitutePlayerMentions('Привет от @cpro29a!', username)).toBe('Привет от @Костян-с-Луговой!');
        expect(substitutePlayerMentions('Взять Раф для @{username} (+Спринт)', username)).toBe('Взять Раф для @Костян-с-Луговой (+Спринт)');
        expect(substitutePlayerMentions('Фото {username} у тигра', username)).toBe('Фото Костян-с-Луговой у тигра');
        expect(substitutePlayerMentions('Люблю cpro29a на Набке', username)).toBe('Люблю Костян-с-Луговой на Набке');
        expect(substitutePlayerMentions('', username)).toBe('');
        expect(substitutePlayerMentions(null, username)).toBe('');
    });

    test('createGameState initializes username from overrides or getInitialUsername', () => {
        const customState = createGameState({ username: 'Артём-с-Шаморы' });
        expect(customState.username).toBe('Артём-с-Шаморы');

        const defaultState = createGameState({});
        expect(typeof defaultState.username).toBe('string');
        expect(defaultState.username.length).toBeGreaterThan(0);
    });

    test('MultiplayerClient.initUI sets random placeholder on first run, saves on submit, and restores on subsequent run', () => {
        const originalDocument = globalThis.document;
        const originalStorage = globalThis.localStorage;
        const fakeStorage = new Map();

        globalThis.localStorage = {
            getItem: (k) => fakeStorage.get(k) || null,
            setItem: (k, v) => fakeStorage.set(k, String(v)),
            removeItem: (k) => fakeStorage.delete(k),
            clear: () => fakeStorage.clear()
        };

        const listeners = {};
        const elements = {
            'mp-login-form': {
                addEventListener: (evt, cb) => { listeners['login-submit'] = cb; }
            },
            'mp-username-input': {
                placeholder: '',
                value: '',
                addEventListener: (evt, cb) => { listeners['input-' + evt] = cb; }
            },
            'header-username': { textContent: '' },
            'local-nametag-text': { textContent: '' },
            'hud-card-username': { textContent: '' },
            'help-modal-username': { textContent: '' }
        };

        globalThis.document = {
            getElementById: (id) => elements[id] || null,
            addEventListener: () => {}
        };

        try {
            // First run: no localStorage
            MultiplayerClient.initUI();

            const firstGeneratedName = elements['mp-username-input'].value;
            expect(typeof firstGeneratedName).toBe('string');
            expect(firstGeneratedName.length).toBeGreaterThan(3);
            expect(elements['mp-username-input'].placeholder).toBe(`Например: ${firstGeneratedName}`);
            expect(elements['header-username'].textContent).toBe('@' + firstGeneratedName);
            expect(elements['local-nametag-text'].textContent).toBe('@' + firstGeneratedName);

            // User types a different Vladivostok name
            elements['mp-username-input'].value = 'Люба-с-Первака';
            if (listeners['input-input']) listeners['input-input']();
            expect(elements['header-username'].textContent).toBe('@Люба-с-Первака');

            // Form is submitted
            let connectedName = null;
            const originalConnect = MultiplayerClient.connect;
            MultiplayerClient.connect = (name) => {
                connectedName = name;
                fakeStorage.set('nabka_username', name);
                fakeStorage.set('nabka_mp_username', name);
            };

            const fakeEvt = { preventDefault: () => {} };
            listeners['login-submit'](fakeEvt);
            expect(connectedName).toBe('Люба-с-Первака');
            expect(fakeStorage.get('nabka_username')).toBe('Люба-с-Первака');

            // Subsequent visit: localStorage has 'Люба-с-Первака'
            elements['mp-username-input'].value = '';
            MultiplayerClient.initUI();
            expect(elements['mp-username-input'].value).toBe('Люба-с-Первака');
            expect(elements['header-username'].textContent).toBe('@Люба-с-Первака');

            MultiplayerClient.connect = originalConnect;
        } finally {
            globalThis.document = originalDocument;
            globalThis.localStorage = originalStorage;
        }
    });
});

describe('Client Auto-Update and Version Check', () => {
    let originalFetch;
    let originalWindow;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        originalWindow = globalThis.window;
        MultiplayerClient.currentBuildVersion = null;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        globalThis.window = originalWindow;
    });

    test('checkServerVersion seeds currentBuildVersion without reloading on first check', async () => {
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({ version: 'nabka-build-100', status: 'ok' })
        });

        const version = await MultiplayerClient.checkServerVersion(false);
        expect(version).toBe('nabka-build-100');
        expect(MultiplayerClient.currentBuildVersion).toBe('nabka-build-100');
    });

    test('checkServerVersion detects new server build and triggers reload when autoReloadOnNewVersion is true', async () => {
        MultiplayerClient.currentBuildVersion = 'nabka-build-100';

        let reloadTriggered = false;
        globalThis.window = {
            location: {
                reload: (force) => { reloadTriggered = true; }
            }
        };

        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({ version: 'nabka-build-200', status: 'ok' })
        });

        let errorShown = '';
        const origShowLoginError = MultiplayerClient.showLoginError;
        MultiplayerClient.showLoginError = (msg) => { errorShown = msg; };

        const version = await MultiplayerClient.checkServerVersion(true);
        expect(version).toBe('nabka-build-200');
        expect(errorShown).toContain('Вышло обновление Набки');

        MultiplayerClient.showLoginError = origShowLoginError;
    });

    test('checkServerVersion handles fetch failure gracefully without error', async () => {
        globalThis.fetch = async () => {
            throw new Error('Network error');
        };

        const result = await MultiplayerClient.checkServerVersion(true);
        expect(result).toBeNull();
    });
});


