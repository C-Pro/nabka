import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { SoundManager, calculateTargetGear, calculateDriftState, GEAR_SEGMENTS } from '../js/audio.js';
import { GAME_STATE } from '../js/state.js';

function createMockAudioParam(initialValue = 0) {
    return {
        value: initialValue,
        setValueAtTime: mock(function (val, time) { this.value = val; }),
        setTargetAtTime: mock(function (val, time, timeConstant) { this.value = val; }),
        linearRampToValueAtTime: mock(function (val, time) { this.value = val; }),
        exponentialRampToValueAtTime: mock(function (val, time) { this.value = val; }),
        cancelScheduledValues: mock(function (time) {}),
    };
}

function createMockAudioNode() {
    return {
        connect: mock(() => {}),
        disconnect: mock(() => {}),
    };
}

function createMockGainNode(initialGain = 1.0) {
    return {
        ...createMockAudioNode(),
        gain: createMockAudioParam(initialGain),
    };
}

function createMockBufferSourceNode() {
    return {
        ...createMockAudioNode(),
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        playbackRate: createMockAudioParam(1.0),
        start: mock(() => {}),
        stop: mock(() => {}),
        onended: null,
    };
}

function createMockOscillatorNode() {
    return {
        ...createMockAudioNode(),
        type: 'sine',
        frequency: createMockAudioParam(440),
        start: mock(() => {}),
        stop: mock(() => {}),
    };
}

function createMockBiquadFilterNode() {
    return {
        ...createMockAudioNode(),
        type: 'lowpass',
        frequency: createMockAudioParam(350),
        Q: createMockAudioParam(1),
    };
}

function createMockAudioContext() {
    return {
        state: 'running',
        currentTime: 10.0,
        sampleRate: 44100,
        destination: createMockAudioNode(),
        createGain: mock(() => createMockGainNode(1.0)),
        createBufferSource: mock(() => createMockBufferSourceNode()),
        createOscillator: mock(() => createMockOscillatorNode()),
        createBiquadFilter: mock(() => createMockBiquadFilterNode()),
        createBuffer: mock((channels, len, sr) => ({
            duration: len / sr,
            numberOfChannels: channels,
            length: len,
            sampleRate: sr,
            getChannelData: mock(() => new Float32Array(len)),
        })),
        resume: mock(async () => {}),
        suspend: mock(async () => {}),
        decodeAudioData: mock(async (arrayBuf, successCb) => {
            const buf = {
                duration: 5.0,
                numberOfChannels: 2,
                length: 220500,
                sampleRate: 44100,
            };
            if (typeof successCb === 'function') successCb(buf);
            return buf;
        }),
    };
}

describe('SoundManager MP3 Audio Engine', () => {
    let mockCtx;

    beforeEach(() => {
        mockCtx = createMockAudioContext();
        GAME_STATE.sfxEnabled = true;
        GAME_STATE.audioEnabled = true;

        SoundManager.initialized = true;
        SoundManager.ctx = mockCtx;
        SoundManager.masterGain = createMockGainNode(1.0);
        SoundManager.ambienceGain = createMockGainNode(0.0);
        SoundManager.vehicleGain = createMockGainNode(1.0);
        SoundManager.roadsterGain = SoundManager.vehicleGain;
        SoundManager.engineGain = createMockGainNode(0.0);
        SoundManager.turboGain = createMockGainNode(0.0);
        SoundManager.tireGain = createMockGainNode(0.0);
        SoundManager.seaGain = createMockGainNode(0.1);
        SoundManager.streetGain = createMockGainNode(0.1);
        SoundManager.fountainGain = createMockGainNode(0.08);

        SoundManager.engineOsc1 = createMockOscillatorNode();
        SoundManager.engineOsc2 = createMockOscillatorNode();
        SoundManager.engineSubOsc = createMockOscillatorNode();
        SoundManager.engineFilter = createMockBiquadFilterNode();
        SoundManager.turboOsc = createMockOscillatorNode();
        SoundManager.tireFilter = createMockBiquadFilterNode();
        SoundManager.tireLfo = createMockOscillatorNode();

        SoundManager.ambienceBuffer = null;
        SoundManager.ambienceSource = null;
        SoundManager.ambiencePlaying = false;

        SoundManager.shortSeagullBuffers = [];
        SoundManager.lastShortSeagullIndex = -1;

        SoundManager.longSeagullBuffers = [];
        SoundManager.lastLongSeagullIndex = -1;
        SoundManager.lastLongSeagullTime = 0;
        SoundManager.nextLongSeagullInterval = 180000;
        SoundManager.longSeagullEndTime = 0;

        SoundManager.roadsterStartBuffer = { duration: 2.81 };
        SoundManager.roadsterStartStatus = 'ready';
        SoundManager.roadsterIdleBuffer = { duration: 7.36 };
        SoundManager.roadsterDrivingBuffer = { duration: 24.57 };
        SoundManager.driftBuffers = [
            { duration: 4.93, name: 'drift1' },
            { duration: 13.56, name: 'drift2' },
            { duration: 3.40, name: 'drift3' },
            { duration: 2.46, name: 'drift4' },
        ];
        SoundManager.lastDriftIndex = -1;
        SoundManager.lastDriftEndTime = 0;

        SoundManager.currentCar = null;
        SoundManager.vehicleState = 'off';
        SoundManager.currentGear = 1;
        SoundManager.lastGearChangeTime = 0;
        SoundManager.activeEngineVoice = null;
        SoundManager.scheduledIdleVoice = null;
        SoundManager.activeDriftVoice = null;
        SoundManager.fadingVoices = [];
    });

    test('startAmbienceLoop creates looping buffer source and fades in ambienceGain', () => {
        SoundManager.ambienceBuffer = { duration: 50.5 };
        SoundManager.startAmbienceLoop();

        expect(SoundManager.ambienceSource).toBeDefined();
        expect(SoundManager.ambienceSource.loop).toBe(true);
        expect(SoundManager.ambienceSource.start).toHaveBeenCalled();
        expect(SoundManager.ambiencePlaying).toBe(true);
        expect(SoundManager.ambienceGain.gain.setTargetAtTime).toHaveBeenCalledWith(0.42, 10.0, 0.4);
        expect(SoundManager.seaGain.gain.setTargetAtTime).toHaveBeenCalledWith(0, 10.0, 0.5);
        expect(SoundManager.streetGain.gain.setTargetAtTime).toHaveBeenCalledWith(0, 10.0, 0.5);
    });

    test('playSeagullCry rotates randomly through shortSeagullBuffers without immediate repeating', () => {
        const buf1 = { duration: 0.85, name: 'ch1' };
        const buf2 = { duration: 1.25, name: 'ch2' };
        const buf3 = { duration: 1.18, name: 'ch3' };
        SoundManager.shortSeagullBuffers = [buf1, buf2, buf3];

        const playedIndices = [];
        for (let i = 0; i < 20; i++) {
            SoundManager.playSeagullCry();
            playedIndices.push(SoundManager.lastShortSeagullIndex);
        }

        // Must have selected all 3 calls across 20 iterations
        expect(new Set(playedIndices).size).toBe(3);

        // No two consecutive short calls should be the same
        for (let i = 1; i < playedIndices.length; i++) {
            expect(playedIndices[i]).not.toBe(playedIndices[i - 1]);
        }
    });

    test('playSeagullCry suppresses short calls while a long seagull call is playing', () => {
        SoundManager.shortSeagullBuffers = [{ duration: 1.0 }, { duration: 1.2 }];
        SoundManager.lastShortSeagullIndex = -1;

        // Long call active until t = now + 5000ms
        SoundManager.longSeagullEndTime = performance.now() + 5000;

        SoundManager.playSeagullCry();
        expect(SoundManager.lastShortSeagullIndex).toBe(-1); // Skipped
    });

    test('playLongSeagullCry picks from longSeagullBuffers, sets end time, and suppresses short calls', () => {
        const long1 = { duration: 10.5 };
        const long2 = { duration: 17.5 };
        SoundManager.longSeagullBuffers = [long1, long2];

        SoundManager.playLongSeagullCry();
        expect(SoundManager.lastLongSeagullIndex).toBeGreaterThanOrEqual(0);
        expect(SoundManager.longSeagullEndTime).toBeGreaterThan(performance.now() + 9000);

        // Now verify short call is suppressed while long call is active
        SoundManager.shortSeagullBuffers = [{ duration: 0.9 }];
        SoundManager.lastShortSeagullIndex = -1;
        SoundManager.playSeagullCry();
        expect(SoundManager.lastShortSeagullIndex).toBe(-1);
    });

    test('entering car plays roadster_start.mp3 (never loops) and pre-schedules idle blend', () => {
        const car = { speed: 0, vx: 0, vz: 0, yaw: 0, isBraking: false, isDrifting: false };

        SoundManager.updateVehicleAudio(car, false, false, false, false);

        expect(SoundManager.vehicleState).toBe('starting');
        expect(SoundManager.activeEngineVoice).toBeDefined();
        expect(SoundManager.activeEngineVoice.type).toBe('start');
        expect(SoundManager.activeEngineVoice.source.loop).toBe(false);
        expect(SoundManager.activeEngineVoice.source.start).toHaveBeenCalled();

        // Idle should be pre-scheduled to overlap before start ends
        expect(SoundManager.scheduledIdleVoice).toBeDefined();
        expect(SoundManager.scheduledIdleVoice.source.loop).toBe(true);
        expect(SoundManager.scheduledIdleVoice.source.start).toHaveBeenCalled();
    });

    test('user movement during startup interrupts roadster_start.mp3 and transitions directly to driving', () => {
        const car = { speed: 0, vx: 0, vz: 0, yaw: 0, isBraking: false, isDrifting: false };
        SoundManager.updateVehicleAudio(car, false, false, false, false);
        expect(SoundManager.vehicleState).toBe('starting');

        // User hits throttle: startup is interrupted, scheduled idle is cancelled
        SoundManager.updateVehicleAudio(car, true, false, false, false);
        expect(SoundManager.vehicleState).toBe('driving');
        expect(SoundManager.currentGear).toBe(1);
        expect(SoundManager.scheduledIdleVoice).toBeNull();
        expect(SoundManager.activeEngineVoice.type).toBe('driving');
        expect(SoundManager.activeEngineVoice.source.loop).toBe(true);
        expect(SoundManager.activeEngineVoice.source.loopStart).toBe(0.0);
        expect(SoundManager.activeEngineVoice.source.loopEnd).toBe(4.17);
    });

    test('driving gear loops match specified intervals and maintain playbackRate 1.0', () => {
        const car = { speed: 2.0, vx: 0, vz: 2.0, yaw: 0, isBraking: false, isDrifting: false };
        SoundManager.updateVehicleAudio(car, true, false, false, false); // Gear 1
        expect(SoundManager.currentGear).toBe(1);
        expect(SoundManager.activeEngineVoice.source.loopStart).toBe(0.0);
        expect(SoundManager.activeEngineVoice.source.loopEnd).toBe(4.17);
        expect(SoundManager.activeEngineVoice.source.playbackRate.value).toBe(1.0);

        // Accelerate to gear 2 (> 6 m/s)
        SoundManager.lastGearChangeTime = 0;
        car.speed = 8.0;
        car.vz = 8.0;
        SoundManager.updateVehicleAudio(car, true, false, false, false);
        expect(SoundManager.currentGear).toBe(2);
        expect(SoundManager.activeEngineVoice.source.loopStart).toBe(4.17);
        expect(SoundManager.activeEngineVoice.source.loopEnd).toBe(10.01);
        expect(SoundManager.activeEngineVoice.source.playbackRate.value).toBe(1.0);

        // Accelerate to gear 3 (> 12 m/s)
        SoundManager.lastGearChangeTime = 0;
        car.speed = 14.0;
        car.vz = 14.0;
        SoundManager.updateVehicleAudio(car, true, false, false, false);
        expect(SoundManager.currentGear).toBe(3);
        expect(SoundManager.activeEngineVoice.source.loopStart).toBe(10.01);
        expect(SoundManager.activeEngineVoice.source.loopEnd).toBe(20.83);
        expect(SoundManager.activeEngineVoice.source.playbackRate.value).toBe(1.0);

        // Accelerate to gear 4 (> 18 m/s, cruising at 25 or 34 boost)
        SoundManager.lastGearChangeTime = 0;
        car.speed = 22.0;
        car.vz = 22.0;
        SoundManager.updateVehicleAudio(car, true, false, false, true); // Boost active
        expect(SoundManager.currentGear).toBe(4);
        expect(SoundManager.activeEngineVoice.source.loopStart).toBe(20.83);
        expect(SoundManager.activeEngineVoice.source.loopEnd).toBe(24.57);
        expect(SoundManager.activeEngineVoice.source.playbackRate.value).toBe(1.0);
    });

    test('startup advances into idle handoff when time elapses, retiring startup voice', () => {
        const car = { speed: 0, vx: 0, vz: 0, yaw: 0, isBraking: false, isDrifting: false };
        mockCtx.currentTime = 10.0;
        SoundManager.updateVehicleAudio(car, false, false, false, false);

        expect(SoundManager.vehicleState).toBe('starting');
        const startVoice = SoundManager.activeEngineVoice;
        const scheduledIdle = SoundManager.scheduledIdleVoice;
        expect(scheduledIdle).toBeDefined();

        // Advance context time past scheduled idle start time (10.0 + 2.81 - 0.20 = 12.61)
        mockCtx.currentTime = 12.7;
        SoundManager.updateVehicleAudio(car, false, false, false, false);

        expect(SoundManager.vehicleState).toBe('idle');
        expect(SoundManager.activeEngineVoice.source).toBe(scheduledIdle.source);
        expect(SoundManager.activeEngineVoice.type).toBe('idle');
        expect(SoundManager.scheduledIdleVoice).toBeNull();
        // Startup voice must have been moved to fadingVoices
        expect(SoundManager.fadingVoices.some(fv => fv.voice === startVoice)).toBe(true);
    });

    test('cancelling scheduled idle when already started crossfades smoothly rather than hard-cutting', () => {
        const car = { speed: 0, vx: 0, vz: 0, yaw: 0, isBraking: false, isDrifting: false };
        mockCtx.currentTime = 10.0;
        SoundManager.updateVehicleAudio(car, false, false, false, false);
        const scheduledIdle = SoundManager.scheduledIdleVoice;

        // Advance to time where scheduled idle has started playback (e.g. 12.65 > 12.61)
        mockCtx.currentTime = 12.65;
        // User now moves
        SoundManager.updateVehicleAudio(car, true, false, false, false);

        // Scheduled idle was already started, so it should be smoothly ramped down, not hard-zeroed
        expect(SoundManager.vehicleState).toBe('driving');
        expect(scheduledIdle.gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 12.65 + 0.15);
        expect(SoundManager.fadingVoices.some(fv => fv.voice === scheduledIdle)).toBe(true);
    });

    test('loadAllSoundAssets reconciles correctly when idle buffer resolves after entry into starting vehicle', async () => {
        let resolveStart, resolveIdle;
        const startPromise = new Promise(r => { resolveStart = r; });
        const idlePromise = new Promise(r => { resolveIdle = r; });

        SoundManager.loadAudioBuffer = mock((url) => {
            if (url.includes('roadster_start')) return startPromise;
            if (url.includes('roadster_idle')) return idlePromise;
            return Promise.resolve(null);
        });

        SoundManager.roadsterStartBuffer = null;
        SoundManager.roadsterIdleBuffer = null;
        SoundManager.loadAllSoundAssets();

        // 1. Startup resolves first
        const startBuf = { duration: 2.81 };
        resolveStart(startBuf);
        await Promise.resolve();
        await Promise.resolve();

        // Player enters car while idle is still decoding
        const car = { speed: 0, vx: 0, vz: 0, yaw: 0, isBraking: false, isDrifting: false };
        mockCtx.currentTime = 10.0;
        SoundManager.updateVehicleAudio(car, false, false, false, false);
        expect(SoundManager.vehicleState).toBe('starting');
        expect(SoundManager.scheduledIdleVoice).toBeNull(); // not yet loaded

        // 2. Idle resolves late while startup is playing (at t = 11.0)
        mockCtx.currentTime = 11.0;
        const idleBuf = { duration: 7.36 };
        resolveIdle(idleBuf);
        await Promise.resolve();
        await Promise.resolve();

        // The real loadAllSoundAssets callback should have executed and scheduled idle!
        expect(SoundManager.scheduledIdleVoice).toBeDefined();
        expect(SoundManager.scheduledIdleVoice.startTime).toBeCloseTo(12.61, 2);
    });

    test('loadAllSoundAssets falls back to idle if startup fails to decode', async () => {
        let resolveStart, resolveIdle;
        const startPromise = new Promise(r => { resolveStart = r; });
        const idlePromise = new Promise(r => { resolveIdle = r; });

        SoundManager.loadAudioBuffer = mock((url) => {
            if (url.includes('roadster_start')) return startPromise;
            if (url.includes('roadster_idle')) return idlePromise;
            return Promise.resolve(null);
        });

        SoundManager.roadsterStartBuffer = null;
        SoundManager.roadsterIdleBuffer = null;
        SoundManager.loadAllSoundAssets();

        // Startup fails (null)
        resolveStart(null);
        await Promise.resolve();
        await Promise.resolve();

        // Idle succeeds
        resolveIdle({ duration: 7.36 });
        await Promise.resolve();
        await Promise.resolve();

        // Player enters stationary car -> startup failed so it directly enters idle!
        const car = { speed: 0, vx: 0, vz: 0, yaw: 0, isBraking: false, isDrifting: false };
        mockCtx.currentTime = 10.0;
        SoundManager.updateVehicleAudio(car, false, false, false, false);
        expect(SoundManager.vehicleState).toBe('idle');
        expect(SoundManager.activeEngineVoice.type).toBe('idle');
    });

    test('exit immediately after idle promotion fades out retiring startup voice', () => {
        const car = { speed: 0, vx: 0, vz: 0, yaw: 0, isBraking: false, isDrifting: false };
        mockCtx.currentTime = 10.0;
        SoundManager.updateVehicleAudio(car, false, false, false, false);
        const startVoice = SoundManager.activeEngineVoice;

        // Advance to time where idle voice is promoted (12.7s)
        mockCtx.currentTime = 12.7;
        SoundManager.updateVehicleAudio(car, false, false, false, false);
        expect(SoundManager.vehicleState).toBe('idle');
        expect(SoundManager.fadingVoices.some(fv => fv.voice === startVoice)).toBe(true);

        // Player immediately exits vehicle at 12.71s
        mockCtx.currentTime = 12.71;
        SoundManager.updateVehicleAudio(null, false, false, false, false);

        expect(SoundManager.vehicleState).toBe('off');
        // Both the active idle voice and the retiring startup voice must be scheduled to stop and ramp to 0
        expect(startVoice.gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 12.71 + 0.15);
        expect(startVoice.source.stop).toHaveBeenCalled();
    });

    test('onended disposer safely disconnects source and gain nodes', () => {
        const car = { speed: 2.0, vx: 0, vz: 2.0, yaw: 0, isBraking: false, isDrifting: false };
        SoundManager.updateVehicleAudio(car, true, false, false, false);
        const voice = SoundManager.activeEngineVoice;
        expect(voice.source.onended).toBeDefined();

        // Trigger onended callback
        voice.source.onended();
        expect(voice.source.disconnect).toHaveBeenCalled();
        expect(voice.gain.disconnect).toHaveBeenCalled();
    });

    test('coasting preserves driving state and stopping returns to idle loop', () => {
        const car = { speed: 10.0, vx: 0, vz: 10.0, yaw: 0, isBraking: false, isDrifting: false };
        SoundManager.updateVehicleAudio(car, true, false, false, false);
        expect(SoundManager.vehicleState).toBe('driving');

        // Release throttle while still coasting (speed 6 m/s) -> must remain driving
        car.speed = 6.0;
        car.vz = 6.0;
        SoundManager.updateVehicleAudio(car, false, false, false, false);
        expect(SoundManager.vehicleState).toBe('driving');

        // Car comes to a complete halt
        car.speed = 0;
        car.vx = 0;
        car.vz = 0;
        SoundManager.updateVehicleAudio(car, false, false, false, false);
        expect(SoundManager.vehicleState).toBe('idle');
        expect(SoundManager.activeEngineVoice.type).toBe('idle');
        expect(SoundManager.activeEngineVoice.source.loop).toBe(true);
    });

    test('drifting triggers random drift audio without repeating consecutive clips', () => {
        const car = {
            speed: 12.0,
            vx: 6.0,
            vz: 10.0,
            yaw: 0,
            isBraking: false,
            isDrifting: true
        };

        const playedIndices = [];
        for (let i = 0; i < 15; i++) {
            // Trigger drift
            car.vx = 6.0;
            car.isDrifting = true;
            SoundManager.lastDriftEndTime = 0;
            SoundManager.activeDriftVoice = null;
            SoundManager.updateVehicleAudio(car, true, false, true, false);
            playedIndices.push(SoundManager.lastDriftIndex);
        }

        expect(playedIndices.length).toBe(15);
        // Assert no two consecutive drift clips were identical
        for (let i = 1; i < playedIndices.length; i++) {
            expect(playedIndices[i]).not.toBe(playedIndices[i - 1]);
        }

        // Drift ends -> stops drift voice
        car.isDrifting = false;
        car.vx = 0;
        car.vz = 12.0;
        SoundManager.updateVehicleAudio(car, true, false, false, false);
        expect(SoundManager.activeDriftVoice).toBeNull();
    });

    test('exiting car during startup-idle overlap fades out and cleans up all active voices', () => {
        const car = { speed: 0, vx: 0, vz: 0, yaw: 0, isBraking: false, isDrifting: false };
        mockCtx.currentTime = 10.0;
        SoundManager.updateVehicleAudio(car, false, false, false, false);
        expect(SoundManager.vehicleState).toBe('starting');
        expect(SoundManager.activeEngineVoice).toBeDefined();
        expect(SoundManager.scheduledIdleVoice).toBeDefined();

        // Advance to overlap window (e.g. 12.65s where start is fading out and idle is fading in)
        mockCtx.currentTime = 12.65;
        // Player exits car
        SoundManager.updateVehicleAudio(null, false, false, false, false);

        expect(SoundManager.vehicleState).toBe('off');
        expect(SoundManager.activeEngineVoice).toBeNull();
        expect(SoundManager.scheduledIdleVoice).toBeNull();
        expect(SoundManager.currentCar).toBeNull();
    });

    test('updateSpatialAmbience manages fountain distance and triggers seagull timing', () => {
        SoundManager.ambienceBuffer = { duration: 50.0 };
        SoundManager.lastSeagullTime = performance.now() - 20000; // Trigger short seagull
        SoundManager.lastLongSeagullTime = performance.now() - 300000; // Trigger long seagull (>3 min)
        SoundManager.nextLongSeagullInterval = 180000;
        SoundManager.shortSeagullBuffers = [{ duration: 1.0 }, { duration: 1.2 }];
        SoundManager.longSeagullBuffers = [{ duration: 12.0 }];

        // Player near fountain at (0, 0)
        SoundManager.updateSpatialAmbience({ x: 2, z: 3 });

        expect(SoundManager.fountainGain.gain.setTargetAtTime).toHaveBeenCalled();
        expect(SoundManager.ambienceSource).toBeDefined();
        expect(SoundManager.lastLongSeagullIndex).toBe(0);
        expect(SoundManager.nextLongSeagullInterval).toBeGreaterThanOrEqual(150000);
    });

    test('calculateTargetGear enforces correct hysteresis bounds across upshifts and downshifts', () => {
        // Gear 1
        expect(calculateTargetGear(1, 0)).toBe(1);
        expect(calculateTargetGear(1, 5.9)).toBe(1);
        expect(calculateTargetGear(1, 6.1)).toBe(2);

        // Gear 2: upshift at >12, downshift at <4.5
        expect(calculateTargetGear(2, 6.0)).toBe(2);
        expect(calculateTargetGear(2, 5.0)).toBe(2);
        expect(calculateTargetGear(2, 4.4)).toBe(1);
        expect(calculateTargetGear(2, 11.9)).toBe(2);
        expect(calculateTargetGear(2, 12.1)).toBe(3);

        // Gear 3: upshift at >18, downshift at <10
        expect(calculateTargetGear(3, 15.0)).toBe(3);
        expect(calculateTargetGear(3, 9.9)).toBe(2);
        expect(calculateTargetGear(3, 18.1)).toBe(4);

        // Gear 4: downshift at <16
        expect(calculateTargetGear(4, 25.0)).toBe(4); // cruising
        expect(calculateTargetGear(4, 34.0)).toBe(4); // boost
        expect(calculateTargetGear(4, 16.5)).toBe(4);
        expect(calculateTargetGear(4, 15.5)).toBe(3);
    });

    test('calculateDriftState separates longitudinal motion from sideways drift', () => {
        // Null car
        expect(calculateDriftState(null).isDrifting).toBe(false);

        // Stopped car
        expect(calculateDriftState({ vx: 0, vz: 0, yaw: 0, isDrifting: false }).isDrifting).toBe(false);

        // Fast straight-line motion (yaw 0, vz 20, vx 0) -> no drift
        const straight = calculateDriftState({ vx: 0, vz: 20.0, yaw: 0, isDrifting: false });
        expect(straight.isDrifting).toBe(false);
        expect(straight.lateralSpeed).toBeCloseTo(0, 3);
        expect(straight.totalSpeed).toBeCloseTo(20.0, 3);

        // Sharp sideways slide (yaw 0, vx 8.0, vz 3.0) -> lateral speed 8.0 -> drifting!
        const slide = calculateDriftState({ vx: 8.0, vz: 3.0, yaw: 0, isDrifting: false });
        expect(slide.isDrifting).toBe(true);
        expect(slide.lateralSpeed).toBeCloseTo(8.0, 3);
    });

    test('synthetic turbo whine and blowoff are suppressed when driving or boosting', () => {
        const car = { speed: 22.0, vx: 0, vz: 22.0, yaw: 0, isBraking: false, isDrifting: false };
        mockCtx.currentTime = 10.0;
        // Drive at high speed with throttle and boost
        SoundManager.updateVehicleAudio(car, true, true, false, false);
        expect(SoundManager.vehicleState).toBe('driving');

        // turboGain must be suppressed to 0, never set to synthetic whistling levels
        expect(SoundManager.turboGain.gain.setTargetAtTime).toHaveBeenCalledWith(0, 10.0, 0.06);
    });
});

