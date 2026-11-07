import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
    VLADIVOSTOK_UTC_OFFSET_MS,
    NOON_GRACE_PERIOD_MS,
    getVladivostokDateParts,
    getNoonUtcTimestamp,
    getNextNoonTimestamp,
    shouldFireNoonCannon,
    NoonCannonScheduler
} from '../js/noon-cannon.js';

describe('Noon Cannon - Vladivostok Timezone Math & Scheduling', () => {
    test('getVladivostokDateParts calculates correct UTC+10 date, time, and ISO date string', () => {
        // UTC 2026-10-24 01:30:00 -> VVO 2026-10-24 11:30:00
        const utcTimestamp = Date.UTC(2026, 9, 24, 1, 30, 0);
        const parts = getVladivostokDateParts(utcTimestamp);
        expect(parts.year).toBe(2026);
        expect(parts.month).toBe(9); // October (0-indexed)
        expect(parts.day).toBe(24);
        expect(parts.hours).toBe(11);
        expect(parts.minutes).toBe(30);
        expect(parts.seconds).toBe(0);
        expect(parts.dateString).toBe('2026-10-24');
    });

    test('getNoonUtcTimestamp maps Vladivostok 12:00:00 to 02:00:00 UTC', () => {
        const noonUtc = getNoonUtcTimestamp(2026, 9, 24);
        const date = new Date(noonUtc);
        expect(date.getUTCHours()).toBe(2);
        expect(date.getUTCMinutes()).toBe(0);
        expect(date.getUTCSeconds()).toBe(0);
        expect(date.getUTCMilliseconds()).toBe(0);

        // Converted to Vladivostok time
        const vvo = getVladivostokDateParts(noonUtc);
        expect(vvo.hours).toBe(12);
        expect(vvo.minutes).toBe(0);
        expect(vvo.seconds).toBe(0);
    });

    test('getNextNoonTimestamp returns today noon before 12:00, and tomorrow noon after 12:00', () => {
        // 11:45 Vladivostok time (01:45 UTC)
        const morningUtc = Date.UTC(2026, 9, 24, 1, 45, 0);
        const nextNoon1 = getNextNoonTimestamp(morningUtc);
        expect(nextNoon1).toBe(Date.UTC(2026, 9, 24, 2, 0, 0));

        // 12:00:00 exact
        const exactNoon = Date.UTC(2026, 9, 24, 2, 0, 0);
        expect(getNextNoonTimestamp(exactNoon)).toBe(exactNoon);

        // 12:15 Vladivostok time (02:15 UTC) -> should schedule next day 2026-10-25
        const afternoonUtc = Date.UTC(2026, 9, 24, 2, 15, 0);
        const nextNoon2 = getNextNoonTimestamp(afternoonUtc);
        expect(nextNoon2).toBe(Date.UTC(2026, 9, 25, 2, 0, 0));
    });
});

describe('Noon Cannon - Eligibility & Grace Period Rules', () => {
    const todayNoonUtc = Date.UTC(2026, 9, 24, 2, 0, 0); // 12:00:00 Vladivostok

    test('fires at exact 12:00 Vladivostok when page was open beforehand', () => {
        const pageOpenedAt = todayNoonUtc - 600000; // 10 min prior
        const shouldFire = shouldFireNoonCannon({
            now: todayNoonUtc,
            pageOpenedAt,
            firedDates: new Set()
        });
        expect(shouldFire).toBe(true);
    });

    test('does not fire before 12:00 Vladivostok', () => {
        const pageOpenedAt = todayNoonUtc - 600000;
        const now = todayNoonUtc - 1000; // 11:59:59 Vladivostok
        const shouldFire = shouldFireNoonCannon({
            now,
            pageOpenedAt,
            firedDates: new Set()
        });
        expect(shouldFire).toBe(false);
    });

    test('fires during tab wake within 60s grace period if page was open prior to noon', () => {
        const pageOpenedAt = todayNoonUtc - 30000; // Opened at 11:59:30
        const now = todayNoonUtc + 45000; // Wakes at 12:00:45 (inside 60s window)
        const shouldFire = shouldFireNoonCannon({
            now,
            pageOpenedAt,
            firedDates: new Set(),
            gracePeriodMs: 60000
        });
        expect(shouldFire).toBe(true);
    });

    test('suppresses playback if device woke after 60s grace period expired', () => {
        const pageOpenedAt = todayNoonUtc - 30000;
        const now = todayNoonUtc + 65000; // Wakes at 12:01:05 (past 60s grace deadline)
        const shouldFire = shouldFireNoonCannon({
            now,
            pageOpenedAt,
            firedDates: new Set(),
            gracePeriodMs: 60000
        });
        expect(shouldFire).toBe(false);
    });

    test('suppresses retroactive playback when user opens page after 12:00', () => {
        const pageOpenedAt = todayNoonUtc + 15000; // User opened at 12:00:15
        const now = todayNoonUtc + 20000; // 12:00:20
        const shouldFire = shouldFireNoonCannon({
            now,
            pageOpenedAt,
            firedDates: new Set()
        });
        expect(shouldFire).toBe(false);
    });

    test('deduplicates playback monotonically and guards against clock rollback', () => {
        const firedDates = new Set();
        const pageOpenedAt = todayNoonUtc - 60000;

        // 1. Day 1: October 24
        expect(shouldFireNoonCannon({
            now: todayNoonUtc,
            pageOpenedAt,
            firedDates
        })).toBe(true);
        firedDates.add('2026-10-24');

        // 2. Day 2: October 25
        const tomorrowNoonUtc = Date.UTC(2026, 9, 25, 2, 0, 0);
        expect(shouldFireNoonCannon({
            now: tomorrowNoonUtc,
            pageOpenedAt,
            firedDates
        })).toBe(true);
        firedDates.add('2026-10-25');

        // 3. Clock rollback to October 24 noon
        expect(shouldFireNoonCannon({
            now: todayNoonUtc,
            pageOpenedAt,
            firedDates
        })).toBe(false);
    });
});

describe('Noon Cannon - Scheduler Lifecycle, Audio Readiness & Retries', () => {
    test('NoonCannonScheduler triggers announce callback and handles audio readiness and retries', () => {
        let simulatedTime = Date.UTC(2026, 9, 24, 1, 59, 59); // 1 sec before noon
        const noonTime = Date.UTC(2026, 9, 24, 2, 0, 0);

        let announcedCount = 0;
        let audioPlayCount = 0;
        let audioContextState = 'suspended'; // Simulate initial suspended audio context

        const scheduler = new NoonCannonScheduler({
            getNow: () => simulatedTime,
            pageOpenedAt: simulatedTime,
            onAnnounce: () => {
                announcedCount++;
            },
            onPlayAudio: () => {
                audioPlayCount++;
                if (audioContextState !== 'running') {
                    return { status: 'suspended' };
                }
                return { status: 'played' };
            }
        });

        scheduler.start();
        expect(announcedCount).toBe(0);

        // Advance to noon
        simulatedTime = noonTime;
        scheduler.checkAndFire();

        // Announced once immediately
        expect(announcedCount).toBe(1);
        expect(audioPlayCount).toBe(1);
        // Audio was suspended, so pendingAudioDeadline was set
        expect(scheduler.pendingAudioDeadline).not.toBeNull();

        // User clicks 10 seconds later, unlocking audio context
        simulatedTime = noonTime + 10000;
        audioContextState = 'running';
        scheduler.retryPendingAudio();

        expect(audioPlayCount).toBe(2);
        expect(scheduler.pendingAudioDeadline).toBeNull(); // Resolved!

        // Further checks don't repeat announcement or audio
        scheduler.checkAndFire();
        expect(announcedCount).toBe(1);

        scheduler.dispose();
    });

    test('NoonCannonScheduler cancels pending audio after grace deadline expires', () => {
        const noonTime = Date.UTC(2026, 9, 24, 2, 0, 0);
        let simulatedTime = noonTime;

        const scheduler = new NoonCannonScheduler({
            getNow: () => simulatedTime,
            pageOpenedAt: noonTime - 10000,
            onAnnounce: () => {},
            onPlayAudio: () => ({ status: 'suspended' })
        });

        scheduler.start();
        expect(scheduler.pendingAudioDeadline).not.toBeNull();

        // Simulate device waking after grace period (75s past noon)
        simulatedTime = noonTime + 75000;
        scheduler.retryPendingAudio();

        // Pending audio is expired without playing
        expect(scheduler.pendingAudioDeadline).toBeNull();

        scheduler.dispose();
    });

    test('NoonCannonScheduler cleanly disposes timers and removes listeners', () => {
        const listeners = [];
        const originalDoc = globalThis.document;
        globalThis.document = {
            addEventListener(ev, fn) { listeners.push({ ev, fn }); },
            removeEventListener(ev, fn) {
                const idx = listeners.findIndex(l => l.ev === ev && l.fn === fn);
                if (idx !== -1) listeners.splice(idx, 1);
            }
        };

        const scheduler = new NoonCannonScheduler({
            getNow: () => Date.now(),
            onAnnounce: () => {}
        });

        scheduler.start();
        expect(scheduler.started).toBe(true);
        expect(scheduler.timerId).not.toBeNull();
        expect(scheduler.intervalId).not.toBeNull();
        expect(listeners.length).toBeGreaterThan(0);

        scheduler.dispose();
        expect(scheduler.started).toBe(false);
        expect(scheduler.timerId).toBeNull();
        expect(scheduler.intervalId).toBeNull();
        expect(scheduler.pendingAudioDeadline).toBeNull();
        expect(listeners.length).toBe(0);

        globalThis.document = originalDoc;
    });

    test('gesture resume within grace produces exactly one playback, while resume after grace produces none', async () => {
        const noonTime = Date.UTC(2026, 9, 24, 2, 0, 0);
        let simulatedTime = noonTime;

        let audioContextState = 'suspended';
        let playbackCount = 0;

        const fakeAudio = {
            async resume() {
                audioContextState = 'running';
            },
            play() {
                if (audioContextState !== 'running') {
                    return { status: 'suspended' };
                }
                playbackCount++;
                return { status: 'played' };
            }
        };

        const scheduler = new NoonCannonScheduler({
            getNow: () => simulatedTime,
            pageOpenedAt: noonTime - 10000,
            onAnnounce: () => {},
            onPlayAudio: () => fakeAudio.play()
        });

        scheduler.start();
        // At exact noon, audio was suspended, so pending audio was armed
        expect(playbackCount).toBe(0);
        expect(scheduler.pendingAudioDeadline).toBe(noonTime + 60000);

        // Gesture adapter simulated: user clicks 15s past noon (inside 60s grace)
        simulatedTime = noonTime + 15000;
        await fakeAudio.resume();
        scheduler.retryPendingAudio();

        expect(playbackCount).toBe(1);
        expect(scheduler.pendingAudioDeadline).toBeNull();

        // Repeated clicks do NOT play again
        scheduler.retryPendingAudio();
        expect(playbackCount).toBe(1);

        scheduler.dispose();

        // Second test: resume happens after grace deadline
        audioContextState = 'suspended';
        playbackCount = 0;
        simulatedTime = noonTime;

        const scheduler2 = new NoonCannonScheduler({
            getNow: () => simulatedTime,
            pageOpenedAt: noonTime - 10000,
            onAnnounce: () => {},
            onPlayAudio: () => fakeAudio.play()
        });

        scheduler2.start();
        expect(scheduler2.pendingAudioDeadline).toBe(noonTime + 60000);

        // Device slept and resumes after grace period (e.g. +70s)
        simulatedTime = noonTime + 70000;
        await fakeAudio.resume();
        scheduler2.retryPendingAudio();

        // Expired, no playback
        expect(playbackCount).toBe(0);
        expect(scheduler2.pendingAudioDeadline).toBeNull();

        scheduler2.dispose();
    });

    test('retains shared Set by reference so scheduler replacement preserves deduplication', () => {
        const sharedFiredDates = new Set();
        const noonTime = Date.UTC(2026, 9, 24, 2, 0, 0);
        let simulatedTime = noonTime;
        let announceCount = 0;

        const scheduler1 = new NoonCannonScheduler({
            getNow: () => simulatedTime,
            pageOpenedAt: noonTime - 10000,
            firedDates: sharedFiredDates,
            onAnnounce: () => { announceCount++; }
        });

        scheduler1.start();
        expect(announceCount).toBe(1);
        expect(sharedFiredDates.has('2026-10-24')).toBe(true);

        scheduler1.dispose();

        // Simulate creating replacement scheduler with the shared Set
        const scheduler2 = new NoonCannonScheduler({
            getNow: () => simulatedTime + 1000,
            pageOpenedAt: noonTime - 10000,
            firedDates: sharedFiredDates,
            onAnnounce: () => { announceCount++; }
        });

        scheduler2.start();
        // Should NOT re-announce
        expect(announceCount).toBe(1);

        scheduler2.dispose();
    });
});
