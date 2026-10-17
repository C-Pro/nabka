import * as StateModule from './state.js';

const getGameState = () => (StateModule && StateModule.GAME_STATE) || (typeof window !== 'undefined' ? window.GAME_STATE : null) || { sfxEnabled: true, audioEnabled: true };

export const SoundManager = {
    initialized: false,
    ctx: null,
    masterGain: null,
    // Ambient nodes
    seaGain: null,
    streetGain: null,
    fountainGain: null,
    // Car Engine & Tire nodes
    engineGain: null,
    engineOsc1: null,
    engineOsc2: null,
    engineSubOsc: null,
    engineFilter: null,
    turboOsc: null,
    turboGain: null,
    tireGain: null,
    tireFilter: null,
    tireLfo: null,
    // Timers & state
    lastCrashTime: 0,
    lastSeagullTime: 0,
    lastHornTime: 0,
    wasBoosting: false,
    radioInterval: null,
    radioStep: 0,
    onToast: null,

    createNoiseBuffer(type = 'pink', seconds = 3) {
        const sr = this.ctx.sampleRate;
        const len = sr * seconds;
        const buffer = this.ctx.createBuffer(1, len, sr);
        const data = buffer.getChannelData(0);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, lastOut = 0;

        for (let i = 0; i < len; i++) {
            const white = Math.random() * 2 - 1;
            if (type === 'white') {
                data[i] = white * 0.5;
            } else if (type === 'brown') {
                data[i] = (lastOut + (0.02 * white)) / 1.02;
                lastOut = data[i];
                data[i] *= 2.5;
            } else {
                // Pink noise
                b0 = 0.99886 * b0 + white * 0.0555179;
                b1 = 0.99332 * b1 + white * 0.0750759;
                b2 = 0.96900 * b2 + white * 0.1538520;
                b3 = 0.86650 * b3 + white * 0.3104856;
                b4 = 0.55000 * b4 + white * 0.5329522;
                b5 = -0.7616 * b5 - white * 0.0168980;
                data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.04;
                b6 = white * 0.115926;
            }
        }
        return buffer;
    },

    async ensureInit() {
        if (this.initialized) {
            if (this.ctx && this.ctx.state === 'suspended') {
                await this.ctx.resume();
            }
            return;
        }
        if (typeof window === 'undefined') return;
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            this.ctx = new AudioCtx();
            if (this.ctx.state === 'suspended') {
                await this.ctx.resume();
            }

            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = getGameState().sfxEnabled ? 1.0 : 0.0;
            this.masterGain.connect(this.ctx.destination);

            const pinkBuf = this.createNoiseBuffer('pink', 4);
            const whiteBuf = this.createNoiseBuffer('white', 3);
            const brownBuf = this.createNoiseBuffer('brown', 4);

            // 1. Seashore Surf (Modulated waves of Amur Bay)
            this.seaGain = this.ctx.createGain();
            this.seaGain.gain.value = 0.11;
            const seaFilter = this.ctx.createBiquadFilter();
            seaFilter.type = 'lowpass';
            seaFilter.frequency.value = 420;

            const seaLfo = this.ctx.createOscillator();
            seaLfo.type = 'sine';
            seaLfo.frequency.value = 0.16; // Wave period ~6.2s
            const seaLfoDepth = this.ctx.createGain();
            seaLfoDepth.gain.value = 260;
            seaLfo.connect(seaFilter.frequency);
            seaLfo.start();

            const seaSource = this.ctx.createBufferSource();
            seaSource.buffer = pinkBuf;
            seaSource.loop = true;
            seaSource.connect(seaFilter);
            seaFilter.connect(this.seaGain);
            this.seaGain.connect(this.masterGain);
            seaSource.start();

            // 2. Bustling Promenade Crowd & Street Traffic Ambience
            this.streetGain = this.ctx.createGain();
            this.streetGain.gain.value = 0.14;

            const streetFilter = this.ctx.createBiquadFilter();
            streetFilter.type = 'bandpass';
            streetFilter.frequency.value = 520;
            streetFilter.Q.value = 0.7;

            const streetSource = this.ctx.createBufferSource();
            streetSource.buffer = pinkBuf;
            streetSource.loop = true;
            streetSource.connect(streetFilter);
            streetFilter.connect(this.streetGain);

            const rumbleFilter = this.ctx.createBiquadFilter();
            rumbleFilter.type = 'lowpass';
            rumbleFilter.frequency.value = 190;
            const rumbleGain = this.ctx.createGain();
            rumbleGain.gain.value = 0.35;
            const rumbleSource = this.ctx.createBufferSource();
            rumbleSource.buffer = brownBuf;
            rumbleSource.loop = true;
            rumbleSource.connect(rumbleFilter);
            rumbleFilter.connect(rumbleGain);
            rumbleGain.connect(this.streetGain);

            this.streetGain.connect(this.masterGain);
            streetSource.start();
            rumbleSource.start();

            // 3. Spatial Central Fountain Water Splash
            this.fountainGain = this.ctx.createGain();
            this.fountainGain.gain.value = 0.08;
            const fntFilter = this.ctx.createBiquadFilter();
            fntFilter.type = 'bandpass';
            fntFilter.frequency.value = 1450;
            fntFilter.Q.value = 1.1;
            const fntSource = this.ctx.createBufferSource();
            fntSource.buffer = whiteBuf;
            fntSource.loop = true;
            fntSource.connect(fntFilter);
            fntFilter.connect(this.fountainGain);
            this.fountainGain.connect(this.masterGain);
            fntSource.start();

            // 4. Realistic JDM Inline-6 Engine (1JZ-GTE / RB26) + Turbo Whine
            this.engineGain = this.ctx.createGain();
            this.engineGain.gain.value = 0;

            this.engineFilter = this.ctx.createBiquadFilter();
            this.engineFilter.type = 'lowpass';
            this.engineFilter.frequency.value = 320;
            this.engineFilter.Q.value = 3.2;

            this.engineOsc1 = this.ctx.createOscillator();
            this.engineOsc1.type = 'sawtooth';
            this.engineOsc1.frequency.value = 55;

            this.engineOsc2 = this.ctx.createOscillator();
            this.engineOsc2.type = 'square';
            this.engineOsc2.frequency.value = 110;
            const osc2Gain = this.ctx.createGain();
            osc2Gain.gain.value = 0.45;

            this.engineSubOsc = this.ctx.createOscillator();
            this.engineSubOsc.type = 'triangle';
            this.engineSubOsc.frequency.value = 27.5;
            const subGain = this.ctx.createGain();
            subGain.gain.value = 0.65;

            this.engineOsc1.connect(this.engineFilter);
            this.engineOsc2.connect(osc2Gain);
            osc2Gain.connect(this.engineFilter);
            this.engineSubOsc.connect(subGain);
            subGain.connect(this.engineFilter);

            this.turboOsc = this.ctx.createOscillator();
            this.turboOsc.type = 'sine';
            this.turboOsc.frequency.value = 1100;
            this.turboGain = this.ctx.createGain();
            this.turboGain.gain.value = 0;
            this.turboOsc.connect(this.turboGain);
            this.turboGain.connect(this.masterGain);

            this.engineFilter.connect(this.engineGain);
            this.engineGain.connect(this.masterGain);

            this.engineOsc1.start();
            this.engineOsc2.start();
            this.engineSubOsc.start();
            this.turboOsc.start();

            // 5. Tire Screech on Braking & Drifting
            this.tireGain = this.ctx.createGain();
            this.tireGain.gain.value = 0;

            this.tireFilter = this.ctx.createBiquadFilter();
            this.tireFilter.type = 'bandpass';
            this.tireFilter.frequency.value = 1750;
            this.tireFilter.Q.value = 9.5;

            const tireSource = this.ctx.createBufferSource();
            tireSource.buffer = whiteBuf;
            tireSource.loop = true;

            this.tireLfo = this.ctx.createOscillator();
            this.tireLfo.type = 'sawtooth';
            this.tireLfo.frequency.value = 1580;
            const tireOscGain = this.ctx.createGain();
            tireOscGain.gain.value = 0.25;

            tireSource.connect(this.tireFilter);
            this.tireLfo.connect(tireOscGain);
            tireOscGain.connect(this.tireFilter);
            this.tireFilter.connect(this.tireGain);
            this.tireGain.connect(this.masterGain);

            tireSource.start();
            this.tireLfo.start();

            this.initialized = true;
            if (typeof document !== 'undefined') {
                const sfxLabel = document.getElementById('sfx-label');
                if (sfxLabel) sfxLabel.textContent = getGameState().sfxEnabled ? 'Прибой & Звук: ВКЛ' : 'Прибой & Звук: ВЫКЛ';
            }
        } catch (err) {
            console.warn('Audio init warning:', err);
        }
    },

    async toggleSfx() {
        await this.ensureInit();
        const gs = getGameState();
        gs.sfxEnabled = !gs.sfxEnabled;
        if (this.masterGain && this.ctx) {
            this.masterGain.gain.setTargetAtTime(gs.sfxEnabled ? 1.0 : 0.0, this.ctx.currentTime, 0.08);
        }
        if (typeof document !== 'undefined') {
            const sfxIcon = document.getElementById('sfx-icon');
            const sfxLabel = document.getElementById('sfx-label');
            if (gs.sfxEnabled) {
                if (sfxIcon) sfxIcon.className = 'fa-solid fa-water text-teal-200';
                if (sfxLabel) sfxLabel.textContent = 'Прибой & Звук: ВКЛ';
                if (this.onToast) this.onToast('🌊 Звук прибоя, чаек, улицы и моторов JDM включён', 'emerald');
            } else {
                if (sfxIcon) sfxIcon.className = 'fa-solid fa-volume-mute text-slate-400';
                if (sfxLabel) sfxLabel.textContent = 'Прибой & Звук: ВЫКЛ';
            }
        }
    },

    async toggleAudio() {
        await this.ensureInit();
        const gs = getGameState();
        gs.audioEnabled = !gs.audioEnabled;
        if (typeof document !== 'undefined') {
            const icon = document.getElementById('audio-icon');
            const label = document.getElementById('radio-label');
            if (gs.audioEnabled) {
                if (icon) icon.className = 'fa-solid fa-music text-emerald-400 animate-pulse';
                if (label) label.textContent = 'VVO FM 101.7: ВКЛ';
                if (this.onToast) this.onToast('📻 Радио VVO FM 101.7 — Вечерний Владивосток', 'sky');
                if (!this.radioInterval) {
                    const freqs = [130.81, 196.00, 233.08, 196.00, 174.61, 261.63, 311.13, 293.66];
                    this.radioInterval = setInterval(() => {
                        const curState = getGameState();
                        if (!curState.audioEnabled || !this.initialized || !curState.sfxEnabled) return;
                        const now = this.ctx.currentTime;
                        const f = freqs[this.radioStep % freqs.length];
                        const osc = this.ctx.createOscillator();
                        const g = this.ctx.createGain();
                        osc.type = 'sawtooth';
                        osc.frequency.setValueAtTime(f, now);
                        g.gain.setValueAtTime(0.06, now);
                        g.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
                        osc.connect(g);
                        g.connect(this.masterGain);
                        osc.start(now);
                        osc.stop(now + 0.25);
                        this.radioStep++;
                    }, 270);
                }
            } else {
                if (icon) icon.className = 'fa-solid fa-radio text-slate-400';
                if (label) label.textContent = 'VVO FM: ВЫКЛ';
            }
        }
    },

    updateSpatialAmbience(playerPos) {
        if (!this.initialized || !getGameState().sfxEnabled || !this.ctx) return;
        const now = this.ctx.currentTime;

        const seaFactor = Math.max(0.035, Math.min(0.18, (22 - playerPos.x) / 170));
        this.seaGain.gain.setTargetAtTime(seaFactor, now, 0.15);

        const streetFactor = Math.max(0.07, Math.min(0.22, (playerPos.x + 35) / 210));
        this.streetGain.gain.setTargetAtTime(streetFactor, now, 0.15);

        const distToFountain = Math.hypot(playerPos.x, playerPos.z);
        const fntVol = distToFountain < 32 ? Math.max(0, (1 - distToFountain / 32) * 0.18) : 0;
        this.fountainGain.gain.setTargetAtTime(fntVol, now, 0.1);

        const timeMs = performance.now();
        if (timeMs - this.lastSeagullTime > 5200 + Math.random() * 4500) {
            this.lastSeagullTime = timeMs;
            this.playSeagullCry();
        }

        if (timeMs - this.lastHornTime > 22000 + Math.random() * 14000) {
            this.lastHornTime = timeMs;
            this.playDistantShipHorn();
        }
    },

    updateVehicleAudio(car, isThrottle, isBraking, isDrifting, isBoost) {
        if (!this.initialized || !getGameState().sfxEnabled || !this.ctx) return;
        const now = this.ctx.currentTime;

        if (!car) {
            this.engineGain.gain.setTargetAtTime(0, now, 0.1);
            this.turboGain.gain.setTargetAtTime(0, now, 0.1);
            this.tireGain.gain.setTargetAtTime(0, now, 0.08);
            return;
        }

        const absSpeed = Math.abs(car.speed);
        const gearRatio = (absSpeed % 8.5) / 8.5;
        const rpmFreq = 46 + absSpeed * 2.5 + gearRatio * 48 + (isThrottle ? 22 : 0) + (isBoost ? 30 : 0);

        this.engineOsc1.frequency.setTargetAtTime(rpmFreq, now, 0.04);
        this.engineOsc2.frequency.setTargetAtTime(rpmFreq * 2.0, now, 0.04);
        this.engineSubOsc.frequency.setTargetAtTime(rpmFreq * 0.5, now, 0.04);
        this.engineFilter.frequency.setTargetAtTime(280 + absSpeed * 38 + (isThrottle ? 420 : 0) + (isBoost ? 350 : 0), now, 0.05);

        const targetEngineGain = 0.16 + Math.min(0.22, absSpeed * 0.006) + (isThrottle ? 0.08 : 0);
        this.engineGain.gain.setTargetAtTime(targetEngineGain, now, 0.05);

        const turboFreq = 950 + absSpeed * 55 + gearRatio * 450;
        this.turboOsc.frequency.setTargetAtTime(turboFreq, now, 0.06);
        const targetTurboGain = (isThrottle && absSpeed > 4) ? (isBoost ? 0.055 : 0.025) : 0;
        this.turboGain.gain.setTargetAtTime(targetTurboGain, now, 0.06);

        if (this.wasBoosting && !isThrottle && absSpeed > 10) {
            this.playActionSound('blowoff');
        }
        this.wasBoosting = isThrottle && (isBoost || absSpeed > 16);

        if ((isBraking || isDrifting) && absSpeed > 2.5) {
            const screechVol = Math.min(0.28, 0.08 + (absSpeed / 26) * 0.22);
            const warble = 1480 + Math.sin(performance.now() * 0.045) * 320;
            this.tireFilter.frequency.setTargetAtTime(warble, now, 0.03);
            this.tireLfo.frequency.setTargetAtTime(warble * 0.95, now, 0.03);
            this.tireGain.gain.setTargetAtTime(screechVol, now, 0.03);
        } else {
            this.tireGain.gain.setTargetAtTime(0, now, 0.06);
        }
    },

    playCrashSound(impactSpeed = 10) {
        if (!this.initialized || !getGameState().sfxEnabled || !this.ctx) return;
        const nowMs = performance.now();
        if (nowMs - this.lastCrashTime < 280) return;
        this.lastCrashTime = nowMs;

        try {
            const now = this.ctx.currentTime;
            const intensity = Math.min(1.0, Math.max(0.35, impactSpeed / 18));

            const impactOsc = this.ctx.createOscillator();
            const impactGain = this.ctx.createGain();
            impactOsc.type = 'triangle';
            impactOsc.frequency.setValueAtTime(135, now);
            impactOsc.frequency.exponentialRampToValueAtTime(28, now + 0.32);

            impactGain.gain.setValueAtTime(0.55 * intensity, now);
            impactGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

            impactOsc.connect(impactGain);
            impactGain.connect(this.masterGain);
            impactOsc.start(now);
            impactOsc.stop(now + 0.36);

            const crunchSource = this.ctx.createBufferSource();
            crunchSource.buffer = this.createNoiseBuffer('white', 0.45);
            const crunchFilter = this.ctx.createBiquadFilter();
            crunchFilter.type = 'bandpass';
            crunchFilter.frequency.setValueAtTime(920, now);
            crunchFilter.Q.value = 1.4;

            const crunchGain = this.ctx.createGain();
            crunchGain.gain.setValueAtTime(0.45 * intensity, now);
            crunchGain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);

            crunchSource.connect(crunchFilter);
            crunchFilter.connect(crunchGain);
            crunchGain.connect(this.masterGain);
            crunchSource.start(now);
        } catch (e) {}
    },

    playSeagullCry() {
        if (!this.initialized || !getGameState().sfxEnabled || !this.ctx) return;
        try {
            const now = this.ctx.currentTime;
            [0, 0.32].forEach((offset, idx) => {
                const t = now + offset;
                const osc = this.ctx.createOscillator();
                const filter = this.ctx.createBiquadFilter();
                const gain = this.ctx.createGain();

                osc.type = 'triangle';
                const startFreq = idx === 0 ? 1950 : 2250;
                const peakFreq = idx === 0 ? 2450 : 2650;
                const endFreq = idx === 0 ? 1450 : 1220;
                const dur = idx === 0 ? 0.24 : 0.42;

                osc.frequency.setValueAtTime(startFreq, t);
                osc.frequency.linearRampToValueAtTime(peakFreq, t + dur * 0.25);
                osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);

                filter.type = 'bandpass';
                filter.frequency.value = 2100;
                filter.Q.value = 3.5;

                gain.gain.setValueAtTime(0.001, t);
                gain.gain.linearRampToValueAtTime(0.065, t + 0.04);
                gain.gain.exponentialRampToValueAtTime(0.001, t + dur);

                osc.connect(filter);
                filter.connect(gain);
                gain.connect(this.masterGain);

                osc.start(t);
                osc.stop(t + dur + 0.02);
            });
        } catch (e) {}
    },

    playDistantShipHorn() {
        if (!this.initialized || !getGameState().sfxEnabled || !this.ctx) return;
        try {
            const now = this.ctx.currentTime;
            [65.4, 98.0].forEach(freq => {
                const osc = this.ctx.createOscillator();
                const filter = this.ctx.createBiquadFilter();
                const gain = this.ctx.createGain();

                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(freq, now);
                filter.type = 'lowpass';
                filter.frequency.value = 210;

                gain.gain.setValueAtTime(0.001, now);
                gain.gain.linearRampToValueAtTime(0.045, now + 0.4);
                gain.gain.setValueAtTime(0.045, now + 1.8);
                gain.gain.exponentialRampToValueAtTime(0.0008, now + 2.9);

                osc.connect(filter);
                filter.connect(gain);
                gain.connect(this.masterGain);

                osc.start(now);
                osc.stop(now + 3.0);
            });
        } catch (e) {}
    },

    playActionSound(type) {
        if (!this.initialized || !getGameState().sfxEnabled || !this.ctx) return;
        try {
            const now = this.ctx.currentTime;
            if (type === 'jump') {
                const osc = this.ctx.createOscillator();
                const g = this.ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(220, now);
                osc.frequency.exponentialRampToValueAtTime(480, now + 0.14);
                g.gain.setValueAtTime(0.12, now);
                g.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
                osc.connect(g);
                g.connect(this.masterGain);
                osc.start(now);
                osc.stop(now + 0.16);
            } else if (type === 'cash') {
                [659.25, 880].forEach((f, idx) => {
                    const osc = this.ctx.createOscillator();
                    const g = this.ctx.createGain();
                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(f, now + idx * 0.08);
                    g.gain.setValueAtTime(0.12, now + idx * 0.08);
                    g.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.22);
                    osc.connect(g);
                    g.connect(this.masterGain);
                    osc.start(now + idx * 0.08);
                    osc.stop(now + idx * 0.08 + 0.24);
                });
            } else if (type === 'car') {
                [420, 520].forEach(f => {
                    const osc = this.ctx.createOscillator();
                    const g = this.ctx.createGain();
                    osc.type = 'sawtooth';
                    osc.frequency.setValueAtTime(f, now);
                    g.gain.setValueAtTime(0.08, now);
                    g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
                    osc.connect(g);
                    g.connect(this.masterGain);
                    osc.start(now);
                    osc.stop(now + 0.3);
                });
            } else if (type === 'blowoff') {
                for (let i = 0; i < 3; i++) {
                    const t = now + i * 0.065;
                    const src = this.ctx.createBufferSource();
                    src.buffer = this.createNoiseBuffer('white', 0.06);
                    const flt = this.ctx.createBiquadFilter();
                    flt.type = 'bandpass';
                    flt.frequency.value = 2600 - i * 350;
                    flt.Q.value = 4.0;
                    const g = this.ctx.createGain();
                    g.gain.setValueAtTime(0.16 * (1 - i * 0.25), t);
                    g.gain.exponentialRampToValueAtTime(0.001, t + 0.055);
                    src.connect(flt);
                    flt.connect(g);
                    g.connect(this.masterGain);
                    src.start(t);
                }
            } else if (type === 'bark') {
                [0, 0.16].forEach((offset, idx) => {
                    const t = now + offset;
                    const osc = this.ctx.createOscillator();
                    const g = this.ctx.createGain();
                    osc.type = 'triangle';
                    const startF = idx === 0 ? 720 : 840;
                    const peakF = idx === 0 ? 1180 : 1320;
                    osc.frequency.setValueAtTime(startF, t);
                    osc.frequency.exponentialRampToValueAtTime(peakF, t + 0.05);
                    osc.frequency.exponentialRampToValueAtTime(520, t + 0.12);

                    g.gain.setValueAtTime(0.001, t);
                    g.gain.linearRampToValueAtTime(0.11, t + 0.02);
                    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);

                    osc.connect(g);
                    g.connect(this.masterGain);
                    osc.start(t);
                    osc.stop(t + 0.14);
                });
            }
        } catch (e) {}
    }
};
