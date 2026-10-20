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

export function clearMovementInput() {
    GAME_STATE.keys.w = false;
    GAME_STATE.keys.a = false;
    GAME_STATE.keys.s = false;
    GAME_STATE.keys.d = false;
    GAME_STATE.keys.shift = false;
    GAME_STATE.keys.space = false;
    GAME_STATE.joystickVector.x = 0;
    GAME_STATE.joystickVector.y = 0;
    GAME_STATE.joystickSprint = false;
}

export function bindInputControls(worldMap = {}) {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const canvas = document.getElementById('three-canvas');

    const unlockAudioOnce = () => {
        SoundManager.ensureInit();
    };
    window.addEventListener('mousedown', unlockAudioOnce, { once: true });
    window.addEventListener('keydown', unlockAudioOnce, { once: true });
    window.addEventListener('touchstart', unlockAudioOnce, { once: true, passive: true });
    window.addEventListener('touchend', unlockAudioOnce, { once: true, passive: true });

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
                if (e.code === 'Digit1' || e.code === 'Numpad1') {
                    const btns = document.querySelectorAll('#npc-options-container button');
                    if (btns[0]) btns[0].click();
                } else if (e.code === 'Digit2' || e.code === 'Numpad2') {
                    const btns = document.querySelectorAll('#npc-options-container button');
                    if (btns[1]) btns[1].click();
                } else if (e.code === 'Digit3' || e.code === 'Numpad3') {
                    const btns = document.querySelectorAll('#npc-options-container button');
                    if (btns[2]) btns[2].click();
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
        if (code === 'KeyW' || code === 'ArrowUp') GAME_STATE.keys.w = true;
        if (code === 'KeyS' || code === 'ArrowDown') GAME_STATE.keys.s = true;
        if (code === 'KeyA' || code === 'ArrowLeft') GAME_STATE.keys.a = true;
        if (code === 'KeyD' || code === 'ArrowRight') GAME_STATE.keys.d = true;
        if (code === 'ShiftLeft' || code === 'ShiftRight') GAME_STATE.keys.shift = true;
        if (code === 'Space') {
            GAME_STATE.keys.space = true;
            Player.jump(MultiplayerClient);
        }
        if (code === 'KeyE') triggerCurrentInteraction();
        if (code === 'KeyF') Player.emote(MultiplayerClient);
        if (code === 'KeyV') handleCycleCamera();
        if (code === 'KeyH') handleToggleHeadlights();
    });

    window.addEventListener('keyup', (e) => {
        const code = e.code;
        if (code === 'KeyW' || code === 'ArrowUp') GAME_STATE.keys.w = false;
        if (code === 'KeyS' || code === 'ArrowDown') GAME_STATE.keys.s = false;
        if (code === 'KeyA' || code === 'ArrowLeft') GAME_STATE.keys.a = false;
        if (code === 'KeyD' || code === 'ArrowRight') GAME_STATE.keys.d = false;
        if (code === 'ShiftLeft' || code === 'ShiftRight') GAME_STATE.keys.shift = false;
        if (code === 'Space') GAME_STATE.keys.space = false;
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
        canvas.addEventListener('touchend', releaseCameraTouch, { passive: true });
        canvas.addEventListener('touchcancel', releaseCameraTouch, { passive: true });
    }

    const joyZone = document.getElementById('touch-joystick-zone');
    const joyKnob = document.getElementById('joystick-knob');
    if (joyZone && joyKnob) {
        let joystickTouchId = null;

        const updateJoystickFromTouch = (touch) => {
            const rect = joyZone.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const maxR = rect.width / 2 - 14;
            let dx = touch.clientX - cx;
            let dy = touch.clientY - cy;
            const dist = Math.hypot(dx, dy);
            const clampedDist = Math.min(dist, maxR);
            if (dist > 0.001) {
                dx = (dx / dist) * clampedDist;
                dy = (dy / dist) * clampedDist;
            }
            joyKnob.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
            GAME_STATE.joystickVector.x = dx / maxR;
            GAME_STATE.joystickVector.y = dy / maxR;
            GAME_STATE.joystickSprint = (clampedDist / maxR) > 0.85;
        };

        const resetJoystick = () => {
            joystickTouchId = null;
            joyKnob.style.transform = 'translate3d(0px, 0px, 0)';
            GAME_STATE.joystickVector.x = 0;
            GAME_STATE.joystickVector.y = 0;
            GAME_STATE.joystickSprint = false;
        };

        joyZone.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            e.preventDefault();
            SoundManager.ensureInit();
            if (joystickTouchId === null && e.changedTouches.length > 0) {
                const t = e.changedTouches[0];
                joystickTouchId = t.identifier;
                updateJoystickFromTouch(t);
            }
        }, { passive: false });

        joyZone.addEventListener('touchmove', (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (joystickTouchId === null) return;
            for (let i = 0; i < e.changedTouches.length; i++) {
                if (e.changedTouches[i].identifier === joystickTouchId) {
                    updateJoystickFromTouch(e.changedTouches[i]);
                    break;
                }
            }
        }, { passive: false });

        const endJoystickTouch = (e) => {
            e.stopPropagation();
            if (joystickTouchId === null) return;
            for (let i = 0; i < e.changedTouches.length; i++) {
                if (e.changedTouches[i].identifier === joystickTouchId) {
                    resetJoystick();
                    break;
                }
            }
        };
        joyZone.addEventListener('touchend', endJoystickTouch, { passive: true });
        joyZone.addEventListener('touchcancel', endJoystickTouch, { passive: true });
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
            GAME_STATE.keys.space = true;
            Player.jump(MultiplayerClient);
        },
        () => {
            GAME_STATE.keys.space = false;
        }
    );

    bindHoldButton(
        'btn-action-sprint',
        () => { GAME_STATE.keys.shift = true; },
        () => { GAME_STATE.keys.shift = false; }
    );

    bindHoldButton(
        'btn-car-gas',
        () => { GAME_STATE.keys.w = true; },
        () => { GAME_STATE.keys.w = false; }
    );
    bindHoldButton(
        'btn-car-brake',
        () => { GAME_STATE.keys.s = true; },
        () => { GAME_STATE.keys.s = false; }
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
