import { test, expect } from 'bun:test';
import { VehicleSnapshotBuffer, renderVehiclePose, resetVehiclePose, smoothingAlpha, angleDelta } from '../js/vehicle-motion.js';
import { createVehiclePhysicsWorld, resolveVehicleToVehicleCollisions, resolveVehicleWorldCollision } from '../js/physics.js';
import { MsgPackCodec } from '../js/msgpack.js';

const car = (fields = {}) => ({ x: 0, y: 0, z: 0, yaw: 0, vx: 10, vz: 18,
    yawRate: 0, speed: 18, mass: 1450, isAwake: true, isDrifting: true, ...fields });
test('144 Hz drift presentation moves between 60 Hz steps without mutating physics', () => {
    const world = createVehiclePhysicsWorld(), c = car();
    let last = null, held = 0;
    for (let i = 0; i < 144; i++) {
        world.step([c], 1 / 144, [], null, c, { throttle: 1, steer: 1 });
        const before = { ...c }, pose = renderVehiclePose(c, world.alpha);
        expect(c).toEqual(before);
        if (i > 3 && pose.x === last.x && pose.z === last.z) held++;
        last = pose;
    }
    expect(held).toBe(0);
    c.x = 100; resetVehiclePose(c);
    expect(renderVehiclePose(c, 0).x).toBe(100);
});
test('camera smoothing is independent of render rate and yaw crosses the short arc', () => {
    for (const hz of [30, 60, 144]) {
        let x = 0;
        for (let i = 0; i < hz; i++) x += (10 - x) * smoothingAlpha(4, 1 / hz);
        expect(x).toBeCloseTo(10 * (1 - Math.exp(-4)), 10);
    }
    const c = car({ yaw: -Math.PI + 0.1, previousPose: { x: 0, z: 0, yaw: Math.PI - 0.1 } });
    expect(Math.abs(angleDelta(Math.PI, renderVehiclePose(c, 0.5).yaw))).toBeLessThan(1e-10);
});
const snapshot = (sequence, time, x) => MsgPackCodec.decode(MsgPackCodec.encode({
    x, y: 0, z: 0, yaw: 0, vx: 10, vz: 0, speed: 0, yaw_rate: 1,
    sequence, sample_time_ms: time,
}));
test('buffer follows lateral velocity, preserves timing through packet jitter and rejects stale updates', () => {
    const b = new VehicleSnapshotBuffer();
    b.push(snapshot(1, 0, 0), 1000);
    b.push(snapshot(2, 50, 0.5), 1090);
    b.push(snapshot(3, 100, 1), 1100);
    expect(b.push(snapshot(2, 50, 20), 1120)).toBe(false);
    expect(b.sample(1175).x).toBeCloseTo(0.75);
    expect(b.sample(1250).x).toBeCloseTo(1.5);
    expect(b.sample(1250).yaw).toBeCloseTo(0.05);
    expect(b.sample(9999).x).toBeCloseTo(2); // extrapolation capped at 100ms
    expect(b.sample(9999).vx).toBe(0); // a frozen proxy must not impart stale motion in collisions
    b.push(snapshot(4, 200, 100), 1200); // teleport resets interpolation history
    expect(b.sample(1200).x).toBe(100);
});
test('remote bodies are immutable collision obstacles in either pair order', () => {
    for (const reversed of [false, true]) {
        const remote = car({ x: 1, vx: -2, remoteDriver: 'other' });
        const local = car({ x: 0, vx: 5, vz: 0 });
        const before = { ...remote };
        resolveVehicleToVehicleCollisions(reversed ? [remote, local] : [local, remote], 1 / 60);
        resolveVehicleWorldCollision(remote, [{ type: 'circle', x: 1, z: 0, radius: 5 }]);
        expect(remote).toEqual(before);
        expect(local.x).toBeLessThan(0);
        expect(local.vx).toBeLessThan(5);
    }
    const a = car({ remoteDriver: 'a' }), b = car({ remoteDriver: 'b' });
    expect(resolveVehicleToVehicleCollisions([a, b], 1 / 60)).toEqual([]);
});
