import { VehicleSnapshotBuffer, resetVehiclePose } from './vehicle-motion.js';
import { MsgPackCodec } from './msgpack.js';
import { GAME_STATE, computePedestrianAnim, deriveDefaultWsUrl, generateRandomVladivostokName, getInitialUsername } from './state.js';
import { SoundManager } from './audio.js';
import { TextureFactory } from './textures.js';
import { World } from './world.js';
import { Player, toggleVehicleDrive, revalidatePlayerSpawn } from './entities.js';
import { showToast, triggerPlayerSpeech, showLocalLabels } from './ui.js';
import { ModelLoader, ModelBuilders } from './models.js';

export function hashUsernameColor(username) {
    const palette = ['#38bdf8', '#fbbf24', '#34d399', '#f472b6', '#a78bfa', '#fb7185', '#2dd4bf'];
    let h = 0;
    const str = String(username || '');
    for (let i = 0; i < str.length; i++) {
        h = (h * 31 + str.charCodeAt(i)) >>> 0;
    }
    return palette[h % palette.length];
}

export const MultiplayerClient = {
    ws: null,
    serverUrl: deriveDefaultWsUrl(),
    authMode: 'query', // 'query' (Option A) or 'register' (Option B)
    isLocalBridge: false,
    broadcastChannel: null,
    simBotsTimer: null,
    keepAliveTimer: null,
    pingTimer: null,
    serverSupportsPing: true,
    remotePlayers: new Map(), // username -> RemotePlayer object
    onlineUsers: new Set(),
    lastSentState: null,
    sendIntervalMs: 55, // ~18 Hz tick rate
    worldMap: null,
    chatAutoHideTimer: null,
    currentBuildVersion: null,
    sessionTokens: {},
    reconnectTimer: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 10,
    isReconnecting: false,

    getSessionToken(username) {
        if (!username) return '';
        if (this.sessionTokens && this.sessionTokens[username]) {
            return this.sessionTokens[username];
        }
        try {
            if (typeof localStorage !== 'undefined') {
                return localStorage.getItem(`nabka_session_token_${username}`) || '';
            }
        } catch (e) {}
        return '';
    },

    setSessionToken(username, token) {
        if (!username || !token) return;
        if (!this.sessionTokens) this.sessionTokens = {};
        this.sessionTokens[username] = token;
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(`nabka_session_token_${username}`, token);
            }
        } catch (e) {}
    },

    clearSessionToken(username) {
        if (!username) return;
        if (this.sessionTokens) delete this.sessionTokens[username];
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.removeItem(`nabka_session_token_${username}`);
            }
        } catch (e) {}
    },

    safeSend(payload) {
        if (!this.ws || this.ws.readyState !== 1) return false;
        try {
            this.ws.send(payload);
            return true;
        } catch (err) {
            console.warn('WebSocket send failed:', err);
            return false;
        }
    },

    async checkServerVersion(autoReloadOnNewVersion = false) {
        if (typeof fetch === 'undefined') return null;
        try {
            const resp = await fetch('/api/version?t=' + Date.now(), { cache: 'no-store' });
            if (!resp.ok) return null;
            const data = await resp.json();
            if (data && data.version) {
                if (this.currentBuildVersion && this.currentBuildVersion !== data.version) {
                    if (autoReloadOnNewVersion && typeof window !== 'undefined' && window.location) {
                        this.showLoginError('Вышло обновление Набки! Перезагрузка страницы...');
                        setTimeout(() => {
                            if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
                                window.location.reload(true);
                            }
                        }, 700);
                    }
                } else if (!this.currentBuildVersion) {
                    this.currentBuildVersion = data.version;
                }
                return data.version;
            }
        } catch (e) {}
        return null;
    },

    showChat(focusInput = false) {
        if (typeof document === 'undefined') return;
        const panel = document.getElementById('mp-chat-panel');
        const body = document.getElementById('mp-chat-body');
        const input = document.getElementById('mp-chat-input');
        const icon = document.getElementById('chat-collapse-icon');

        GAME_STATE.chatCollapsed = false;

        if (panel) panel.classList.remove('hidden');
        if (body) body.classList.remove('hidden');
        if (icon) icon.className = 'fa-solid fa-chevron-up';

        if (focusInput && input) {
            this.cancelChatAutoHide();
            input.focus();
        } else {
            this.scheduleChatAutoHide(5000);
        }
    },

    hideChat() {
        if (typeof document === 'undefined') return;
        this.cancelChatAutoHide();
        const panel = document.getElementById('mp-chat-panel');
        const body = document.getElementById('mp-chat-body');
        const input = document.getElementById('mp-chat-input');
        const icon = document.getElementById('chat-collapse-icon');

        GAME_STATE.chatCollapsed = true;

        if (input && document.activeElement === input) {
            input.blur();
        }
        if (panel) panel.classList.add('hidden');
        if (body) body.classList.add('hidden');
        if (icon) icon.className = 'fa-solid fa-chevron-down';
    },

    scheduleChatAutoHide(delayMs = 5000) {
        this.cancelChatAutoHide();
        this.chatAutoHideTimer = setTimeout(() => {
            this.chatAutoHideTimer = null;
            if (typeof document === 'undefined') return;
            const input = document.getElementById('mp-chat-input');
            if (input && document.activeElement === input) {
                return;
            }
            this.hideChat();
        }, delayMs);
    },

    cancelChatAutoHide() {
        if (this.chatAutoHideTimer) {
            clearTimeout(this.chatAutoHideTimer);
            this.chatAutoHideTimer = null;
        }
    },

    initUI(worldMap = null) {
        if (worldMap) this.worldMap = worldMap;
        if (typeof document === 'undefined') return;
        const loginForm = document.getElementById('mp-login-form');
        const usernameInput = document.getElementById('mp-username-input');
        const chatForm = document.getElementById('mp-chat-form');
        const chatInput = document.getElementById('mp-chat-input');
        const btnCollapseChat = document.getElementById('btn-collapse-chat');
        const btnToggleTopChat = document.getElementById('btn-toggle-mp-chat');

        // Gameplay and version checks must use the server serving this page.
        this.serverUrl = deriveDefaultWsUrl();
        this.authMode = 'query';

        // Restore last used username if available, or generate random placeholder name
        let initialName = null;
        try {
            const saved = localStorage.getItem('nabka_username') || localStorage.getItem('nabka_mp_username');
            if (saved && saved.trim()) initialName = saved.trim();
        } catch (e) {}

        const randomPlaceholder = generateRandomVladivostokName();
        const effectiveName = initialName || randomPlaceholder;
        GAME_STATE.username = effectiveName;

        const hUser = document.getElementById('header-username');
        const lTag = document.getElementById('local-nametag-text');
        const helpUser = document.getElementById('help-modal-username');
        if (hUser) hUser.textContent = '@' + effectiveName;
        if (lTag) lTag.textContent = '@' + effectiveName;
        if (helpUser) helpUser.textContent = '@' + effectiveName;

        if (usernameInput) {
            usernameInput.placeholder = `Например: ${randomPlaceholder}`;
            usernameInput.value = initialName ? initialName : randomPlaceholder;
            usernameInput.addEventListener('input', () => {
                const preview = usernameInput.value.trim() || randomPlaceholder;
                if (hUser) hUser.textContent = '@' + preview;
                if (lTag) lTag.textContent = '@' + preview;
                if (helpUser) helpUser.textContent = '@' + preview;
            });
        }

        if (loginForm) {
            loginForm.addEventListener('submit', (e) => {
                e.preventDefault();
                let rawName = usernameInput ? usernameInput.value.trim() : '';
                if (!rawName) {
                    rawName = usernameInput ? usernameInput.placeholder.replace(/^Например:\s*/, '').trim() : '';
                }
                if (!rawName || rawName.length > 32) {
                    this.showLoginError('Имя должно быть от 1 до 32 символов');
                    return;
                }
                this.connect(rawName, false);
            });
        }

        if (chatForm && chatInput) {
            chatInput.addEventListener('focus', () => {
                this.cancelChatAutoHide();
            });
            chatInput.addEventListener('blur', () => {
                this.scheduleChatAutoHide(5000);
            });
            chatInput.addEventListener('keydown', (e) => {
                if (e.code === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.hideChat();
                }
            });
            chatForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const text = chatInput.value.trim();
                if (!text) return;
                this.sendChat(text);
                chatInput.value = '';
                chatInput.blur();
                this.scheduleChatAutoHide(5000);
            });
        }

        const chatPanel = document.getElementById('mp-chat-panel');
        if (chatPanel) {
            chatPanel.addEventListener('mouseenter', () => {
                this.cancelChatAutoHide();
            });
            chatPanel.addEventListener('mouseleave', () => {
                if (chatInput && document.activeElement === chatInput) return;
                this.scheduleChatAutoHide(5000);
            });
        }

        if (btnCollapseChat) {
            btnCollapseChat.addEventListener('click', () => {
                const panel = document.getElementById('mp-chat-panel');
                if (panel && !panel.classList.contains('hidden') && !GAME_STATE.chatCollapsed) {
                    this.hideChat();
                } else {
                    this.showChat(true);
                }
            });
        }

        if (btnToggleTopChat) {
            btnToggleTopChat.addEventListener('click', () => {
                this.showChat(true);
            });
        }

        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && GAME_STATE.isConnected) {
                    this.safeSend(MsgPackCodec.encode({ type: 'ping' }));
                    this.sendMoveSnapshot(true);
                }
                if (document.visibilityState === 'visible') {
                    this.checkServerVersion(!GAME_STATE.isConnected);
                }
            });
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('focus', () => {
                if (GAME_STATE.isConnected) {
                    this.safeSend(MsgPackCodec.encode({ type: 'ping' }));
                    this.sendMoveSnapshot(true);
                }
                this.checkServerVersion(!GAME_STATE.isConnected);
            });
        }

        this.checkServerVersion(false);
    },

    showLoginError(msg, detail = '') {
        if (typeof document === 'undefined') return;
        const box = document.getElementById('mp-login-error');
        const txt = document.getElementById('mp-login-error-text');
        const det = document.getElementById('mp-login-error-details');
        const diagnostics = document.getElementById('mp-login-error-diagnostics');
        if (diagnostics) diagnostics.classList.toggle('hidden', !detail);
        if (txt) txt.textContent = msg;
        if (det) {
            if (detail) {
                det.textContent = detail;
                det.classList.remove('hidden');
            } else {
                det.textContent = '';
                det.classList.add('hidden');
            }
        }
        if (box) box.classList.remove('hidden');
    },

    hideLoginError() {
        if (typeof document === 'undefined') return;
        const box = document.getElementById('mp-login-error');
        if (box) box.classList.add('hidden');
    },

    setConnectingUI(isConnecting) {
        if (typeof document === 'undefined') return;
        const btn = document.getElementById('mp-connect-btn');
        const txt = document.getElementById('mp-connect-text');
        const icon = document.getElementById('mp-connect-icon');
        if (btn) btn.disabled = isConnecting;
        if (txt && icon) {
            if (isConnecting) {
                txt.textContent = 'ПОДКЛЮЧЕНИЕ К СЕРВЕРУ...';
                icon.className = 'fa-solid fa-circle-notch animate-spin';
            } else {
                txt.textContent = 'ВОЙТИ НА НАБКУ';
                icon.className = 'fa-solid fa-plug-circle-bolt';
            }
        }
    },

    activateSessionUI(username, statusLabel = '') {
        this.setConnectingUI(false);
        GAME_STATE.isConnected = true;
        GAME_STATE.lastActiveEventAt = performance.now();
        this.onlineUsers.clear();
        this.onlineUsers.add(username);

        if (typeof document !== 'undefined') {
            const hUser = document.getElementById('header-username');
            const lTag = document.getElementById('local-nametag-text');
            const helpUser = document.getElementById('help-modal-username');
            const dot = document.getElementById('net-status-dot');
            const overlay = document.getElementById('mp-login-overlay');
            if (hUser) hUser.textContent = '@' + username;
            if (lTag) lTag.textContent = '@' + username;
            if (helpUser) helpUser.textContent = '@' + username;
            if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-ping';
            if (overlay) overlay.classList.add('hidden');
        }

        if (Player.group && Player.group.children && Player.group.children[0]) {
            const tex = TextureFactory.createCustomShirtTexture(username, '#38bdf8');
            if (tex) {
                Player.group.children[0].material.map = tex;
                Player.group.children[0].material.needsUpdate = true;
            }
        }

        this.updateOnlineRosterUI();
        this.appendChatSystemMessage(statusLabel || `Подключён к серверу Набки как @${username}`);
        this.sendMoveSnapshot(true);

        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = setInterval(() => {
            if (GAME_STATE.isConnected) {
                this.sendMoveSnapshot(true);
            }
        }, 7000);

        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
            if (this.serverSupportsPing && GAME_STATE.isConnected && this.ws && this.ws.readyState === 1) {
                this.safeSend(MsgPackCodec.encode({ type: 'ping' }));
            }
        }, 8000);
    },

    startLocalBridgeMode(username) {
        SoundManager.ensureInit();
        this.hideLoginError();
        this.stopLocalBridgeMode();

        this.isLocalBridge = true;
        GAME_STATE.username = username;
        try {
            localStorage.setItem('nabka_username', username);
            localStorage.setItem('nabka_mp_username', username);
        } catch (e) {}

        this.activateSessionUI(username, `🌐 Локальный MsgPack-мост активирован для @${username} (синхронизация между вкладками + боты Набки)`);

        if (typeof BroadcastChannel !== 'undefined') {
            this.broadcastChannel = new BroadcastChannel('nabka_mp_msgpack_bridge');
            this.broadcastChannel.onmessage = (ev) => {
                if (ev.data instanceof ArrayBuffer) {
                    const decoded = MsgPackCodec.decode(ev.data);
                    if (decoded && decoded.username !== GAME_STATE.username) {
                        this.handleServerMessage(decoded);
                    }
                }
            };
            const joinBuf = MsgPackCodec.encode({ type: 'join', user: username });
            this.broadcastChannel.postMessage(joinBuf);
        }

        const bot1 = 'vvo_drifter';
        const bot2 = 'alisa_25rus';
        this.handleServerMessage(MsgPackCodec.decode(MsgPackCodec.encode({ type: 'join', user: bot1 })));
        this.handleServerMessage(MsgPackCodec.decode(MsgPackCodec.encode({ type: 'join', user: bot2 })));

        setTimeout(() => {
            if (!this.isLocalBridge) return;
            this.handleServerMessage(MsgPackCodec.decode(MsgPackCodec.encode({
                type: 'chat',
                username: bot1,
                from: bot1,
                text: `Салют, @${username}! Го дрифтить вокруг фонтана на Марке! 🏎️💨`
            })));
        }, 1400);

        let simTick = 0;
        this.simBotsTimer = setInterval(() => {
            if (!this.isLocalBridge || !GAME_STATE.isConnected) return;
            simTick += 0.055;

            const b1Angle = simTick * 0.55;
            const b1X = Math.cos(b1Angle) * 12.5;
            const b1Z = Math.sin(b1Angle) * 12.5;
            const b1Vx = -Math.sin(b1Angle) * 12.5 * 0.55;
            const b1Vz = Math.cos(b1Angle) * 12.5 * 0.55;
            const b1Yaw = Math.atan2(b1Vx, b1Vz);

            const b1Packet = MsgPackCodec.encode({
                username: bot1,
                type: 'move',
                mode: 'pedestrian',
                x: b1X,
                y: 0,
                z: b1Z,
                vx: b1Vx,
                vz: b1Vz,
                yaw: b1Yaw,
                anim: 'run'
            });
            this.handleServerMessage(MsgPackCodec.decode(b1Packet));

            const b2Z = -30 + Math.sin(simTick * 0.35) * 22;
            const b2Vz = Math.cos(simTick * 0.35) * 22 * 0.35;
            const b2Packet = MsgPackCodec.encode({
                username: bot2,
                type: 'move',
                mode: 'pedestrian',
                x: -6.5,
                y: 0,
                z: b2Z,
                vx: 0,
                vz: b2Vz,
                yaw: b2Vz >= 0 ? 0 : Math.PI,
                anim: 'walk'
            });
            this.handleServerMessage(MsgPackCodec.decode(b2Packet));
        }, 55);
    },

    stopLocalBridgeMode() {
        this.isLocalBridge = false;
        if (this.simBotsTimer) {
            clearInterval(this.simBotsTimer);
            this.simBotsTimer = null;
        }
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        if (this.broadcastChannel) {
            try { this.broadcastChannel.close(); } catch (e) {}
            this.broadcastChannel = null;
        }
        this.cancelChatAutoHide();
    },

    cleanupOnDisconnect() {
        this.setConnectingUI(false);
        GAME_STATE.isConnected = false;
        if (typeof document !== 'undefined') {
            const dot = document.getElementById('net-status-dot');
            if (dot) dot.className = 'w-2 h-2 rounded-full bg-rose-500';
            const overlay = document.getElementById('mp-login-overlay');
            if (overlay) overlay.classList.remove('hidden');
        }

        if (GAME_STATE.inVehicle) {
            toggleVehicleDrive(GAME_STATE.inVehicle);
        }
        World.resetVehicles();

        for (const usernameKey of Array.from(this.remotePlayers.keys())) {
            this.removeRemotePlayer(usernameKey);
        }
        this.onlineUsers.clear();
        this.updateOnlineRosterUI();
    },

    connect(username, isFallbackAttempt = false, isReconnect = false) {
        SoundManager.ensureInit();
        this.stopLocalBridgeMode();
        this.hideLoginError();

        if (!isReconnect) {
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
            World.resetVehicles();
        }

        this.setConnectingUI(true);
        this.serverSupportsPing = true;

        if (this.currentBuildVersion) {
            this.checkServerVersion(!GAME_STATE.isConnected && !isReconnect);
        }

        if (this.ws) {
            try {
                this.ws.onopen = null;
                this.ws.onmessage = null;
                this.ws.onerror = null;
                this.ws.onclose = null;
                this.ws.close();
            } catch (e) {}
            this.ws = null;
        }

        GAME_STATE.username = username;
        try {
            localStorage.setItem('nabka_username', username);
            localStorage.setItem('nabka_mp_username', username);
        } catch (e) {}

        const cleanBaseUrl = this.serverUrl.replace(/\?.*$/, '');
        const useRegisterPacket = isFallbackAttempt ? (this.authMode === 'query') : (this.authMode === 'register');
        const token = this.getSessionToken(username);
        const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
        const wsUrl = useRegisterPacket
            ? cleanBaseUrl
            : `${cleanBaseUrl}?username=${encodeURIComponent(username)}${tokenParam}`;

        const wsSource = Function.prototype.toString.call((typeof window !== 'undefined' && window.WebSocket) || '');
        const isPatchedByPreview = !wsSource.includes('[native code]');

        let socket;
        try {
            socket = new window.WebSocket(wsUrl);
        } catch (err) {
            this.setConnectingUI(false);
            if (isReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                const delay = Math.min(8000, Math.round(500 * Math.pow(1.5, this.reconnectAttempts - 1)));
                if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
                this.reconnectTimer = setTimeout(() => {
                    this.connect(username, false, true);
                }, delay);
                return;
            }
            const hint = isPatchedByPreview
                ? 'Окно превью Gemini перехватывает window.WebSocket. Нажми «Скачать index.html» ниже (теперь файл сохраняется чистым, без перехватчика postMessage) или скопируй код из редактора справа.'
                : `${err.name || 'Error'}: ${err.message || String(err)} (URL: ${wsUrl})`;
            this.showLoginError('Не удалось открыть WebSocket соединение', hint);
            return;
        }

        socket.binaryType = 'arraybuffer';
        this.ws = socket;
        let openedSuccessfully = false;

        socket.onopen = () => {
            if (this.ws !== socket) return;
            openedSuccessfully = true;
            const wasReconnecting = this.isReconnecting;
            this.isReconnecting = false;
            this.reconnectAttempts = 0;
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }

            if (useRegisterPacket) {
                const regObj = {
                    type: 'register',
                    username: username
                };
                if (token) regObj.token = token;
                this.safeSend(MsgPackCodec.encode(regObj));
            }
            this.activateSessionUI(username);
            if (wasReconnecting) {
                showToast('🟢 Связь с сервером восстановлена!', 'emerald');
            }
        };

        socket.onmessage = (event) => {
            if (this.ws !== socket) return;
            if (event.data instanceof ArrayBuffer) {
                try {
                    const msg = MsgPackCodec.decode(event.data);
                    if (msg && typeof msg === 'object') {
                        this.handleServerMessage(msg);
                    }
                } catch (err) {
                    console.warn('MsgPack decode warning:', err);
                }
            } else if (typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg && typeof msg === 'object') {
                        this.handleServerMessage(msg);
                    }
                } catch (err) {}
            }
        };

        socket.onerror = () => {
            if (this.ws !== socket) return;
        };

        socket.onclose = (event) => {
            if (this.ws !== socket) return;
            this.ws = null;

            if (this.keepAliveTimer) {
                clearInterval(this.keepAliveTimer);
                this.keepAliveTimer = null;
            }
            if (this.pingTimer) {
                clearInterval(this.pingTimer);
                this.pingTimer = null;
            }
            this.cancelChatAutoHide();

            // 1. Initial fallback attempt (Option A vs Option B) on initial failure
            if (!openedSuccessfully && !isFallbackAttempt && event.code !== 4409 && this.reconnectAttempts === 0) {
                this.connect(username, true);
                return;
            }

            // 2. Name is taken by another client / session token mismatch
            const isNameTaken = event.code === 4409 || (event.reason && event.reason.includes('taken'));
            if (isNameTaken) {
                this.clearSessionToken(username);
                this.isReconnecting = false;
                this.reconnectAttempts = 0;
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
                this.cleanupOnDisconnect();
                const diagDetail = `WebSocket CloseCode: ${event.code} | Reason: "${event.reason || 'нет'}" | URL: ${wsUrl}`;
                this.showLoginError(`Имя "@${GAME_STATE.username}" уже занято другим игроком онлайн! Выбери другое.`, diagDetail);
                return;
            }

            // 3. Normal clean closure by user or deliberate close
            if (event.code === 1000 && !this.isReconnecting) {
                this.cleanupOnDisconnect();
                return;
            }

            // 4. Unexpected disconnect during active play: attempt automatic reconnection
            const canRetry = (openedSuccessfully || this.isReconnecting) && this.reconnectAttempts < this.maxReconnectAttempts;
            if (canRetry) {
                GAME_STATE.isConnected = false;
                this.isReconnecting = true;
                this.reconnectAttempts++;

                if (typeof document !== 'undefined') {
                    const dot = document.getElementById('net-status-dot');
                    if (dot) dot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-pulse';
                }

                const delay = Math.min(8000, Math.round(500 * Math.pow(1.5, this.reconnectAttempts - 1)));
                showToast(`🔄 Связь потеряна. Переподключение (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`, 'amber');

                if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
                this.reconnectTimer = setTimeout(() => {
                    this.connect(username, false, true);
                }, delay);
                return;
            }

            // 5. Max retry attempts exhausted or never opened
            this.isReconnecting = false;
            this.reconnectAttempts = 0;
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }

            this.cleanupOnDisconnect();

            const diagDetail = `WebSocket CloseCode: ${event.code} | Reason: "${event.reason || 'нет'}" | URL: ${wsUrl}`;
            if (event.reason) {
                this.showLoginError(`Отключён от сервера: ${event.reason}`, diagDetail);
            } else if (openedSuccessfully) {
                this.showLoginError('Связь с сервером потеряна. Нажми «Войти», чтобы вернуться!', diagDetail);
            } else {
                this.showLoginError('Не удалось открыть WebSocket соединение (сервер недоступен)', diagDetail);
            }

            if (this.currentBuildVersion) {
                setTimeout(() => {
                    this.checkServerVersion(!GAME_STATE.isConnected);
                }, 1200);
            }
        };
    },

    handleServerMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        const vehicles = World.vehicles;

        switch (msg.type) {
            case 'join': {
                const user = String(msg.user || '');
                if (!user) break;
                this.onlineUsers.add(user);
                this.updateOnlineRosterUI();
                if (user === GAME_STATE.username) {
                    if (msg.token) {
                        this.setSessionToken(user, String(msg.token));
                    }
                    if (this.isReconnecting) {
                        showToast(`🟢 Соединение с Набкой восстановлено!`, 'emerald');
                        this.isReconnecting = false;
                        this.reconnectAttempts = 0;
                    } else {
                        showToast(`🌐 Ты на Спортивной набережной как @${user}!`, 'emerald');
                    }
                    showLocalLabels(1500);
                    if (this.worldMap && revalidatePlayerSpawn(this.worldMap, this.remotePlayers)) {
                        this.sendMoveSnapshot(true);
                    }
                } else {
                    showToast(`🟢 @${user} подключился к Набке!`, 'sky');
                    this.appendChatSystemMessage(`🟢 @${user} вышел на Набку`);
                    this.getOrCreateRemotePlayer(user);
                    this.sendMoveSnapshot(true);
                }
                break;
            }
            case 'session': {
                const user = String(msg.user || '');
                const token = String(msg.token || '');
                if (user && token) {
                    this.setSessionToken(user, token);
                }
                break;
            }
            case 'leave': {
                const user = String(msg.user || '');
                const reason = String(msg.reason || 'left');
                if (!user) break;
                this.onlineUsers.delete(user);
                this.removeRemotePlayer(user);
                this.updateOnlineRosterUI();
                const reasonRu = reason.includes('30s') ? 'соединение не отвечает' : (reason === 'slow consumer' ? 'медленное соединение' : 'вышел');
                showToast(`🔴 @${user} покинул Набку (${reasonRu})`, 'amber');
                this.appendChatSystemMessage(`🔴 @${user} покинул Набку (${reasonRu})`);
                break;
            }
            case 'move': {
                if (msg.mode === 'driving' && msg.car_id) {
                    const car = vehicles.find(v => v.id === msg.car_id);
                    const driver = String(msg.username || '');

                    // Reconcile vehicle conflict: if another player is authoritative driver for our currently occupied car
                    if (car && GAME_STATE.inVehicle === car && driver && driver !== GAME_STATE.username) {
                        showToast(`⚠️ Машина занята игроком @${driver}!`, 'amber');
                        toggleVehicleDrive(car, (force) => this.sendMoveSnapshot(force));
                    }

                    if (!driver) {
                        if (car && GAME_STATE.inVehicle !== car) {
                            if (car.remoteDriver) {
                                const prevRp = this.remotePlayers.get(car.remoteDriver);
                                if (prevRp && prevRp.carId === car.id) {
                                    prevRp.carId = null;
                                    prevRp.mode = 'pedestrian';
                                    prevRp.group.visible = true;
                                }
                                car.remoteDriver = null;
                                car.netTarget = null;
                            }
                            const parkedY = (msg.y !== undefined && Number.isFinite(Number(msg.y)))
                                ? Number(msg.y)
                                : ((car.spawnY !== undefined && Number.isFinite(car.spawnY)) ? car.spawnY : 0.02);
                            car.group.position.set(Number(msg.x) || 0, parkedY, Number(msg.z) || 0);
                            car.group.rotation.y = Number(msg.yaw) || 0;
                            car.x = car.group.position.x;
                            car.y = car.group.position.y;
                            car.z = car.group.position.z;
                            car.yaw = car.group.rotation.y;
                            car.vx = car.vz = car.yawRate = car.speed = 0;
                            car.isAwake = false;
                            car.isDrifting = false;
                            car.tractionLoss = 0;
                            car.snapshotBuffer = null;
                            resetVehiclePose(car);
                            if (car.headBeam) {
                                car.headBeam.intensity = msg.lights ? 1.8 : 0;
                            }
                        }
                        break;
                    }
                }

                const user = String(msg.username || '');
                if (!user || user === GAME_STATE.username) break;
                this.onlineUsers.add(user);
                this.updateOnlineRosterUI();
                const rp = this.getOrCreateRemotePlayer(user);
                rp.applyNetworkMove(msg);
                break;
            }
            case 'chat': {
                const sender = String(msg.from || msg.username || 'Игрок');
                const text = String(msg.text || '');
                if (!text) break;
                this.onlineUsers.add(sender);
                this.updateOnlineRosterUI();
                this.appendChatMessage(sender, text);
                SoundManager.playActionSound('cash');

                if (sender === GAME_STATE.username) {
                    triggerPlayerSpeech(text);
                } else {
                    const rp = this.getOrCreateRemotePlayer(sender);
                    rp.triggerSpeech(text);
                }
                break;
            }
            case 'error': {
                const errText = String(msg.message || 'Ошибка протокола');
                if (errText.includes('unknown message type')) {
                    // Older server deployment does not support TypePing; fall back to move heartbeat silently
                    this.serverSupportsPing = false;
                    break;
                }
                showToast(`⚠️ Сервер: ${errText}`, 'amber');
                break;
            }
            case 'pong': {
                // Heartbeat response from server
                break;
            }
        }
    },

    hashColor(username) {
        return hashUsernameColor(username);
    },

    getOrCreateRemotePlayer(username) {
        if (this.remotePlayers.has(username)) {
            return this.remotePlayers.get(username);
        }

        const accentHex = this.hashColor(username);
        const accentColorInt = parseInt(accentHex.replace('#', '0x'), 16);

        let group, head, leftArm, rightArm, leftLeg, rightLeg;
        let tagWrapper = null;
        let speechBubble = null;

        if (typeof THREE !== 'undefined' && World.scene) {
            group = ModelLoader.instantiate('models/player.glb', () => ModelBuilders.player(username, accentHex));
            group.position.set(0, 0, 18);

            const shirtTex = TextureFactory.createCustomShirtTexture(username, accentHex);
            const torso = group.getObjectByName ? group.getObjectByName('torso') : null;
            if (torso && torso.material) {
                if (torso.material.map && torso.material.map.flipY === false) {
                    shirtTex.flipY = false;
                }
                torso.material = torso.material.clone();
                torso.material.map = shirtTex;
                torso.material.needsUpdate = true;
            }
            ['capCrown', 'capVisor', 'leftLeg_shoe', 'rightLeg_shoe'].forEach(nodeName => {
                const n = group.getObjectByName ? group.getObjectByName(nodeName) : null;
                if (n && n.material) {
                    n.material = n.material.clone();
                    n.material.color.setHex(accentColorInt);
                }
            });

            head = (group.getObjectByName && group.getObjectByName('head')) || new THREE.Group();
            leftArm = (group.getObjectByName && group.getObjectByName('leftArm')) || new THREE.Group();
            rightArm = (group.getObjectByName && group.getObjectByName('rightArm')) || new THREE.Group();
            leftLeg = (group.getObjectByName && group.getObjectByName('leftLeg')) || new THREE.Group();
            rightLeg = (group.getObjectByName && group.getObjectByName('rightLeg')) || new THREE.Group();

            World.scene.add(group);
        } else {
            // Headless stub for unit tests without Three.js
            group = {
                visible: true,
                position: {
                    x: 0, y: 0, z: 18,
                    set(x, y, z) { this.x = x; this.y = y; this.z = z; },
                    copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; }
                },
                rotation: { y: 0 }
            };
            leftArm = { rotation: { x: 0 } };
            rightArm = { rotation: { x: 0 } };
            leftLeg = { rotation: { x: 0 } };
            rightLeg = { rotation: { x: 0 } };
        }

        if (typeof document !== 'undefined') {
            const labelsContainer = document.getElementById('remote-players-labels-container');
            tagWrapper = document.createElement('div');
            tagWrapper.className = 'absolute top-0 left-0 -translate-x-1/2 -translate-y-full transition-opacity duration-150 flex flex-col items-center';

            const badge = document.createElement('div');
            badge.className = 'bg-slate-950/85 border border-emerald-400/60 px-2.5 py-0.5 rounded-full shadow-lg flex items-center gap-1.5';
            const dot = document.createElement('span');
            dot.className = 'w-2 h-2 rounded-full bg-emerald-400';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'font-mono-code font-bold text-xs text-white tracking-tight';
            nameSpan.textContent = '@' + username;
            badge.appendChild(dot);
            badge.appendChild(nameSpan);

            speechBubble = document.createElement('div');
            speechBubble.className = 'hidden mt-1 bg-white text-slate-900 font-bold text-xs px-2.5 py-1 rounded-lg shadow-md max-w-[220px] text-center break-words';

            tagWrapper.appendChild(badge);
            tagWrapper.appendChild(speechBubble);
            if (labelsContainer) labelsContainer.appendChild(tagWrapper);
        }

        const rp = {
            username,
            accentHex,
            group,
            head,
            leftArm,
            rightArm,
            leftLeg,
            rightLeg,
            tagWrapper,
            speechBubble,
            lastSpeechText: '',
            mode: 'pedestrian',
            carId: null,
            anim: 'idle',
            walkCycle: 0,
            target: {
                x: 0,
                y: 0,
                z: 18,
                vx: 0,
                vz: 0,
                yaw: Math.PI,
                timestamp: performance.now()
            },
            applyNetworkMove(msg) {
                const now = performance.now();
                const vehicles = World.vehicles;
                if (msg.mode === 'driving' && msg.car_id) {
                    if (this.carId && this.carId !== msg.car_id) {
                        const prevCar = vehicles.find(v => v.id === this.carId);
                        if (prevCar && prevCar.remoteDriver === this.username) {
                            prevCar.remoteDriver = null;
                            prevCar.netTarget = null;
                            prevCar.snapshotBuffer = null;
                            prevCar.vx = prevCar.vz = prevCar.yawRate = prevCar.speed = 0;
                            prevCar.isAwake = false;
                            resetVehiclePose(prevCar);
                        }
                    }
                    this.mode = 'driving';
                    this.carId = String(msg.car_id);
                    this.group.visible = false;

                    const car = vehicles.find(v => v.id === this.carId);
                    if (car) {
                        if (GAME_STATE.inVehicle === car && this.username !== GAME_STATE.username) {
                            showToast(`⚠️ Машина занята игроком @${this.username}!`, 'amber');
                            toggleVehicleDrive(car, (force) => MultiplayerClient.sendMoveSnapshot(force));
                        }
                        if (car.remoteDriver !== this.username || !car.snapshotBuffer) {
                            car.snapshotBuffer = new VehicleSnapshotBuffer();
                        }
                        if (!car.snapshotBuffer.push(msg, now)) return;
                        car.remoteDriver = this.username;
                        car.netTarget = {
                            x: Number(msg.x) || 0,
                            y: (msg.y !== undefined && Number.isFinite(Number(msg.y)))
                                ? Number(msg.y)
                                : ((car.spawnY !== undefined && Number.isFinite(car.spawnY)) ? car.spawnY : 0.02),
                            z: Number(msg.z) || 0,
                            speed: Number(msg.speed) || 0,
                            yaw: Number(msg.yaw) || 0,
                            drift: Boolean(msg.drift),
                            lights: msg.lights !== undefined ? Boolean(msg.lights) : true,
                            timestamp: now
                        };
                        this.target.x = car.netTarget.x;
                        this.target.y = car.netTarget.y;
                        this.target.z = car.netTarget.z;
                    }
                } else {
                    if (this.carId) {
                        const prevCar = vehicles.find(v => v.id === this.carId);
                        if (prevCar && prevCar.remoteDriver === this.username) {
                            prevCar.remoteDriver = null;
                            prevCar.netTarget = null;
                            prevCar.snapshotBuffer = null;
                            prevCar.vx = prevCar.vz = prevCar.yawRate = prevCar.speed = 0;
                            prevCar.isAwake = false;
                            resetVehiclePose(prevCar);
                        }
                        this.carId = null;
                    }
                    const wasHidden = !this.group.visible;
                    this.mode = 'pedestrian';
                    this.group.visible = true;
                    this.anim = ['idle', 'walk', 'run', 'jump', 'emote'].includes(msg.anim) ? msg.anim : 'idle';
                    this.target.x = Number(msg.x) || 0;
                    this.target.y = Number(msg.y) || 0;
                    this.target.z = Number(msg.z) || 0;
                    this.target.vx = Number(msg.vx) || 0;
                    this.target.vz = Number(msg.vz) || 0;
                    this.target.yaw = Number(msg.yaw) || 0;
                    this.target.timestamp = now;

                    if (wasHidden) {
                        this.group.position.set(this.target.x, this.target.y, this.target.z);
                        this.group.rotation.y = this.target.yaw;
                    }
                }
            },
            triggerSpeech(text) {
                this.lastSpeechText = text;
                if (!this.speechBubble) return;
                this.speechBubble.textContent = text;
                this.speechBubble.classList.remove('hidden');
                clearTimeout(this.speechBubble._timer);
                this.speechBubble._timer = setTimeout(() => {
                    this.speechBubble.classList.add('hidden');
                }, 4200);
            },
            update(dt) {
                const vehicles = World.vehicles;
                if (this.mode === 'driving' && this.carId) {
                    const car = vehicles.find(v => v.id === this.carId);
                    if (car) {
                        this.group.position.copy(car.group.position);
                    }
                    return;
                }

                const ageSec = Math.min(0.25, (performance.now() - this.target.timestamp) / 1000);
                const predX = this.target.x + this.target.vx * ageSec;
                const predZ = this.target.z + this.target.vz * ageSec;

                this.group.position.x += (predX - this.group.position.x) * Math.min(1, dt * 14);
                this.group.position.y += (this.target.y - this.group.position.y) * Math.min(1, dt * 14);
                this.group.position.z += (predZ - this.group.position.z) * Math.min(1, dt * 14);

                let yawDiff = this.target.yaw - this.group.rotation.y;
                yawDiff = Math.atan2(Math.sin(yawDiff), Math.cos(yawDiff));
                this.group.rotation.y += yawDiff * Math.min(1, dt * 14);

                if (this.anim === 'emote') {
                    const t = performance.now() * 0.012;
                    this.leftArm.rotation.x = Math.PI * 0.75 + Math.sin(t) * 0.5;
                    this.rightArm.rotation.x = Math.PI * 0.75 + Math.cos(t) * 0.5;
                    this.leftLeg.rotation.x = Math.sin(t) * 0.35;
                    this.rightLeg.rotation.x = -Math.sin(t) * 0.35;
                } else if (this.anim === 'jump') {
                    this.leftArm.rotation.x = -0.6;
                    this.rightArm.rotation.x = -0.6;
                    this.leftLeg.rotation.x = 0.4;
                    this.rightLeg.rotation.x = -0.3;
                } else if (this.anim === 'run' || this.anim === 'walk') {
                    const isRun = this.anim === 'run';
                    this.walkCycle += dt * (isRun ? 15 : 9.5);
                    const swing = Math.sin(this.walkCycle) * (isRun ? 0.85 : 0.55);
                    this.leftLeg.rotation.x = swing;
                    this.rightLeg.rotation.x = -swing;
                    this.leftArm.rotation.x = -swing * 0.8;
                    this.rightArm.rotation.x = swing * 0.8;
                } else {
                    this.leftLeg.rotation.x *= 0.85;
                    this.rightLeg.rotation.x *= 0.85;
                    this.leftArm.rotation.x *= 0.85;
                    this.rightArm.rotation.x *= 0.85;
                }
            }
        };

        this.remotePlayers.set(username, rp);
        this.updateOnlineRosterUI();
        return rp;
    },

    removeRemotePlayer(username) {
        const rp = this.remotePlayers.get(username);
        if (!rp) return;
        if (rp.carId) {
            const car = World.vehicles.find(v => v.id === rp.carId);
            if (car && car.remoteDriver === username) {
                car.remoteDriver = null;
                car.netTarget = null;
                car.snapshotBuffer = null;
                car.vx = car.vz = car.yawRate = car.speed = 0;
                car.isAwake = false;
                car.isDrifting = false;
                car.tractionLoss = 0;
                resetVehiclePose(car);
            }
        }
        if (rp.group) {
            if (World.scene && typeof World.scene.remove === 'function') {
                World.scene.remove(rp.group);
            }
            if (typeof rp.group.traverse === 'function') {
                rp.group.traverse(child => {
                    if (child.geometry && typeof child.geometry.dispose === 'function') {
                        child.geometry.dispose();
                    }
                    if (child.material) {
                        if (Array.isArray(child.material)) {
                            child.material.forEach(mat => {
                                if (mat.map && typeof mat.map.dispose === 'function') mat.map.dispose();
                                if (typeof mat.dispose === 'function') mat.dispose();
                            });
                        } else {
                            if (child.material.map && typeof child.material.map.dispose === 'function') {
                                child.material.map.dispose();
                            }
                            if (typeof child.material.dispose === 'function') {
                                child.material.dispose();
                            }
                        }
                    }
                });
            }
        }
        if (rp.tagWrapper) rp.tagWrapper.remove();
        this.remotePlayers.delete(username);
    },

    updateOnlineRosterUI() {
        if (typeof document === 'undefined') return;
        const count = Math.max(1, this.onlineUsers.size);
        const badge = document.getElementById('online-count-badge');
        const mobileBadge = document.getElementById('online-count-mobile');
        if (badge) badge.textContent = String(count);
        if (mobileBadge) mobileBadge.textContent = String(count);

        const bar = document.getElementById('mp-online-users-bar');
        if (!bar) return;
        bar.innerHTML = '';
        this.onlineUsers.forEach(user => {
            const chip = document.createElement('button');
            chip.type = 'button';
            const isMe = user === GAME_STATE.username;
            chip.className = isMe
                ? 'bg-sky-500/25 border border-sky-400/50 text-sky-200 px-2 py-0.5 rounded-full text-[10px] font-mono-code font-bold shrink-0'
                : 'bg-slate-800/90 hover:bg-slate-700 border border-emerald-400/40 text-emerald-300 px-2 py-0.5 rounded-full text-[10px] font-mono-code font-bold shrink-0';
            chip.textContent = '@' + user;
            if (!isMe) {
                chip.title = `Упомянуть @${user} в чате`;
                chip.addEventListener('click', () => {
                    const input = document.getElementById('mp-chat-input');
                    this.showChat(true);
                    if (input) {
                        if (!input.value.startsWith(`@${user} `)) {
                            input.value = `@${user} ` + input.value;
                        }
                        input.focus();
                    }
                });
            }
            bar.appendChild(chip);
        });
    },

    appendChatMessage(sender, text) {
        if (typeof document === 'undefined') return;
        this.showChat(false);
        const list = document.getElementById('mp-chat-messages');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'leading-relaxed break-words';

        const nameEl = document.createElement('span');
        nameEl.className = sender === GAME_STATE.username
            ? 'font-mono-code font-bold text-sky-400 mr-1'
            : 'font-mono-code font-bold text-emerald-400 mr-1';
        nameEl.textContent = `@${sender}:`;

        const textEl = document.createElement('span');
        textEl.className = 'text-slate-100';
        textEl.textContent = text;

        row.appendChild(nameEl);
        row.appendChild(textEl);
        list.appendChild(row);
        while (list.children.length > 60) {
            list.removeChild(list.firstChild);
        }
        list.scrollTop = list.scrollHeight;
    },

    appendChatSystemMessage(text) {
        if (typeof document === 'undefined') return;
        this.showChat(false);
        const list = document.getElementById('mp-chat-messages');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'text-[11px] sm:text-xs font-mono-code text-amber-300/90 leading-relaxed';
        row.textContent = text;
        list.appendChild(row);
        list.scrollTop = list.scrollHeight;
    },

    sendChat(text) {
        const trimmed = String(text || '').trim().slice(0, 500);
        if (!trimmed) return;

        if (this.isLocalBridge) {
            const outMsg = {
                username: GAME_STATE.username,
                type: 'chat',
                from: GAME_STATE.username,
                text: trimmed
            };
            const encoded = MsgPackCodec.encode(outMsg);
            if (this.broadcastChannel) {
                this.broadcastChannel.postMessage(encoded);
            }
            this.handleServerMessage(MsgPackCodec.decode(encoded));
            GAME_STATE.lastActiveEventAt = performance.now();
            return;
        }

        if (!this.ws || this.ws.readyState !== 1) return;
        const payload = {
            type: 'chat',
            text: trimmed
        };
        this.safeSend(MsgPackCodec.encode(payload));
        GAME_STATE.lastActiveEventAt = performance.now();
    },

    getLocalPedestrianAnim() {
        return computePedestrianAnim({
            emoteTimer: Player.emoteTimer,
            isGrounded: Player.isGrounded,
            vx: Player.velocity ? Player.velocity.x : 0,
            vz: Player.velocity ? Player.velocity.z : 0
        });
    },

    sendMoveSnapshot(force = false) {
        if (!GAME_STATE.isConnected) return;
        if (!this.isLocalBridge && (!this.ws || this.ws.readyState !== 1)) return;
        if (!Player.position || !Player.velocity) return;

        const now = performance.now();
        const heartbeatDue = (now - GAME_STATE.lastPacketSentAt) >= 15000;
        if (!force && !heartbeatDue && now - GAME_STATE.lastPacketSentAt < this.sendIntervalMs) return;

        if (GAME_STATE.inVehicle) {
            const car = GAME_STATE.inVehicle;
            const isBoostActive = Boolean(GAME_STATE.keys.shift || GAME_STATE.joystickSprint);
            const isDrifting = (car.isDrifting !== undefined) ? Boolean(car.isDrifting) : (Math.abs(car.speed) > 7.5 && (GAME_STATE.keys.space || isBoostActive));

            const state = {
                type: 'move',
                mode: 'driving',
                car_id: car.id,
                x: Number((car.x ?? car.group.position.x).toFixed(3)),
                y: Number((car.y ?? car.group.position.y).toFixed(3)),
                z: Number((car.z ?? car.group.position.z).toFixed(3)),
                speed: Number(car.speed.toFixed(2)),
                vx: car.vx || 0,
                vz: car.vz || 0,
                yaw_rate: car.yawRate || 0,
                yaw: Number((car.yaw ?? car.group.rotation.y).toFixed(3)),
                drift: Boolean(isDrifting),
                lights: Boolean(GAME_STATE.headlightsOn)
            };

            const changed = force || heartbeatDue || !this.lastSentState ||
                this.lastSentState.mode !== 'driving' ||
                Math.abs(this.lastSentState.x - state.x) > 0.02 ||
                Math.abs(this.lastSentState.z - state.z) > 0.02 ||
                Math.abs(this.lastSentState.yaw - state.yaw) > 0.015 ||
                Math.abs((this.lastSentState.vx || 0) - state.vx) > 0.05 ||
                Math.abs((this.lastSentState.vz || 0) - state.vz) > 0.05 ||
                Math.abs((this.lastSentState.yaw_rate || 0) - state.yaw_rate) > 0.01 ||
                this.lastSentState.lights !== state.lights ||
                this.lastSentState.drift !== state.drift;

            if (changed) {
                if (this.isLocalBridge) {
                    if (this.broadcastChannel) {
                        this.broadcastChannel.postMessage(MsgPackCodec.encode({ ...state, username: GAME_STATE.username }));
                    }
                } else {
                    this.safeSend(MsgPackCodec.encode(state));
                }
                this.lastSentState = state;
                GAME_STATE.lastPacketSentAt = now;
                GAME_STATE.lastActiveEventAt = now;
            }
        } else {
            const anim = this.getLocalPedestrianAnim();
            const state = {
                type: 'move',
                mode: 'pedestrian',
                x: Number(Player.position.x.toFixed(3)),
                y: Number(Player.position.y.toFixed(3)),
                z: Number(Player.position.z.toFixed(3)),
                vx: Number(Player.velocity.x.toFixed(2)),
                vz: Number(Player.velocity.z.toFixed(2)),
                yaw: Number(Player.rotationY.toFixed(3)),
                anim: anim
            };

            const changed = force || heartbeatDue || !this.lastSentState ||
                this.lastSentState.mode !== 'pedestrian' ||
                this.lastSentState.anim !== state.anim ||
                Math.abs(this.lastSentState.x - state.x) > 0.02 ||
                Math.abs(this.lastSentState.y - state.y) > 0.02 ||
                Math.abs(this.lastSentState.z - state.z) > 0.02 ||
                Math.abs(this.lastSentState.yaw - state.yaw) > 0.02;

            if (changed) {
                if (this.isLocalBridge) {
                    if (this.broadcastChannel) {
                        this.broadcastChannel.postMessage(MsgPackCodec.encode({ ...state, username: GAME_STATE.username }));
                    }
                } else {
                    this.safeSend(MsgPackCodec.encode(state));
                }
                this.lastSentState = state;
                GAME_STATE.lastPacketSentAt = now;
                GAME_STATE.lastActiveEventAt = now;
            }
        }
    },

    update(dt) {
        this.sendMoveSnapshot(false);
        this.remotePlayers.forEach(rp => rp.update(dt));
    }
};

export function showChatBox(focusInput = false) {
    MultiplayerClient.showChat(focusInput);
}

export function hideChatBox() {
    MultiplayerClient.hideChat();
}

export function scheduleChatAutoHide(delayMs = 5000) {
    MultiplayerClient.scheduleChatAutoHide(delayMs);
}
