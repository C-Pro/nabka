import { GAME_STATE, applyPOICompletion, startNpcDialogueSession, advanceNpcDialogue, resolveZoneName } from './state.js';
import { SoundManager } from './audio.js';

export function substitutePlayerMentions(text, username = (typeof GAME_STATE !== 'undefined' ? GAME_STATE.username : 'Игрок')) {
    if (!text) return '';
    const user = username || (typeof GAME_STATE !== 'undefined' ? GAME_STATE.username : 'Игрок');
    return String(text)
        .replaceAll('@cpro29a', '@' + user)
        .replaceAll('cpro29a', user)
        .replaceAll('@{username}', '@' + user)
        .replaceAll('{username}', user);
}

export function showToast(text, theme = 'sky') {
    if (typeof document === 'undefined') return;
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    const borderColors = {
        sky: 'border-sky-400 text-sky-200',
        amber: 'border-amber-400 text-amber-200',
        emerald: 'border-emerald-400 text-emerald-200'
    };
    toast.className = `hud-glass px-4 py-2 rounded-xl border-l-4 ${borderColors[theme] || borderColors.sky} text-xs sm:text-sm font-bold shadow-2xl transition-all duration-300`;
    toast.textContent = substitutePlayerMentions(text);
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-8px)';
        setTimeout(() => toast.remove(), 300);
    }, 3400);
}

// Wire SoundManager toast callback
SoundManager.onToast = showToast;

export function triggerPlayerSpeech(text) {
    if (typeof document === 'undefined') return;
    const bubble = document.getElementById('player-speech-bubble');
    if (!bubble) return;
    bubble.textContent = substitutePlayerMentions(text);
    bubble.classList.remove('hidden');
    clearTimeout(bubble._timer);
    bubble._timer = setTimeout(() => bubble.classList.add('hidden'), 3800);
}

export function renderStars() {
    if (typeof document === 'undefined') return;
    const container = document.getElementById('wanted-stars');
    if (!container) return;
    container.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
        const star = document.createElement('i');
        star.className = `fa-solid fa-star ${i <= GAME_STATE.stars ? 'text-amber-400' : 'text-slate-600/70'}`;
        container.appendChild(star);
    }
}

export function completePOI(poiId, message, cashReward) {
    SoundManager.playActionSound('cash');
    const res = applyPOICompletion(GAME_STATE, poiId, cashReward);

    if (typeof document !== 'undefined') {
        const moneyEl = document.getElementById('hud-money');
        if (moneyEl) moneyEl.textContent = `₽ ${GAME_STATE.money.toLocaleString('ru-RU')}`;

        if (res.isNew) {
            const questProgressEl = document.getElementById('quest-progress');
            if (questProgressEl) {
                questProgressEl.textContent = `${res.count} / ${GAME_STATE.totalPOIs}`;
            }
            renderStars();
        }
    }
    showToast(`${message} (+₽${cashReward})`, 'amber');
}

export function openNpcDialogue(npc, playerPos) {
    SoundManager.ensureInit();
    SoundManager.playActionSound('cash');
    GAME_STATE.activeNpcChat = npc;
    GAME_STATE.keys.w = GAME_STATE.keys.a = GAME_STATE.keys.s = GAME_STATE.keys.d = GAME_STATE.keys.shift = GAME_STATE.keys.space = false;
    if (typeof document !== 'undefined' && document.pointerLockElement && document.exitPointerLock) {
        document.exitPointerLock();
    }

    if (playerPos && npc.group) {
        const dx = playerPos.x - npc.group.position.x;
        const dz = playerPos.z - npc.group.position.z;
        npc.group.rotation.y = Math.atan2(dx, dz);
    }

    startNpcDialogueSession(npc);

    if (typeof document !== 'undefined') {
        document.getElementById('npc-avatar-badge').textContent = npc.persona.emoji;
        document.getElementById('npc-modal-name').textContent = npc.persona.name;
        document.getElementById('npc-modal-role').textContent = npc.persona.role;

        renderNpcChatHistory(npc);
        renderNpcDialogueOptions(npc);

        document.getElementById('npc-dialogue-modal').classList.remove('hidden');
    }
    completePOI('npc_' + npc.persona.name, `💬 Разговор на Набке с ${npc.persona.name}`, 300);
}

export function closeNpcDialogue() {
    GAME_STATE.activeNpcChat = null;
    GAME_STATE.keys.w = GAME_STATE.keys.a = GAME_STATE.keys.s = GAME_STATE.keys.d = GAME_STATE.keys.shift = GAME_STATE.keys.space = false;
    if (typeof document !== 'undefined') {
        const modal = document.getElementById('npc-dialogue-modal');
        if (modal) modal.classList.add('hidden');
    }
}

export function renderNpcChatHistory(npc) {
    if (typeof document === 'undefined') return;
    const historyEl = document.getElementById('npc-chat-history');
    if (!historyEl) return;
    historyEl.innerHTML = '';

    npc.chatHistory.forEach(msg => {
        const row = document.createElement('div');
        const bubble = document.createElement('div');
        const senderTag = document.createElement('span');
        const textNode = document.createElement('span');
        textNode.textContent = msg.text;

        if (msg.role === 'user') {
            row.className = 'flex justify-end';
            bubble.className = 'bg-sky-600/35 border border-sky-400/40 text-white px-3 py-1.5 rounded-xl rounded-br-none max-w-[85%]';
            senderTag.className = 'font-mono-code text-[10px] text-sky-300 block mb-0.5';
            senderTag.textContent = '@' + GAME_STATE.username;
        } else {
            row.className = 'flex justify-start';
            bubble.className = 'bg-slate-900/95 border border-slate-700 text-slate-100 px-3 py-1.5 rounded-xl rounded-bl-none max-w-[88%]';
            senderTag.className = 'font-bold text-[10px] text-amber-400 block mb-0.5';
            senderTag.textContent = `${npc.persona.emoji} ${npc.persona.name}`;
        }

        bubble.appendChild(senderTag);
        bubble.appendChild(textNode);
        row.appendChild(bubble);
        historyEl.appendChild(row);
    });

    historyEl.scrollTop = historyEl.scrollHeight;
}

export function renderNpcDialogueOptions(npc) {
    if (typeof document === 'undefined') return;
    const optionsContainer = document.getElementById('npc-options-container');
    if (!optionsContainer) return;
    optionsContainer.innerHTML = '';

    if (npc.chatStage === 'opening') {
        npc.persona.options.forEach((opt, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-game w-full text-left bg-slate-800/95 hover:bg-sky-600/35 text-sky-200 border border-sky-400/35 px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold flex items-center gap-2.5 transition shadow';

            const numBadge = document.createElement('span');
            numBadge.className = 'bg-sky-500/25 text-sky-300 border border-sky-400/40 font-mono-code text-[10px] px-1.5 py-0.5 rounded shrink-0';
            numBadge.textContent = String(idx + 1);

            const labelSpan = document.createElement('span');
            labelSpan.textContent = opt.question;

            btn.appendChild(numBadge);
            btn.appendChild(labelSpan);
            btn.addEventListener('click', () => selectNpcFollowUpOption(idx));
            optionsContainer.appendChild(btn);
        });
    } else {
        npc.persona.goodbyes.forEach((byeText, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-game w-full text-left bg-amber-500/15 hover:bg-amber-500/30 text-amber-200 border border-amber-400/40 px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold flex items-center gap-2.5 transition shadow';

            const numBadge = document.createElement('span');
            numBadge.className = 'bg-amber-500/25 text-amber-300 border border-amber-400/40 font-mono-code text-[10px] px-1.5 py-0.5 rounded shrink-0';
            numBadge.textContent = String(idx + 1);

            const labelSpan = document.createElement('span');
            labelSpan.textContent = byeText;

            btn.appendChild(numBadge);
            btn.appendChild(labelSpan);
            btn.addEventListener('click', () => selectNpcGoodbyeOption(byeText));
            optionsContainer.appendChild(btn);
        });
    }
}

export function selectNpcFollowUpOption(optionIndex) {
    const npc = GAME_STATE.activeNpcChat;
    const chosen = advanceNpcDialogue(npc, optionIndex);
    if (!chosen) return;

    triggerPlayerSpeech(chosen.question);
    SoundManager.playActionSound('cash');
    renderNpcChatHistory(npc);
    renderNpcDialogueOptions(npc);
}

export function selectNpcGoodbyeOption(byeText) {
    if (!GAME_STATE.activeNpcChat) return;
    triggerPlayerSpeech(byeText);
    SoundManager.playActionSound('cash');
    closeNpcDialogue();
}

export function getLabelDistanceMetrics(distFromCamera) {
    if (distFromCamera > 50) {
        return { visible: false, opacity: '0', zIndex: 0 };
    }
    let opacity = 1.0;
    if (distFromCamera > 10) {
        opacity = 1.0 - ((distFromCamera - 10) / 40) * 0.4;
    }
    const zIndex = Math.max(1, Math.round((100 - distFromCamera) * 100));
    return { visible: true, opacity: opacity.toFixed(3), zIndex };
}

export function updateScreenProjections({ camera, playerPos, dunya, worldLabels, npcs, remotePlayers }) {
    const container = document.getElementById('game-canvas-container');
    if (!container || !camera) return;
    const width = container.clientWidth;
    const height = container.clientHeight;

    const nametag = document.getElementById('player-nametag');
    if (nametag) {
        if (!GAME_STATE.isConnected) {
            nametag.style.opacity = '0';
            nametag.style.display = 'none';
        } else {
            const playerDist = camera.position.distanceTo(playerPos);
            const pMetrics = getLabelDistanceMetrics(playerDist);
            const headWorldPos = playerPos.clone().add(new THREE.Vector3(0, GAME_STATE.inVehicle ? 2.4 : 2.95, 0));
            headWorldPos.project(camera);

            if (pMetrics.visible && headWorldPos.z < 1) {
                const sx = (headWorldPos.x * 0.5 + 0.5) * width;
                const sy = (-headWorldPos.y * 0.5 + 0.5) * height;
                nametag.style.display = '';
                nametag.style.transform = `translate3d(${sx}px, ${sy}px, 0) translate(-50%, -100%)`;
                nametag.style.opacity = pMetrics.opacity;
                nametag.style.zIndex = pMetrics.zIndex;
            } else {
                nametag.style.opacity = '0';
                nametag.style.display = 'none';
            }
        }
    }

    const dunyaTag = document.getElementById('dunya-nametag');
    if (dunyaTag && dunya && dunya.group) {
        if (!GAME_STATE.isConnected) {
            dunyaTag.style.opacity = '0';
            dunyaTag.style.display = 'none';
        } else {
            const dunyaDist = camera.position.distanceTo(dunya.position);
            const dMetrics = getLabelDistanceMetrics(dunyaDist);
            const dunyaHeadPos = dunya.position.clone().add(new THREE.Vector3(0, 1.05, 0));
            dunyaHeadPos.project(camera);
            if (dMetrics.visible && dunyaHeadPos.z < 1 && GAME_STATE.cameraMode !== 3) {
                const dxScreen = (dunyaHeadPos.x * 0.5 + 0.5) * width;
                const dyScreen = (-dunyaHeadPos.y * 0.5 + 0.5) * height;
                dunyaTag.style.display = '';
                dunyaTag.style.transform = `translate3d(${dxScreen}px, ${dyScreen}px, 0) translate(-50%, -100%)`;
                dunyaTag.style.opacity = dMetrics.opacity;
                dunyaTag.style.zIndex = dMetrics.zIndex;
            } else {
                dunyaTag.style.opacity = '0';
                dunyaTag.style.display = 'none';
            }
        }
    }

    worldLabels.forEach(item => {
        const dist = camera.position.distanceTo(item.pos);
        const metrics = getLabelDistanceMetrics(dist);
        if (!metrics.visible) {
            item.el.style.opacity = '0';
            item.el.style.display = 'none';
            return;
        }
        const p = item.pos.clone().project(camera);
        if (p.z < 1) {
            const lx = (p.x * 0.5 + 0.5) * width;
            const ly = (-p.y * 0.5 + 0.5) * height;
            item.el.style.display = '';
            item.el.style.transform = `translate3d(${lx}px, ${ly}px, 0) translate(-50%, -100%)`;
            item.el.style.opacity = metrics.opacity;
            item.el.style.zIndex = metrics.zIndex;
        } else {
            item.el.style.opacity = '0';
            item.el.style.display = 'none';
        }
    });

    npcs.forEach(npc => {
        if (!npc.labelEl) return;
        const dist = camera.position.distanceTo(npc.group.position);
        const metrics = getLabelDistanceMetrics(dist);
        if (!metrics.visible || GAME_STATE.inVehicle) {
            npc.labelEl.style.opacity = '0';
            npc.labelEl.style.display = 'none';
            return;
        }
        const npcHead = npc.group.position.clone().add(new THREE.Vector3(0, 2.35, 0));
        npcHead.project(camera);
        if (npcHead.z < 1) {
            const nx = (npcHead.x * 0.5 + 0.5) * width;
            const ny = (-npcHead.y * 0.5 + 0.5) * height;
            npc.labelEl.style.display = '';
            npc.labelEl.style.transform = `translate3d(${nx}px, ${ny}px, 0) translate(-50%, -100%)`;
            npc.labelEl.style.opacity = metrics.opacity;
            npc.labelEl.style.zIndex = metrics.zIndex;
        } else {
            npc.labelEl.style.opacity = '0';
            npc.labelEl.style.display = 'none';
        }
    });

    remotePlayers.forEach(rp => {
        if (!rp.tagWrapper) return;
        const dist = camera.position.distanceTo(rp.group.position);
        const metrics = getLabelDistanceMetrics(dist);
        if (!metrics.visible) {
            rp.tagWrapper.style.opacity = '0';
            rp.tagWrapper.style.display = 'none';
            return;
        }
        const worldAnchor = rp.group.position.clone().add(new THREE.Vector3(0, rp.mode === 'driving' ? 2.45 : 2.95, 0));
        worldAnchor.project(camera);
        if (worldAnchor.z < 1) {
            const rx = (worldAnchor.x * 0.5 + 0.5) * width;
            const ry = (-worldAnchor.y * 0.5 + 0.5) * height;
            rp.tagWrapper.style.display = '';
            rp.tagWrapper.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -100%)`;
            rp.tagWrapper.style.opacity = metrics.opacity;
            rp.tagWrapper.style.zIndex = metrics.zIndex;
        } else {
            rp.tagWrapper.style.opacity = '0';
            rp.tagWrapper.style.display = 'none';
        }
    });
}

export function drawGTARadar({ playerPos, interactables, npcs, dunya, remotePlayers }) {
    const canvas = document.getElementById('radar-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const scale = 1.15;

    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(GAME_STATE.cameraYaw);

    const px = playerPos.x;
    const pz = playerPos.z;

    ctx.fillStyle = '#0369a1';
    ctx.fillRect((-220 - px) * scale, (-220 - pz) * scale, 205 * scale, 440 * scale);

    ctx.fillStyle = '#475569';
    ctx.fillRect((-15 - px) * scale, (-180 - pz) * scale, 30 * scale, 360 * scale);

    ctx.fillStyle = '#1e293b';
    ctx.fillRect((15 - px) * scale, (-180 - pz) * scale, 16 * scale, 360 * scale);

    ctx.fillStyle = '#92400e';
    ctx.fillRect((-48 - px) * scale, (44 - pz) * scale, 33 * scale, 8 * scale);

    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc((0 - px) * scale, (0 - pz) * scale, 9 * scale, 0, Math.PI * 2);
    ctx.fill();

    interactables.forEach(poi => {
        const bx = (poi.x - px) * scale;
        const bz = (poi.z - pz) * scale;
        ctx.fillStyle = poi.isCar ? '#10b981' : (GAME_STATE.completedPOIs.has(poi.id) ? '#94a3b8' : '#fbbf24');
        ctx.beginPath();
        ctx.arc(bx, bz, poi.isCar ? 4.5 : 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    });

    npcs.forEach(npc => {
        const nx = (npc.group.position.x - px) * scale;
        const nz = (npc.group.position.z - pz) * scale;
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(nx, nz, 3, 0, Math.PI * 2);
        ctx.fill();
    });

    if (dunya && dunya.group) {
        const dxRadar = (dunya.position.x - px) * scale;
        const dzRadar = (dunya.position.z - pz) * scale;
        ctx.fillStyle = '#f43f5e';
        ctx.beginPath();
        ctx.arc(dxRadar, dzRadar, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        ctx.stroke();
    }

    remotePlayers.forEach(rp => {
        const rx = (rp.group.position.x - px) * scale;
        const rz = (rp.group.position.z - pz) * scale;
        ctx.fillStyle = '#10b981';
        ctx.beginPath();
        ctx.arc(rx, rz, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    });

    ctx.restore();
}

export function checkProximityInteractions({ playerPos, npcs, interactables, dunya, worldMap }) {
    let closest = null;
    let minDist = Infinity;

    if (!GAME_STATE.inVehicle) {
        for (const npc of npcs) {
            const dNpc = Math.hypot(playerPos.x - npc.group.position.x, playerPos.z - npc.group.position.z);
            if (dNpc < 3.6 && dNpc < minDist) {
                minDist = dNpc;
                closest = {
                    id: npc.id,
                    isNpc: true,
                    npcRef: npc,
                    prompt: `Поговорить: ${npc.persona.emoji} ${npc.persona.name} (Набка)`,
                    onInteract: () => openNpcDialogue(npc, playerPos)
                };
            }
        }
    }

    for (const item of interactables) {
        if (GAME_STATE.inVehicle && item.carRef !== GAME_STATE.inVehicle) continue;
        const d = Math.hypot(playerPos.x - item.x, playerPos.z - item.z);
        if (d < item.radius && d < minDist) {
            minDist = d;
            closest = item;
        }
    }

    if (!closest && !GAME_STATE.inVehicle && dunya && dunya.group) {
        const dDunya = Math.hypot(playerPos.x - dunya.position.x, playerPos.z - dunya.position.z);
        if (dDunya < 2.5) {
            closest = {
                id: 'dunya_pet',
                name: 'Мальтийская болонка Дуня',
                prompt: 'Погладить болонку Дуню 🐾🤍 (+Вайб)',
                onInteract: () => {
                    dunya.hopAndBark(`Тяф! Люблю @${GAME_STATE.username || 'Игрок'}! 🐾💖`);
                    triggerPlayerSpeech('Хорошая девочка, Дуня! 🐾🤍');
                    completePOI('dunya_pet', '🐾 Ты погладил мальтийскую болонку Дуню на Набке!', 250);
                }
            };
        }
    }

    GAME_STATE.nearestInteractable = closest;
    const promptEl = document.getElementById('interaction-prompt');
    const promptText = document.getElementById('interaction-text');

    if (promptEl && promptText) {
        if (GAME_STATE.inVehicle) {
            promptEl.classList.remove('hidden');
            promptText.textContent = `Выйти из ${GAME_STATE.inVehicle.name} на Набку`;
        } else if (closest) {
            promptEl.classList.remove('hidden');
            promptText.textContent = substitutePlayerMentions(closest.prompt);
        } else {
            promptEl.classList.add('hidden');
        }
    }

    const x = playerPos.x;
    const z = playerPos.z;
    const zone = resolveZoneName(x, z, worldMap);
    const zoneEl = document.getElementById('location-zone-label');
    if (zoneEl) zoneEl.textContent = zone;
    const coordsEl = document.getElementById('coords-display');
    if (coordsEl) coordsEl.textContent = `X: ${Math.round(x)} | Z: ${Math.round(z)}`;
}
