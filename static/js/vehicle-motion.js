// Presentation-only poses. Physics and wire snapshots always use simulation state.
export const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
export const smoothingAlpha = (rate, dt) => 1 - Math.exp(-rate * Math.max(0, dt));
export function interpolatePose(a, b, alpha) {
    const t = Math.max(0, Math.min(1, alpha));
    const pose = { ...b };
    for (const key of ['x', 'y', 'z', 'vx', 'vz', 'yawRate', 'speed']) {
        pose[key] = (a[key] || 0) + ((b[key] || 0) - (a[key] || 0)) * t;
    }
    pose.yaw = a.yaw + angleDelta(a.yaw, b.yaw) * t;
    return pose;
}
export function resetVehiclePose(car) {
    car.previousPose = { x: car.x, y: car.y, z: car.z, yaw: car.yaw };
}
export function renderVehiclePose(car, alpha) {
    return interpolatePose(car.previousPose || car, car, alpha);
}

export class VehicleSnapshotBuffer {
    constructor() { this.samples = []; this.offset = null; this.sequence = -1; }
    push(message, receivedAt) {
        const sequence = message.sequence;
        if (Number.isFinite(sequence) && sequence <= this.sequence) return false;
        const time = Number.isFinite(message.sample_time_ms) ? message.sample_time_ms : receivedAt;
        // Establish a server-to-local clock offset, retaining packet spacing even
        // when several packets arrive together. Rebase after long interruptions.
        const last = this.samples.at(-1);
        if (last && time <= last.time) return false;
        if (Number.isFinite(sequence)) this.sequence = sequence;
        const jump = last && Math.hypot(message.x - last.x, message.z - last.z) >
            Math.max(10, Math.hypot(last.vx, last.vz) * (time - last.time) / 1000 * 2);
        if (this.offset === null || jump || (last && time - last.time > 1000)) {
            this.offset = receivedAt - time;
            this.samples = [];
        }
        this.samples.push({ ...message, time,
            vx: Number.isFinite(message.vx) ? message.vx : Math.sin(message.yaw) * message.speed,
            vz: Number.isFinite(message.vz) ? message.vz : Math.cos(message.yaw) * message.speed,
            yawRate: message.yaw_rate || 0 });
        if (this.samples.length > 32) this.samples.shift();
        return true;
    }
    sample(now, delay = 100) {
        if (!this.samples.length) return null;
        const time = now - this.offset - delay;
        while (this.samples.length > 2 && this.samples[1].time <= time) this.samples.shift();
        const first = this.samples[0];
        if (time <= first.time) return { ...first };
        for (let i = 1; i < this.samples.length; i++) {
            const a = this.samples[i - 1], b = this.samples[i];
            if (time <= b.time) return interpolatePose(a, b, (time - a.time) / (b.time - a.time));
        }
        const last = this.samples.at(-1);
        const age = time - last.time;
        const dt = Math.min(100, age) / 1000;
        return { ...last, x: last.x + last.vx * dt, z: last.z + last.vz * dt,
            yaw: last.yaw + last.yawRate * dt,
            vx: age > 100 ? 0 : last.vx, vz: age > 100 ? 0 : last.vz,
            yawRate: age > 100 ? 0 : last.yawRate };
    }
}
