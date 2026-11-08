import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { GAME_STATE } from '../js/state.js';
import { bindInputControls, clearMovementInput, setTurboToggle, isTurboActive } from '../js/input.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function createMockElement(id, initialClasses = [], customRect = null) {
    const classSet = new Set(initialClasses);
    const listeners = {};
    let textContent = '';
    const attributes = {};
    const defaultRect = {
        left: 10,
        top: 200,
        width: 200,
        height: 100,
        right: 210,
        bottom: 300
    };
    const rect = customRect || defaultRect;
    return {
        id,
        classList: {
            add: (c) => classSet.add(c),
            remove: (c) => classSet.delete(c),
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
        get className() {
            return Array.from(classSet).join(' ');
        },
        set className(str) {
            classSet.clear();
            if (str) str.split(/\s+/).filter(Boolean).forEach(c => classSet.add(c));
        },
        get textContent() {
            return textContent;
        },
        set textContent(val) {
            textContent = String(val);
        },
        setAttribute: (k, v) => { attributes[k] = String(v); },
        getAttribute: (k) => attributes[k] ?? null,
        addEventListener: (ev, handler) => {
            listeners[ev] = listeners[ev] || [];
            listeners[ev].push(handler);
        },
        removeEventListener: (ev, handler) => {
            if (!listeners[ev]) return;
            listeners[ev] = listeners[ev].filter(h => h !== handler);
        },
        dispatchEvent: (evName, evObj = {}) => {
            if (listeners[evName]) {
                for (const h of listeners[evName]) h({
                    stopPropagation: () => {},
                    preventDefault: () => {},
                    cancelable: true,
                    ...evObj
                });
            }
        },
        getBoundingClientRect: () => rect,
        querySelectorAll: () => []
    };
}

function setupMockDOM() {
    clearMovementInput();
    const mockElements = {
        'three-canvas': createMockElement('three-canvas'),
        'touch-arrows-zone': createMockElement('touch-arrows-zone', [], {
            left: 10, top: 200, width: 184, height: 100, right: 194, bottom: 300
        }),
        'btn-arrow-left': createMockElement('btn-arrow-left', ['dpad-btn', 'dpad-btn-steer'], {
            left: 10, top: 200, width: 56, height: 100, right: 66, bottom: 300
        }),
        'btn-arrow-up': createMockElement('btn-arrow-up', ['dpad-btn'], {
            left: 76, top: 200, width: 48, height: 40, right: 124, bottom: 240
        }),
        'btn-arrow-down': createMockElement('btn-arrow-down', ['dpad-btn'], {
            left: 76, top: 260, width: 48, height: 40, right: 124, bottom: 300
        }),
        'btn-arrow-right': createMockElement('btn-arrow-right', ['dpad-btn', 'dpad-btn-steer'], {
            left: 134, top: 200, width: 56, height: 100, right: 190, bottom: 300
        }),
        'btn-action-jump': createMockElement('btn-action-jump', ['btn-game'], {
            left: 310, top: 200, width: 70, height: 44, right: 380, bottom: 244
        }),
        'btn-action-sprint': createMockElement('btn-action-sprint', ['btn-game'], {
            left: 236, top: 200, width: 68, height: 44, right: 304, bottom: 244
        }),
        'turbo-label': createMockElement('turbo-label'),
        'btn-action-interact': createMockElement('btn-action-interact', ['btn-game'], {
            left: 275, top: 256, width: 105, height: 44, right: 380, bottom: 300
        }),
        'btn-action-emote': createMockElement('btn-action-emote', ['btn-game'], {
            left: 234, top: 256, width: 36, height: 44, right: 270, bottom: 300
        }),
        'btn-car-gas': createMockElement('btn-car-gas', ['car-pedal', 'car-pedal-gas'], {
            left: 336, top: 190, width: 44, height: 110, right: 380, bottom: 300
        }),
        'btn-car-brake': createMockElement('btn-car-brake', ['car-pedal', 'car-pedal-brake'], {
            left: 266, top: 220, width: 60, height: 80, right: 326, bottom: 300
        }),
        'mobile-car-pedals': createMockElement('mobile-car-pedals', ['hidden'])
    };

    const allButtons = Object.values(mockElements);
    const windowListeners = {};

    globalThis.document = {
        documentElement: { style: { setProperty: () => {} } },
        activeElement: null,
        getElementById: (id) => mockElements[id] || null,
        querySelectorAll: (sel) => {
            if (sel.includes('.dpad-btn') || sel.includes('.car-pedal') || sel.includes('.touch-active')) {
                return allButtons.filter(b => b.classList.contains('touch-active'));
            }
            return [];
        },
        addEventListener: () => {},
        removeEventListener: () => {}
    };

    globalThis.window = {
        innerWidth: 390,
        innerHeight: 844,
        addEventListener: (ev, handler) => {
            windowListeners[ev] = windowListeners[ev] || [];
            windowListeners[ev].push(handler);
        },
        removeEventListener: (ev, handler) => {
            if (!windowListeners[ev]) return;
            windowListeners[ev] = windowListeners[ev].filter(h => h !== handler);
        },
        dispatchEvent: (evName, evObj = {}) => {
            if (windowListeners[evName]) {
                for (const h of windowListeners[evName]) h({
                    stopPropagation: () => {},
                    preventDefault: () => {},
                    cancelable: true,
                    ...evObj
                });
            }
        }
    };

    bindInputControls();
    return { mockElements, windowListeners };
}

describe('Mobile Controls - Directional Arrow Buttons (D-Pad)', () => {
    let originalDocument;
    let originalWindow;
    let mockElements;
    let windowListeners;

    beforeEach(() => {
        originalDocument = globalThis.document;
        originalWindow = globalThis.window;
        const res = setupMockDOM();
        mockElements = res.mockElements;
        windowListeners = res.windowListeners;
    });

    afterEach(() => {
        clearMovementInput();
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    });

    test('touching up arrow activates forward movement (key W) and applies touch-active class', () => {
        const zone = mockElements['touch-arrows-zone'];
        const upBtn = mockElements['btn-arrow-up'];

        // Up position: clientX: 100, clientY: 220
        zone.dispatchEvent('touchstart', {
            changedTouches: [{ identifier: 1, clientX: 100, clientY: 220 }]
        });

        expect(GAME_STATE.keys.w).toBe(true);
        expect(GAME_STATE.keys.s).toBe(false);
        expect(GAME_STATE.keys.a).toBe(false);
        expect(GAME_STATE.keys.d).toBe(false);
        expect(upBtn.classList.contains('touch-active')).toBe(true);

        zone.dispatchEvent('touchend', {
            changedTouches: [{ identifier: 1, clientX: 100, clientY: 220 }]
        });

        expect(GAME_STATE.keys.w).toBe(false);
        expect(upBtn.classList.contains('touch-active')).toBe(false);
    });

    test('touching down arrow activates backward movement (key S)', () => {
        const zone = mockElements['touch-arrows-zone'];
        const downBtn = mockElements['btn-arrow-down'];

        // Down position: clientX: 100, clientY: 280
        zone.dispatchEvent('touchstart', {
            changedTouches: [{ identifier: 2, clientX: 100, clientY: 280 }]
        });

        expect(GAME_STATE.keys.s).toBe(true);
        expect(GAME_STATE.keys.w).toBe(false);
        expect(downBtn.classList.contains('touch-active')).toBe(true);

        zone.dispatchEvent('touchend', {
            changedTouches: [{ identifier: 2, clientX: 100, clientY: 280 }]
        });

        expect(GAME_STATE.keys.s).toBe(false);
        expect(downBtn.classList.contains('touch-active')).toBe(false);
    });

    test('touching left arrow activates strafe/steer left (key A)', () => {
        const zone = mockElements['touch-arrows-zone'];
        const leftBtn = mockElements['btn-arrow-left'];

        // Left position: clientX: 35, clientY: 250
        zone.dispatchEvent('touchstart', {
            changedTouches: [{ identifier: 3, clientX: 35, clientY: 250 }]
        });

        expect(GAME_STATE.keys.a).toBe(true);
        expect(leftBtn.classList.contains('touch-active')).toBe(true);

        zone.dispatchEvent('touchend', {
            changedTouches: [{ identifier: 3, clientX: 35, clientY: 250 }]
        });

        expect(GAME_STATE.keys.a).toBe(false);
        expect(leftBtn.classList.contains('touch-active')).toBe(false);
    });

    test('touching right arrow activates strafe/steer right (key D)', () => {
        const zone = mockElements['touch-arrows-zone'];
        const rightBtn = mockElements['btn-arrow-right'];

        // Right position: clientX: 160, clientY: 250
        zone.dispatchEvent('touchstart', {
            changedTouches: [{ identifier: 4, clientX: 160, clientY: 250 }]
        });

        expect(GAME_STATE.keys.d).toBe(true);
        expect(rightBtn.classList.contains('touch-active')).toBe(true);

        zone.dispatchEvent('touchend', {
            changedTouches: [{ identifier: 4, clientX: 160, clientY: 250 }]
        });

        expect(GAME_STATE.keys.d).toBe(false);
        expect(rightBtn.classList.contains('touch-active')).toBe(false);
    });

    test('diagonal touch activates two directions simultaneously (Up + Left)', () => {
        const zone = mockElements['touch-arrows-zone'];
        const upBtn = mockElements['btn-arrow-up'];
        const leftBtn = mockElements['btn-arrow-left'];

        // Overlapping boundary between Up and Left: clientX: 70, clientY: 235
        zone.dispatchEvent('touchstart', {
            changedTouches: [{ identifier: 5, clientX: 70, clientY: 235 }]
        });

        expect(GAME_STATE.keys.w).toBe(true);
        expect(GAME_STATE.keys.a).toBe(true);
        expect(GAME_STATE.keys.s).toBe(false);
        expect(GAME_STATE.keys.d).toBe(false);
        expect(upBtn.classList.contains('touch-active')).toBe(true);
        expect(leftBtn.classList.contains('touch-active')).toBe(true);

        zone.dispatchEvent('touchend', {
            changedTouches: [{ identifier: 5, clientX: 70, clientY: 235 }]
        });

        expect(GAME_STATE.keys.w).toBe(false);
        expect(GAME_STATE.keys.a).toBe(false);
    });

    test('alternating rapidly between forward and left does NOT leave left button stuck', () => {
        const zone = mockElements['touch-arrows-zone'];
        const leftBtn = mockElements['btn-arrow-left'];
        const upBtn = mockElements['btn-arrow-up'];

        // 1. Press forward
        zone.dispatchEvent('touchstart', {
            changedTouches: [{ identifier: 8, clientX: 100, clientY: 220 }]
        });
        expect(GAME_STATE.keys.w).toBe(true);
        expect(GAME_STATE.keys.a).toBe(false);

        // 2. Slide or tap left
        zone.dispatchEvent('touchmove', {
            changedTouches: [{ identifier: 8, clientX: 35, clientY: 250 }]
        });
        expect(GAME_STATE.keys.a).toBe(true);
        expect(GAME_STATE.keys.w).toBe(false);

        // 3. Slide back to forward
        zone.dispatchEvent('touchmove', {
            changedTouches: [{ identifier: 8, clientX: 100, clientY: 220 }]
        });
        expect(GAME_STATE.keys.w).toBe(true);
        expect(GAME_STATE.keys.a).toBe(false);

        // 4. End touch completely
        zone.dispatchEvent('touchend', {
            changedTouches: [{ identifier: 8, clientX: 100, clientY: 220 }]
        });
        globalThis.window.dispatchEvent('touchend', { touches: [] });

        // CRITICAL CHECK: Character must NOT spin; key A and key W must both be false!
        expect(GAME_STATE.keys.a).toBe(false);
        expect(GAME_STATE.keys.w).toBe(false);
        expect(leftBtn.classList.contains('touch-active')).toBe(false);
        expect(upBtn.classList.contains('touch-active')).toBe(false);
    });

    test('reconcileActiveTouches clears all inputs when all fingers leave the screen', () => {
        const zone = mockElements['touch-arrows-zone'];
        const leftBtn = mockElements['btn-arrow-left'];

        zone.dispatchEvent('touchstart', {
            changedTouches: [{ identifier: 9, clientX: 35, clientY: 250 }]
        });
        expect(GAME_STATE.keys.a).toBe(true);

        // Global touchend with 0 touches remaining
        globalThis.window.dispatchEvent('touchend', { touches: [] });

        expect(GAME_STATE.keys.a).toBe(false);
        expect(leftBtn.classList.contains('touch-active')).toBe(false);
    });
});

describe('Mobile Controls - Turbo / Nitro Toggle', () => {
    let originalDocument;
    let originalWindow;
    let mockElements;

    beforeEach(() => {
        originalDocument = globalThis.document;
        originalWindow = globalThis.window;
        const res = setupMockDOM();
        mockElements = res.mockElements;
    });

    afterEach(() => {
        clearMovementInput();
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    });

    test('tapping turbo button toggles nitro/sprint ON and applies turbo-active styling', () => {
        const sprintBtn = mockElements['btn-action-sprint'];
        const turboLabel = mockElements['turbo-label'];

        expect(GAME_STATE.keys.shift).toBe(false);
        expect(isTurboActive()).toBe(false);

        // First tap: toggle ON
        sprintBtn.dispatchEvent('touchstart');
        expect(isTurboActive()).toBe(true);
        expect(GAME_STATE.keys.shift).toBe(true);
        expect(sprintBtn.classList.contains('turbo-active')).toBe(true);
        expect(sprintBtn.getAttribute('aria-pressed')).toBe('true');
        expect(turboLabel.textContent).toBe('Турбо: ВКЛ');

        // Second tap: toggle OFF
        sprintBtn.dispatchEvent('touchstart');
        expect(isTurboActive()).toBe(false);
        expect(GAME_STATE.keys.shift).toBe(false);
        expect(sprintBtn.classList.contains('turbo-active')).toBe(false);
        expect(sprintBtn.getAttribute('aria-pressed')).toBe('false');
        expect(turboLabel.textContent).toBe('Турбо');
    });

    test('driving with turbo toggled ON maintains nitro while gas pedal is pressed', () => {
        const sprintBtn = mockElements['btn-action-sprint'];
        const gasBtn = mockElements['btn-car-gas'];
        const zone = mockElements['touch-arrows-zone'];

        // 1. Toggle Turbo ON with right thumb
        sprintBtn.dispatchEvent('touchstart');
        expect(GAME_STATE.keys.shift).toBe(true);

        // 2. Right thumb presses gas pedal
        gasBtn.dispatchEvent('touchstart');
        expect(GAME_STATE.keys.w).toBe(true);
        expect(GAME_STATE.keys.shift).toBe(true); // Nitro MUST stay active!

        // 3. Left thumb steers right
        zone.dispatchEvent('touchstart', {
            changedTouches: [{ identifier: 15, clientX: 160, clientY: 250 }]
        });
        expect(GAME_STATE.keys.w).toBe(true);
        expect(GAME_STATE.keys.shift).toBe(true);
        expect(GAME_STATE.keys.d).toBe(true);

        // 4. Release steering and gas
        zone.dispatchEvent('touchend', {
            changedTouches: [{ identifier: 15, clientX: 160, clientY: 250 }]
        });
        gasBtn.dispatchEvent('touchend');

        expect(GAME_STATE.keys.w).toBe(false);
        expect(GAME_STATE.keys.d).toBe(false);
        expect(GAME_STATE.keys.shift).toBe(true); // Turbo remains toggled until tapped off

        // 5. Tap turbo again to toggle OFF
        sprintBtn.dispatchEvent('touchstart');
        expect(GAME_STATE.keys.shift).toBe(false);
    });

    test('clearMovementInput resets turbo toggle state', () => {
        setTurboToggle(true);
        expect(GAME_STATE.keys.shift).toBe(true);
        expect(isTurboActive()).toBe(true);

        clearMovementInput();
        expect(GAME_STATE.keys.shift).toBe(false);
        expect(isTurboActive()).toBe(false);
    });
});

describe('Mobile Controls - Car Pedals & Multi-Touch', () => {
    let originalDocument;
    let originalWindow;
    let mockElements;

    beforeEach(() => {
        originalDocument = globalThis.document;
        originalWindow = globalThis.window;
        const res = setupMockDOM();
        mockElements = res.mockElements;
    });

    afterEach(() => {
        clearMovementInput();
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    });

    test('holding gas pedal while pressing left then right maintains gas engagement continuously', () => {
        const gasBtn = mockElements['btn-car-gas'];
        const leftBtn = mockElements['btn-arrow-left'];
        const rightBtn = mockElements['btn-arrow-right'];
        const zone = mockElements['touch-arrows-zone'];

        // 1. Hold gas pedal down with right thumb
        gasBtn.dispatchEvent('touchstart');
        expect(GAME_STATE.keys.w).toBe(true);
        expect(gasBtn.classList.contains('touch-active')).toBe(true);

        // 2. Press left arrow with left thumb
        zone.dispatchEvent('touchstart', {
            changedTouches: [{ identifier: 10, clientX: 35, clientY: 250 }]
        });
        expect(GAME_STATE.keys.w).toBe(true);
        expect(GAME_STATE.keys.a).toBe(true);
        expect(GAME_STATE.keys.d).toBe(false);

        // 3. Move to right arrow
        zone.dispatchEvent('touchmove', {
            changedTouches: [{ identifier: 10, clientX: 160, clientY: 250 }]
        });
        expect(GAME_STATE.keys.w).toBe(true);
        expect(GAME_STATE.keys.a).toBe(false);
        expect(GAME_STATE.keys.d).toBe(true);

        // 4. Release steering arrow
        zone.dispatchEvent('touchend', {
            changedTouches: [{ identifier: 10, clientX: 160, clientY: 250 }]
        });
        expect(GAME_STATE.keys.w).toBe(true);
        expect(GAME_STATE.keys.d).toBe(false);

        // 5. Release gas pedal
        gasBtn.dispatchEvent('touchend');
        expect(GAME_STATE.keys.w).toBe(false);
    });
});

describe('HTML Structure & Layout Separation Verification', () => {
    test('Jump button and D-pad are separated and cleanly laid out in static/index.html', () => {
        const html = readFileSync(resolve(import.meta.dir, '../index.html'), 'utf-8');

        // Virtual joystick zone should be completely removed
        expect(html.includes('id="touch-joystick-zone"')).toBe(false);
        expect(html.includes('id="joystick-knob"')).toBe(false);

        // Arrow buttons container present
        expect(html.includes('id="touch-arrows-zone"')).toBe(true);
        expect(html.includes('id="btn-arrow-up"')).toBe(true);
        expect(html.includes('id="btn-arrow-down"')).toBe(true);
        expect(html.includes('id="btn-arrow-left"')).toBe(true);
        expect(html.includes('id="btn-arrow-right"')).toBe(true);

        // Jump button is placed in the upper action row with sprint, NOT in the bottom row
        const sprintIndex = html.indexOf('id="btn-action-sprint"');
        const jumpIndex = html.indexOf('id="btn-action-jump"');
        const interactIndex = html.indexOf('id="btn-action-interact"');

        expect(jumpIndex).toBeGreaterThan(0);
        expect(sprintIndex).toBeGreaterThan(0);
        expect(interactIndex).toBeGreaterThan(jumpIndex); // Jump precedes Interact in DOM hierarchy (upper row)

        // Turbo toggle attributes
        expect(html.includes('aria-pressed="false"')).toBe(true);
        expect(html.includes('id="turbo-icon"')).toBe(true);
        expect(html.includes('id="turbo-label"')).toBe(true);

        // Pedals container and order
        expect(html.includes('id="mobile-car-pedals"')).toBe(true);
        const brakeIndex = html.indexOf('id="btn-car-brake"');
        const gasIndex = html.indexOf('id="btn-car-gas"');
        expect(brakeIndex).toBeGreaterThan(0);
        expect(gasIndex).toBeGreaterThan(brakeIndex);
    });
});
