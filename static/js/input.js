import { GAME_STATE, isGameplayInputSuspended } from './state.js';
import { SoundManager } from './audio.js';
import { World } from './world.js';
import { Player, Dunya, toggleVehicleDrive } from './entities.js';
import { MultiplayerClient, showChatBox, hideChatBox } from './network.js';
import { showToast, closeNpcDialogue, dismissInteractionPrompt } from './ui.js';

export function triggerCurrentInteraction() {
    if (isGameplayInputSuspended()) return;
    dismissInteractionPrompt();
    if (GAME_STATE.inVehicle) {
        toggleVehicleDrive(GAME_STATE.inVehicle, (force) => MultiplayerClient.sendMoveSnapshot(force));
    } else if (GAME_STATE.nearestInteractable) {
        GAME_STATE.nearestInteractable.onInteract();
    } else {
        Player.emote(MultiplayerClient);
    }
}

export const inputSources = {
    keyboard: { w: false, a: false, s: false, d: false, shift: false, space: false },
    dpad: { w: false, a: false, s: false, d: false },
    pedals: { gas: false, brake: false },
    touchButtons: { shift: false, space: false }
};

let isTurboToggled = false;

export function setTurboToggle(active) {
    isTurboToggled = Boolean(active);
    inputSources.touchButtons.shift = isTurboToggled;
    syncGameStateKeys();
    if (typeof document !== 'undefined') {
        const btn = document.getElementById('btn-action-sprint');
        if (btn) {
            btn.classList.toggle('turbo-active', isTurboToggled);
            btn.setAttribute('aria-pressed', isTurboToggled ? 'true' : 'false');
            const label = document.getElementById('turbo-label');
            if (label) {
                label.textContent = isTurboToggled ? 'Турбо: ВКЛ' : 'Турбо';
            }
        }
    }
}

export function isTurboActive() {
    return isTurboToggled;
}

export function syncGameStateKeys() {
    GAME_STATE.keys.w = Boolean(inputSources.keyboard.w || inputSources.dpad.w || inputSources.pedals.gas);
    GAME_STATE.keys.s = Boolean(inputSources.keyboard.s || inputSources.dpad.s || inputSources.pedals.brake);
    GAME_STATE.keys.a = Boolean(inputSources.keyboard.a || inputSources.dpad.a);
    GAME_STATE.keys.d = Boolean(inputSources.keyboard.d || inputSources.dpad.d);
    GAME_STATE.keys.shift = Boolean(inputSources.keyboard.shift || inputSources.touchButtons.shift);
    GAME_STATE.keys.space = Boolean(inputSources.keyboard.space || inputSources.touchButtons.space);
}

let dpadResetFn = null;

let activeBrakeKeys = new Set();
const HANDBRAKE_CODES = ['Space', 'ControlRight', 'ControlLeft', 'Numpad0', 'KeyB'];
const PREVENTED_GAMEPLAY_CODES = [
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Space', 'ControlRight', 'Numpad0', 'KeyB'
];

export function clearMovementInput() {
    activeBrakeKeys.clear();
    inputSources.keyboard.w = false;
    inputSources.keyboard.a = false;
    inputSources.keyboard.s = false;
    inputSources.keyboard.d = false;
    inputSources.keyboard.shift = false;
    inputSources.keyboard.space = false;
    inputSources.dpad.w = false;
    inputSources.dpad.a = false;
    inputSources.dpad.s = false;
    inputSources.dpad.d = false;
    inputSources.pedals.gas = false;
    inputSources.pedals.brake = false;
    inputSources.touchButtons.shift = false;
    inputSources.touchButtons.space = false;
    setTurboToggle(false);
    GAME_STATE.keys.w = false;
    GAME_STATE.keys.a = false;
    GAME_STATE.keys.s = false;
    GAME_STATE.keys.d = false;
    GAME_STATE.keys.shift = false;
    GAME_STATE.keys.space = false;
    GAME_STATE.joystickVector.x = 0;
    GAME_STATE.joystickVector.y = 0;
    GAME_STATE.joystickSprint = false;
    if (typeof dpadResetFn === 'function') {
        dpadResetFn();
    }
    if (typeof document !== 'undefined') {
        const activeTouchEls = document.querySelectorAll('.dpad-btn.touch-active, .car-pedal.touch-active, .touch-active');
        activeTouchEls.forEach(el => el.classList.remove('touch-active'));
    }
}

export function bindInputControls(worldMap = {}) {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const canvas = document.getElementById('three-canvas');

    const unlockAudio = () => {
        SoundManager.ensureInit();
        if (SoundManager.ctx && SoundManager.ctx.state === 'running') {
            window.removeEventListener('mousedown', unlockAudio);
            window.removeEventListener('keydown', unlockAudio);
            window.removeEventListener('touchstart', unlockAudio);
            window.removeEventListener('touchend', unlockAudio);
            window.removeEventListener('pointerup', unlockAudio);
            window.removeEventListener('click', unlockAudio);
        }
    };
    window.addEventListener('mousedown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
    window.addEventListener('touchstart', unlockAudio, { passive: true });
    window.addEventListener('touchend', unlockAudio, { passive: true });
    window.addEventListener('pointerup', unlockAudio, { passive: true });
    window.addEventListener('click', unlockAudio, { passive: true });

    const questBody = document.getElementById('quest-details-body');
    const questIcon = document.getElementById('quest-toggle-icon');
    const syncQuestCollapse = () => {
        if (!questBody || !questIcon) return;
        if (GAME_STATE.questCollapsed && window.innerWidth < 640) {
            questBody.classList.add('hidden');
            questIcon.className = 'fa-solid fa-chevron-down';
        } else {
            questBody.classList.remove('hidden');
            questIcon.className = 'fa-solid fa-chevron-up';
        }
    };
    syncQuestCollapse();
    const btnToggleQuest = document.getElementById('btn-toggle-quest');
    if (btnToggleQuest) {
        btnToggleQuest.addEventListener('click', (e) => {
            e.stopPropagation();
            GAME_STATE.questCollapsed = !GAME_STATE.questCollapsed;
            syncQuestCollapse();
        });
    }

    const handleCycleCamera = () => {
        World.cycleCameraMode();
        if (Player.group) Player.group.visible = true;
    };

    const handleToggleHeadlights = () => {
        World.toggleCarHeadlights();
        MultiplayerClient.sendMoveSnapshot(true);
    };

    window.addEventListener('focusin', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
            clearMovementInput();
        }
    });

    const handleLoseFocus = () => {
        clearMovementInput();
        GAME_STATE.isDraggingCamera = false;
        if (typeof document !== 'undefined' && document.pointerLockElement && typeof document.exitPointerLock === 'function') {
            document.exitPointerLock();
        }
    };
    window.addEventListener('blur', handleLoseFocus);
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                handleLoseFocus();
            }
        });
    }

    window.addEventListener('keydown', (e) => {
        const helpModal = document.getElementById('help-modal');
        if (isGameplayInputSuspended()) {
            clearMovementInput();
            if (e.code === 'Escape') {
                if (helpModal && !helpModal.classList.contains('hidden')) {
                    helpModal.classList.add('hidden');
                    return;
                }
                const chatInput = document.getElementById('mp-chat-input');
                if (chatInput && document.activeElement === chatInput) {
                    e.preventDefault();
                    hideChatBox();
                    return;
                }
                if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
                    document.activeElement.blur();
                }
                closeNpcDialogue();
                return;
            }
            if (GAME_STATE.activeNpcChat) {
                if (e.repeat) return;
                if (e.code === 'Digit1' || e.code === 'Numpad1') {
                    const btns = document.querySelectorAll('#npc-options-container button');
                    if (btns[0]) btns[0].click();
                } else if (e.code === 'Digit2' || e.code === 'Numpad2') {
                    const btns = document.querySelectorAll('#npc-options-container button');
                    if (btns[1]) btns[1].click();
                } else if (e.code === 'Digit3' || e.code === 'Numpad3') {
                    const btns = document.querySelectorAll('#npc-options-container button');
                    if (btns[2]) btns[2].click();
                } else if (e.code === 'Digit4' || e.code === 'Numpad4') {
                    const btns = document.querySelectorAll('#npc-options-container button');
                    if (btns[3]) btns[3].click();
                }
            }
            return;
        }
        if (!GAME_STATE.isConnected) return;

        if (e.code === 'Enter' || e.code === 'KeyC') {
            e.preventDefault();
            clearMovementInput();
            showChatBox(true);
            return;
        }

        const code = e.code;
        if (PREVENTED_GAMEPLAY_CODES.includes(code)) {
            e.preventDefault();
        }
        if (code === 'KeyW' || code === 'ArrowUp') inputSources.keyboard.w = true;
        if (code === 'KeyS' || code === 'ArrowDown') inputSources.keyboard.s = true;
        if (code === 'KeyA' || code === 'ArrowLeft') inputSources.keyboard.a = true;
        if (code === 'KeyD' || code === 'ArrowRight') inputSources.keyboard.d = true;
        if (code === 'ShiftLeft' || code === 'ShiftRight') inputSources.keyboard.shift = true;
        if (HANDBRAKE_CODES.includes(code)) {
            activeBrakeKeys.add(code);
            inputSources.keyboard.space = true;
            syncGameStateKeys();
            Player.jump(MultiplayerClient);
        } else {
            syncGameStateKeys();
        }
        if (code === 'KeyE') {
            if (e.repeat) return;
            triggerCurrentInteraction();
        }
        if (code === 'KeyF') Player.emote(MultiplayerClient);
        if (code === 'KeyV') handleCycleCamera();
        if (code === 'KeyH') handleToggleHeadlights();
    });

    window.addEventListener('keyup', (e) => {
        const code = e.code;
        if (PREVENTED_GAMEPLAY_CODES.includes(code)) {
            e.preventDefault();
        }
        if (code === 'KeyW' || code === 'ArrowUp') inputSources.keyboard.w = false;
        if (code === 'KeyS' || code === 'ArrowDown') inputSources.keyboard.s = false;
        if (code === 'KeyA' || code === 'ArrowLeft') inputSources.keyboard.a = false;
        if (code === 'KeyD' || code === 'ArrowRight') inputSources.keyboard.d = false;
        if (code === 'ShiftLeft' || code === 'ShiftRight') inputSources.keyboard.shift = false;
        if (HANDBRAKE_CODES.includes(code)) {
            activeBrakeKeys.delete(code);
            inputSources.keyboard.space = activeBrakeKeys.size > 0;
            syncGameStateKeys();
        } else {
            syncGameStateKeys();
        }
    });

    if (canvas) {
        const requestLock = () => {
            if (canvas.requestPointerLock) {
                canvas.requestPointerLock();
            }
        };

        const btnLock = document.getElementById('btn-pointer-lock');
        if (btnLock) btnLock.addEventListener('click', requestLock);

        canvas.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
                GAME_STATE.isDraggingCamera = true;
            }
        });
        window.addEventListener('mouseup', () => {
            GAME_STATE.isDraggingCamera = false;
        });

        document.addEventListener('pointerlockchange', () => {
            GAME_STATE.pointerLocked = (document.pointerLockElement === canvas);
            const btnText = document.getElementById('pointer-lock-text');
            if (btnText) {
                btnText.textContent = GAME_STATE.pointerLocked ? 'Мышь захвачена (ESC — выход)' : 'Захват мыши (GTA Камера)';
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (GAME_STATE.pointerLocked || GAME_STATE.isDraggingCamera) {
                GAME_STATE.lastMouseMoveTime = performance.now();
                const sensitivity = 0.0032;
                GAME_STATE.cameraYaw -= e.movementX * sensitivity;
                GAME_STATE.cameraPitch = Math.max(0.08, Math.min(1.18, GAME_STATE.cameraPitch + e.movementY * sensitivity));
            }
        });

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            GAME_STATE.cameraDistance = Math.max(4.2, Math.min(16, GAME_STATE.cameraDistance + e.deltaY * 0.006));
        }, { passive: false });

        let cameraTouchId = null;
        let lastTouchX = 0;
        let lastTouchY = 0;

        canvas.addEventListener('touchstart', (e) => {
            if (cameraTouchId !== null) return;
            for (let i = 0; i < e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                cameraTouchId = t.identifier;
                lastTouchX = t.clientX;
                lastTouchY = t.clientY;
                GAME_STATE.lastMouseMoveTime = performance.now();
                break;
            }
        }, { passive: true });

        canvas.addEventListener('touchmove', (e) => {
            if (cameraTouchId === null) return;
            for (let i = 0; i < e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                if (t.identifier === cameraTouchId) {
                    GAME_STATE.lastMouseMoveTime = performance.now();
                    const dx = t.clientX - lastTouchX;
                    const dy = t.clientY - lastTouchY;
                    lastTouchX = t.clientX;
                    lastTouchY = t.clientY;
                    GAME_STATE.cameraYaw -= dx * 0.0055;
                    GAME_STATE.cameraPitch = Math.max(0.08, Math.min(1.15, GAME_STATE.cameraPitch + dy * 0.0055));
                    break;
                }
            }
        }, { passive: true });

        const releaseCameraTouch = (e) => {
            if (cameraTouchId === null) return;
            for (let i = 0; i < e.changedTouches.length; i++) {
                if (e.changedTouches[i].identifier === cameraTouchId) {
                    cameraTouchId = null;
                    break;
                }
            }
        };
        const handleCameraTouchEnd = (e) => {
            SoundManager.ensureInit();
            releaseCameraTouch(e);
        };
        canvas.addEventListener('touchend', handleCameraTouchEnd, { passive: true });
        canvas.addEventListener('touchcancel', releaseCameraTouch, { passive: true });
    }

    const arrowsZone = document.getElementById('touch-arrows-zone');
    const btnUp = document.getElementById('btn-arrow-up');
    const btnDown = document.getElementById('btn-arrow-down');
    const btnLeft = document.getElementById('btn-arrow-left');
    const btnRight = document.getElementById('btn-arrow-right');

    if (arrowsZone) {
        const touchMap = new Map();
        const mouseActive = new Set();

        const updateDpadState = () => {
            if (isGameplayInputSuspended()) {
                touchMap.clear();
                mouseActive.clear();
                inputSources.dpad.w = false;
                inputSources.dpad.s = false;
                inputSources.dpad.a = false;
                inputSources.dpad.d = false;
                syncGameStateKeys();
                btnUp?.classList.remove('touch-active');
                btnDown?.classList.remove('touch-active');
                btnLeft?.classList.remove('touch-active');
                btnRight?.classList.remove('touch-active');
                return;
            }

            const activeDirs = new Set(mouseActive);
            for (const dirs of touchMap.values()) {
                for (const d of dirs) activeDirs.add(d);
            }

            const isUp = activeDirs.has('up');
            const isDown = activeDirs.has('down');
            const isLeft = activeDirs.has('left');
            const isRight = activeDirs.has('right');

            inputSources.dpad.w = isUp;
            inputSources.dpad.s = isDown;
            inputSources.dpad.a = isLeft;
            inputSources.dpad.d = isRight;
            syncGameStateKeys();

            btnUp?.classList.toggle('touch-active', isUp);
            btnDown?.classList.toggle('touch-active', isDown);
            btnLeft?.classList.toggle('touch-active', isLeft);
            btnRight?.classList.toggle('touch-active', isRight);
        };

        dpadResetFn = () => {
            touchMap.clear();
            mouseActive.clear();
            inputSources.dpad.w = false;
            inputSources.dpad.s = false;
            inputSources.dpad.a = false;
            inputSources.dpad.d = false;
            btnUp?.classList.remove('touch-active');
            btnDown?.classList.remove('touch-active');
            btnLeft?.classList.remove('touch-active');
            btnRight?.classList.remove('touch-active');
        };

        const getDirectionsForTouch = (touch) => {
            const dirs = new Set();
            if (!arrowsZone) return dirs;
            const rect = arrowsZone.getBoundingClientRect();
            if (touch.clientX < rect.left - 20 || touch.clientX > rect.right + 20 ||
                touch.clientY < rect.top - 20 || touch.clientY > rect.bottom + 20) {
                return dirs;
            }

            const inBox = (el, x, y, margin = 8) => {
                if (!el || typeof el.getBoundingClientRect !== 'function') return false;
                const r = el.getBoundingClientRect();
                return x >= r.left - margin && x <= r.right + margin &&
                       y >= r.top - margin && y <= r.bottom + margin;
            };

            if (inBox(btnLeft, touch.clientX, touch.clientY)) dirs.add('left');
            if (inBox(btnRight, touch.clientX, touch.clientY)) dirs.add('right');
            if (inBox(btnUp, touch.clientX, touch.clientY)) dirs.add('up');
            if (inBox(btnDown, touch.clientX, touch.clientY)) dirs.add('down');

            if (dirs.size === 0 && rect.width > 0 && rect.height > 0) {
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const dx = touch.clientX - cx;
                const dy = touch.clientY - cy;

                if (dx < -rect.width * 0.15) dirs.add('left');
                else if (dx > rect.width * 0.15) dirs.add('right');

                if (dy < -rect.height * 0.15) dirs.add('up');
                else if (dy > rect.height * 0.15) dirs.add('down');
            }

            return dirs;
        };

        let lastDpadTouchTime = 0;

        arrowsZone.addEventListener('touchstart', (e) => {
            lastDpadTouchTime = performance.now();
            if (isGameplayInputSuspended()) return;
            e.stopPropagation();
            if (e.cancelable) e.preventDefault();
            SoundManager.ensureInit();
            for (let i = 0; i < e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                touchMap.set(t.identifier, getDirectionsForTouch(t));
            }
            updateDpadState();
        }, { passive: false });

        arrowsZone.addEventListener('touchmove', (e) => {
            lastDpadTouchTime = performance.now();
            if (isGameplayInputSuspended()) return;
            e.stopPropagation();
            if (e.cancelable) e.preventDefault();
            for (let i = 0; i < e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                touchMap.set(t.identifier, getDirectionsForTouch(t));
            }
            updateDpadState();
        }, { passive: false });

        const endArrowTouch = (e) => {
            lastDpadTouchTime = performance.now();
            e.stopPropagation();
            SoundManager.ensureInit();
            for (let i = 0; i < e.changedTouches.length; i++) {
                touchMap.delete(e.changedTouches[i].identifier);
            }
            updateDpadState();
        };

        arrowsZone.addEventListener('touchend', endArrowTouch, { passive: true });
        arrowsZone.addEventListener('touchcancel', endArrowTouch, { passive: true });

        // Global touch reconciliation so no finger ID or directional key can EVER be stuck
        const reconcileActiveTouches = (e) => {
            lastDpadTouchTime = performance.now();
            if (!e.touches || e.touches.length === 0) {
                touchMap.clear();
                mouseActive.clear();
                inputSources.dpad.w = false;
                inputSources.dpad.s = false;
                inputSources.dpad.a = false;
                inputSources.dpad.d = false;
                inputSources.pedals.gas = false;
                inputSources.pedals.brake = false;
                inputSources.touchButtons.space = false;
                syncGameStateKeys();
                btnUp?.classList.remove('touch-active');
                btnDown?.classList.remove('touch-active');
                btnLeft?.classList.remove('touch-active');
                btnRight?.classList.remove('touch-active');
                document.getElementById('btn-car-gas')?.classList.remove('touch-active');
                document.getElementById('btn-car-brake')?.classList.remove('touch-active');
                document.getElementById('btn-action-jump')?.classList.remove('touch-active');
                return;
            }
            const liveIds = new Set();
            for (let i = 0; i < e.touches.length; i++) {
                liveIds.add(e.touches[i].identifier);
            }
            let changed = false;
            for (const id of touchMap.keys()) {
                if (!liveIds.has(id)) {
                    touchMap.delete(id);
                    changed = true;
                }
            }
            if (changed) {
                updateDpadState();
            }
        };

        window.addEventListener('touchend', reconcileActiveTouches, { passive: true });
        window.addEventListener('touchcancel', reconcileActiveTouches, { passive: true });

        const bindMouseButton = (btn, dir) => {
            if (!btn) return;
            btn.addEventListener('mousedown', (e) => {
                // Ignore synthetic mouse events generated from touch
                if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return;
                if (performance.now() - lastDpadTouchTime < 600) return;
                if (isGameplayInputSuspended()) return;
                e.stopPropagation();
                SoundManager.ensureInit();
                mouseActive.add(dir);
                updateDpadState();
            });
            const handleMouseRelease = (e) => {
                e.stopPropagation();
                SoundManager.ensureInit();
                mouseActive.delete(dir);
                updateDpadState();
            };
            btn.addEventListener('mouseup', handleMouseRelease);
            btn.addEventListener('mouseleave', handleMouseRelease);
        };

        window.addEventListener('mouseup', () => {
            if (mouseActive.size > 0) {
                mouseActive.clear();
                updateDpadState();
            }
        });

        bindMouseButton(btnUp, 'up');
        bindMouseButton(btnDown, 'down');
        bindMouseButton(btnLeft, 'left');
        bindMouseButton(btnRight, 'right');
    }

    const bindHoldButton = (btnId, onDown, onUp) => {
        const el = document.getElementById(btnId);
        if (!el) return;
        const handleDown = (e) => {
            if (isGameplayInputSuspended()) return;
            e.stopPropagation();
            if (e.cancelable) e.preventDefault();
            SoundManager.ensureInit();
            el.classList.add('touch-active');
            onDown();
        };
        const handleUp = (e) => {
            e.stopPropagation();
            SoundManager.ensureInit();
            el.classList.remove('touch-active');
            onUp();
        };
        el.addEventListener('touchstart', handleDown, { passive: false });
        el.addEventListener('touchend', handleUp, { passive: true });
        el.addEventListener('touchcancel', handleUp, { passive: true });
        el.addEventListener('mousedown', handleDown);
        el.addEventListener('mouseup', handleUp);
        el.addEventListener('mouseleave', handleUp);
    };

    bindHoldButton(
        'btn-action-jump',
        () => {
            inputSources.touchButtons.space = true;
            syncGameStateKeys();
            Player.jump(MultiplayerClient);
        },
        () => {
            inputSources.touchButtons.space = false;
            syncGameStateKeys();
        }
    );

    // Nitro / Turbo toggle button for mobile mode (tap to toggle ON/OFF)
    const btnSprint = document.getElementById('btn-action-sprint');
    if (btnSprint) {
        let lastSprintTouch = 0;
        btnSprint.addEventListener('touchstart', (e) => {
            if (isGameplayInputSuspended()) return;
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();
            lastSprintTouch = performance.now();
            SoundManager.ensureInit();
            setTurboToggle(!isTurboToggled);
        }, { passive: false });

        btnSprint.addEventListener('click', (e) => {
            if (isGameplayInputSuspended()) return;
            if (performance.now() - lastSprintTouch < 500) return;
            e.stopPropagation();
            SoundManager.ensureInit();
            setTurboToggle(!isTurboToggled);
        });
    }

    bindHoldButton(
        'btn-car-gas',
        () => {
            inputSources.pedals.gas = true;
            syncGameStateKeys();
        },
        () => {
            inputSources.pedals.gas = false;
            syncGameStateKeys();
        }
    );
    bindHoldButton(
        'btn-car-brake',
        () => {
            inputSources.pedals.brake = true;
            syncGameStateKeys();
        },
        () => {
            inputSources.pedals.brake = false;
            syncGameStateKeys();
        }
    );

    const btnCam = document.getElementById('btn-cam-mode');
    if (btnCam) {
        btnCam.addEventListener('click', () => {
            if (isGameplayInputSuspended()) return;
            handleCycleCamera();
        });
    }

    const btnPet = document.getElementById('btn-pet-toggle');
    const syncPetButton = (petType) => {
        const iconEl = document.getElementById('pet-toggle-icon');
        const labelEl = document.getElementById('pet-toggle-label');
        if (btnPet) {
            const isCat = petType === 'cat';
            if (iconEl) iconEl.textContent = isCat ? '🐱' : '🐶';
            if (labelEl) labelEl.textContent = isCat ? 'Берик' : 'Дуня';
            btnPet.title = isCat
                ? 'Питомец: кот Берик (нажми, чтобы выбрать болонку Дуню)'
                : 'Питомец: болонка Дуня (нажми, чтобы выбрать кота Берика)';
        }
    };
    syncPetButton(GAME_STATE.petType);

    if (btnPet) {
        btnPet.addEventListener('click', (e) => {
            e.stopPropagation();
            const nextType = GAME_STATE.petType === 'cat' ? 'dog' : 'cat';
            GAME_STATE.petType = nextType;
            if (typeof localStorage !== 'undefined') {
                try {
                    localStorage.setItem('nabka_pet_type', nextType);
                } catch (err) {}
            }
            Dunya.setPetType(nextType);
            syncPetButton(nextType);
            showToast(nextType === 'cat' ? '🐾 Твой спутник: кот Берик!' : '🐾 Твой спутник: болонка Дуня!');
        });
    }

    const btnEmote = document.getElementById('btn-action-emote');
    if (btnEmote) {
        btnEmote.addEventListener('click', () => {
            if (isGameplayInputSuspended()) return;
            Player.emote(MultiplayerClient);
        });
    }

    const btnInteract = document.getElementById('btn-action-interact');
    if (btnInteract) {
        btnInteract.addEventListener('click', () => {
            if (isGameplayInputSuspended()) return;
            triggerCurrentInteraction();
        });
    }

    const btnInteractTrigger = document.getElementById('btn-interact-trigger');
    if (btnInteractTrigger) {
        btnInteractTrigger.addEventListener('click', () => {
            if (isGameplayInputSuspended()) return;
            triggerCurrentInteraction();
        });
    }

    const btnHeadlightsMobile = document.getElementById('btn-headlights-mobile');
    if (btnHeadlightsMobile) {
        btnHeadlightsMobile.addEventListener('click', () => {
            if (isGameplayInputSuspended()) return;
            handleToggleHeadlights();
        });
    }

    const btnCloseNpc = document.getElementById('btn-close-npc-chat');
    if (btnCloseNpc) btnCloseNpc.addEventListener('click', closeNpcDialogue);

    const helpModal = document.getElementById('help-modal');
    const btnHelp = document.getElementById('btn-help');
    const btnCloseHelp = document.getElementById('btn-close-help');
    const btnStartPlay = document.getElementById('btn-start-play');
    if (helpModal) {
        if (btnHelp) {
            btnHelp.addEventListener('click', () => {
                clearMovementInput();
                helpModal.classList.remove('hidden');
            });
        }
        if (btnCloseHelp) {
            btnCloseHelp.addEventListener('click', () => {
                clearMovementInput();
                helpModal.classList.add('hidden');
            });
        }
        if (btnStartPlay) {
            btnStartPlay.addEventListener('click', () => {
                clearMovementInput();
                helpModal.classList.add('hidden');
            });
        }
    }

    const updateAppViewportHeight = () => {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        document.documentElement.style.setProperty('--app-height', `${vh}px`);
    };

    const handleViewportResize = () => {
        updateAppViewportHeight();
        const container = document.getElementById('game-canvas-container');
        if (!container || !World.renderer || !World.camera) return;
        World.camera.aspect = container.clientWidth / Math.max(1, container.clientHeight);
        World.camera.updateProjectionMatrix();
        World.renderer.setSize(container.clientWidth, container.clientHeight);
        syncQuestCollapse();
    };
    updateAppViewportHeight();
    window.addEventListener('resize', handleViewportResize);
    if (typeof window !== 'undefined' && window.visualViewport) {
        window.visualViewport.addEventListener('resize', handleViewportResize);
    }
    window.addEventListener('orientationchange', () => {
        setTimeout(handleViewportResize, 150);
    });
}
