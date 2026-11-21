/**
 * Game state, pure domain helpers, and world configuration loader.
 * Keeps gameplay state, zone resolution, and dialogue state transitions decoupled from DOM/Three.js.
 */

export const DEFAULT_WALK_PITCH = 0.56; // 2/3 top-down looking forward angle (~32 deg)

export const RUSSIAN_NAMES = {
    male: [
        'Костян', 'Саня', 'Димон', 'Вован', 'Лёха',
        'Артём', 'Макс', 'Миша', 'Даня', 'Егор',
        'Ваня', 'Игорь', 'Илья', 'Кирилл', 'Никита',
        'Олег', 'Паша', 'Рома', 'Серёга', 'Тима',
        'Ярик', 'Витя', 'Вадим', 'Богдан', 'Денис'
    ],
    female: [
        'Люба', 'Алина', 'Алиса', 'Настя', 'Аня',
        'Лера', 'Вероника', 'Вика', 'Даша', 'Диана',
        'Женя', 'Катя', 'Лена', 'Ксюша', 'Марина',
        'Маша', 'Надя', 'Наташа', 'Оксана', 'Оля',
        'Полина', 'Света', 'Соня', 'Юля', 'Кристина'
    ]
};

export const VLADIVOSTOK_LOCATION_SUFFIXES = [
    '-с-Чуркина',
    '-со-Спортивки',
    '-из-Центра',
    '-с-Эгершельда',
    '-с-Зелёнки',
    '-с-Луговой',
    '-с-Первака',
    '-с-Тихой',
    '-с-Второй-Речки',
    '-с-БАМа',
    '-со-Снеговой',
    '-с-Шаморы',
    '-с-Зари',
    '-с-Патрокла',
    '-с-Седанки',
    '-с-Окатовой',
    '-с-Фуникулёра',
    '-с-Миллионки',
    '-с-Нейбута',
    '-с-Баляйки',
    '-с-Третьей-Рабочей',
    '-с-Калинина',
    '-с-Русского',
    '-с-Улисса',
    '-с-Гоголя'
];

export function generateRandomVladivostokName(randomFn = Math.random) {
    const allNames = [...RUSSIAN_NAMES.male, ...RUSSIAN_NAMES.female];
    const nameIndex = Math.floor(randomFn() * allNames.length);
    const suffixIndex = Math.floor(randomFn() * VLADIVOSTOK_LOCATION_SUFFIXES.length);
    const name = allNames[Math.max(0, Math.min(allNames.length - 1, nameIndex))];
    const suffix = VLADIVOSTOK_LOCATION_SUFFIXES[Math.max(0, Math.min(VLADIVOSTOK_LOCATION_SUFFIXES.length - 1, suffixIndex))];
    return `${name}${suffix}`;
}

export function getInitialUsername() {
    try {
        if (typeof localStorage !== 'undefined') {
            const saved = localStorage.getItem('nabka_username') || localStorage.getItem('nabka_mp_username');
            if (saved && saved.trim()) return saved.trim();
        }
    } catch (e) {}
    return generateRandomVladivostokName();
}

export function getInitialPetType() {
    try {
        if (typeof localStorage !== 'undefined') {
            const saved = localStorage.getItem('nabka_pet_type');
            if (saved === 'cat' || saved === 'dog') return saved;
        }
    } catch (e) {}
    return 'dog';
}

export function createGameState(overrides = {}) {
    const isNarrowViewport = typeof window !== 'undefined' ? window.innerWidth < 640 : false;
    return {
        username: overrides.username || getInitialUsername(),
        petType: overrides.petType || getInitialPetType(),
        isConnected: false,
        lastPacketSentAt: 0,
        lastActiveEventAt: 0,
        money: 125400,
        health: 100,
        stamina: 100,
        stars: 1,
        weatherIndex: 0, // 0: Golden Sunset, 1: Vladivostok Sea Fog, 2: Neon Night, 3: Sunny Day
        weatherPresets: [
            { name: 'Закат на Амурском', icon: 'fa-sun', sky: 0x1e2942, horizon: 0xf97316, fogColor: 0xd97746, fogDensity: 0.0022, sunIntensity: 1.35, sunColor: 0xff9e5e, ambientIntensity: 0.65, nightLights: false, timeText: '19:30', westTint: 0x7c5869, westOpacity: 0.34 },
            { name: 'Приморский Туман', icon: 'fa-cloud-meatball', sky: 0x94a3b8, horizon: 0xcbd5e1, fogColor: 0x94a3b8, fogDensity: 0.0095, sunIntensity: 0.6, sunColor: 0xe2e8f0, ambientIntensity: 0.75, nightLights: true, timeText: '11:15', westTint: 0x94a3b8, westOpacity: 0.16 },
            { name: 'Ночная Набка', icon: 'fa-moon', sky: 0x050811, horizon: 0x0f172a, fogColor: 0x070b16, fogDensity: 0.0028, sunIntensity: 0.25, sunColor: 0x38bdf8, ambientIntensity: 0.4, nightLights: true, timeText: '23:10', westTint: 0x1e293b, westOpacity: 0.28 },
            { name: 'Солнечный День', icon: 'fa-cloud-sun', sky: 0x0284c7, horizon: 0x7dd3fc, fogColor: 0xbae6fd, fogDensity: 0.0015, sunIntensity: 1.5, sunColor: 0xffffff, ambientIntensity: 0.85, nightLights: false, timeText: '14:45', westTint: 0x38bdf8, westOpacity: 0.36 }
        ],
        completedPOIs: new Set(),
        completedQuests: overrides.completedQuests || new Set(),
        questFlags: overrides.questFlags || {},
        totalPOIs: 10,
        inVehicle: null,
        cameraMode: 0, // 0: GTA Standard, 1: Close Action, 2: Far Cinematic, 3: RHD Cockpit / First-Person
        cameraModes: [
            { name: 'GTA 2/3 Вид сверху', dist: 9.2, heightOffset: 1.95 },
            { name: 'Экшен Близко', dist: 5.5, heightOffset: 1.75 },
            { name: 'Панорама Набки', dist: 14.5, heightOffset: 2.6 },
            { name: 'От 1-го лица / Правый руль', dist: 0.1, heightOffset: 2.35 }
        ],
        headlightsOn: true,
        pointerLocked: false,
        isDraggingCamera: false,
        cameraYaw: 0,
        cameraPitch: DEFAULT_WALK_PITCH,
        cameraDistance: 9.2,
        lastMouseMoveTime: 0,
        keys: { w: false, a: false, s: false, d: false, shift: false, space: false },
        joystickVector: { x: 0, y: 0 },
        joystickSprint: false,
        chatCollapsed: isNarrowViewport,
        questCollapsed: isNarrowViewport,
        sfxEnabled: true,
        audioEnabled: true,
        nearestInteractable: null,
        activeNpcChat: null,
        policeCops: overrides.policeCops || new Map(),
        policeCars: overrides.policeCars || new Map(),
        policeStateSequence: -1,
        activePoliceEncounter: null,
        activePoliceChases: overrides.activePoliceChases || new Map(),
        activePoliceChase: null,
        ...overrides
    };
}

export const GAME_STATE = createGameState();
export default GAME_STATE;

/**
 * Resolves the human-readable zone name on Sportivnaya Naberezhnaya from (x, z) coordinates.
 */
export function resolveZoneName(x, z, worldMap = null) {
    if (worldMap && Array.isArray(worldMap.zones)) {
        for (const rule of worldMap.zones) {
            if (rule.condition === 'x_lt' && x < rule.threshold) return rule.label;
            if (rule.condition === 'abs_z_lt' && Math.abs(z) < rule.threshold) return rule.label;
            if (rule.condition === 'z_lt' && z < rule.threshold) return rule.label;
            if (rule.condition === 'z_gt' && z > rule.threshold) return rule.label;
            if (rule.condition === 'z_between' && z > rule.min && z < rule.max) return rule.label;
        }
        if (worldMap.defaultZoneLabel) return worldMap.defaultZoneLabel;
    }
    if (x < -16) return 'Пляж «Юбилейный» & Амурский залив';
    if (Math.abs(z) < 16) return 'Площадь у Большого Фонтана';
    if (z < -65) return 'Парк аттракционов & Колесо обозрения';
    if (z > 70) return 'Набережная у к/т «Океан»';
    if (z > 20 && z < 65) return 'Фудкорт Набки (Пян-се & Чифаньки)';
    return 'Спортивная набережная — Променад';
}

/**
 * Pure state transition for completing a Point of Interest (POI).
 */
export function applyPOICompletion(state, poiId, cashReward) {
    state.money += cashReward;
    const isNew = !state.completedPOIs.has(poiId);
    if (isNew) {
        state.completedPOIs.add(poiId);
        const count = Math.min(state.totalPOIs, state.completedPOIs.size);
        state.stars = Math.min(5, 1 + count);
    }
    const count = Math.min(state.totalPOIs, state.completedPOIs.size);
    return { isNew, count, money: state.money, stars: state.stars };
}

/**
 * Pure NPC dialogue state machine helpers.
 */
export function startNpcDialogueSession(npc) {
    npc.chatStage = 'opening';
    npc.chatHistory = [
        { role: 'model', text: npc.persona.opening }
    ];
    return npc;
}

export function advanceNpcDialogue(npc, optionIndex) {
    if (!npc || npc.chatStage !== 'opening') return null;
    const chosen = npc.persona && npc.persona.options ? npc.persona.options[optionIndex] : null;
    if (!chosen) return null;

    npc.chatHistory.push({ role: 'user', text: chosen.question });
    npc.chatHistory.push({ role: 'model', text: chosen.answer });
    npc.chatStage = 'answered';
    return chosen;
}

/**
 * Computes pedestrian animation name from velocity/state for network replication.
 */
export function computePedestrianAnim({ emoteTimer = 0, isGrounded = true, isSwimming = false, vx = 0, vz = 0 }) {
    if (isSwimming) return 'swim';
    if (emoteTimer > 0) return 'emote';
    if (!isGrounded) return 'jump';
    const speedSq = vx * vx + vz * vz;
    if (speedSq > 85) return 'run';
    if (speedSq > 0.6) return 'walk';
    return 'idle';
}

/**
 * Derives default WebSocket endpoint URL accounting for current location protocol (ws vs wss).
 */
export function deriveDefaultWsUrl(loc = typeof window !== 'undefined' ? window.location : null) {
    if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:') && loc.host) {
        const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${wsProto}//${loc.host}/ws`;
    }
    return 'wss://nabka.melekhin.me/ws';
}

/**
 * Loads world map and NPC dialogue JSON data files from `static/data/`.
 */
export async function loadGameData(fetchFn = fetch) {
    const t = Date.now();
    const [worldRes, dialoguesRes] = await Promise.all([
        fetchFn(`data/world_map.json?t=${t}`),
        fetchFn(`data/npc_dialogues.json?t=${t}`)
    ]);
    if (!worldRes.ok) {
        throw new Error(`Failed to load world_map.json: ${worldRes.status}`);
    }
    if (!dialoguesRes.ok) {
        throw new Error(`Failed to load npc_dialogues.json: ${dialoguesRes.status}`);
    }
    const [worldMap, npcDialogues] = await Promise.all([
        worldRes.json(),
        dialoguesRes.json()
    ]);
    return { worldMap, npcDialogues };
}

/**
 * Returns true if gameplay input (movement, vehicle controls, actions) should be suspended
 * due to active modal dialogs (help modal, login overlay, NPC chat, police encounter) or focused text inputs.
 */
export function isGameplayInputSuspended(state = GAME_STATE) {
    if (state && (state.activeNpcChat || state.activePoliceEncounter)) return true;
    if (typeof document === 'undefined') return false;
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
        return true;
    }
    const helpModal = document.getElementById('help-modal');
    if (helpModal && !helpModal.classList.contains('hidden')) {
        return true;
    }
    const loginOverlay = document.getElementById('mp-login-overlay');
    if (loginOverlay && !loginOverlay.classList.contains('hidden')) {
        return true;
    }
    return false;
}

/**
 * Pure, DOM/Three.js-free police and economy state helpers.
 */
export function setMoneyBalance(state, newMoney) {
    if (!state || typeof newMoney !== 'number' || !Number.isFinite(newMoney) || !Number.isSafeInteger(newMoney)) {
        return { updated: false, money: state ? state.money : 0 };
    }
    state.money = newMoney;
    return { updated: true, money: state.money };
}

export function applyJoinBalance(state, msg) {
    if (!state || !msg || typeof msg !== 'object') {
        return { updated: false };
    }
    if (msg.user && state.username && String(msg.user) !== String(state.username)) {
        return { updated: false, reason: 'USERNAME_MISMATCH' };
    }
    if (msg.money === undefined || msg.money === null) {
        return { updated: false, reason: 'NO_MONEY' };
    }
    return setMoneyBalance(state, msg.money);
}

export function applyBalanceUpdate(state, msg) {
    if (!state || !msg || typeof msg !== 'object') {
        return { updated: false };
    }
    const targetUser = String(msg.username || '');
    if (!state.username || !targetUser || targetUser !== String(state.username)) {
        return { updated: false, reason: 'USERNAME_MISMATCH' };
    }
    const res = setMoneyBalance(state, msg.money);
    if (!res.updated) return res;
    return {
        updated: true,
        money: state.money,
        delta: (typeof msg.delta === 'number' && Number.isSafeInteger(msg.delta)) ? msg.delta : 0,
        reason: String(msg.reason || '')
    };
}

function syncActivePoliceChaseSummary(state) {
    if (!state || !(state.activePoliceChases instanceof Map) || !state.username) {
        if (state) state.activePoliceChase = null;
        return;
    }
    let found = null;
    for (const chase of state.activePoliceChases.values()) {
        if (chase && chase.target_user === state.username) {
            found = chase;
            break;
        }
    }
    state.activePoliceChase = found;
}

export function applyPoliceStateSnapshot(state, msg) {
    if (!state || !msg || typeof msg !== 'object') {
        return { applied: false, reason: 'INVALID_MESSAGE', removedCops: [], removedCars: [] };
    }
    const hasSeq = msg.sequence !== undefined && msg.sequence !== null;
    const seq = hasSeq ? Number(msg.sequence) : NaN;
    if (hasSeq && (!Number.isFinite(seq) || (Number.isFinite(state.policeStateSequence) && state.policeStateSequence >= 0 && seq <= state.policeStateSequence))) {
        return { applied: false, reason: 'STALE_SEQUENCE', removedCops: [], removedCars: [] };
    }
    if (Number.isFinite(seq)) {
        state.policeStateSequence = seq;
    }

    if (!(state.policeCops instanceof Map)) state.policeCops = new Map();
    if (!(state.policeCars instanceof Map)) state.policeCars = new Map();
    if (!(state.activePoliceChases instanceof Map)) state.activePoliceChases = new Map();

    const removedCops = [];
    const removedCars = [];

    if (Array.isArray(msg.foot_cops)) {
        const seenCopIds = new Set();
        for (const rawCop of msg.foot_cops) {
            if (!rawCop || !rawCop.id) continue;
            const id = String(rawCop.id);
            seenCopIds.add(id);
            const existing = state.policeCops.get(id) || {};
            const updated = Object.assign(existing, {
                id,
                name: String(rawCop.name || existing.name || 'Сержант ППС'),
                x: Number(rawCop.x) || 0,
                y: Number(rawCop.y) || 0,
                z: Number(rawCop.z) || 0,
                vx: Number(rawCop.vx) || 0,
                vz: Number(rawCop.vz) || 0,
                yaw: Number(rawCop.yaw) || 0,
                state: String(rawCop.state || 'patrol'),
                anim: String(rawCop.anim || 'idle'),
                target_user: String(rawCop.target_user || '')
            });
            state.policeCops.set(id, updated);
        }
        for (const [id, cop] of Array.from(state.policeCops.entries())) {
            if (!seenCopIds.has(id)) {
                removedCops.push(cop);
                state.policeCops.delete(id);
            }
        }
    }

    if (Array.isArray(msg.police_cars)) {
        const seenCarIds = new Set();
        for (const rawCar of msg.police_cars) {
            if (!rawCar || !rawCar.id) continue;
            const id = String(rawCar.id);
            seenCarIds.add(id);
            const existing = state.policeCars.get(id) || {};
            const keepVisualPose = existing._initialized && existing.snapshotBuffer?.samples?.length > 0;
            const serverX = Number(rawCar.x) || 0;
            const serverY = Number(rawCar.y) || 0;
            const serverZ = Number(rawCar.z) || 0;
            const serverVx = Number(rawCar.vx) || 0;
            const serverVz = Number(rawCar.vz) || 0;
            const serverYaw = Number(rawCar.yaw) || 0;
            const serverYawRate = Number(rawCar.yaw_rate) || 0;
            const serverSpeed = Number(rawCar.speed) || 0;
            const updated = Object.assign(existing, {
                id,
                serverX, serverY, serverZ, serverVx, serverVz, serverYaw, serverYawRate, serverSpeed,
                x: keepVisualPose ? existing.x : serverX,
                y: keepVisualPose ? existing.y : serverY,
                z: keepVisualPose ? existing.z : serverZ,
                vx: keepVisualPose ? existing.vx : serverVx,
                vz: keepVisualPose ? existing.vz : serverVz,
                yaw: keepVisualPose ? existing.yaw : serverYaw,
                yaw_rate: keepVisualPose ? existing.yaw_rate : serverYawRate,
                speed: keepVisualPose ? existing.speed : serverSpeed,
                mass: (Number.isFinite(Number(rawCar.mass)) && Number(rawCar.mass) > 10) ? Number(rawCar.mass) : (existing.mass || 4200),
                state: String(rawCar.state || 'patrol'),
                target_car_id: String(rawCar.target_car_id || ''),
                target_user: String(rawCar.target_user || ''),
                siren: Boolean(rawCar.siren),
                lights: Boolean(rawCar.lights)
            });
            state.policeCars.set(id, updated);

            if (updated.state === 'chase' && updated.target_user) {
                state.activePoliceChases.set(id, {
                    police_car_id: id,
                    target_car_id: updated.target_car_id,
                    target_user: updated.target_user,
                    status: 'started'
                });
            } else {
                state.activePoliceChases.delete(id);
            }
        }
        for (const [id, car] of Array.from(state.policeCars.entries())) {
            if (!seenCarIds.has(id)) {
                removedCars.push(car);
                state.policeCars.delete(id);
                state.activePoliceChases.delete(id);
            }
        }
    }

    syncActivePoliceChaseSummary(state);
    return { applied: true, sequence: state.policeStateSequence, removedCops, removedCars };
}

export function startPoliceEncounterState(state, msg) {
    if (!state || !msg || typeof msg !== 'object' || !msg.encounter_id || !Array.isArray(msg.options)) {
        return { started: false, reason: 'INVALID_ENCOUNTER' };
    }
    const targetUser = msg.target_user ? String(msg.target_user) : '';
    if (targetUser && state.username && targetUser !== String(state.username)) {
        return { started: false, reason: 'USERNAME_MISMATCH' };
    }
    const encounterId = String(msg.encounter_id);
    if (state.activePoliceEncounter && state.activePoliceEncounter.encounter_id === encounterId) {
        if (state.activePoliceEncounter.stage === 'pending') {
            state.activePoliceEncounter.stage = 'opening';
            state.activePoliceEncounter.chosenOptionIndex = null;
        }
        return { started: true, idempotent: true, encounter: state.activePoliceEncounter };
    }
    const opening = String(msg.opening || '');
    state.activeNpcChat = null;
    state.activePoliceEncounter = {
        encounter_id: encounterId,
        cop_id: String(msg.cop_id || ''),
        cop_name: String(msg.cop_name || 'Сержант ППС'),
        scenario_id: String(msg.scenario_id || ''),
        title: String(msg.title || 'Полиция Владивостока'),
        opening,
        options: msg.options.map((opt, idx) => ({
            index: Number.isInteger(opt && opt.index) ? opt.index : idx,
            text: String((opt && opt.text) || ''),
            fine: Number(opt && opt.fine) || 0
        })),
        target_user: targetUser || String(state.username || ''),
        stage: 'opening',
        chosenOptionIndex: null,
        replyText: '',
        fine: 0,
        chatHistory: [
            { role: 'police', text: opening }
        ]
    };
    return { started: true, idempotent: false, encounter: state.activePoliceEncounter };
}

export function resolvePoliceEncounterState(state, msg) {
    if (!state || !msg || typeof msg !== 'object') {
        return { resolved: false, moneyUpdated: false };
    }
    const targetUser = String(msg.target_user || '');
    if (!state.username || !targetUser || targetUser !== String(state.username)) {
        return { resolved: false, moneyUpdated: false, reason: 'USERNAME_MISMATCH' };
    }

    let moneyUpdated = false;
    if (msg.money !== undefined && msg.money !== null) {
        const res = setMoneyBalance(state, msg.money);
        moneyUpdated = res.updated;
    }

    const enc = state.activePoliceEncounter;
    if (enc && (!msg.encounter_id || enc.encounter_id === String(msg.encounter_id))) {
        enc.stage = 'resolved';
        enc.replyText = String(msg.reply_text || '');
        enc.fine = Number.isFinite(Number(msg.fine)) ? Number(msg.fine) : 0;
        if (Number.isInteger(msg.option_index)) {
            enc.chosenOptionIndex = msg.option_index;
        }
        if (enc.replyText) {
            enc.chatHistory.push({ role: 'police', text: enc.replyText });
        }
        return { resolved: true, moneyUpdated, encounter: enc };
    }
    return { resolved: false, moneyUpdated };
}

export function clearPoliceEncounterState(state = GAME_STATE) {
    if (!state) return;
    state.activePoliceEncounter = null;
}

export function isLocalPlayerChased(state = GAME_STATE) {
    if (!state || !state.username) return false;
    if (state.activePoliceChases instanceof Map) {
        for (const chase of state.activePoliceChases.values()) {
            if (chase && chase.target_user === state.username) {
                return true;
            }
        }
    }
    if (state.policeCars instanceof Map) {
        for (const car of state.policeCars.values()) {
            if (car && car.state === 'chase' && car.target_user === state.username) {
                return true;
            }
        }
    }
    return false;
}

export function applyPoliceChaseEvent(state, msg) {
    if (!state || !msg || typeof msg !== 'object') {
        return { isLocalTarget: false, status: '', chased: false, moneyUpdated: false };
    }
    if (!(state.activePoliceChases instanceof Map)) {
        state.activePoliceChases = new Map();
    }
    const policeCarId = String(msg.police_car_id || '');
    const targetCarId = String(msg.target_car_id || '');
    const targetUser = String(msg.target_user || '');
    const status = String(msg.status || '');

    if (policeCarId) {
        if (status === 'started') {
            state.activePoliceChases.set(policeCarId, {
                police_car_id: policeCarId,
                target_car_id: targetCarId,
                target_user: targetUser,
                status: 'started',
                reason: String(msg.reason || '')
            });
        } else if (status === 'stopped' || status === 'evaded') {
            state.activePoliceChases.delete(policeCarId);
            if (state.policeCars instanceof Map) {
                const pcar = state.policeCars.get(policeCarId);
                if (pcar) {
                    pcar.state = 'cooldown';
                    pcar.target_user = '';
                    pcar.target_car_id = '';
                    pcar.siren = false;
                    pcar.lights = false;
                }
            }
        }
    }
    syncActivePoliceChaseSummary(state);

    const isLocalTarget = Boolean(state.username && targetUser && targetUser === String(state.username));
    let moneyUpdated = false;
    if (isLocalTarget && msg.money !== undefined && msg.money !== null) {
        const res = setMoneyBalance(state, msg.money);
        moneyUpdated = res.updated;
    }

    return {
        isLocalTarget,
        status,
        chased: isLocalPlayerChased(state),
        moneyUpdated
    };
}

export function resetPoliceState(state = GAME_STATE) {
    if (!state) return;
    if (state.policeCops instanceof Map) state.policeCops.clear();
    else state.policeCops = new Map();
    if (state.policeCars instanceof Map) state.policeCars.clear();
    else state.policeCars = new Map();
    if (state.activePoliceChases instanceof Map) state.activePoliceChases.clear();
    else state.activePoliceChases = new Map();
    state.policeStateSequence = -1;
    state.activePoliceEncounter = null;
    state.activePoliceChase = null;
}

