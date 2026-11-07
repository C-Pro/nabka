/**
 * Client-side scheduler for the Vladivostok 12:00 Noon Cannon tradition.
 * 
 * At Sportivnaya Embankment and Vladivostok Fortress, the ceremonial cannon
 * fires daily at 12:00 Vladivostok time (Asia/Vladivostok, UTC+10).
 * 
 * This module coordinates wall-clock scheduling, page eligibility,
 * wake/tab-throttling grace periods, and monotonic calendar-date deduplication.
 */

export const VLADIVOSTOK_UTC_OFFSET_MS = 10 * 3600 * 1000;
export const NOON_GRACE_PERIOD_MS = 60 * 1000; // 60-second grace window on tab wake

/**
 * Returns date and time components in Vladivostok (UTC+10).
 */
export function getVladivostokDateParts(timestamp = Date.now()) {
    const vvoTime = new Date(timestamp + VLADIVOSTOK_UTC_OFFSET_MS);
    const year = vvoTime.getUTCFullYear();
    const month = vvoTime.getUTCMonth();
    const day = vvoTime.getUTCDate();
    const hours = vvoTime.getUTCHours();
    const minutes = vvoTime.getUTCMinutes();
    const seconds = vvoTime.getUTCSeconds();
    const dateString = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { year, month, day, hours, minutes, seconds, dateString };
}

/**
 * Computes the UTC timestamp corresponding to 12:00:00 Vladivostok time
 * for the calendar date (year, month, day).
 * 12:00 Vladivostok (UTC+10) is exactly 02:00 UTC.
 */
export function getNoonUtcTimestamp(year, month, day) {
    return Date.UTC(year, month, day, 2, 0, 0, 0);
}

/**
 * Calculates the UTC timestamp for the next upcoming noon in Vladivostok.
 */
export function getNextNoonTimestamp(currentTimestamp = Date.now()) {
    const vvo = getVladivostokDateParts(currentTimestamp);
    const todayNoonUtc = getNoonUtcTimestamp(vvo.year, vvo.month, vvo.day);
    if (currentTimestamp <= todayNoonUtc) {
        return todayNoonUtc;
    }
    return getNoonUtcTimestamp(vvo.year, vvo.month, vvo.day + 1);
}

/**
 * Pure evaluation function checking if the noon cannon should fire right now.
 * 
 * Rules:
 * 1. Has not already fired for the current Vladivostok calendar date (monotonic set).
 * 2. Current time is >= today's 12:00 Vladivostok.
 * 3. Current time is <= today's 12:00 + grace period (60s).
 * 4. The page was opened at or before today's 12:00 Vladivostok (users who open the page
 *    after 12:00 do not get a retroactive blast).
 */
export function shouldFireNoonCannon({
    now = Date.now(),
    pageOpenedAt = now,
    firedDates = new Set(),
    gracePeriodMs = NOON_GRACE_PERIOD_MS
}) {
    const vvo = getVladivostokDateParts(now);
    if (firedDates && (firedDates.has ? firedDates.has(vvo.dateString) : firedDates[vvo.dateString])) {
        return false;
    }

    const todayNoonUtc = getNoonUtcTimestamp(vvo.year, vvo.month, vvo.day);

    // If noon hasn't occurred yet today
    if (now < todayNoonUtc) {
        return false;
    }

    // If current time exceeded the grace deadline
    if (now > todayNoonUtc + gracePeriodMs) {
        return false;
    }

    // Page must have been active/open before or at exact noon
    if (pageOpenedAt > todayNoonUtc) {
        return false;
    }

    return true;
}

export class NoonCannonScheduler {
    constructor(options = {}) {
        this.getNow = options.getNow || (() => Date.now());
        this.pageOpenedAt = options.pageOpenedAt !== undefined ? options.pageOpenedAt : this.getNow();
        this.onAnnounce = options.onAnnounce || options.onFire || null;
        this.onPlayAudio = options.onPlayAudio || null;
        this.gracePeriodMs = options.gracePeriodMs || NOON_GRACE_PERIOD_MS;
        this.firedDates = options.firedDates instanceof Set ? options.firedDates : new Set(options.firedDates || []);
        this.shouldRun = options.shouldRun || null;
        this.pendingAudioDeadline = null;
        this.timerId = null;
        this.intervalId = null;
        this.boundCheck = this.checkAndFire.bind(this);
        this.boundAudioRetry = this.retryPendingAudio.bind(this);
        this.started = false;
    }

    retryPendingAudio() {
        if (!this.pendingAudioDeadline) return;
        const now = this.getNow();
        if (now > this.pendingAudioDeadline) {
            // Expire pending audio attempt after grace deadline; never play late!
            this.pendingAudioDeadline = null;
            return;
        }

        if (typeof this.onPlayAudio === 'function') {
            try {
                const res = this.onPlayAudio();
                if (res && (res.status === 'played' || res.status === 'played_fallback' || res.status === 'muted')) {
                    this.pendingAudioDeadline = null;
                }
            } catch (err) {
                console.warn('Error during pending audio retry:', err);
            }
        }
    }

    checkAndFire() {
        if (typeof this.shouldRun === 'function' && !this.shouldRun()) {
            this.pendingAudioDeadline = null;
            this.scheduleNextTimer();
            return;
        }

        const now = this.getNow();
        const vvo = getVladivostokDateParts(now);

        if (shouldFireNoonCannon({
            now,
            pageOpenedAt: this.pageOpenedAt,
            firedDates: this.firedDates,
            gracePeriodMs: this.gracePeriodMs
        })) {
            // Deduplicate synchronously for this calendar date
            this.firedDates.add(vvo.dateString);

            // 1. Announce event once
            if (typeof this.onAnnounce === 'function') {
                try {
                    this.onAnnounce({ now, dateString: vvo.dateString });
                } catch (err) {
                    console.warn('Error during noon cannon onAnnounce callback:', err);
                }
            }

            // 2. Play audio or schedule retry within grace window if blocked/suspended
            if (typeof this.onPlayAudio === 'function') {
                try {
                    const audioRes = this.onPlayAudio();
                    if (!audioRes || (audioRes.status !== 'played' && audioRes.status !== 'played_fallback' && audioRes.status !== 'muted')) {
                        const todayNoonUtc = getNoonUtcTimestamp(vvo.year, vvo.month, vvo.day);
                        this.pendingAudioDeadline = todayNoonUtc + this.gracePeriodMs;
                    }
                } catch (err) {
                    console.warn('Error during noon audio playback:', err);
                }
            }
        } else {
            // If there is an active pending audio deadline, attempt retry
            this.retryPendingAudio();
        }

        this.scheduleNextTimer();
    }

    scheduleNextTimer() {
        if (!this.started) return;
        if (this.timerId !== null) {
            clearTimeout(this.timerId);
            this.timerId = null;
        }

        const now = this.getNow();
        const nextNoon = getNextNoonTimestamp(now);
        const delay = Math.max(0, nextNoon - now);

        this.timerId = setTimeout(() => {
            this.checkAndFire();
        }, delay);
    }

    start() {
        if (this.started) return;
        this.started = true;

        this.checkAndFire();

        if (typeof setInterval !== 'undefined') {
            this.intervalId = setInterval(this.boundCheck, 1500);
        }

        if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('visibilitychange', this.boundCheck);
            document.addEventListener('click', this.boundAudioRetry, { passive: true });
            document.addEventListener('keydown', this.boundAudioRetry, { passive: true });
        }
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('focus', this.boundCheck);
            window.addEventListener('pageshow', this.boundCheck);
        }
    }

    dispose() {
        this.started = false;
        this.pendingAudioDeadline = null;
        if (this.timerId !== null) {
            clearTimeout(this.timerId);
            this.timerId = null;
        }
        if (this.intervalId !== null) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener('visibilitychange', this.boundCheck);
            document.removeEventListener('click', this.boundAudioRetry);
            document.removeEventListener('keydown', this.boundAudioRetry);
        }
        if (typeof window !== 'undefined' && window.removeEventListener) {
            window.removeEventListener('focus', this.boundCheck);
            window.removeEventListener('pageshow', this.boundCheck);
        }
    }
}
