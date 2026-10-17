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

export function createGameState(overrides = {}) {
    const isNarrowViewport = typeof window !== 'undefined' ? window.innerWidth < 640 : false;
    return {
        username: overrides.username || getInitialUsername(),
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
export function computePedestrianAnim({ emoteTimer = 0, isGrounded = true, vx = 0, vz = 0 }) {
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
    const [worldRes, dialoguesRes] = await Promise.all([
        fetchFn('data/world_map.json'),
        fetchFn('data/npc_dialogues.json')
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
 * due to active modal dialogs (help modal, login overlay, NPC chat) or focused text inputs.
 */
export function isGameplayInputSuspended() {
    if (GAME_STATE.activeNpcChat) return true;
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

