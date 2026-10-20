import * as StateModule from './state.js';

const getGameState = () => (StateModule && StateModule.GAME_STATE) || (typeof window !== 'undefined' ? window.GAME_STATE : null) || { sfxEnabled: true, audioEnabled: true };

export const GEAR_SEGMENTS = {
    1: { start: 0.0, end: 4.17 },
    2: { start: 4.17, end: 10.01 },
    3: { start: 10.01, end: 20.83 },
    4: { start: 20.83, end: null }, // bound to driving buffer duration
};

export function calculateTargetGear(currentGear, speed) {
    const absSpeed = Math.abs(speed || 0);
    const gear = Number(currentGear) || 1;
    if (gear === 1) {
        if (absSpeed > 6.0) return 2;
        return 1;
    }
    if (gear === 2) {
        if (absSpeed > 12.0) return 3;
        if (absSpeed < 4.5) return 1;
        return 2;
    }
    if (gear === 3) {
        if (absSpeed > 18.0) return 4;
        if (absSpeed < 10.0) return 2;
        return 3;
    }
    if (gear === 4) {
        if (absSpeed < 16.0) return 3;
        return 4;
    }
    return 1;
}

export function calculateDriftState(car, currentlyDrifting = false) {
    if (!car) return { isDrifting: false, lateralSpeed: 0, totalSpeed: 0 };
    const vx = Number(car.vx) || 0;
    const vz = Number(car.vz) || 0;
    const yaw = Number(car.yaw) || 0;
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    const vLat = vx * cosY - vz * sinY;
    const lateralSpeed = Math.abs(vLat);
    const totalSpeed = Math.hypot(vx, vz);

    let isDrifting = false;
    if (currentlyDrifting) {
        // Lower threshold for release prevents stuttering on boundary fluctuations
        isDrifting = totalSpeed >= 2.0 && (Boolean(car.isDrifting) || lateralSpeed >= 0.5);
    } else {
        // Higher threshold for onset requires definite lateral slide or drift intent
        isDrifting = totalSpeed > 2.5 && ((Boolean(car.isDrifting) && lateralSpeed > 0.8) || lateralSpeed > 1.8);
    }
    return { isDrifting, lateralSpeed, totalSpeed };
}

export const SoundManager = {
    initialized: false,
    ctx: null,
    masterGain: null,

    // Real audio asset buffers
    ambienceBuffer: null,
    ambienceSource: null,
    ambienceGain: null,
    ambiencePlaying: false,

    shortSeagullBuffers: [],
    lastShortSeagullIndex: -1,

    longSeagullBuffers: [],
    lastLongSeagullIndex: -1,
    lastLongSeagullTime: 0,
    nextLongSeagullInterval: 120000, // Initial delay ~2 min, then ~3 min thereafter
    longSeagullEndTime: 0,

    // Vehicle audio engine
    vehicleGain: null,
    roadsterGain: null, // alias for backwards-compat with existing test references
    roadsterStartBuffer: null,
    roadsterStartStatus: 'unloaded', // 'unloaded' | 'loading' | 'ready' | 'failed'
    roadsterIdleBuffer: null,
    roadsterDrivingBuffer: null,
    driftBuffers: [],
    lastDriftIndex: -1,
    lastDriftEndTime: 0,
    isDriftingAudioActive: false,

    currentCar: null,
    vehicleState: 'off', // 'off' | 'starting' | 'idle' | 'driving'
    currentGear: 1,
    lastGearChangeTime: 0,
    activeEngineVoice: null,
    scheduledIdleVoice: null,
    activeDriftVoice: null,
    fadingVoices: [],

    // Synthetic Ambient nodes (fallback & fountain splash)
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
        if (!this.ctx) return null;
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

    async loadAudioBuffer(url) {
        if (!this.ctx) return null;
        try {
            const res = await fetch(url);
            if (!res.ok) {
                console.warn(`Failed to fetch audio ${url}: ${res.status}`);
                return null;
            }
            const arrayBuffer = await res.arrayBuffer();
            return await new Promise((resolve, reject) => {
                const promise = this.ctx.decodeAudioData(arrayBuffer, resolve, reject);
                if (promise && typeof promise.then === 'function') {
                    promise.then(resolve).catch(reject);
                }
            });
        } catch (err) {
            console.warn(`Error loading audio ${url}:`, err);
            return null;
        }
    },

    loadAllSoundAssets() {
        if (!this.ctx) return;

        // 1. Nabka Ambience Loop
        this.loadAudioBuffer('audio/nabka_ambience.mp3').then((buf) => {
            if (!buf) return;
            this.ambienceBuffer = buf;
            if (this.initialized) {
                this.startAmbienceLoop();
            }
        });

        // 2. Short Seagull Calls (ch1, ch2, ch3)
        const shortUrls = ['audio/ch1.mp3', 'audio/ch2.mp3', 'audio/ch3.mp3'];
        Promise.all(shortUrls.map(url => this.loadAudioBuffer(url))).then((buffers) => {
            const valid = buffers.filter(Boolean);
            if (valid.length > 0) {
                this.shortSeagullBuffers = valid;
            }
        });

        // 3. Long Seagull Calls (ch_long1, ch_long2)
        const longUrls = ['audio/ch_long1.mp3', 'audio/ch_long2.mp3'];
        Promise.all(longUrls.map(url => this.loadAudioBuffer(url))).then((buffers) => {
            const valid = buffers.filter(Boolean);
            if (valid.length > 0) {
                this.longSeagullBuffers = valid;
            }
        });

        // 4. Roadster Engine Audio (start, idle, driving)
        this.roadsterStartStatus = 'loading';
        this.loadAudioBuffer('audio/roadster_start.mp3').then((buf) => {
            if (!buf) {
                this.roadsterStartStatus = 'failed';
                // If startup failed to load, transition stationary car to idle if idle buffer is available
                if (this.vehicleState === 'starting' && this.currentCar && this.roadsterIdleBuffer) {
                    this.vehicleState = 'idle';
                    this.startEngineVoice('idle', 1, 0.18);
                }
                return;
            }
            this.roadsterStartStatus = 'ready';
            this.roadsterStartBuffer = buf;
            if (this.vehicleState === 'starting' && !this.activeEngineVoice && this.currentCar) {
                this.startEngineVoice('start', 1, 0.05);
            }
        });

        this.loadAudioBuffer('audio/roadster_idle.mp3').then((buf) => {
            if (!buf) return;
            this.roadsterIdleBuffer = buf;
            if (this.vehicleState === 'idle' && !this.activeEngineVoice && this.currentCar) {
                this.startEngineVoice('idle', 1, 0.18);
            } else if (this.vehicleState === 'starting' && this.currentCar && !this.scheduledIdleVoice) {
                // Startup began before idle was decoded:
                const now = this.ctx ? this.ctx.currentTime : 0;
                if (this.activeEngineVoice && this.activeEngineVoice.type === 'start') {
                    const elapsed = now - (this.activeEngineVoice.startTime ?? now);
                    const remaining = Math.max(0, (this.activeEngineVoice.duration || 2.81) - elapsed);
                    if (remaining > 0.20) {
                        this.scheduleIdleVoice(now + remaining - 0.20, 0.20);
                    } else {
                        this.vehicleState = 'idle';
                        this.startEngineVoice('idle', 1, Math.max(0.08, remaining));
                    }
                } else if (this.roadsterStartStatus === 'failed') {
                    this.vehicleState = 'idle';
                    this.startEngineVoice('idle', 1, 0.18);
                }
            }
        });

        this.loadAudioBuffer('audio/roadster_driving.mp3').then((buf) => {
            if (!buf) return;
            this.roadsterDrivingBuffer = buf;
            if (GEAR_SEGMENTS[4]) {
                GEAR_SEGMENTS[4].end = buf.duration;
            }
            if (this.vehicleState === 'driving' && !this.activeEngineVoice && this.currentCar) {
                this.startEngineVoice('driving', this.currentGear || 1, 0.18);
            }
        });

        // 5. Drift Audio Buffers (drift1..drift4)
        const driftUrls = ['audio/drift1.mp3', 'audio/drift2.mp3', 'audio/drift3.mp3', 'audio/drift4.mp3'];
        Promise.all(driftUrls.map(url => this.loadAudioBuffer(url))).then((buffers) => {
            const valid = buffers.filter(Boolean);
            if (valid.length > 0) {
                this.driftBuffers = valid;
            }
        });
    },

    cancelScheduledIdle(fadeDuration = 0.15) {
        if (!this.scheduledIdleVoice) return;
        const voice = this.scheduledIdleVoice;
        this.scheduledIdleVoice = null;
        const now = this.ctx ? this.ctx.currentTime : 0;

        try {
            if (now < voice.startTime) {
                // Not yet started: hard cancel future values and stop immediately
                if (voice.gain && voice.gain.gain) {
                    voice.gain.gain.cancelScheduledValues(now);
                    voice.gain.gain.setValueAtTime(0, now);
                }
                if (voice.source) {
                    voice.source.stop(now);
                    voice.source.disconnect();
                }
                if (voice.gain) {
                    voice.gain.disconnect();
                }
            } else {
                // Already started and audible: smoothly fade out and retire
                if (voice.gain && voice.gain.gain) {
                    voice.gain.gain.cancelScheduledValues(now);
                    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
                    voice.gain.gain.linearRampToValueAtTime(0, now + fadeDuration);
                }
                if (voice.source) {
                    voice.source.stop(now + fadeDuration + 0.05);
                }
                this.fadingVoices.push({
                    voice,
                    stopTime: now + fadeDuration + 0.06
                });
            }
        } catch (e) {}
    },

    scheduleIdleVoice(startTime, blendDuration = 0.20) {
        if (!this.ctx || !this.vehicleGain || !this.roadsterIdleBuffer) return;
        this.cancelScheduledIdle();

        try {
            const src = this.ctx.createBufferSource();
            src.buffer = this.roadsterIdleBuffer;
            src.loop = true;

            const gain = this.ctx.createGain();
            const now = this.ctx.currentTime;
            gain.gain.setValueAtTime(0, now);
            gain.gain.setValueAtTime(0, startTime);
            gain.gain.linearRampToValueAtTime(0.28, startTime + blendDuration);

            src.connect(gain);
            gain.connect(this.vehicleGain);

            src.onended = () => {
                try { src.disconnect(); } catch (e) {}
                try { gain.disconnect(); } catch (e) {}
            };

            src.start(startTime, 0);

            this.scheduledIdleVoice = {
                source: src,
                gain: gain,
                startTime: startTime,
                blendDuration: blendDuration
            };

            // Schedule current start voice to cross-fade out during the overlap window
            if (this.activeEngineVoice && this.activeEngineVoice.type === 'start') {
                const startGain = this.activeEngineVoice.gain;
                const startSource = this.activeEngineVoice.source;
                if (startGain && startGain.gain) {
                    startGain.gain.setValueAtTime(startGain.gain.value || 0.35, startTime);
                    startGain.gain.linearRampToValueAtTime(0, startTime + blendDuration);
                }
                if (startSource) {
                    try {
                        startSource.stop(startTime + blendDuration + 0.05);
                    } catch (e) {}
                }
            }
        } catch (e) {}
    },

    startEngineVoice(type, gear = 1, fadeDuration = 0.18) {
        this.transitionToEngineVoice(type, gear, fadeDuration);
    },

    transitionToEngineVoice(type, gear = 1, fadeDuration = 0.18) {
        if (!this.ctx || !this.vehicleGain) return;
        const now = this.ctx.currentTime;

        // Crossfade out existing engine voice
        if (this.activeEngineVoice) {
            const oldVoice = this.activeEngineVoice;
            this.activeEngineVoice = null;
            try {
                if (oldVoice.gain && oldVoice.gain.gain) {
                    oldVoice.gain.gain.cancelScheduledValues(now);
                    oldVoice.gain.gain.setValueAtTime(oldVoice.gain.gain.value, now);
                    oldVoice.gain.gain.linearRampToValueAtTime(0, now + fadeDuration);
                }
                if (oldVoice.source) {
                    oldVoice.source.stop(now + fadeDuration + 0.05);
                }
                this.fadingVoices.push({
                    voice: oldVoice,
                    stopTime: now + fadeDuration + 0.06
                });
            } catch (e) {}
        }

        if (type !== 'start') {
            this.cancelScheduledIdle();
        }

        let buffer = null;
        let loop = false;
        let loopStart = 0;
        let loopEnd = 0;
        let targetGain = 0.35;

        if (type === 'start') {
            buffer = this.roadsterStartBuffer;
            loop = false;
            targetGain = 0.35;
        } else if (type === 'idle') {
            buffer = this.roadsterIdleBuffer;
            loop = true;
            targetGain = 0.28;
        } else if (type === 'driving') {
            buffer = this.roadsterDrivingBuffer;
            loop = true;
            const seg = GEAR_SEGMENTS[gear] || GEAR_SEGMENTS[1];
            loopStart = seg.start;
            loopEnd = (seg.end !== null && seg.end !== undefined) ? seg.end : (buffer ? buffer.duration : 24.57);
            targetGain = 0.35;
        }

        if (!buffer) return;

        try {
            const src = this.ctx.createBufferSource();
            src.buffer = buffer;
            src.loop = loop;
            if (loop) {
                src.loopStart = loopStart;
                src.loopEnd = loopEnd;
            }

            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(targetGain, now + fadeDuration);

            src.connect(gain);
            gain.connect(this.vehicleGain);

            src.onended = () => {
                try { src.disconnect(); } catch (e) {}
                try { gain.disconnect(); } catch (e) {}
            };

            src.start(now, loop ? loopStart : 0);

            this.activeEngineVoice = {
                source: src,
                gain: gain,
                type: type,
                gear: gear,
                startTime: now,
                duration: buffer.duration || 0
            };

            if (type === 'start') {
                const startDur = buffer.duration || 2.81;
                const blendDuration = 0.20;
                const idleStartTime = now + Math.max(0.1, startDur - blendDuration);
                this.scheduleIdleVoice(idleStartTime, blendDuration);
            }
        } catch (e) {}
    },

    stopAllVehicleVoices(fadeDuration = 0.15) {
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        this.cancelScheduledIdle();
        this.isDriftingAudioActive = false;

        if (this.activeEngineVoice) {
            const v = this.activeEngineVoice;
            this.activeEngineVoice = null;
            try {
                if (v.gain && v.gain.gain) {
                    v.gain.gain.cancelScheduledValues(now);
                    v.gain.gain.setValueAtTime(v.gain.gain.value, now);
                    v.gain.gain.linearRampToValueAtTime(0, now + fadeDuration);
                }
                if (v.source) v.source.stop(now + fadeDuration + 0.05);
                this.fadingVoices.push({ voice: v, stopTime: now + fadeDuration + 0.06 });
            } catch (e) {}
        }

        if (this.activeDriftVoice) {
            const dv = this.activeDriftVoice;
            this.activeDriftVoice = null;
            try {
                if (dv.gain && dv.gain.gain) {
                    dv.gain.gain.cancelScheduledValues(now);
                    dv.gain.gain.setValueAtTime(dv.gain.gain.value, now);
                    dv.gain.gain.linearRampToValueAtTime(0, now + fadeDuration);
                }
                if (dv.source) dv.source.stop(now + fadeDuration + 0.05);
                this.fadingVoices.push({ voice: dv, stopTime: now + fadeDuration + 0.06 });
            } catch (e) {}
        }

        // Also fade out and stop any retired voices in fadingVoices (such as finishing startup voice during overlap)
        for (const item of this.fadingVoices) {
            try {
                if (item.voice && item.voice.gain && item.voice.gain.gain) {
                    item.voice.gain.gain.cancelScheduledValues(now);
                    item.voice.gain.gain.setValueAtTime(item.voice.gain.gain.value, now);
                    item.voice.gain.gain.linearRampToValueAtTime(0, now + fadeDuration);
                }
                if (item.voice && item.voice.source) {
                    item.voice.source.stop(now + fadeDuration + 0.05);
                }
                item.stopTime = now + fadeDuration + 0.06;
            } catch (e) {}
        }

        this.cleanupFadingVoices(now);
    },

    cleanupFadingVoices(now = (this.ctx ? this.ctx.currentTime : 0)) {
        if (!Array.isArray(this.fadingVoices) || this.fadingVoices.length === 0) return;
        this.fadingVoices = this.fadingVoices.filter(item => {
            if (now >= item.stopTime) {
                try {
                    if (item.voice && item.voice.source) item.voice.source.disconnect();
                    if (item.voice && item.voice.gain) item.voice.gain.disconnect();
                } catch (e) {}
                return false;
            }
            return true;
        });
    },

    startDriftVoice(fadeDuration = 0.08) {
        if (!this.ctx || !this.vehicleGain || !this.driftBuffers || this.driftBuffers.length === 0) return;
        const now = this.ctx.currentTime;

        let nextIndex = Math.floor(Math.random() * this.driftBuffers.length);
        if (this.driftBuffers.length > 1 && nextIndex === this.lastDriftIndex) {
            nextIndex = (nextIndex + 1 + Math.floor(Math.random() * (this.driftBuffers.length - 1))) % this.driftBuffers.length;
        }
        this.lastDriftIndex = nextIndex;
        const buffer = this.driftBuffers[nextIndex];
        if (!buffer) return;

        try {
            const src = this.ctx.createBufferSource();
            src.buffer = buffer;
            src.loop = false;

            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(0.38, now + fadeDuration);

            src.connect(gain);
            gain.connect(this.vehicleGain);

            src.onended = () => {
                try { src.disconnect(); } catch (e) {}
                try { gain.disconnect(); } catch (e) {}
                if (this.activeDriftVoice && this.activeDriftVoice.source === src) {
                    this.activeDriftVoice = null;
                    this.lastDriftEndTime = this.ctx ? this.ctx.currentTime : 0;
                    // If car is still actively drifting, trigger next clip seamlessly
                    if (this.isDriftingAudioActive && this.currentCar && Boolean(getGameState().sfxEnabled)) {
                        this.startDriftVoice(0.06);
                    }
                }
            };

            src.start(now);

            this.activeDriftVoice = { source: src, gain: gain, startTime: now };
        } catch (e) {}
    },

    stopDriftVoice(fadeDuration = 0.12) {
        if (!this.activeDriftVoice || !this.ctx) return;
        const now = this.ctx.currentTime;
        const voice = this.activeDriftVoice;
        this.activeDriftVoice = null;
        this.lastDriftEndTime = now;

        try {
            if (voice.gain && voice.gain.gain) {
                voice.gain.gain.cancelScheduledValues(now);
                voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
                voice.gain.gain.linearRampToValueAtTime(0, now + fadeDuration);
            }
            if (voice.source) {
                voice.source.stop(now + fadeDuration + 0.05);
            }
            this.fadingVoices.push({ voice, stopTime: now + fadeDuration + 0.06 });
        } catch (e) {}
    },

    startAmbienceLoop() {
        if (!this.ctx || !this.ambienceBuffer) return;
        if (this.ambienceSource) {
            try { this.ambienceSource.stop(); } catch (e) {}
            try { this.ambienceSource.disconnect(); } catch (e) {}
            this.ambienceSource = null;
        }

        const src = this.ctx.createBufferSource();
        src.buffer = this.ambienceBuffer;
        src.loop = true;

        if (!this.ambienceGain) {
            this.ambienceGain = this.ctx.createGain();
            this.ambienceGain.gain.value = 0;
            this.ambienceGain.connect(this.masterGain);
        }

        src.connect(this.ambienceGain);
        try {
            src.start(0);
        } catch (e) {}
        this.ambienceSource = src;
        this.ambiencePlaying = true;

        const now = this.ctx.currentTime;
        // Fade in authentic Nabka ambient loop
        this.ambienceGain.gain.setTargetAtTime(0.42, now, 0.4);

        // Fade out synthetic sea & street noise
        if (this.seaGain) {
            this.seaGain.gain.setTargetAtTime(0, now, 0.5);
        }
        if (this.streetGain) {
            this.streetGain.gain.setTargetAtTime(0, now, 0.5);
        }
    },

    async ensureInit() {
        if (this.initialized) {
            if (this.ctx && this.ctx.state === 'suspended') {
                await this.ctx.resume();
            }
            if (this.ambienceBuffer && !this.ambienceSource) {
                this.startAmbienceLoop();
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

            // Pre-create ambience gain node
            this.ambienceGain = this.ctx.createGain();
            this.ambienceGain.gain.value = 0;
            this.ambienceGain.connect(this.masterGain);

            // Pre-create vehicle gain node
            this.vehicleGain = this.ctx.createGain();
            this.vehicleGain.gain.value = 1.0;
            this.vehicleGain.connect(this.masterGain);
            this.roadsterGain = this.vehicleGain;

            const pinkBuf = this.createNoiseBuffer('pink', 4);
            const whiteBuf = this.createNoiseBuffer('white', 3);
            const brownBuf = this.createNoiseBuffer('brown', 4);

            // 1. Seashore Surf (Synthetic fallback until nabka_ambience loads)
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

            // 2. Promenade Crowd & Street Traffic (Synthetic fallback)
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

            // 4. Realistic JDM Inline-6 Engine (Idle Rumbling) + Turbo Whine
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

            this.turboGain = this.ctx.createGain();
            this.turboGain.gain.value = 0;
            this.turboGain.connect(this.masterGain);

            this.engineFilter.connect(this.engineGain);
            this.engineGain.connect(this.masterGain);

            this.engineOsc1.start();
            this.engineOsc2.start();
            this.engineSubOsc.start();

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

            // Start background fetching and decoding of real sound files
            this.loadAllSoundAssets();

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
        const timeMs = performance.now();

        // Start ambience loop if buffer was loaded after initial ensureInit
        if (this.ambienceBuffer && !this.ambienceSource) {
            this.startAmbienceLoop();
        }

        // If real ambience is still loading, adjust synthetic noise
        if (!this.ambienceBuffer) {
            const seaFactor = Math.max(0.035, Math.min(0.18, (22 - playerPos.x) / 170));
            if (this.seaGain) this.seaGain.gain.setTargetAtTime(seaFactor, now, 0.15);

            const streetFactor = Math.max(0.07, Math.min(0.22, (playerPos.x + 35) / 210));
            if (this.streetGain) this.streetGain.gain.setTargetAtTime(streetFactor, now, 0.15);
        }

        // Spatial central fountain splash
        if (this.fountainGain) {
            const distToFountain = Math.hypot(playerPos.x, playerPos.z);
            const fntVol = distToFountain < 32 ? Math.max(0, (1 - distToFountain / 32) * 0.18) : 0;
            this.fountainGain.gain.setTargetAtTime(fntVol, now, 0.1);
        }

        // Short seagull calls (ch1, ch2, ch3): rotate randomly every 6-12 seconds
        if (timeMs - this.lastSeagullTime > 6000 + Math.random() * 6000) {
            this.lastSeagullTime = timeMs;
            this.playSeagullCry();
        }

        // Long seagull calls (ch_long1, ch_long2): sparingly, like once in 3 minutes (~150-210s)
        if (timeMs - this.lastLongSeagullTime > this.nextLongSeagullInterval) {
            this.lastLongSeagullTime = timeMs;
            this.nextLongSeagullInterval = 150000 + Math.random() * 60000;
            this.playLongSeagullCry();
        }

        // Distant cargo ship horn
        if (timeMs - this.lastHornTime > 24000 + Math.random() * 16000) {
            this.lastHornTime = timeMs;
            this.playDistantShipHorn();
        }
    },

    updateVehicleAudio(car, isThrottle, isBraking, isDrifting, isBoost) {
        const sfxOn = Boolean(getGameState().sfxEnabled);
        if (!car || !sfxOn) {
            if (this.vehicleState !== 'off' || this.currentCar !== null) {
                this.stopAllVehicleVoices(0.15);
                this.currentCar = null;
                this.vehicleState = 'off';
                this.currentGear = 1;
            }
            if (this.engineGain && this.ctx) this.engineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
            if (this.turboGain && this.ctx) this.turboGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
            if (this.tireGain && this.ctx) this.tireGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
            return;
        }

        if (!this.initialized || !this.ctx) return;
        const now = this.ctx.currentTime;
        const nowMs = performance.now();
        this.cleanupFadingVoices(now);

        const speedTotal = Math.hypot(car.vx || 0, car.vz || 0);
        const absSpeed = Math.abs(car.speed || 0);

        // 1. Vehicle entry transition
        if (this.currentCar !== car) {
            this.currentCar = car;
            this.stopAllVehicleVoices(0.05);
            if (isThrottle || speedTotal > 0.7) {
                this.vehicleState = 'driving';
                this.currentGear = calculateTargetGear(1, car.speed);
                this.lastGearChangeTime = nowMs;
                this.transitionToEngineVoice('driving', this.currentGear, 0.10);
            } else {
                this.vehicleState = 'starting';
                this.currentGear = 1;
                if (this.roadsterStartStatus === 'failed' && this.roadsterIdleBuffer) {
                    this.vehicleState = 'idle';
                    this.startEngineVoice('idle', 1, 0.18);
                } else {
                    this.startEngineVoice('start', 1, 0.05);
                }
                return;
            }
        }

        // 2. Engine state machine: starting -> idle -> driving
        if (this.vehicleState === 'starting') {
            if (isThrottle || speedTotal > 0.7) {
                // Movement interrupts startup with a smooth crossfade into driving
                this.cancelScheduledIdle();
                this.vehicleState = 'driving';
                this.currentGear = 1;
                this.lastGearChangeTime = nowMs;
                this.transitionToEngineVoice('driving', 1, 0.18);
            } else if (this.scheduledIdleVoice && now >= this.scheduledIdleVoice.startTime) {
                // Scheduled idle voice takes over after startup; retire the finishing start voice
                if (this.activeEngineVoice && this.activeEngineVoice !== this.scheduledIdleVoice) {
                    this.fadingVoices.push({
                        voice: this.activeEngineVoice,
                        stopTime: this.scheduledIdleVoice.startTime + (this.scheduledIdleVoice.blendDuration || 0.20) + 0.06
                    });
                }
                this.activeEngineVoice = {
                    source: this.scheduledIdleVoice.source,
                    gain: this.scheduledIdleVoice.gain,
                    type: 'idle',
                    gear: 1,
                    startTime: this.scheduledIdleVoice.startTime
                };
                this.scheduledIdleVoice = null;
                this.vehicleState = 'idle';
            }
        } else if (this.vehicleState === 'idle') {
            if (isThrottle || speedTotal > 0.7) {
                // Stationary car starts moving
                this.vehicleState = 'driving';
                this.currentGear = 1;
                this.lastGearChangeTime = nowMs;
                this.transitionToEngineVoice('driving', 1, 0.18);
            }
        } else if (this.vehicleState === 'driving') {
            if (speedTotal < 0.35 && !isThrottle) {
                // Car has come to a stop and throttle is released -> return to idle
                this.vehicleState = 'idle';
                this.transitionToEngineVoice('idle', 1, 0.20);
            } else {
                // Driving or coasting: evaluate gear based on speed (no playback rate changes!)
                const targetGear = calculateTargetGear(this.currentGear, car.speed);
                if (targetGear !== this.currentGear && (!this.lastGearChangeTime || nowMs - this.lastGearChangeTime > 220)) {
                    this.currentGear = targetGear;
                    this.lastGearChangeTime = nowMs;
                    this.transitionToEngineVoice('driving', targetGear, 0.18);
                }
            }
        } else {
            this.vehicleState = 'idle';
            this.transitionToEngineVoice('idle', 1, 0.20);
        }

        // 3. Drift sound detection & playback (drift1..drift4)
        const driftState = calculateDriftState(car, this.isDriftingAudioActive);
        this.isDriftingAudioActive = driftState.isDrifting;
        if (driftState.isDrifting) {
            if (!this.activeDriftVoice && (!this.lastDriftEndTime || now - this.lastDriftEndTime > 0.25)) {
                this.startDriftVoice(0.08);
            }
        } else {
            if (this.activeDriftVoice) {
                this.stopDriftVoice(0.12);
            }
        }

        // 4. Suppress legacy synthetic turbo whine and blowoff
        if (this.turboGain) {
            this.turboGain.gain.setTargetAtTime(0, now, 0.06);
        }
        this.wasBoosting = false;

        // 5. Tire screech (only on straight braking when not drift sliding)
        if (this.tireGain && this.tireFilter && this.tireLfo) {
            if (isBraking && !driftState.isDrifting && absSpeed > 2.5) {
                const screechVol = Math.min(0.24, 0.08 + (absSpeed / 26) * 0.18);
                const warble = 1480 + Math.sin(nowMs * 0.045) * 320;
                this.tireFilter.frequency.setTargetAtTime(warble, now, 0.03);
                this.tireLfo.frequency.setTargetAtTime(warble * 0.95, now, 0.03);
                this.tireGain.gain.setTargetAtTime(screechVol, now, 0.03);
            } else {
                this.tireGain.gain.setTargetAtTime(0, now, 0.06);
            }
        }

        // 6. Suppress legacy synthetic engine oscillators when authentic samples are active
        if (this.engineGain) {
            this.engineGain.gain.setTargetAtTime(0, now, 0.06);
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
        const nowMs = performance.now();
        // Do not interrupt while a long seagull call is actively playing
        if (nowMs < this.longSeagullEndTime) return;

        // If short seagull recordings are loaded, rotate through them randomly
        if (this.shortSeagullBuffers && this.shortSeagullBuffers.length > 0) {
            let nextIndex = Math.floor(Math.random() * this.shortSeagullBuffers.length);
            if (this.shortSeagullBuffers.length > 1 && nextIndex === this.lastShortSeagullIndex) {
                nextIndex = (nextIndex + 1 + Math.floor(Math.random() * (this.shortSeagullBuffers.length - 1))) % this.shortSeagullBuffers.length;
            }
            this.lastShortSeagullIndex = nextIndex;
            const buffer = this.shortSeagullBuffers[nextIndex];
            if (buffer) {
                try {
                    const src = this.ctx.createBufferSource();
                    src.buffer = buffer;
                    src.playbackRate.value = 0.95 + Math.random() * 0.10;
                    const gain = this.ctx.createGain();
                    gain.gain.value = 0.22 + Math.random() * 0.08;
                    src.connect(gain);
                    gain.connect(this.masterGain);
                    src.start();
                    return;
                } catch (e) {}
            }
        }

        // Fallback to synthetic chirp if buffers are still loading
        this.playSyntheticSeagullCry();
    },

    playLongSeagullCry() {
        if (!this.initialized || !getGameState().sfxEnabled || !this.ctx) return;
        if (!this.longSeagullBuffers || this.longSeagullBuffers.length === 0) return;

        let nextIndex = Math.floor(Math.random() * this.longSeagullBuffers.length);
        if (this.longSeagullBuffers.length > 1 && nextIndex === this.lastLongSeagullIndex) {
            nextIndex = (nextIndex + 1) % this.longSeagullBuffers.length;
        }
        this.lastLongSeagullIndex = nextIndex;
        const buffer = this.longSeagullBuffers[nextIndex];
        if (!buffer) return;

        try {
            const src = this.ctx.createBufferSource();
            src.buffer = buffer;
            src.playbackRate.value = 0.98 + Math.random() * 0.04;
            const gain = this.ctx.createGain();
            gain.gain.value = 0.24 + Math.random() * 0.06;
            src.connect(gain);
            gain.connect(this.masterGain);
            src.start();
            const dur = buffer.duration || 12;
            this.longSeagullEndTime = performance.now() + (dur * 1000);
        } catch (e) {}
    },

    playSyntheticSeagullCry() {
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
                if (this.roadsterStartBuffer) {
                    return;
                }
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
            } else if (type === 'meow') {
                const osc = this.ctx.createOscillator();
                const g = this.ctx.createGain();
                osc.type = 'sine';
                // Classic cat meow: rises softly then descends with expressive inflection
                osc.frequency.setValueAtTime(540, now);
                osc.frequency.exponentialRampToValueAtTime(780, now + 0.10);
                osc.frequency.exponentialRampToValueAtTime(520, now + 0.32);

                g.gain.setValueAtTime(0.001, now);
                g.gain.linearRampToValueAtTime(0.12, now + 0.04);
                g.gain.setValueAtTime(0.12, now + 0.16);
                g.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

                osc.connect(g);
                g.connect(this.masterGain);
                osc.start(now);
                osc.stop(now + 0.36);
            }
        } catch (e) {}
    }
};
