import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { GAME_STATE, isGameplayInputSuspended, resetPoliceState } from '../js/state.js';
import {
    renderMoneyHUD,
    formatRubles,
    openPoliceEncounterModal,
    resolvePoliceEncounterModal,
    closeNpcDialogue,
    updatePolicePursuitBanner,
    updateScreenProjections,
    drawGTARadar,
    completePOI,
    selectCaptainCannonAccept
} from '../js/ui.js';
import { bindInputControls, clearMovementInput, setTurboToggle, isTurboActive } from '../js/input.js';
import { Player, toggleVehicleDrive } from '../js/entities.js';
import { SoundManager, computePoliceSirenAcoustics } from '../js/audio.js';

test('police siren attenuates continuously and shifts pitch for approaching and receding cars', () => {
    const listenerPos = { x: 0, z: 0 };
    const listenerVel = { vx: 0, vz: 0 };
    const near = computePoliceSirenAcoustics({ sirenPos: { x: 0, z: 10 }, sirenVel: { vx: 0, vz: -20 }, listenerPos, listenerVel });
    const far = computePoliceSirenAcoustics({ sirenPos: { x: 0, z: 80 }, sirenVel: { vx: 0, vz: -20 }, listenerPos, listenerVel });
    const outOfRange = computePoliceSirenAcoustics({ sirenPos: { x: 0, z: 116 }, sirenVel: { vx: 0, vz: -20 }, listenerPos, listenerVel });
    const receding = computePoliceSirenAcoustics({ sirenPos: { x: 0, z: 10 }, sirenVel: { vx: 0, vz: 20 }, listenerPos, listenerVel });
    expect(near.active).toBe(true);
    expect(near.volume).toBeGreaterThan(far.volume);
    expect(far.volume).toBeGreaterThan(0);
    expect(outOfRange.active).toBe(false);
    expect(outOfRange.volume).toBe(0);
    expect(near.dopplerRatio).toBeGreaterThan(1);
    expect(receding.dopplerRatio).toBeLessThan(1);
    expect(near.cutoffHz).toBeGreaterThan(far.cutoffHz);
});

function createElement(tagOrId, initialClasses = []) {
    const classSet = new Set(initialClasses);
    const attrs = {};
    const listeners = {};
    const children = [];
    let textContent = '';
    let innerHTML = '';
    const el = {
        id: tagOrId,
        tagName: String(tagOrId).toUpperCase(),
        children,
        style: {},
        disabled: false,
        scrollTop: 0,
        scrollHeight: 100,
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
        set className(str) {
            classSet.clear();
            String(str || '').split(/\s+/).filter(Boolean).forEach(c => classSet.add(c));
        },
        get textContent() { return textContent; },
        set textContent(v) { textContent = String(v); },
        get innerHTML() { return innerHTML; },
        set innerHTML(v) { innerHTML = String(v); },
        setAttribute: (k, v) => { attrs[k] = String(v); },
        getAttribute: (k) => attrs[k] ?? null,
        removeAttribute: (k) => { delete attrs[k]; },
        append(...nodes) { children.push(...nodes); },
        appendChild(node) { children.push(node); return node; },
        replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
        querySelectorAll(sel) {
            if (sel === 'button') return children.filter(c => c.tagName === 'BUTTON');
            return [];
        },
        addEventListener(ev, handler) {
            listeners[ev] = listeners[ev] || [];
            listeners[ev].push(handler);
        },
        click() {
            if (this.disabled) return;
            for (const h of (listeners.click || [])) h({ preventDefault() {}, stopPropagation() {} });
        },
        blur() { this._blurred = true; },
        focus() { this._focused = true; },
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 })
    };
    return el;
}

function createMockAudioParam(initial = 0) {
    return {
        value: initial,
        setValueAtTime: mock(function (v) { this.value = v; }),
        setTargetAtTime: mock(function (v) { this.value = v; }),
        linearRampToValueAtTime: mock(function (v) { this.value = v; }),
        exponentialRampToValueAtTime: mock(function (v) { this.value = v; }),
        cancelScheduledValues: mock(() => {})
    };
}

function createMockAudioCtx() {
    const oscs = [];
    const gains = [];
    const filters = [];
    return {
        oscs,
        gains,
        filters,
        state: 'running',
        currentTime: 5.0,
        createOscillator: mock(() => {
            const o = {
                type: 'sine',
                frequency: createMockAudioParam(440),
                connect: mock(() => {}),
                disconnect: mock(() => {}),
                start: mock(() => {}),
                stop: mock(() => {})
            };
            oscs.push(o);
            return o;
        }),
        createGain: mock(() => {
            const g = {
                gain: createMockAudioParam(1.0),
                connect: mock((dest) => { g._connectedTo = dest; }),
                disconnect: mock(() => {})
            };
            gains.push(g);
            return g;
        }),
        createBiquadFilter: mock(() => {
            const f = {
                type: 'lowpass',
                frequency: createMockAudioParam(350),
                connect: mock(() => {}),
                disconnect: mock(() => {})
            };
            filters.push(f);
            return f;
        }),
        resume: mock(async () => {})
    };
}

describe('Police UI, Input Safety, Radar/Labels & Audio', () => {
    let prevDoc;
    let prevWindow;
    let prevMoney;
    let prevUsername;
    let prevInVehicle;
    let prevCompletedPOIs;
    let prevConnected;
    let prevSfxEnabled;
    let prevSoundState;
    let mockEls;
    let windowListeners;

    beforeEach(() => {
        prevDoc = globalThis.document;
        prevWindow = globalThis.window;
        prevMoney = GAME_STATE.money;
        prevUsername = GAME_STATE.username;
        prevInVehicle = GAME_STATE.inVehicle;
        prevCompletedPOIs = new Set(GAME_STATE.completedPOIs);
        prevConnected = GAME_STATE.isConnected;
        prevSfxEnabled = GAME_STATE.sfxEnabled;
        prevSoundState = {
            initialized: SoundManager.initialized,
            ctx: SoundManager.ctx,
            masterGain: SoundManager.masterGain,
            surfaceSfxGain: SoundManager.surfaceSfxGain,
            policeSirenNodes: SoundManager.policeSirenNodes,
            policeSirenActive: SoundManager.policeSirenActive
        };

        windowListeners = {};
        const radarOps = [];
        const radarCanvas = {
            width: 180,
            height: 180,
            getContext: () => ({
                clearRect() {},
                save() {},
                restore() {},
                translate() {},
                rotate() {},
                fillRect() {},
                beginPath() {},
                arc(x, y, r) { radarOps.push({ type: 'arc', x, y, r, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle }); },
                fill() {},
                stroke() {},
                _ops: radarOps
            }),
            _ops: radarOps
        };

        mockEls = {
            'hud-money': createElement('div', ['text-emerald-400']),
            'quest-progress': createElement('span'),
            'police-pursuit-banner': createElement('div', ['hidden']),
            'police-pursuit-text': createElement('span'),
            'npc-dialogue-modal': createElement('div', ['hidden']),
            'npc-avatar-badge': createElement('div'),
            'npc-modal-name': createElement('h3'),
            'npc-modal-badge': createElement('span'),
            'npc-modal-role': createElement('p'),
            'npc-chat-history': createElement('div'),
            'npc-options-container': createElement('div'),
            'btn-close-npc-chat': createElement('button'),
            'toast-container': createElement('div'),
            'help-modal': createElement('div', ['hidden']),
            'mp-login-overlay': createElement('div', ['hidden']),
            'game-canvas-container': Object.assign(createElement('div'), { clientWidth: 1280, clientHeight: 720 }),
            'radar-canvas': radarCanvas,
            'btn-arrow-up': createElement('button', ['dpad-btn', 'touch-active']),
            'btn-arrow-down': createElement('button', ['dpad-btn']),
            'btn-arrow-left': createElement('button', ['dpad-btn']),
            'btn-arrow-right': createElement('button', ['dpad-btn']),
            'btn-car-gas': createElement('button', ['car-pedal', 'touch-active']),
            'btn-car-brake': createElement('button', ['car-pedal']),
            'btn-action-jump': createElement('button'),
            'btn-action-sprint': createElement('button'),
            'turbo-label': createElement('span'),
            'three-canvas': createElement('canvas')
        };

        const activeInput = createElement('input');
        globalThis.document = {
            documentElement: { style: { setProperty() {} } },
            activeElement: activeInput,
            pointerLockElement: { id: 'three-canvas' },
            exitPointerLock: mock(() => { globalThis.document.pointerLockElement = null; }),
            getElementById: (id) => mockEls[id] || null,
            createElement: (tag) => createElement(tag),
            querySelectorAll: (sel) => {
                if (sel === '#npc-options-container button') {
                    return mockEls['npc-options-container'].children.filter(c => c.tagName === 'BUTTON');
                }
                if (sel.includes('touch-active')) {
                    return Object.values(mockEls).filter(el => el.classList?.contains('touch-active'));
                }
                return [];
            },
            addEventListener() {},
            removeEventListener() {}
        };

        globalThis.window = {
            innerWidth: 1280,
            innerHeight: 720,
            addEventListener: (ev, handler) => {
                windowListeners[ev] = windowListeners[ev] || [];
                windowListeners[ev].push(handler);
            },
            removeEventListener() {}
        };

        resetPoliceState(GAME_STATE);
        GAME_STATE.activeNpcChat = null;
        GAME_STATE.username = 'Димон-с-Первака';
        GAME_STATE.money = 125400;
        GAME_STATE.inVehicle = null;
        GAME_STATE.completedPOIs = new Set();
        GAME_STATE.isConnected = true;
        GAME_STATE.sfxEnabled = true;
    });

    afterEach(() => {
        clearMovementInput();
        closeNpcDialogue({ force: true });
        resetPoliceState(GAME_STATE);
        GAME_STATE.money = prevMoney;
        GAME_STATE.username = prevUsername;
        GAME_STATE.inVehicle = prevInVehicle;
        GAME_STATE.completedPOIs = prevCompletedPOIs;
        GAME_STATE.isConnected = prevConnected;
        GAME_STATE.sfxEnabled = prevSfxEnabled;
        SoundManager.stopPoliceSiren();
        SoundManager.initialized = prevSoundState.initialized;
        SoundManager.ctx = prevSoundState.ctx;
        SoundManager.masterGain = prevSoundState.masterGain;
        SoundManager.surfaceSfxGain = prevSoundState.surfaceSfxGain;
        SoundManager.policeSirenNodes = prevSoundState.policeSirenNodes;
        SoundManager.policeSirenActive = prevSoundState.policeSirenActive;

        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
    });

    test('unsolicited police_encounter_start clears all movement/touch/turbo inputs, halts car & player, blurs input, exits pointer lock, and awards NO +300 POI bonus', () => {
        const car = { id: 'car_0', vx: 12, vz: 18, speed: 21.6, yawRate: 0.7, isAwake: true };
        GAME_STATE.inVehicle = car;
        GAME_STATE.keys = { w: true, a: true, s: false, d: true, shift: true, space: true };
        GAME_STATE.joystickVector = { x: 0.9, y: -0.8 };
        GAME_STATE.joystickSprint = true;
        GAME_STATE.isDraggingCamera = true;
        setTurboToggle(true);
        Player.velocity.x = 5;
        Player.velocity.y = 2;
        Player.velocity.z = -6;
        const focusedEl = globalThis.document.activeElement;

        const opened = openPoliceEncounterModal({
            encounter_id: 'enc_1',
            cop_id: 'cop_0',
            cop_name: 'Сержант Петров',
            scenario_id: 'person_search',
            title: 'Ориентировка',
            opening: 'Гражданин, не видели тут высокого в чёрной куртке?',
            options: [
                { index: 0, text: 'Не видел', fine: 0 },
                { index: 1, text: 'Ушёл к фонтану', fine: 0 }
            ],
            target_user: 'Димон-с-Первака'
        });

        expect(opened).toBe(true);
        expect(isGameplayInputSuspended()).toBe(true);
        expect(GAME_STATE.keys).toEqual({ w: false, a: false, s: false, d: false, shift: false, space: false });
        expect(GAME_STATE.joystickVector).toEqual({ x: 0, y: 0 });
        expect(GAME_STATE.joystickSprint).toBe(false);
        expect(GAME_STATE.isDraggingCamera).toBe(false);
        expect(isTurboActive()).toBe(false);
        expect(mockEls['btn-arrow-up'].classList.contains('touch-active')).toBe(false);
        expect(mockEls['btn-car-gas'].classList.contains('touch-active')).toBe(false);

        // Vehicle & player halted
        expect(car.vx).toBe(0);
        expect(car.vz).toBe(0);
        expect(car.speed).toBe(0);
        expect(car.yawRate).toBe(0);
        expect(car.isAwake).toBe(false);
        expect(Player.velocity.x).toBe(0);
        expect(Player.velocity.y).toBe(0);
        expect(Player.velocity.z).toBe(0);

        // Focus & pointer lock cleared
        expect(focusedEl._blurred).toBe(true);
        expect(globalThis.document.pointerLockElement).toBeNull();

        // NO +300 ₽ POI bonus!
        expect(GAME_STATE.money).toBe(125400);
        expect(GAME_STATE.completedPOIs.size).toBe(0);
        expect(mockEls['npc-dialogue-modal'].classList.contains('hidden')).toBe(false);
    });

    test('police modal blocks Escape, #btn-close-npc-chat, and movement keys until police_encounter_result resolves it, and supports Digit1..4', () => {
        bindInputControls({});
        globalThis.document.activeElement = null;
        const selected = [];

        openPoliceEncounterModal({
            encounter_id: 'enc_lock',
            cop_id: 'cop_0',
            cop_name: 'Сержант Петров',
            scenario_id: 'weed_shakedown',
            title: 'Досмотр',
            opening: 'Что в карманах?',
            options: [
                { index: 0, text: 'Договориться', fine: 15000 },
                { index: 1, text: 'Протокол', fine: 25000 }
            ],
            target_user: 'Димон-с-Первака'
        }, (encId, optIdx) => {
            selected.push({ encId, optIdx });
            return true;
        });

        expect(mockEls['btn-close-npc-chat'].disabled).toBe(true);
        expect(closeNpcDialogue()).toBe(false);
        expect(mockEls['npc-dialogue-modal'].classList.contains('hidden')).toBe(false);

        // Escape key cannot close unresolved police modal
        const keydownHandlers = windowListeners.keydown || [];
        for (const h of keydownHandlers) {
            h({ code: 'Escape', preventDefault() {}, repeat: false });
        }
        expect(mockEls['npc-dialogue-modal'].classList.contains('hidden')).toBe(false);

        // Movement key W is ignored while encounter active
        for (const h of keydownHandlers) {
            h({ code: 'KeyW', preventDefault() {}, repeat: false });
        }
        expect(GAME_STATE.keys.w).toBe(false);

        // Digit1 selects option 0
        for (const h of keydownHandlers) {
            h({ code: 'Digit1', preventDefault() {}, repeat: false });
        }
        expect(selected).toEqual([{ encId: 'enc_lock', optIdx: 0 }]);
        expect(GAME_STATE.activePoliceEncounter.stage).toBe('pending');

        // Still locked while pending
        expect(closeNpcDialogue()).toBe(false);

        // Resolution unlocks close button and updates negative balance
        resolvePoliceEncounterModal({
            encounter_id: 'enc_lock',
            target_user: 'Димон-с-Первака',
            option_index: 0,
            reply_text: 'Ладно, свободен.',
            fine: 15000,
            money: -4600
        });

        expect(GAME_STATE.money).toBe(-4600);
        expect(GAME_STATE.activePoliceEncounter.stage).toBe('resolved');
        expect(mockEls['btn-close-npc-chat'].disabled).toBe(false);

        // Now Escape closes the modal cleanly
        for (const h of keydownHandlers) {
            h({ code: 'Escape', preventDefault() {}, repeat: false });
        }
        expect(mockEls['npc-dialogue-modal'].classList.contains('hidden')).toBe(true);
        expect(GAME_STATE.activePoliceEncounter).toBeNull();
    });

    test('police modal renders all strings strictly via .textContent (XSS-safe)', () => {
        const xssName = '<img src=x onerror=alert(1)>';
        const xssTitle = '<script>window.__xss=true</script>';
        const xssOpening = '<b>Внимание!</b>';
        const xssOpt = '<svg onload=alert(2)>';
        const xssReply = '<iframe src=evil></iframe>';

        openPoliceEncounterModal({
            encounter_id: 'enc_xss',
            cop_id: 'cop_0',
            cop_name: xssName,
            title: xssTitle,
            opening: xssOpening,
            options: [{ index: 0, text: xssOpt, fine: 0 }],
            target_user: 'Димон-с-Первака'
        });

        expect(mockEls['npc-modal-name'].textContent).toBe(xssName);
        expect(mockEls['npc-modal-role'].textContent).toBe(xssTitle);
        // History bubble uses textContent on child span, never innerHTML
        const historyRow = mockEls['npc-chat-history'].children[0];
        const historyBubble = historyRow.children[0];
        expect(historyBubble.innerHTML).toBe('');
        expect(historyBubble.children[1].textContent).toBe(xssOpening);

        const optBtn = mockEls['npc-options-container'].children[0];
        expect(optBtn.innerHTML).toBe('');
        expect(optBtn.children[1].textContent).toBe(xssOpt);

        resolvePoliceEncounterModal({
            encounter_id: 'enc_xss',
            target_user: 'Димон-с-Первака',
            option_index: 0,
            reply_text: xssReply,
            fine: 0,
            money: 125400
        });
        const replyRow = mockEls['npc-chat-history'].children[1];
        expect(replyRow.children[0].children[1].textContent).toBe(xssReply);
    });

    test('renderMoneyHUD formats negative and positive balances with text-rose-400 / text-emerald-400 consistently across POI and quests', () => {
        expect(formatRubles(125400)).toBe(`₽ ${(125400).toLocaleString('ru-RU')}`);
        expect(formatRubles(-15400)).toBe(`-₽ ${(15400).toLocaleString('ru-RU')}`);

        renderMoneyHUD(-15400);
        expect(mockEls['hud-money'].textContent).toBe(`-₽ ${(15400).toLocaleString('ru-RU')}`);
        expect(mockEls['hud-money'].classList.contains('text-rose-400')).toBe(true);
        expect(mockEls['hud-money'].classList.contains('text-emerald-400')).toBe(false);

        // POI reward that leaves balance still negative keeps rose styling
        GAME_STATE.money = -15400;
        completePOI('test_poi', 'Тест', 300);
        expect(GAME_STATE.money).toBe(-15100);
        expect(mockEls['hud-money'].textContent).toBe(`-₽ ${(15100).toLocaleString('ru-RU')}`);
        expect(mockEls['hud-money'].classList.contains('text-rose-400')).toBe(true);

        // Quest accept when negative fails cleanly without breaking rose styling
        const npc = {
            persona: { name: 'Капитан Михалыч', emoji: '⚓', goodbyes: ['До встречи!'] },
            chatStage: 'quest_offer',
            chatHistory: []
        };
        selectCaptainCannonAccept(npc);
        expect(GAME_STATE.money).toBe(-15100);
        expect(mockEls['hud-money'].classList.contains('text-rose-400')).toBe(true);

        renderMoneyHUD(0);
        expect(mockEls['hud-money'].textContent).toBe('₽ 0');
        expect(mockEls['hud-money'].classList.contains('text-emerald-400')).toBe(true);
        expect(mockEls['hud-money'].classList.contains('text-rose-400')).toBe(false);
    });

    test('updateScreenProjections and drawGTARadar keep police labels and blips visible BOTH on foot and while driving', () => {
        const mockCamera = {
            position: { distanceTo: () => 25 },
            project: () => ({ x: 0, y: 0, z: 0.5 })
        };
        const copLabel = createElement('div');
        const carLabel = createElement('div');
        const carTextEl = createElement('span');
        const cop = { id: 'cop_0', renderPosition: { x: 2, y: 0, z: 5 }, labelEl: copLabel };
        const pcar = { id: 'police_car_0', x: 23, y: 0, z: -15, state: 'chase', siren: true, labelEl: carLabel, labelTextEl: carTextEl };

        // While driving inVehicle (civilian NPC labels hide, police labels & radar blips MUST stay visible!)
        const npcLabel = createElement('div');
        const civNpc = { group: { position: { x: 1, y: 0, z: 1 } }, labelEl: npcLabel };
        GAME_STATE.inVehicle = { id: 'car_0', x: 0, y: 0, z: 0 };

        updateScreenProjections({
            camera: mockCamera,
            playerPos: { x: 0, y: 0, z: 0 },
            dunya: null,
            worldLabels: [],
            npcs: [civNpc],
            remotePlayers: new Map(),
            policeCops: [cop],
            policeCars: [pcar]
        });

        expect(npcLabel.style.display).toBe('none');
        expect(copLabel.style.display).toBe('');
        expect(carLabel.style.display).toBe('');
        expect(carTextEl.textContent).toBe('🚓 ДПС • ПОГОНЯ!');

        drawGTARadar({
            playerPos: { x: 0, y: 0, z: 0 },
            interactables: [],
            npcs: [],
            dunya: null,
            remotePlayers: new Map(),
            policeCops: [cop],
            policeCars: [pcar]
        });

        const ops = mockEls['radar-canvas']._ops;
        // Fountain (1) + cop (1) + police car (1) = 3 arcs
        expect(ops.length).toBe(3);
        expect(ops[1].fillStyle).toBe('#2563eb'); // cop blip
        expect(ops[2].r).toBe(6); // chasing police car blip

        updatePolicePursuitBanner(true);
        expect(mockEls['police-pursuit-banner'].classList.contains('hidden')).toBe(false);
        updatePolicePursuitBanner(false);
        expect(mockEls['police-pursuit-banner'].classList.contains('hidden')).toBe(true);
    });

    test('SoundManager police siren and chime route through surfaceSfxGain and respect sfxEnabled', async () => {
        const ctx = createMockAudioCtx();
        SoundManager.initialized = true;
        SoundManager.ctx = ctx;
        SoundManager.masterGain = ctx.createGain();
        SoundManager.surfaceSfxGain = ctx.createGain();

        expect(SoundManager.playPoliceSiren(true, 0.14)).toBe(true);
        expect(SoundManager.policeSirenActive).toBe(true);
        // sirenGain is the 2nd gain created after masterGain/surfaceSfxGain -> connected to surfaceSfxGain
        const sirenGain = SoundManager.policeSirenNodes.sirenGain;
        expect(sirenGain._connectedTo).toBe(SoundManager.surfaceSfxGain);

        expect(SoundManager.playPoliceChime('fine')).toBe(true);
        const lastChimeGain = ctx.gains[ctx.gains.length - 1];
        expect(lastChimeGain._connectedTo).toBe(SoundManager.surfaceSfxGain);

        // Muting SFX stops siren and prevents new chime/siren
        await SoundManager.toggleSfx();
        expect(GAME_STATE.sfxEnabled).toBe(false);
        expect(SoundManager.policeSirenActive).toBe(false);
        expect(SoundManager.playPoliceSiren(true, 0.14)).toBe(false);
        expect(SoundManager.playPoliceChime('stop')).toBe(false);
    });

    test('Digit1..4 hotkeys do NOT trigger dialogue option when an INPUT or TEXTAREA is focused', () => {
        bindInputControls({});
        const selected = [];
        openPoliceEncounterModal({
            encounter_id: 'enc_chat_focus',
            cop_id: 'cop_0',
            cop_name: 'Сержант',
            title: 'Проверка',
            opening: 'Документы?',
            options: [{ index: 0, text: 'Показать', fine: 0 }],
            target_user: 'Димон-с-Первака'
        }, (encId, optIdx) => {
            selected.push({ encId, optIdx });
            return true;
        });

        const chatInput = createElement('input');
        globalThis.document.activeElement = chatInput;
        const keydownHandlers = windowListeners.keydown || [];
        for (const h of keydownHandlers) {
            h({ code: 'Digit1', preventDefault() {}, repeat: false });
        }
        expect(selected.length).toBe(0);
        expect(GAME_STATE.activePoliceEncounter.stage).toBe('opening');

        const textarea = createElement('textarea');
        globalThis.document.activeElement = textarea;
        for (const h of keydownHandlers) {
            h({ code: 'Numpad1', preventDefault() {}, repeat: false });
        }
        expect(selected.length).toBe(0);
    });

    test('toggleVehicleDrive is blocked during unresolved police encounter unless { force: true } is passed', () => {
        const car = {
            id: 'car_0',
            name: 'Mark II',
            group: { position: { x: 10, y: 0.02, z: 20 }, rotation: { y: 0 } },
            vx: 0, vz: 0, speed: 0, yawRate: 0,
            isAwake: false, isDrifting: false, isBraking: false
        };
        Player.position = { set() {}, x: 0, y: 0, z: 0 };

        openPoliceEncounterModal({
            encounter_id: 'enc_drive_guard',
            cop_id: 'cop_0',
            cop_name: 'Сержант',
            title: 'Проверка',
            opening: 'Стоять!',
            options: [{ index: 0, text: 'Ок', fine: 0 }],
            target_user: 'Димон-с-Первака'
        });

        // Blocked on foot
        expect(toggleVehicleDrive(car)).toBe(false);
        expect(GAME_STATE.inVehicle).toBeNull();

        // Blocked while in vehicle
        GAME_STATE.inVehicle = car;
        expect(toggleVehicleDrive(car)).toBe(false);
        expect(GAME_STATE.inVehicle).toBe(car);

        // Forced eviction succeeds even while encounter is unresolved
        expect(toggleVehicleDrive(car, { force: true })).toBe(true);
        expect(GAME_STATE.inVehicle).toBeNull();

        // Once resolved, openPoliceEncounterModal does not re-disable close button and driving works again
        resolvePoliceEncounterModal({
            encounter_id: 'enc_drive_guard',
            target_user: 'Димон-с-Первака',
            option_index: 0,
            reply_text: 'Свободен.',
            fine: 0,
            money: 125400
        });
        openPoliceEncounterModal({
            encounter_id: 'enc_drive_guard',
            cop_id: 'cop_0',
            cop_name: 'Сержант',
            title: 'Проверка',
            opening: 'Стоять!',
            options: [{ index: 0, text: 'Ок', fine: 0 }],
            target_user: 'Димон-с-Первака'
        });
        expect(mockEls['btn-close-npc-chat'].disabled).toBe(false);
        expect(toggleVehicleDrive(car)).toBe(true);
        expect(GAME_STATE.inVehicle).toBe(car);
    });

    test('canvas camera mouse/wheel/touch events are ignored when gameplay input is suspended and clearMovementInput resets cameraTouchId', () => {
        const canvasListeners = {};
        const canvasEl = mockEls['three-canvas'];
        canvasEl.addEventListener = (ev, handler) => {
            canvasListeners[ev] = canvasListeners[ev] || [];
            canvasListeners[ev].push(handler);
        };

        bindInputControls({});
        GAME_STATE.cameraYaw = 1.0;
        GAME_STATE.cameraPitch = 0.5;
        GAME_STATE.cameraDistance = 9.0;
        GAME_STATE.isDraggingCamera = false;

        // Start a camera touch while input is NOT suspended
        globalThis.document.activeElement = null;
        for (const h of (canvasListeners.touchstart || [])) {
            h({ changedTouches: [{ identifier: 7, clientX: 100, clientY: 100 }] });
        }
        // Suspend gameplay input via police encounter (calls clearMovementInput)
        openPoliceEncounterModal({
            encounter_id: 'enc_cam',
            cop_id: 'cop_0',
            cop_name: 'Сержант',
            title: 'Проверка',
            opening: 'Стоять!',
            options: [{ index: 0, text: 'Ок', fine: 0 }],
            target_user: 'Димон-с-Первака'
        });

        // Pre-existing touchmove, new touchstart, mousedown, mousemove, and wheel must NOT mutate camera
        for (const h of (canvasListeners.touchmove || [])) {
            h({ changedTouches: [{ identifier: 7, clientX: 250, clientY: 200 }] });
        }
        for (const h of (canvasListeners.touchstart || [])) {
            h({ changedTouches: [{ identifier: 8, clientX: 50, clientY: 50 }] });
        }
        for (const h of (canvasListeners.mousedown || [])) {
            h({ button: 0 });
        }
        for (const h of (windowListeners.mousemove || [])) {
            h({ movementX: 120, movementY: 60 });
        }
        for (const h of (canvasListeners.wheel || [])) {
            h({ deltaY: 500, preventDefault() {} });
        }

        expect(GAME_STATE.isDraggingCamera).toBe(false);
        expect(GAME_STATE.cameraYaw).toBe(1.0);
        expect(GAME_STATE.cameraPitch).toBe(0.5);
        expect(GAME_STATE.cameraDistance).toBe(9.0);

        // Even after modal closes, the cleared pre-modal touch identifier 7 must not continue dragging
        closeNpcDialogue({ force: true });
        for (const h of (canvasListeners.touchmove || [])) {
            h({ changedTouches: [{ identifier: 7, clientX: 400, clientY: 300 }] });
        }
        expect(GAME_STATE.cameraYaw).toBe(1.0);
        expect(GAME_STATE.cameraPitch).toBe(0.5);
    });

    test('drawGTARadar invalidates radar canvas cache independently of updateScreenProjections after document swap', () => {
        const mockCamera = {
            position: { distanceTo: () => 25 },
            project: () => ({ x: 0, y: 0, z: 0.5 })
        };

        // Prime both caches on first document
        updateScreenProjections({
            camera: mockCamera,
            playerPos: { x: 0, y: 0, z: 0 },
            dunya: null,
            worldLabels: [],
            npcs: [],
            remotePlayers: new Map()
        });
        drawGTARadar({
            playerPos: { x: 0, y: 0, z: 0 },
            interactables: [],
            npcs: [],
            dunya: null,
            remotePlayers: new Map()
        });
        expect(mockEls['radar-canvas']._ops.length).toBe(1);

        // Swap globalThis.document with a brand new radar canvas
        const radarOps2 = [];
        const radarCanvas2 = {
            width: 180,
            height: 180,
            getContext: () => ({
                clearRect() {},
                save() {},
                restore() {},
                translate() {},
                rotate() {},
                fillRect() {},
                beginPath() {},
                arc(x, y, r) { radarOps2.push({ type: 'arc', x, y, r }); },
                fill() {},
                stroke() {}
            })
        };
        const mockEls2 = {
            ...mockEls,
            'radar-canvas': radarCanvas2
        };
        globalThis.document = {
            ...globalThis.document,
            getElementById: (id) => mockEls2[id] || null
        };

        // Call updateScreenProjections FIRST on new document, then drawGTARadar
        updateScreenProjections({
            camera: mockCamera,
            playerPos: { x: 0, y: 0, z: 0 },
            dunya: null,
            worldLabels: [],
            npcs: [],
            remotePlayers: new Map()
        });
        drawGTARadar({
            playerPos: { x: 0, y: 0, z: 0 },
            interactables: [],
            npcs: [],
            dunya: null,
            remotePlayers: new Map()
        });

        expect(radarOps2.length).toBe(1);
        expect(mockEls['radar-canvas']._ops.length).toBe(1);
    });
});
