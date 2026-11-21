import { describe, test, expect } from 'bun:test';
import policeDialogues from '../data/police_dialogues.json';
import npcDialogues from '../data/npc_dialogues.json';

const CYRILLIC_RE = /[а-яА-ЯёЁ]/;

describe('Police Dialogues Schema (police_dialogues.json)', () => {
    test('has top-level scenarios array with at least 4 distinct scenarios', () => {
        expect(typeof policeDialogues).toBe('object');
        expect(policeDialogues).not.toBeNull();
        expect(Array.isArray(policeDialogues)).toBe(false);
        expect(Array.isArray(policeDialogues.scenarios)).toBe(true);
        expect(policeDialogues.scenarios.length).toBeGreaterThanOrEqual(4);

        const ids = policeDialogues.scenarios.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('includes person_search, weed_shakedown, document_check, and public_order', () => {
        const ids = policeDialogues.scenarios.map((s) => s.id);
        expect(ids).toContain('person_search');
        expect(ids).toContain('weed_shakedown');
        expect(ids).toContain('document_check');
        expect(ids).toContain('public_order');
    });

    test('every scenario has Russian title, Russian opening, and contiguous 0-based options with non-negative integer fines', () => {
        for (const scenario of policeDialogues.scenarios) {
            expect(typeof scenario.id).toBe('string');
            expect(scenario.id.trim().length).toBeGreaterThan(0);
            expect(typeof scenario.title).toBe('string');
            expect(scenario.title.trim().length).toBeGreaterThan(0);
            expect(CYRILLIC_RE.test(scenario.title)).toBe(true);

            expect(typeof scenario.opening).toBe('string');
            expect(scenario.opening.trim().length).toBeGreaterThan(0);
            expect(CYRILLIC_RE.test(scenario.opening)).toBe(true);

            expect(Array.isArray(scenario.options)).toBe(true);
            expect(scenario.options.length).toBeGreaterThanOrEqual(2);

            scenario.options.forEach((opt, expectedIdx) => {
                expect(Number.isInteger(opt.index)).toBe(true);
                expect(opt.index).toBe(expectedIdx);
                expect(opt.index).toBeGreaterThanOrEqual(0);
                expect(opt.index).toBeLessThanOrEqual(15);

                expect(typeof opt.text).toBe('string');
                expect(opt.text.trim().length).toBeGreaterThan(0);
                expect(CYRILLIC_RE.test(opt.text)).toBe(true);

                expect(typeof opt.reply).toBe('string');
                expect(opt.reply.trim().length).toBeGreaterThan(0);
                expect(CYRILLIC_RE.test(opt.reply)).toBe(true);

                expect(Number.isInteger(opt.fine)).toBe(true);
                expect(opt.fine).toBeGreaterThanOrEqual(0);
            });
        }
    });

    test('weed_shakedown deducts money (fine > 0) for EVERY selectable option', () => {
        const weed = policeDialogues.scenarios.find((s) => s.id === 'weed_shakedown');
        expect(weed).toBeTruthy();
        expect(weed.options.length).toBeGreaterThanOrEqual(2);
        for (const opt of weed.options) {
            expect(opt.fine).toBeGreaterThan(0);
        }
    });

    test('civilian npc_dialogues.json remains untouched at 10 entries', () => {
        expect(Array.isArray(npcDialogues)).toBe(true);
        expect(npcDialogues.length).toBe(10);
    });
});
