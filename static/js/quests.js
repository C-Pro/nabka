/**
 * Pure Quest System Module for Nabka.
 * Handles quest registry, eligibility checks, atomic balance transactions,
 * flag/ability assignments, and dialogue tree hooks.
 * 
 * NOTE ON AUTHORITY & LIFECYCLE:
 * In this client-side prototype, player balance, completed quests, and quest ability
 * flags are maintained locally in GAME_STATE. They are session-local, reset upon
 * page reload/refresh, and do not persist across restarts or replicate across multiplayer
 * network sessions. All transactions validate non-negative finite safe-integer balances
 * and enforce idempotent transitions.
 */

export const QUEST_DEFINITIONS = [
    {
        id: 'captain_cannon',
        npcId: 'captain_mikhalych',
        npcName: 'Капитан Михалыч',
        title: 'Полуденный выстрел Владивостокской крепости',
        description: 'Капитан Михалыч предлагает за мзду малую в 50 000 ₽ договориться со смотрителями и пальнуть из пушки в музее владивостокской крепости.',
        cost: 50000,
        repeatable: true,
        rewardAbility: 'can_fire_fortress_cannon',
        consumedFlag: 'fired_fortress_cannon',
        // Scaffolded inventory hooks for future items support
        items: {
            give: [],
            take: []
        },
        dialogue: {
            promptQuestion: 'Капитан, а можно как-то самому пальнуть из пушки на крепости?',
            offerAnswer: 'А то! За мзду малую в 50 000 ₽ договорюсь с музейными смотрителями — зарядят холостым и дадут дёрнуть шнур! Договорились?',
            repeatPromptQuestion: 'Капитан, а можно пальнуть из пушки ещё разок?',
            repeatOfferAnswer: 'Понравилось, да? Душа просит ещё огоньку! За те же 50 000 ₽ договорюсь со смотрителями на повторный залп. Ну что, бахнем ещё?',
            acceptOptionText: '[Заплатить 50 000 ₽] По рукам, капитан! Вот деньги.',
            declineOptionText: 'Ого, дороговато... В другой раз.',
            successAnswer: 'По рукам! Дуй к музею крепости на Батарейной, подходи к орудиям и жми [E] — пушка готова к залпу! 💥',
            repeatSuccessAnswer: 'Красава! Снова договорился с артиллеристами на Батарейной — иди к пушке и жми [E]! 💥',
            insufficientFundsAnswer: 'Э, браток, у тебя в кармане не густо! Приходи, когда накопишь 50 000 ₽.',
            alreadyCompletedAnswer: 'Так ты уже договаривался со мной, шнур тебя ждёт на Батарейной!',
            declineAnswer: 'Дело хозяйское. Надумаешь пальнуть — подходи, я на рейде ещё постою.',
            pendingShotAnswer: 'Чего стоишь? Пушка на Батарейной уже ждёт твоего залпа! Иди к крепости и жми [E]!',
            firedAnswer: 'Слышал я твой залп — на весь Амурский залив эхо прокатилось! Красава!'
        }
    }
];

export function getQuestById(id) {
    if (typeof id !== 'string') return null;
    return QUEST_DEFINITIONS.find(q => q.id === id) || null;
}

export function getQuestsForNpc(npcIdOrName) {
    if (!npcIdOrName) return [];
    return QUEST_DEFINITIONS.filter(q => q.npcId === npcIdOrName || q.npcName === npcIdOrName);
}

export function isQuestCompleted(questId, state) {
    if (!state || !state.completedQuests) return false;
    if (state.completedQuests instanceof Set) {
        return state.completedQuests.has(questId);
    }
    return Boolean(state.completedQuests[questId]);
}

export function hasQuestAbility(flagName, state) {
    if (!state || !state.questFlags) return false;
    return Boolean(state.questFlags[flagName]);
}

/**
 * Validates whether the player can accept a registered quest.
 */
export function canAcceptQuest(questId, state) {
    if (typeof questId !== 'string') {
        return { ok: false, reason: 'INVALID_QUEST_ID' };
    }
    const quest = getQuestById(questId);
    if (!quest) {
        return { ok: false, reason: 'QUEST_NOT_FOUND' };
    }
    if (!state) {
        return { ok: false, reason: 'NO_STATE' };
    }

    // Validate balance integrity
    if (typeof state.money !== 'number' || !Number.isFinite(state.money) || !Number.isSafeInteger(state.money) || state.money < 0) {
        return { ok: false, reason: 'INVALID_BALANCE', currentMoney: state.money };
    }

    // Check if unsupported inventory items are requested
    if (quest.items && ((Array.isArray(quest.items.give) && quest.items.give.length > 0) || (Array.isArray(quest.items.take) && quest.items.take.length > 0))) {
        return { ok: false, reason: 'ITEMS_NOT_YET_SUPPORTED' };
    }

    // Check if ability is already active (pending use)
    if (quest.rewardAbility && hasQuestAbility(quest.rewardAbility, state)) {
        return { ok: false, reason: 'ABILITY_ALREADY_ACTIVE' };
    }

    if (!quest.repeatable && isQuestCompleted(quest.id, state)) {
        return { ok: false, reason: 'ALREADY_COMPLETED' };
    }

    const cost = Number(quest.cost) || 0;
    if (cost < 0 || !Number.isFinite(cost) || !Number.isSafeInteger(cost)) {
        return { ok: false, reason: 'INVALID_QUEST_COST' };
    }

    if (cost > 0 && state.money < cost) {
        return { ok: false, reason: 'INSUFFICIENT_FUNDS', cost, currentMoney: state.money };
    }

    return { ok: true, quest };
}

/**
 * Atomically commits quest acceptance:
 * 1. Checks eligibility & funds
 * 2. Deducts cost from state.money
 * 3. Marks quest completed in state.completedQuests
 * 4. Grants rewardAbility in state.questFlags
 * 5. Returns a structured result descriptor
 */
export function acceptQuest(questId, state) {
    const check = canAcceptQuest(questId, state);
    if (!check.ok) {
        return check;
    }

    const quest = check.quest;
    const cost = quest.cost;

    // Mutate state atomically
    state.money -= cost;

    if (!state.completedQuests) {
        state.completedQuests = new Set();
    }
    if (state.completedQuests instanceof Set) {
        state.completedQuests.add(quest.id);
    } else {
        state.completedQuests[quest.id] = true;
    }

    if (!state.questFlags) {
        state.questFlags = {};
    }
    if (quest.rewardAbility) {
        state.questFlags[quest.rewardAbility] = true;
    }

    if (!state.questCompletions) {
        state.questCompletions = {};
    }
    state.questCompletions[quest.id] = (state.questCompletions[quest.id] || 0) + 1;

    return {
        ok: true,
        quest,
        deducted: cost,
        newBalance: state.money,
        grantedAbility: quest.rewardAbility,
        completions: state.questCompletions[quest.id]
    };
}

/**
 * Consumes a single-use quest ability flag (e.g. firing the fortress cannon once).
 */
export function consumeAbility(abilityFlag, state) {
    if (!state || !state.questFlags || !state.questFlags[abilityFlag]) {
        return { ok: false, reason: 'ABILITY_NOT_AVAILABLE' };
    }

    state.questFlags[abilityFlag] = false;

    // If there is an associated consumed flag (e.g. fired_fortress_cannon), set it
    const quest = QUEST_DEFINITIONS.find(q => q.rewardAbility === abilityFlag);
    if (quest && quest.consumedFlag) {
        state.questFlags[quest.consumedFlag] = true;
    }

    return {
        ok: true,
        consumedAbility: abilityFlag,
        consumedFlag: quest ? quest.consumedFlag : null
    };
}
