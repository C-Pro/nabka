import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { MultiplayerClient } from '../js/network.js';
import { GAME_STATE, resetPoliceState, isLocalPlayerChased, isGameplayInputSuspended } from '../js/state.js';
import { World } from '../js/world.js';
import { MsgPackCodec } from '../js/msgpack.js';
import { POLICE_CAR_SPECS } from '../js/physics.js';
import { clearPoliceEntities } from '../js/entities.js';
import { SoundManager } from '../js/audio.js';

function makeMockElement(id) {
    const classSet = new Set();
    const attrs = {};
    const children = [];
    let textContent = '';
    return {
        id,
        children,
        classList: {
            add: (...cls) => cls.forEach(c => classSet.add(c)),
            remove: (...cls) => cls.forEach(c => classSet.delete(c)),
            contains: (c) => classSet.has(c),
            toggle: (c, force) => {
                if (force === undefined) {
                    if (classSet.has(c)) { classSet.delete(c); return false; }
                    classSet.add(c); return true;
                }
                if (force) classSet.add(c);
                else classSet.delete(c);
                return force;
            }
        },
        get className() { return Array.from(classSet).join(' '); },
        set className(v) {
            classSet.clear();
            String(v || '').split(/\s+/).filter(Boolean).forEach(c => classSet.add(c));
        },
        get textContent() { return textContent; },
        set textContent(v) { textContent = String(v); },
        innerHTML: '',
        disabled: false,
        setAttribute: (k, v) => { attrs[k] = String(v); },
        removeAttribute: (k) => { delete attrs[k]; },
        getAttribute: (k) => attrs[k] ?? null,
        append(...nodes) { children.push(...nodes); },
        appendChild(node) { children.push(node); return node; },
        replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
        remove() { this._removed = true; },
        addEventListener() {},
        focus() {}
    };
}

describe('Police Multiplayer Network Sync & Isolation', () => {
    let prevDoc;
    let prevVehicles;
    let prevInteractables;
    let prevMoney;
    let prevUsername;
    let prevInVehicle;
    let prevConnected;
    let mockEls;

    beforeEach(() => {
        prevDoc = globalThis.document;
        prevVehicles = World.vehicles;
        prevInteractables = World.interactables;
        prevMoney = GAME_STATE.money;
        prevUsername = GAME_STATE.username;
        prevInVehicle = GAME_STATE.inVehicle;
        prevConnected = GAME_STATE.isConnected;

        mockEls = {
            'hud-money': makeMockElement('hud-money'),
            'police-pursuit-banner': makeMockElement('police-pursuit-banner'),
            'police-pursuit-text': makeMockElement('police-pursuit-text'),
            'npc-dialogue-modal': makeMockElement('npc-dialogue-modal'),
            'npc-avatar-badge': makeMockElement('npc-avatar-badge'),
            'npc-modal-name': makeMockElement('npc-modal-name'),
            'npc-modal-badge': makeMockElement('npc-modal-badge'),
            'npc-modal-role': makeMockElement('npc-modal-role'),
            'npc-chat-history': makeMockElement('npc-chat-history'),
            'npc-options-container': makeMockElement('npc-options-container'),
            'btn-close-npc-chat': makeMockElement('btn-close-npc-chat'),
            'npc-labels-container': makeMockElement('npc-labels-container'),
            'toast-container': makeMockElement('toast-container')
        };
        mockEls['police-pursuit-banner'].classList.add('hidden');
        mockEls['npc-dialogue-modal'].classList.add('hidden');

        globalThis.document = {
            activeElement: null,
            getElementById: (id) => mockEls[id] || null,
            createElement: (tag) => makeMockElement(tag),
            querySelectorAll: () => []
        };

        World.vehicles = [];
        World.interactables = [];
        clearPoliceEntities();
        resetPoliceState(GAME_STATE);
        GAME_STATE.username = 'Лёха-со-Спортивки';
        GAME_STATE.money = 125400;
        GAME_STATE.inVehicle = null;
        GAME_STATE.isConnected = true;
    });

    afterEach(() => {
        clearPoliceEntities();
        resetPoliceState(GAME_STATE);
        World.vehicles = prevVehicles;
        World.interactables = prevInteractables;
        GAME_STATE.money = prevMoney;
        GAME_STATE.username = prevUsername;
        GAME_STATE.inVehicle = prevInVehicle;
        GAME_STATE.isConnected = prevConnected;
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    });

    function createClientStub(sentPayloads = []) {
        return Object.assign(Object.create(MultiplayerClient), {
            sessionTokens: {},
            onlineUsers: new Set(),
            remotePlayers: new Map(),
            lastPoliceStateSequence: 0,
            lastVehicleImpulseSequence: 0,
            ws: {
                readyState: 1,
                send: (buf) => sentPayloads.push(MsgPackCodec.decode(buf))
            },
            safeSend(buf) {
                this.ws.send(buf);
                return true;
            },
            activateSessionUI() {},
            updateOnlineRosterUI() {},
            sendMoveSnapshot() {},
            setConnectingUI() {},
            stopLocalBridgeMode() {},
            hideLoginError() {},
            checkServerVersion() {}
        });
    }

    test('join syncs positive, zero, and negative money and resets police sequences across reconnects', () => {
        const client = createClientStub();
        client.lastPoliceStateSequence = 99;
        client.lastVehicleImpulseSequence = 42;
        GAME_STATE.policeStateSequence = 99;

        client.handleServerMessage({
            type: 'join',
            user: 'Лёха-со-Спортивки',
            token: 'tok_1',
            money: -15400,
            roster: ['Лёха-со-Спортивки']
        });

        expect(GAME_STATE.money).toBe(-15400);
        expect(mockEls['hud-money'].textContent).toBe(`-₽ ${(15400).toLocaleString('ru-RU')}`);
        expect(mockEls['hud-money'].classList.contains('text-rose-400')).toBe(true);
        expect(client.lastPoliceStateSequence).toBe(0);
        expect(client.lastVehicleImpulseSequence).toBe(0);
        expect(GAME_STATE.policeStateSequence).toBe(-1);

        // Fresh baseline at sequence 1 after reconnect must be accepted
        client.handleServerMessage({
            type: 'police_state',
            sequence: 1,
            sample_time_ms: 1000,
            foot_cops: [{ id: 'cop_0', name: 'Сержант', x: 5, y: 0, z: 10, vx: 0, vz: 0, yaw: 0, state: 'patrol', anim: 'idle', target_user: '' }],
            police_cars: [{ id: 'police_car_0', x: 23, y: 0, z: -20, vx: 0, vz: 9, yaw: 0, yaw_rate: 0, speed: 9, mass: 4200, state: 'patrol', target_car_id: '', target_user: '', siren: false, lights: false }]
        });
        expect(GAME_STATE.policeCops.size).toBe(1);
        expect(GAME_STATE.policeCars.size).toBe(1);

        // Zero balance on join
        client.handleServerMessage({
            type: 'join',
            user: 'Лёха-со-Спортивки',
            money: 0
        });
        expect(GAME_STATE.money).toBe(0);
        expect(mockEls['hud-money'].classList.contains('text-emerald-400')).toBe(true);
    });

    test('police_state drops stale sequences, keeps police cars out of World.vehicles/interactables, forwards outer header to snapshotBuffer, and disposes removed entities', () => {
        const client = createClientStub();

        client.handleServerMessage({
            type: 'police_state',
            sequence: 10,
            sample_time_ms: 5000,
            foot_cops: [
                { id: 'cop_0', name: 'Сержант Петров', x: 1, y: 0, z: 2, vx: 0, vz: 1, yaw: 0, state: 'patrol', anim: 'walk', target_user: '' }
            ],
            police_cars: [
                { id: 'police_car_0', x: 23, y: 0, z: -30, vx: 0, vz: 12, yaw: 0, yaw_rate: 0.1, speed: 12, mass: 4200, state: 'chase', target_car_id: 'car_0', target_user: 'Лёха-со-Спортивки', siren: true, lights: true }
            ]
        });

        expect(World.vehicles.length).toBe(0);
        expect(World.interactables.length).toBe(0);
        const pcar = GAME_STATE.policeCars.get('police_car_0');
        expect(pcar).toBeTruthy();
        expect(pcar.driveable).toBe(false);
        expect(pcar.isPolice).toBe(true);
        expect(pcar.isServerControlled).toBe(true);
        expect(pcar.remoteDriver).toBeNull();
        expect(pcar.mass).toBe(POLICE_CAR_SPECS.mass);
        expect(pcar.snapshotBuffer.sequence).toBe(10);
        expect(pcar.snapshotBuffer.samples[0].sample_time_ms).toBe(5000);

        // Stale sequence 9 dropped
        client.handleServerMessage({
            type: 'police_state',
            sequence: 9,
            sample_time_ms: 4900,
            foot_cops: [],
            police_cars: []
        });
        expect(GAME_STATE.policeCops.size).toBe(1);
        expect(GAME_STATE.policeCars.size).toBe(1);

        // Sequence 11 removes cop & car and removes their DOM labels
        const copLabel = GAME_STATE.policeCops.get('cop_0').labelEl;
        const carLabel = pcar.labelEl;
        client.handleServerMessage({
            type: 'police_state',
            sequence: 11,
            sample_time_ms: 5050,
            foot_cops: [],
            police_cars: []
        });
        expect(GAME_STATE.policeCops.size).toBe(0);
        expect(GAME_STATE.policeCars.size).toBe(0);
        expect(copLabel._removed).toBe(true);
        expect(carLabel._removed).toBe(true);
    });

    test('broadcast balance_update, police_encounter_result, and police_chase isolate local user wallet', () => {
        const client = createClientStub();
        GAME_STATE.money = 10000;

        // Broadcast for another user must NOT touch local GAME_STATE.money
        client.handleServerMessage({
            type: 'balance_update',
            username: 'Другой-игрок',
            money: -99999,
            delta: -109999,
            reason: 'police_fine'
        });
        expect(GAME_STATE.money).toBe(10000);

        client.handleServerMessage({
            type: 'police_encounter_result',
            encounter_id: 'enc_other',
            target_user: 'Другой-игрок',
            option_index: 0,
            reply_text: 'Оплата прошла',
            fine: 5000,
            money: -5000
        });
        expect(GAME_STATE.money).toBe(10000);

        client.handleServerMessage({
            type: 'police_chase',
            police_car_id: 'police_car_0',
            target_car_id: 'car_1',
            target_user: 'Другой-игрок',
            status: 'stopped',
            fine: 5000,
            money: -5000
        });
        expect(GAME_STATE.money).toBe(10000);

        // Matching local user updates money into negative territory
        client.handleServerMessage({
            type: 'balance_update',
            username: 'Лёха-со-Спортивки',
            money: -5000,
            delta: -15000,
            reason: 'police_fine'
        });
        expect(GAME_STATE.money).toBe(-5000);
        expect(mockEls['hud-money'].textContent).toBe(`-₽ ${(5000).toLocaleString('ru-RU')}`);
    });

    test('sendPoliceDialogueChoice validates option_index 0..15, encodes MsgPack, and guards against double-submit', () => {
        const sent = [];
        const client = createClientStub(sent);

        client.handleServerMessage({
            type: 'police_encounter_start',
            encounter_id: 'enc_77',
            cop_id: 'cop_0',
            cop_name: 'Старшина Волков',
            scenario_id: 'weed_shakedown',
            title: 'Обыск',
            opening: 'Откуда свёрток?',
            options: [
                { index: 0, text: 'Договориться', fine: 15000 },
                { index: 1, text: 'Составляйте протокол', fine: 25000 }
            ],
            target_user: 'Лёха-со-Спортивки'
        });

        // Invalid option indices rejected
        expect(client.sendPoliceDialogueChoice('enc_77', -1)).toBe(false);
        expect(client.sendPoliceDialogueChoice('enc_77', 16)).toBe(false);
        expect(client.sendPoliceDialogueChoice('', 0)).toBe(false);
        expect(sent.length).toBe(0);

        // First valid send succeeds and transitions encounter to 'pending'
        expect(client.sendPoliceDialogueChoice('enc_77', 0)).toBe(true);
        expect(sent.length).toBe(1);
        expect(sent[0]).toEqual({
            type: 'police_dialogue_choice',
            encounter_id: 'enc_77',
            option_index: 0
        });
        expect(GAME_STATE.activePoliceEncounter.stage).toBe('pending');

        // Second submit while pending is blocked
        expect(client.sendPoliceDialogueChoice('enc_77', 1)).toBe(false);
        expect(sent.length).toBe(1);
    });

    test('vehicle_impulse applies deflection to matching local car and rejects stale sequences or other users', () => {
        const client = createClientStub();
        const localCar = {
            id: 'car_0',
            x: 23, y: 0, z: 0, yaw: 0,
            vx: 0, vz: 10, yawRate: 0, speed: 10,
            isAwake: false,
            remoteDriver: null
        };
        GAME_STATE.inVehicle = localCar;

        // Different user ignored
        client.handleServerMessage({
            type: 'vehicle_impulse',
            police_car_id: 'police_car_0',
            car_id: 'car_0',
            target_user: 'Другой-игрок',
            dvx: 10, dvz: -20, dyaw_rate: 1.0,
            sequence: 1
        });
        expect(localCar.vz).toBe(10);

        // Valid impulse applied
        client.handleServerMessage({
            type: 'vehicle_impulse',
            police_car_id: 'police_car_0',
            car_id: 'car_0',
            target_user: 'Лёха-со-Спортивки',
            dvx: 4, dvz: -15, dyaw_rate: 0.5,
            sequence: 2
        });
        expect(localCar.vx).toBeCloseTo(4, 6);
        expect(localCar.vz).toBeCloseTo(-5, 6);
        expect(localCar.yawRate).toBeCloseTo(0.5, 6);
        expect(localCar.isAwake).toBe(true);

        // Stale sequence dropped
        client.handleServerMessage({
            type: 'vehicle_impulse',
            police_car_id: 'police_car_0',
            car_id: 'car_0',
            target_user: 'Лёха-со-Спортивки',
            dvx: 50, dvz: 0, dyaw_rate: 0,
            sequence: 2
        });
        expect(localCar.vx).toBeCloseTo(4, 6);
    });

    test('cleanupOnDisconnect clears police entities, resets sequence counters, hides banner, and force-closes locked modal', () => {
        const client = createClientStub();
        client.lastPoliceStateSequence = 15;
        client.lastVehicleImpulseSequence = 7;

        client.handleServerMessage({
            type: 'police_state',
            sequence: 15,
            sample_time_ms: 9000,
            foot_cops: [{ id: 'cop_0', name: 'Сержант', x: 0, y: 0, z: 0, vx: 0, vz: 0, yaw: 0, state: 'dialogue', anim: 'idle', target_user: 'Лёха-со-Спортивки' }],
            police_cars: [{ id: 'police_car_0', x: 23, y: 0, z: 0, vx: 0, vz: 10, yaw: 0, state: 'chase', target_user: 'Лёха-со-Спортивки', siren: true, lights: true }]
        });
        client.handleServerMessage({
            type: 'police_encounter_start',
            encounter_id: 'enc_locked',
            cop_id: 'cop_0',
            cop_name: 'Сержант',
            title: 'Проверка',
            opening: 'Документы!',
            options: [{ index: 0, text: 'Показать', fine: 0 }],
            target_user: 'Лёха-со-Спортивки'
        });

        expect(mockEls['npc-dialogue-modal'].classList.contains('hidden')).toBe(false);
        expect(GAME_STATE.activePoliceEncounter).not.toBeNull();

        client.cleanupOnDisconnect();

        expect(client.lastPoliceStateSequence).toBe(0);
        expect(client.lastVehicleImpulseSequence).toBe(0);
        expect(GAME_STATE.policeCops.size).toBe(0);
        expect(GAME_STATE.policeCars.size).toBe(0);
        expect(GAME_STATE.activePoliceEncounter).toBeNull();
        expect(mockEls['npc-dialogue-modal'].classList.contains('hidden')).toBe(true);
        expect(mockEls['police-pursuit-banner'].classList.contains('hidden')).toBe(true);
    });

    test('police_chase evaded/stopped immediately clears chase banner and stops siren even after police_state marked chase', () => {
        const client = createClientStub();

        client.handleServerMessage({
            type: 'police_chase',
            police_car_id: 'police_car_0',
            target_car_id: 'car_0',
            target_user: 'Лёха-со-Спортивки',
            status: 'started',
            reason: 'speeding'
        });
        SoundManager.policeSirenActive = true;
        expect(mockEls['police-pursuit-banner'].classList.contains('hidden')).toBe(false);

        client.handleServerMessage({
            type: 'police_state',
            sequence: 1,
            sample_time_ms: 1000,
            foot_cops: [],
            police_cars: [
                { id: 'police_car_0', x: 23, y: 0, z: 0, vx: 0, vz: 15, yaw: 0, state: 'chase', target_car_id: 'car_0', target_user: 'Лёха-со-Спортивки', siren: true, lights: true }
            ]
        });
        expect(isLocalPlayerChased(GAME_STATE)).toBe(true);
        expect(mockEls['police-pursuit-banner'].classList.contains('hidden')).toBe(false);

        client.handleServerMessage({
            type: 'police_chase',
            police_car_id: 'police_car_0',
            target_car_id: 'car_0',
            target_user: 'Лёха-со-Спортивки',
            status: 'evaded',
            reason: 'target_exited'
        });

        expect(isLocalPlayerChased(GAME_STATE)).toBe(false);
        expect(mockEls['police-pursuit-banner'].classList.contains('hidden')).toBe(true);
        expect(SoundManager.policeSirenActive).toBe(false);
    });

    test('reconnect join clears stale pending encounter and re-enables options if server resends baseline', () => {
        const sent = [];
        const client = createClientStub(sent);
        client.isReconnecting = true;
        SoundManager.policeSirenActive = true;

        client.handleServerMessage({
            type: 'police_encounter_start',
            encounter_id: 'enc_reconn',
            cop_id: 'cop_0',
            cop_name: 'Сержант',
            title: 'Обыск',
            opening: 'Что в карманах?',
            options: [
                { index: 0, text: 'Договориться', fine: 5000 },
                { index: 1, text: 'Протокол', fine: 10000 }
            ],
            target_user: 'Лёха-со-Спортивки'
        });
        expect(client.sendPoliceDialogueChoice('enc_reconn', 0)).toBe(true);
        expect(GAME_STATE.activePoliceEncounter.stage).toBe('pending');

        // Reconnect baseline join arrives: stale pending modal is cleared first
        client.handleServerMessage({
            type: 'join',
            user: 'Лёха-со-Спортивки',
            money: 125400,
            roster: ['Лёха-со-Спортивки']
        });
        expect(GAME_STATE.activePoliceEncounter).toBeNull();
        expect(mockEls['npc-dialogue-modal'].classList.contains('hidden')).toBe(true);
        expect(isGameplayInputSuspended()).toBe(false);
        expect(SoundManager.policeSirenActive).toBe(false);

        // Server resends active encounter on reconnect -> options are enabled and selectable
        client.handleServerMessage({
            type: 'police_encounter_start',
            encounter_id: 'enc_reconn',
            cop_id: 'cop_0',
            cop_name: 'Сержант',
            title: 'Обыск',
            opening: 'Что в карманах?',
            options: [
                { index: 0, text: 'Договориться', fine: 5000 },
                { index: 1, text: 'Протокол', fine: 10000 }
            ],
            target_user: 'Лёха-со-Спортивки'
        });
        expect(GAME_STATE.activePoliceEncounter.stage).toBe('opening');
        expect(mockEls['npc-options-container'].children[0].disabled).toBe(false);
        expect(mockEls['npc-options-container'].children[1].disabled).toBe(false);
        expect(client.sendPoliceDialogueChoice('enc_reconn', 1)).toBe(true);
        expect(sent.length).toBe(2);
    });

    test('server error for police_dialogue_choice unlocks and closes pending encounter modal', () => {
        const client = createClientStub();

        client.handleServerMessage({
            type: 'police_encounter_start',
            encounter_id: 'enc_err',
            cop_id: 'cop_0',
            cop_name: 'Сержант',
            title: 'Проверка',
            opening: 'Документы!',
            options: [{ index: 0, text: 'Показать', fine: 0 }],
            target_user: 'Лёха-со-Спортивки'
        });
        expect(client.sendPoliceDialogueChoice('enc_err', 0)).toBe(true);
        expect(GAME_STATE.activePoliceEncounter.stage).toBe('pending');
        expect(mockEls['btn-close-npc-chat'].disabled).toBe(true);

        client.handleServerMessage({
            type: 'error',
            op: 'police_dialogue_choice',
            message: 'police encounter not found or expired'
        });

        expect(GAME_STATE.activePoliceEncounter).toBeNull();
        expect(mockEls['npc-dialogue-modal'].classList.contains('hidden')).toBe(true);
        expect(mockEls['btn-close-npc-chat'].disabled).toBe(false);
        expect(isGameplayInputSuspended()).toBe(false);
        expect(mockEls['toast-container'].children.length).toBeGreaterThan(0);
    });
});
