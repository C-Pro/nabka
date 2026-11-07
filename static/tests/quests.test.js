import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
    QUEST_DEFINITIONS,
    getQuestById,
    getQuestsForNpc,
    canAcceptQuest,
    acceptQuest,
    consumeAbility,
    hasQuestAbility,
    isQuestCompleted
} from '../js/quests.js';
import { createGameState, GAME_STATE } from '../js/state.js';
import {
    renderNpcDialogueOptions,
    selectCaptainCannonPrompt,
    selectCaptainCannonAccept,
    selectCaptainCannonDecline,
    selectCaptainCannonStatus,
    checkProximityInteractions
} from '../js/ui.js';
import { MultiplayerClient } from '../js/network.js';

function createMockElement(tag = 'div') {
    const el = {
        tagName: tag.toUpperCase(),
        _textContent: '',
        get textContent() {
            if (this.children.length > 0) {
                return this.children.map(c => c.textContent).join(' ');
            }
            return this._textContent;
        },
        set textContent(val) {
            this._textContent = String(val);
        },
        get innerHTML() {
            return this._textContent;
        },
        set innerHTML(val) {
            this._textContent = String(val);
            this.children = [];
        },
        className: '',
        children: [],
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        _listeners: {},
        addEventListener(event, fn) {
            this._listeners[event] = fn;
        },
        click() {
            if (this._listeners.click) this._listeners.click();
        }
    };
    return el;
}

describe('Quest System - Pure Logic and State Transitions', () => {
    test('QUEST_DEFINITIONS contains the Captain Mikhalych cannon quest with required fields', () => {
        const quest = getQuestById('captain_cannon');
        expect(quest).not.toBeNull();
        expect(quest.id).toBe('captain_cannon');
        expect(quest.npcId).toBe('captain_mikhalych');
        expect(quest.cost).toBe(50000);
        expect(quest.rewardAbility).toBe('can_fire_fortress_cannon');
        expect(quest.consumedFlag).toBe('fired_fortress_cannon');
        expect(Array.isArray(quest.items.give)).toBe(true);
        expect(Array.isArray(quest.items.take)).toBe(true);
    });

    test('getQuestsForNpc finds quest by persona ID or persona name', () => {
        expect(getQuestsForNpc('captain_mikhalych').length).toBe(1);
        expect(getQuestsForNpc('Капитан Михалыч').length).toBe(1);
        expect(getQuestsForNpc('unknown_npc').length).toBe(0);
    });

    test('canAcceptQuest rejects non-registered IDs or arbitrary user objects', () => {
        const state = createGameState({ money: 100000 });
        expect(canAcceptQuest(null, state).ok).toBe(false);
        expect(canAcceptQuest({ id: 'fake', cost: 10 }, state).ok).toBe(false);
        expect(canAcceptQuest('non_existent_quest', state).ok).toBe(false);
    });

    test('canAcceptQuest rejects non-finite, negative, or unsafe integer balances', () => {
        const stateInf = createGameState({ money: Infinity });
        expect(canAcceptQuest('captain_cannon', stateInf).reason).toBe('INVALID_BALANCE');

        const stateNeg = createGameState({ money: -500 });
        expect(canAcceptQuest('captain_cannon', stateNeg).reason).toBe('INVALID_BALANCE');

        const stateNaN = createGameState({ money: NaN });
        expect(canAcceptQuest('captain_cannon', stateNaN).reason).toBe('INVALID_BALANCE');
    });

    test('canAcceptQuest rejects when user has insufficient balance without modifying state', () => {
        const state = createGameState({ money: 49999 });
        const check = canAcceptQuest('captain_cannon', state);
        expect(check.ok).toBe(false);
        expect(check.reason).toBe('INSUFFICIENT_FUNDS');
        expect(state.money).toBe(49999);
        expect(isQuestCompleted('captain_cannon', state)).toBe(false);
    });

    test('acceptQuest atomically deducts 50,000 ₽ and grants ability flag for exact funds', () => {
        const state = createGameState({ money: 50000 });
        const res = acceptQuest('captain_cannon', state);
        expect(res.ok).toBe(true);
        expect(state.money).toBe(0);
        expect(isQuestCompleted('captain_cannon', state)).toBe(true);
        expect(hasQuestAbility('can_fire_fortress_cannon', state)).toBe(true);
    });

    test('acceptQuest cannot be accepted twice while ability is active (duplicate prevention)', () => {
        const state = createGameState({ money: 125400 });
        const r1 = acceptQuest('captain_cannon', state);
        expect(r1.ok).toBe(true);
        expect(state.money).toBe(75400);

        // Attempting to accept again while ability is still unconsumed is rejected
        const r2 = acceptQuest('captain_cannon', state);
        expect(r2.ok).toBe(false);
        expect(r2.reason).toBe('ABILITY_ALREADY_ACTIVE');
        expect(state.money).toBe(75400); // Balance remains protected
    });

    test('re-entrant quest: user can accept again after firing if they have enough money', () => {
        const state = createGameState({ money: 125400 });
        const r1 = acceptQuest('captain_cannon', state);
        expect(r1.ok).toBe(true);
        expect(state.money).toBe(75400);

        // Player fires the cannon, consuming the ability
        consumeAbility('can_fire_fortress_cannon', state);
        expect(hasQuestAbility('can_fire_fortress_cannon', state)).toBe(false);

        // Player still has 75,400 ₽ >= 50,000 ₽: can accept a second time!
        const r2 = acceptQuest('captain_cannon', state);
        expect(r2.ok).toBe(true);
        expect(state.money).toBe(25400);
        expect(hasQuestAbility('can_fire_fortress_cannon', state)).toBe(true);
        expect(r2.completions).toBe(2);

        // Player fires the second shot
        consumeAbility('can_fire_fortress_cannon', state);

        // Player now has 25,400 ₽ < 50,000 ₽: cannot afford another shot
        const r3 = acceptQuest('captain_cannon', state);
        expect(r3.ok).toBe(false);
        expect(r3.reason).toBe('INSUFFICIENT_FUNDS');
        expect(state.money).toBe(25400);
        expect(hasQuestAbility('can_fire_fortress_cannon', state)).toBe(false);
    });

    test('consumeAbility atomically clears can_fire_fortress_cannon and records fired_fortress_cannon', () => {
        const state = createGameState({ money: 100000 });
        acceptQuest('captain_cannon', state);
        expect(hasQuestAbility('can_fire_fortress_cannon', state)).toBe(true);

        const useRes = consumeAbility('can_fire_fortress_cannon', state);
        expect(useRes.ok).toBe(true);
        expect(hasQuestAbility('can_fire_fortress_cannon', state)).toBe(false);
        expect(state.questFlags.fired_fortress_cannon).toBe(true);

        // Second consumption is rejected
        const dupUse = consumeAbility('can_fire_fortress_cannon', state);
        expect(dupUse.ok).toBe(false);
        expect(dupUse.reason).toBe('ABILITY_NOT_AVAILABLE');
    });
});

describe('Captain Mikhalych Dialogue & Fortress Cannon Interaction', () => {
    let originalDocument;

    beforeEach(() => {
        originalDocument = globalThis.document;
        GAME_STATE.money = 125400;
        GAME_STATE.completedQuests = new Set();
        GAME_STATE.questFlags = {};
        GAME_STATE.inVehicle = null;
        GAME_STATE.nearestInteractable = null;
        GAME_STATE.activeNpcChat = null;
    });

    afterEach(() => {
        globalThis.document = originalDocument;
    });

    test('Captain Mikhalych dialogue offers quest option 4 in opening stage', () => {
        const npc = {
            persona: {
                id: 'captain_mikhalych',
                name: 'Капитан Михалыч',
                emoji: '⚓',
                options: [
                    { question: 'Q1', answer: 'A1' },
                    { question: 'Q2', answer: 'A2' },
                    { question: 'Q3', answer: 'A3' }
                ],
                goodbyes: ['B1', 'B2', 'B3']
            },
            chatStage: 'opening',
            chatHistory: []
        };

        const container = createMockElement('div');
        globalThis.document = {
            createElement: createMockElement,
            getElementById(id) {
                if (id === 'npc-options-container') return container;
                return null;
            }
        };

        renderNpcDialogueOptions(npc);
        // 3 standard options + 1 quest option = 4 buttons
        expect(container.children.length).toBe(4);
        expect(container.children[3].textContent).toContain('Пальнуть из пушки на крепости (50 000 ₽)');
    });

    test('Selecting quest prompt advances dialogue to quest_offer with accept/decline choices', () => {
        const npc = {
            persona: { id: 'captain_mikhalych', name: 'Капитан Михалыч', options: [], goodbyes: [] },
            chatStage: 'opening',
            chatHistory: []
        };
        const container = createMockElement('div');
        const historyContainer = createMockElement('div');

        globalThis.document = {
            createElement: createMockElement,
            getElementById(id) {
                if (id === 'npc-options-container') return container;
                if (id === 'npc-chat-history') return historyContainer;
                return null;
            }
        };

        selectCaptainCannonPrompt(npc);
        expect(npc.chatStage).toBe('quest_offer');
        expect(npc.chatHistory.length).toBe(2);
        expect(npc.chatHistory[0].text).toContain('Капитан, а можно как-то самому пальнуть');
        expect(npc.chatHistory[1].text).toContain('За мзду малую в 50 000 ₽');

        // Check options rendered in quest_offer stage
        expect(container.children.length).toBe(2);
        expect(container.children[0].textContent).toContain('[Заплатить 50 000 ₽]');
        expect(container.children[1].textContent).toContain('Ого, дороговато... В другой раз.');
    });

    test('Declining quest offer transitions to answered stage without spending money', () => {
        const npc = {
            persona: { id: 'captain_mikhalych', name: 'Капитан Михалыч', options: [], goodbyes: ['До встречи'] },
            chatStage: 'quest_offer',
            chatHistory: []
        };
        const container = createMockElement('div');
        const historyContainer = createMockElement('div');

        globalThis.document = {
            createElement: createMockElement,
            getElementById(id) {
                if (id === 'npc-options-container') return container;
                if (id === 'npc-chat-history') return historyContainer;
                return null;
            }
        };

        const initialMoney = GAME_STATE.money;
        selectCaptainCannonDecline(npc);
        expect(npc.chatStage).toBe('answered');
        expect(npc.chatHistory[npc.chatHistory.length - 1].text).toContain('Дело хозяйское');
        expect(GAME_STATE.money).toBe(initialMoney);
    });

    test('Captain Mikhalych offers repeat shot if user already fired and has enough money', () => {
        const npc = {
            persona: {
                id: 'captain_mikhalych',
                name: 'Капитан Михалыч',
                options: [
                    { question: 'Q1', answer: 'A1' },
                    { question: 'Q2', answer: 'A2' },
                    { question: 'Q3', answer: 'A3' }
                ],
                goodbyes: ['B1', 'B2', 'B3']
            },
            chatStage: 'opening',
            chatHistory: []
        };
        const container = createMockElement('div');
        const historyContainer = createMockElement('div');
        const toastContainer = createMockElement('div');

        globalThis.document = {
            createElement: createMockElement,
            getElementById(id) {
                if (id === 'npc-options-container') return container;
                if (id === 'npc-chat-history') return historyContainer;
                if (id === 'toast-container') return toastContainer;
                return null;
            }
        };

        // User initially has 120,000 ₽
        GAME_STATE.money = 120000;
        GAME_STATE.completedQuests = {};
        GAME_STATE.questFlags = {};
        GAME_STATE.questCompletions = {};

        // 1. Complete quest first time and fire
        acceptQuest('captain_cannon', GAME_STATE);
        expect(GAME_STATE.money).toBe(70000);
        consumeAbility('can_fire_fortress_cannon', GAME_STATE);

        // 2. Open Mikhalych dialogue again
        renderNpcDialogueOptions(npc);
        expect(container.children.length).toBe(4);
        expect(container.children[3].textContent).toContain('Пальнуть из пушки ещё разок (50 000 ₽)');

        // 3. User clicks the repeat option
        selectCaptainCannonPrompt(npc, true);
        expect(npc.chatStage).toBe('quest_offer');
        expect(npc.chatHistory[npc.chatHistory.length - 2].text).toContain('пальнуть из пушки ещё разок?');
        expect(npc.chatHistory[npc.chatHistory.length - 1].text).toContain('повторный залп');

        // 4. User accepts repeat shot with 70,000 ₽
        selectCaptainCannonAccept(npc);
        expect(GAME_STATE.money).toBe(20000);
        expect(hasQuestAbility('can_fire_fortress_cannon', GAME_STATE)).toBe(true);
        expect(npc.chatHistory[npc.chatHistory.length - 1].text).toContain('Снова договорился с артиллеристами');

        // 5. User fires second shot
        consumeAbility('can_fire_fortress_cannon', GAME_STATE);
        expect(hasQuestAbility('can_fire_fortress_cannon', GAME_STATE)).toBe(false);

        // 6. User now has 20,000 ₽ < 50,000 ₽; tries to accept again
        selectCaptainCannonPrompt(npc, true);
        selectCaptainCannonAccept(npc);
        expect(GAME_STATE.money).toBe(20000); // Money not deducted
        expect(hasQuestAbility('can_fire_fortress_cannon', GAME_STATE)).toBe(false); // Ability not granted
        expect(npc.chatHistory[npc.chatHistory.length - 1].text).toContain('у тебя в кармане не густо');
    });

    test('Fortress interactable switches to cannon shot when player holds ability, revalidating distance', () => {
        acceptQuest('captain_cannon', GAME_STATE);
        expect(hasQuestAbility('can_fire_fortress_cannon', GAME_STATE)).toBe(true);

        const fortressItem = {
            id: 'fortress',
            name: 'Музей «Владивостокская крепость»',
            prompt: 'Осмотреть береговые орудия Крепости',
            x: 127.87,
            z: -124.43,
            radius: 6,
            reward: 850
        };

        const promptEl = { classList: { remove() {}, add() {} } };
        const promptText = { textContent: '' };
        const toastContainer = createMockElement('div');

        globalThis.document = {
            createElement: createMockElement,
            getElementById(id) {
                if (id === 'interaction-prompt') return promptEl;
                if (id === 'interaction-text') return promptText;
                if (id === 'toast-container') return toastContainer;
                return null;
            }
        };

        checkProximityInteractions({
            playerPos: { x: 127.87, z: -124.43 },
            npcs: [],
            interactables: [fortressItem],
            dunya: null
        });

        expect(GAME_STATE.nearestInteractable).not.toBeNull();
        expect(GAME_STATE.nearestInteractable.id).toBe('fortress_cannon');
        expect(GAME_STATE.nearestInteractable.prompt).toContain('Пальнуть из пушки');

        // Fire cannon in local bridge mode
        MultiplayerClient.isLocalBridge = true;
        GAME_STATE.nearestInteractable.onInteract();
        expect(hasQuestAbility('can_fire_fortress_cannon', GAME_STATE)).toBe(false);
        expect(GAME_STATE.questFlags.fired_fortress_cannon).toBe(true);
        MultiplayerClient.isLocalBridge = false;

        // Next proximity check without ability reverts to regular fortress inspection
        checkProximityInteractions({
            playerPos: { x: 127.87, z: -124.43 },
            npcs: [],
            interactables: [fortressItem],
            dunya: null
        });
        expect(GAME_STATE.nearestInteractable.id).toBe('fortress');
        expect(GAME_STATE.nearestInteractable.prompt).toBe('Осмотреть береговые орудия Крепости');
    });
});

describe('Multiplayer Cannon Events & Quest Invariants', () => {
    let originalDoc;
    let toastContainer;

    beforeEach(() => {
        originalDoc = globalThis.document;
        toastContainer = createMockElement('div');
        globalThis.document = {
            createElement: createMockElement,
            getElementById(id) {
                if (id === 'toast-container') return toastContainer;
                return null;
            }
        };
        GAME_STATE.username = 'test_player';
        GAME_STATE.money = 100000;
        GAME_STATE.completedQuests = {};
        GAME_STATE.questFlags = {};
        GAME_STATE.isCannonFirePending = false;
        MultiplayerClient.ws = null;
        MultiplayerClient.isLocalBridge = false;
    });

    afterEach(() => {
        globalThis.document = originalDoc;
        GAME_STATE.isCannonFirePending = false;
        MultiplayerClient.ws = null;
    });

    test('Pending fortress request overlapping noon event: noon must neither consume ability nor clear pending flag', () => {
        acceptQuest('captain_cannon', GAME_STATE);
        expect(hasQuestAbility('can_fire_fortress_cannon', GAME_STATE)).toBe(true);

        // Player pressed [E], request is in-flight to server
        GAME_STATE.isCannonFirePending = true;

        // Server broadcasts noon event
        MultiplayerClient.handleServerMessage({
            type: 'cannon_shot',
            user: '',
            reason: 'noon'
        });

        // Invariants: noon event MUST NOT consume the player's ability
        expect(hasQuestAbility('can_fire_fortress_cannon', GAME_STATE)).toBe(true);
        // Noon event MUST NOT clear the in-flight fortress request
        expect(GAME_STATE.isCannonFirePending).toBe(true);
    });

    test('Remote player firing cannon does not consume local player ability or clear pending flag', () => {
        acceptQuest('captain_cannon', GAME_STATE);
        GAME_STATE.isCannonFirePending = true;

        // Another player fires fortress cannon
        MultiplayerClient.handleServerMessage({
            type: 'cannon_shot',
            user: 'other_player',
            reason: 'fortress'
        });

        expect(hasQuestAbility('can_fire_fortress_cannon', GAME_STATE)).toBe(true);
        expect(GAME_STATE.isCannonFirePending).toBe(true);
    });

    test('Server error clears pending state without consuming ability', () => {
        acceptQuest('captain_cannon', GAME_STATE);
        GAME_STATE.isCannonFirePending = true;

        MultiplayerClient.handleServerMessage({
            type: 'error',
            message: 'too far from fortress cannon'
        });

        expect(GAME_STATE.isCannonFirePending).toBe(false);
        expect(hasQuestAbility('can_fire_fortress_cannon', GAME_STATE)).toBe(true);
    });

    test('Authoritative server confirmation consumes ability and clears pending state', () => {
        acceptQuest('captain_cannon', GAME_STATE);
        GAME_STATE.isCannonFirePending = true;

        MultiplayerClient.handleServerMessage({
            type: 'cannon_shot',
            user: 'test_player',
            reason: 'fortress'
        });

        expect(GAME_STATE.isCannonFirePending).toBe(false);
        expect(hasQuestAbility('can_fire_fortress_cannon', GAME_STATE)).toBe(false);
        expect(GAME_STATE.questFlags.fired_fortress_cannon).toBe(true);
    });

    test('sendCannonFire when disconnected preserves ability and clears pending state', () => {
        acceptQuest('captain_cannon', GAME_STATE);
        GAME_STATE.isCannonFirePending = true;
        MultiplayerClient.ws = null;
        MultiplayerClient.isLocalBridge = false;

        MultiplayerClient.sendCannonFire();

        expect(GAME_STATE.isCannonFirePending).toBe(false);
        expect(hasQuestAbility('can_fire_fortress_cannon', GAME_STATE)).toBe(true);
        expect(toastContainer.children.length).toBeGreaterThan(0);
        expect(toastContainer.children[toastContainer.children.length - 1].textContent).toContain('Нет соединения с сервером');
    });

    test('Older server returning unknown message type clears pending state and informs user', () => {
        acceptQuest('captain_cannon', GAME_STATE);
        GAME_STATE.isCannonFirePending = true;

        MultiplayerClient.handleServerMessage({
            type: 'error',
            message: 'unknown message type'
        });

        expect(GAME_STATE.isCannonFirePending).toBe(false);
        expect(hasQuestAbility('can_fire_fortress_cannon', GAME_STATE)).toBe(true);
        expect(toastContainer.children.length).toBeGreaterThan(0);
        expect(toastContainer.children[toastContainer.children.length - 1].textContent).toContain('не поддерживает пушечный залп');
    });
});
