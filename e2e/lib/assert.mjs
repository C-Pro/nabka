/**
 * Lightweight assertion helpers for opaque-box E2E tests.
 * Compatible with both Node.js and Bun without external dependencies.
 */

export class AssertionError extends Error {
    constructor(message, { actual, expected } = {}) {
        super(message);
        this.name = 'AssertionError';
        this.actual = actual;
        this.expected = expected;
    }
}

function fmt(val) {
    if (typeof val === 'string') return JSON.stringify(val);
    if (val === undefined) return 'undefined';
    try {
        return JSON.stringify(val);
    } catch {
        return String(val);
    }
}

function deepEq(a, b) {
    if (Object.is(a, b)) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!deepEq(a[i], b[i])) return false;
        }
        return true;
    }
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!deepEq(a[k], b[k])) return false;
    }
    return true;
}

export function assert(condition, message = 'Assertion failed') {
    if (!condition) {
        throw new AssertionError(message, { actual: condition, expected: true });
    }
}

export function assertEqual(actual, expected, message = '') {
    if (!Object.is(actual, expected)) {
        const prefix = message ? `${message}: ` : '';
        throw new AssertionError(`${prefix}expected ${fmt(expected)}, got ${fmt(actual)}`, { actual, expected });
    }
}

export function assertNotEqual(actual, notExpected, message = '') {
    if (Object.is(actual, notExpected)) {
        const prefix = message ? `${message}: ` : '';
        throw new AssertionError(`${prefix}expected value not equal to ${fmt(notExpected)}`, { actual });
    }
}

export function assertDeepEqual(actual, expected, message = '') {
    if (!deepEq(actual, expected)) {
        const prefix = message ? `${message}: ` : '';
        throw new AssertionError(`${prefix}expected ${fmt(expected)}, got ${fmt(actual)}`, { actual, expected });
    }
}

export function assertGreater(actual, min, message = '') {
    if (!(typeof actual === 'number' && Number.isFinite(actual) && actual > min)) {
        const prefix = message ? `${message}: ` : '';
        throw new AssertionError(`${prefix}expected ${fmt(actual)} > ${fmt(min)}`, { actual, expected: `> ${min}` });
    }
}

export function assertGreaterOrEqual(actual, min, message = '') {
    if (!(typeof actual === 'number' && Number.isFinite(actual) && actual >= min)) {
        const prefix = message ? `${message}: ` : '';
        throw new AssertionError(`${prefix}expected ${fmt(actual)} >= ${fmt(min)}`, { actual, expected: `>= ${min}` });
    }
}

export function assertLess(actual, max, message = '') {
    if (!(typeof actual === 'number' && Number.isFinite(actual) && actual < max)) {
        const prefix = message ? `${message}: ` : '';
        throw new AssertionError(`${prefix}expected ${fmt(actual)} < ${fmt(max)}`, { actual, expected: `< ${max}` });
    }
}

export function assertLessOrEqual(actual, max, message = '') {
    if (!(typeof actual === 'number' && Number.isFinite(actual) && actual <= max)) {
        const prefix = message ? `${message}: ` : '';
        throw new AssertionError(`${prefix}expected ${fmt(actual)} <= ${fmt(max)}`, { actual, expected: `<= ${max}` });
    }
}

export function assertIncludes(haystack, needle, message = '') {
    const ok = typeof haystack === 'string'
        ? haystack.includes(needle)
        : Array.isArray(haystack) && haystack.includes(needle);
    if (!ok) {
        const prefix = message ? `${message}: ` : '';
        throw new AssertionError(`${prefix}expected ${fmt(haystack)} to include ${fmt(needle)}`, { actual: haystack, expected: needle });
    }
}

export function assertMatch(value, regex, message = '') {
    if (typeof value !== 'string' || !regex.test(value)) {
        const prefix = message ? `${message}: ` : '';
        throw new AssertionError(`${prefix}expected ${fmt(value)} to match ${regex}`, { actual: value, expected: String(regex) });
    }
}

export function assertCyrillic(value, message = '') {
    if (typeof value !== 'string' || !/[\u0400-\u04FF]/.test(value)) {
        const prefix = message ? `${message}: ` : '';
        throw new AssertionError(`${prefix}expected Cyrillic text, got ${fmt(value)}`, { actual: value });
    }
}

export function assertFinite(value, message = '') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        const prefix = message ? `${message}: ` : '';
        throw new AssertionError(`${prefix}expected finite number, got ${fmt(value)}`, { actual: value });
    }
}

export function assertInSet(value, allowed, message = '') {
    const set = allowed instanceof Set ? allowed : new Set(allowed);
    if (!set.has(value)) {
        const prefix = message ? `${message}: ` : '';
        throw new AssertionError(`${prefix}expected one of ${fmt([...set])}, got ${fmt(value)}`, { actual: value, expected: [...set] });
    }
}
