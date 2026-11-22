import { describe, test, expect } from 'bun:test';
import {
    stepVehicleDynamics,
    stepSingleVehicleDynamics,
    resolveVehicleToVehicleCollisions,
    resolveVehicleWorldCollision,
    getVehicleCollisionCircles,
    getMinVehicleCircleGap,
    createVehiclePhysicsWorld,
    stepWorldVehiclePhysics,
    crossYaw,
    rotationalVelocity,
    CAR_SPECS,
    POLICE_SPEED_LIMIT_KMH,
    POLICE_SPEED_LIMIT_MS,
    POLICE_CAR_SPECS,
    applyVehicleImpulse
} from '../js/physics.js';
import { applyPoliceStateSnapshot } from '../js/state.js';

function createTestCar(overrides = {}) {
    const mass = overrides.mass || 1450;
    const length = overrides.length || 4.8;
    const width = overrides.width || 2.3;
    const yawInertia = mass * (width * width + length * length) / 12;
    return {
        id: overrides.id || 'car_test',
        x: overrides.x || 0,
        y: overrides.y || 0.02,
        z: overrides.z || 0,
        yaw: overrides.yaw || 0,
        vx: overrides.vx || 0,
        vz: overrides.vz || 0,
        speed: overrides.speed || 0,
        yawRate: overrides.yawRate || 0,
        mass,
        yawInertia,
        width,
        length,
        axleOffset: overrides.axleOffset || CAR_SPECS.axleOffset,
        collisionRadius: overrides.collisionRadius || CAR_SPECS.collisionRadius,
        isAwake: overrides.isAwake !== undefined ? overrides.isAwake : true,
        isDrifting: overrides.isDrifting || false,
        isBraking: overrides.isBraking || false,
        tractionLoss: overrides.tractionLoss !== undefined ? overrides.tractionLoss : 0,
        ...overrides
    };
}

describe('Vehicle Dynamics & Inertia', () => {
    test('car accelerates forward with positive throttle and respects max speed', () => {
        const car = createTestCar({ yaw: 0 }); // Facing +Z
        const input = { throttle: 1, steer: 0, handbrake: false, boost: false };

        stepVehicleDynamics(car, input, 0.1);
        expect(car.vz).toBeGreaterThan(1.0);
        expect(car.vx).toBeCloseTo(0, 3);
        expect(car.z).toBeGreaterThan(0);

        // Accelerate for 5 seconds
        for (let i = 0; i < 50; i++) {
            stepVehicleDynamics(car, input, 0.1);
        }
        // Should cap near maxSpeedForward (44.44 m/s = 160 km/h)
        expect(car.vz).toBeLessThanOrEqual(CAR_SPECS.maxSpeedForward + 0.5);
        expect(car.vz).toBeGreaterThanOrEqual(CAR_SPECS.maxSpeedForward - 0.5);
    });

    test('car cannot stop on a dime: decelerates with negative acceleration when braking', () => {
        const car = createTestCar({ yaw: 0, vz: 20.0, speed: 20.0 }); // Moving at 20 m/s (~72 km/h)
        const brakeInput = { throttle: -1, steer: 0, handbrake: false, boost: false };

        // After a single 0.05s frame, car must NOT stop immediately
        stepVehicleDynamics(car, brakeInput, 0.05);
        expect(car.vz).toBeGreaterThan(19.0);
        expect(car.vz).toBeLessThan(20.0);
        expect(car.isBraking).toBe(true);

        // Measure deceleration over 1 second
        const vStart = car.vz;
        for (let i = 0; i < 20; i++) {
            stepVehicleDynamics(car, brakeInput, 0.05);
        }
        const deltaV = vStart - car.vz;
        expect(deltaV).toBeGreaterThanOrEqual(9.0);
        expect(deltaV).toBeLessThanOrEqual(14.0);
        expect(car.vz).toBeGreaterThan(0); // Still moving after 1s!
    });

    test('handbrake stops vehicle to 0 without entering reverse, unlike foot brake (throttle: -1)', () => {
        const carHandbrake = createTestCar({ yaw: 0, vz: 10.0, speed: 10.0 });
        const carFootBrake = createTestCar({ yaw: 0, vz: 10.0, speed: 10.0 });

        const handbrakeInput = { throttle: 0, steer: 0, handbrake: true, boost: false };
        const footBrakeInput = { throttle: -1, steer: 0, handbrake: false, boost: false };

        // Step both for 2 seconds (20 frames of 0.1s)
        for (let i = 0; i < 20; i++) {
            stepVehicleDynamics(carHandbrake, handbrakeInput, 0.1);
            stepVehicleDynamics(carFootBrake, footBrakeInput, 0.1);
        }

        // Handbrake must come to a complete stop and remain at 0 (never reverse)
        expect(carHandbrake.vz).toBe(0);
        expect(carHandbrake.vx).toBe(0);

        // Foot brake must transition through 0 and accelerate into reverse
        expect(carFootBrake.vz).toBeLessThan(0);
    });

    test('engine beats handbrake: holding throttle (W) and handbrake (Space) maintains forward propulsion and does not stop', () => {
        // 1. Moving vehicle maintains speed under throttle + handbrake
        const movingCar = createTestCar({ yaw: 0, vz: 20.0, speed: 20.0 });
        const throttleHandbrakeInput = { throttle: 1, steer: 0, handbrake: true, boost: false };

        for (let i = 0; i < 30; i++) {
            stepVehicleDynamics(movingCar, throttleHandbrakeInput, 0.1);
        }

        // Must still be moving fast under forward engine power (never decelerate to 0)
        expect(movingCar.vz).toBeGreaterThan(18.0);
        expect(movingCar.isBraking).toBe(false);

        // 2. Stationary vehicle accelerates forward under throttle + handbrake
        const stoppedCar = createTestCar({ yaw: 0, vx: 0, vz: 0, speed: 0 });
        for (let i = 0; i < 20; i++) {
            stepVehicleDynamics(stoppedCar, throttleHandbrakeInput, 0.1);
        }

        expect(stoppedCar.vz).toBeGreaterThan(10.0);
        expect(stoppedCar.speed).toBeGreaterThan(10.0);
    });

    test('engine beats handbrake in drift: holding throttle and handbrake while steering sustains drift without stopping', () => {
        const car = createTestCar({ yaw: 0, vz: 15.0, speed: 15.0 });
        const driftInput = { throttle: 1, steer: 0.5, handbrake: true, boost: false };

        for (let i = 0; i < 20; i++) {
            stepVehicleDynamics(car, driftInput, 0.1);
        }

        expect(car.isDrifting).toBe(true);
        const totalSpeed = Math.hypot(car.vx, car.vz);
        expect(totalSpeed).toBeGreaterThan(8.0);
    });

    test('drift speed is less effective than straight-line speed due to tire scrub and propulsion loss', () => {
        // Straight line car reaches top speed of ~44.44 m/s (160 km/h) with 0 traction loss
        const straightCar = createTestCar({ yaw: 0, vz: 20.0, speed: 20.0 });
        const straightInput = { throttle: 1, steer: 0, handbrake: false, boost: false };
        for (let i = 0; i < 40; i++) {
            stepVehicleDynamics(straightCar, straightInput, 0.1);
        }
        const straightSpeed = Math.hypot(straightCar.vx, straightCar.vz);
        expect(straightSpeed).toBeGreaterThan(43.5);
        expect(straightCar.tractionLoss).toBeLessThan(0.01);

        // Drifting car with sustained steering and handbrake stabilizes at lower speed (~19-20 m/s)
        const driftCar = createTestCar({ yaw: 0, vz: 20.0, speed: 20.0 });
        const driftInput = { throttle: 1, steer: 0.5, handbrake: true, boost: false };
        for (let i = 0; i < 40; i++) {
            stepVehicleDynamics(driftCar, driftInput, 0.1);
        }
        const driftSpeed = Math.hypot(driftCar.vx, driftCar.vz);

        expect(driftCar.isDrifting).toBe(true);
        expect(driftCar.tractionLoss).toBeGreaterThan(0.5);
        expect(driftSpeed).toBeLessThan(straightSpeed - 10.0); // Distinctly slower than straight line
        expect(driftSpeed).toBeGreaterThan(10.0); // Still moving fast under engine power
    });

    test('exiting drift accelerates forward as car regains traction and restores propulsion efficiency', () => {
        const car = createTestCar({ yaw: 0, vz: 20.0, speed: 20.0 });
        const driftInput = { throttle: 1, steer: 0.5, handbrake: true, boost: false };

        // Establish steady drift
        for (let i = 0; i < 40; i++) {
            stepVehicleDynamics(car, driftInput, 0.1);
        }
        const speedAtDriftEnd = Math.hypot(car.vx, car.vz);
        const lossAtDriftEnd = car.tractionLoss;
        expect(lossAtDriftEnd).toBeGreaterThan(0.5);

        // Exit drift: release handbrake and straighten wheels while holding throttle
        const exitInput = { throttle: 1, steer: 0, handbrake: false, boost: false };
        for (let i = 0; i < 20; i++) {
            stepVehicleDynamics(car, exitInput, 0.1);
        }

        const speedAfterExit = Math.hypot(car.vx, car.vz);
        // Traction recovers smoothly towards 0
        expect(car.tractionLoss).toBeLessThan(0.05);
        // Vehicle surges forward, accelerating from drift speed up to top speed
        expect(speedAfterExit).toBeGreaterThan(speedAtDriftEnd + 10.0);
        expect(speedAfterExit).toBeCloseTo(CAR_SPECS.maxSpeedForward, 0);
    });

    test('releasing handbrake while maintaining lateral slip retains positive traction penalty', () => {
        const car = createTestCar({ yaw: 0, vz: 20.0, speed: 20.0 });
        // Drift initiated with handbrake and sharp steering
        for (let i = 0; i < 20; i++) {
            stepVehicleDynamics(car, { throttle: 1, steer: 0.6, handbrake: true, boost: false }, 0.1);
        }
        // Release handbrake while keeping sharp steering active
        for (let i = 0; i < 15; i++) {
            stepVehicleDynamics(car, { throttle: 1, steer: 0.6, handbrake: false, boost: false }, 0.1);
        }
        // Lateral slip is still substantial, so traction loss must remain active
        expect(car.tractionLoss).toBeGreaterThan(0.2);
        const speed = Math.hypot(car.vx, car.vz);
        expect(speed).toBeLessThan(CAR_SPECS.maxSpeedForward - 3.0);
    });

    test('recovering traction with zero throttle never gains kinetic energy in collision-free motion', () => {
        const car = createTestCar({ yaw: 0, vz: 20.0, speed: 20.0 });
        for (let i = 0; i < 40; i++) {
            stepVehicleDynamics(car, { throttle: 1, steer: 0.5, handbrake: true, boost: false }, 0.1);
        }
        expect(car.tractionLoss).toBeGreaterThan(0.5);

        // Coast out of drift: throttle 0, handbrake false, straight steer
        let previousSpeed = Math.hypot(car.vx, car.vz);
        for (let i = 0; i < 20; i++) {
            stepVehicleDynamics(car, { throttle: 0, steer: 0, handbrake: false, boost: false }, 0.05);
            const currentSpeed = Math.hypot(car.vx, car.vz);
            expect(currentSpeed).toBeLessThanOrEqual(previousSpeed + 1e-6);
            previousSpeed = currentSpeed;
        }
        expect(car.tractionLoss).toBeLessThan(0.05);
    });

    test('repeated handbrake toggles do not accumulate speed bonus or boost glitch', () => {
        const carStraight = createTestCar({ yaw: 0, vz: 10.0, speed: 10.0 });
        const carToggle = createTestCar({ yaw: 0, vz: 10.0, speed: 10.0 });

        for (let i = 0; i < 30; i++) {
            stepVehicleDynamics(carStraight, { throttle: 1, steer: 0, handbrake: false, boost: false }, 0.1);
            stepVehicleDynamics(carToggle, { throttle: 1, steer: 0, handbrake: (i % 2 === 0), boost: false }, 0.1);

            const currentStraightSpeed = Math.hypot(carStraight.vx, carStraight.vz);
            const currentToggleSpeed = Math.hypot(carToggle.vx, carToggle.vz);
            expect(currentToggleSpeed).toBeLessThanOrEqual(currentStraightSpeed + 1e-4);
        }

        const finalStraightSpeed = Math.hypot(carStraight.vx, carStraight.vz);
        expect(finalStraightSpeed).toBeCloseTo(CAR_SPECS.maxSpeedForward, 0);
    });

    test('boost release does not delete existing velocity; car coasts down naturally', () => {
        const car = createTestCar({ yaw: 0, vz: 50.0, speed: 50.0 });
        // Throttle held, but boost released
        const normalThrottleInput = { throttle: 1, steer: 0, handbrake: false, boost: false };
        stepVehicleDynamics(car, normalThrottleInput, 0.05);
        // Velocity should NOT drop immediately to maxSpeedForward (44.44 m/s)
        expect(car.vz).toBeGreaterThan(49.0);
    });

    test('car coasts to a stop with negative drag acceleration when throttle is released', () => {
        const car = createTestCar({ yaw: 0, vz: 10.0, speed: 10.0 });
        const coastInput = { throttle: 0, steer: 0, handbrake: false, boost: false };

        stepVehicleDynamics(car, coastInput, 0.1);
        expect(car.vz).toBeLessThan(10.0);
        expect(car.vz).toBeGreaterThan(9.5); // Still rolling smoothly due to inertia

        for (let i = 0; i < 30; i++) {
            stepVehicleDynamics(car, coastInput, 0.1);
        }
        expect(car.vz).toBeLessThan(6.0);
        expect(car.vz).toBeGreaterThan(2.0);
    });

    test('stopped car with handbrake cannot be spun by steering alone', () => {
        const car = createTestCar({ yaw: 0, vx: 0, vz: 0, speed: 0, yawRate: 0 });
        const driftInput = { throttle: 0, steer: 1.0, handbrake: true, boost: false };
        stepVehicleDynamics(car, driftInput, 0.1);
        expect(car.yawRate).toBeCloseTo(0, 3);
        expect(car.yaw).toBeCloseTo(0, 3);
        expect(car.isDrifting).toBe(false);
    });

    test('high-speed turn produces outward skidding and lateral velocity', () => {
        const car = createTestCar({ yaw: 0, vz: 20.0, speed: 20.0 });
        const steerInput = { throttle: 0.5, steer: 1.0, handbrake: false, boost: false };

        stepVehicleDynamics(car, steerInput, 0.1);

        expect(Math.abs(car.yawRate)).toBeGreaterThan(0);
        expect(Math.abs(car.yaw)).toBeGreaterThan(0);
        const uRightX = Math.cos(car.yaw);
        const uRightZ = -Math.sin(car.yaw);
        const vLat = car.vx * uRightX + car.vz * uRightZ;
        expect(Math.abs(vLat)).toBeGreaterThan(0.2);
    });

    test('handbrake during sharp turn triggers drift state and extended lateral sliding', () => {
        const car = createTestCar({ yaw: 0, vz: 15.0, speed: 15.0 });
        const driftInput = { throttle: 0.5, steer: 1.0, handbrake: true, boost: false };

        for (let i = 0; i < 3; i++) {
            stepVehicleDynamics(car, driftInput, 0.1);
        }
        expect(car.isDrifting).toBe(true);

        const uRightX = Math.cos(car.yaw);
        const uRightZ = -Math.sin(car.yaw);
        const vLat = car.vx * uRightX + car.vz * uRightZ;
        expect(Math.abs(vLat)).toBeGreaterThan(0.5);
    });

    test('handbrake while moving with steering rotates vehicle into responsive handbrake turn', () => {
        const carRight = createTestCar({ yaw: 0, vz: 12.0, speed: 12.0 });
        const carLeft = createTestCar({ yaw: 0, vz: 12.0, speed: 12.0 });

        // User driving at 12 m/s presses handbrake (Space) and steers right (D / ArrowRight) with throttle 0
        const inputRight = { throttle: 0, steer: 1.0, handbrake: true, boost: false };
        const inputLeft = { throttle: 0, steer: -1.0, handbrake: true, boost: false };

        for (let i = 0; i < 40; i++) {
            stepVehicleDynamics(carRight, inputRight, 0.02);
            stepVehicleDynamics(carLeft, inputLeft, 0.02);
        }

        // Must produce significant yaw rotation (at least 60 degrees / > 1.0 rad) instead of ignoring steering
        expect(carRight.yaw).toBeGreaterThan(1.0);
        expect(carLeft.yaw).toBeLessThan(-1.0);
        // Vehicle comes to a complete halt
        expect(carRight.speed).toBeLessThan(0.5);
        expect(carLeft.speed).toBeLessThan(0.5);
    });
});

describe('Rigid Body Impulse Collisions', () => {
    test('front bumper +X impact produces positive yaw rate (clockwise spin around +Y)', () => {
        const r = { x: 0, z: 1.25 };
        const q = { x: 1000, z: 0 };
        const torque = crossYaw(r, q);
        expect(torque).toBeGreaterThan(0);

        const rot = rotationalVelocity(r, 2.0);
        expect(rot.x).toBeGreaterThan(0);
        expect(rot.z).toBeCloseTo(0, 5);
    });

    test('equal mass head-on collision bounces to -2.5 and +2.5 m/s with restitution 0.25', () => {
        const carA = createTestCar({ id: 'carA', x: 0, z: 0, yaw: 0, vz: 10, speed: 10, mass: 1500 });
        const carB = createTestCar({ id: 'carB', x: 0, z: 3.2, yaw: Math.PI, vz: -10, speed: 10, mass: 1500 });

        const events = resolveVehicleToVehicleCollisions([carA, carB], 0.05);
        expect(events.length).toBeGreaterThan(0);

        expect(carA.vz).toBeCloseTo(-2.5, 1);
        expect(carB.vz).toBeCloseTo(2.5, 1);

        const totalMomentumZ = carA.mass * carA.vz + carB.mass * carB.vz;
        expect(totalMomentumZ).toBeCloseTo(0, 2);
    });

    test('off-center collision rotates struck car and wakes up parked car', () => {
        const carA = createTestCar({ id: 'carA', x: 0, z: 0, yaw: 0, vz: 12, speed: 12, mass: 1500 });
        const carB = createTestCar({ id: 'carB', x: 1.1, z: 2.8, yaw: 0, vx: 0, vz: 0, speed: 0, yawRate: 0, mass: 1500, isAwake: false });

        const events = resolveVehicleToVehicleCollisions([carA, carB], 0.05);
        expect(events.length).toBeGreaterThan(0);

        expect(carB.isAwake).toBe(true);
        expect(carB.vz).toBeGreaterThan(0);
        expect(Math.abs(carB.yawRate)).toBeGreaterThan(0.5);
    });

    test('collision respects vehicle mass ratio (heavier car transfers more impulse)', () => {
        const heavyCar = createTestCar({ id: 'heavy', x: 0, z: 0, yaw: 0, vz: 10, speed: 10, mass: 1560 });
        const lightCar = createTestCar({ id: 'light', x: 0, z: 3.2, yaw: Math.PI, vz: 0, speed: 0, mass: 1280, isAwake: false });

        resolveVehicleToVehicleCollisions([heavyCar, lightCar], 0.05);

        const deltaVHeavy = Math.abs(10 - heavyCar.vz);
        const deltaVLight = Math.abs(0 - lightCar.vz);
        expect(deltaVLight).toBeGreaterThan(deltaVHeavy);
        expect(lightCar.isAwake).toBe(true);
    });

    test('overlapping stationary cars separate via mass-weighted push without gaining velocity', () => {
        const carA = createTestCar({ id: 'carA', x: 0, z: 0, yaw: 0, vx: 0, vz: 0, speed: 0, mass: 1500 });
        const carB = createTestCar({ id: 'carB', x: 0, z: 1.8, yaw: 0, vx: 0, vz: 0, speed: 0, mass: 1500 });

        resolveVehicleToVehicleCollisions([carA, carB], 0.05);

        expect(carA.z).toBeLessThan(0);
        expect(carB.z).toBeGreaterThan(1.8);
        expect(Math.abs(carA.vz)).toBeLessThan(0.01);
        expect(Math.abs(carB.vz)).toBeLessThan(0.01);
    });

    test('parked car rolls, decelerates under ground friction, and settles to sleep', () => {
        const car = createTestCar({ id: 'parked', x: 0, z: 0, yaw: 0, vx: 0, vz: 4.0, yawRate: 1.5, isAwake: true });
        for (let i = 0; i < 40; i++) {
            stepVehicleDynamics(car, null, 0.05);
        }
        expect(car.isAwake).toBe(false);
        expect(car.vx).toBe(0);
        expect(car.vz).toBe(0);
        expect(car.yawRate).toBe(0);
    });
});

describe('Continuous 3-Circle Hull & World Collisions', () => {
    test('getVehicleCollisionCircles returns 3 overlapping circles covering the full chassis without gaps', () => {
        const car = createTestCar({ x: 10, z: 20, yaw: 0 });
        const circles = getVehicleCollisionCircles(car);
        expect(circles.length).toBe(3);
        // Front circle along +Z (yaw = 0)
        expect(circles[0].x).toBeCloseTo(10, 4);
        expect(circles[0].z).toBeCloseTo(21.18, 4);
        expect(circles[0].radius).toBe(0.96);
        // Center circle at chassis midpoint
        expect(circles[1].x).toBeCloseTo(10, 4);
        expect(circles[1].z).toBeCloseTo(20.0, 4);
        expect(circles[1].radius).toBe(0.96);
        // Rear circle along -Z
        expect(circles[2].x).toBeCloseTo(10, 4);
        expect(circles[2].z).toBeCloseTo(18.82, 4);
        expect(circles[2].radius).toBe(0.96);
    });

    test('minimum vehicle circle gap follows the visual collider positions and each car hull', () => {
        const car = createTestCar({ x: 0, z: 0 });
        const police = createTestCar({ x: 3, z: 0, axleOffset: POLICE_CAR_SPECS.axleOffset,
            collisionRadius: POLICE_CAR_SPECS.collisionRadius });
        expect(getMinVehicleCircleGap(car, police)).toBeCloseTo(1.08, 5);
        police.x = 2;
        expect(getMinVehicleCircleGap(car, police)).toBeCloseTo(0.08, 5);
        police.x = 1.8;
        expect(getMinVehicleCircleGap(car, police)).toBeLessThan(0);
    });

    test('incoming police snapshot preserves sampled collision pose until the next render sample', () => {
        const police = createTestCar({ id: 'police_car_0', x: 3, z: 0, vx: 4,
            axleOffset: POLICE_CAR_SPECS.axleOffset, collisionRadius: POLICE_CAR_SPECS.collisionRadius });
        police._initialized = true;
        police.snapshotBuffer = { samples: [{ x: 3, z: 0 }] };
        const state = { policeCars: new Map([[police.id, police]]), policeStateSequence: 1 };
        const playerCar = createTestCar({ x: 0, z: 0 });
        const gapBefore = getMinVehicleCircleGap(playerCar, police);
        const result = applyPoliceStateSnapshot(state, { sequence: 2, police_cars: [{
            id: police.id, x: 1.5, y: 0.02, z: 0, vx: -2, vz: 0,
            yaw: 0.5, yaw_rate: 0.2, speed: 2, state: 'chase'
        }] });
        expect(result.applied).toBe(true);
        expect(police.serverX).toBe(1.5);
        expect(police.serverVx).toBe(-2);
        expect(police.serverYaw).toBe(0.5);
        expect(police.x).toBe(3);
        expect(police.vx).toBe(4);
        expect(getMinVehicleCircleGap(playerCar, police)).toBeCloseTo(gapBefore, 5);
    });

    test('center circle detects obstacle positioned at car chassis waist', () => {
        const car = createTestCar({ x: 0, z: 0, yaw: 0, vx: 5, vz: 0 });
        const colliders = [
            { type: 'circle', x: 1.4, z: 0, radius: 0.5, height: 2.0, climbable: false }
        ];
        const hit = resolveVehicleWorldCollision(car, colliders, null);
        expect(hit).toBe(true);
    });

    test('rotating car front bumper hitting a wall receives opposing angular impulse', () => {
        const car = createTestCar({ x: 1.0, z: 0, yaw: 0, vx: 0, vz: 0, yawRate: 4.0 });
        const colliders = [
            { type: 'box', x: 2.8, z: 1.25, halfW: 1.0, halfD: 2.0, height: 4.0, climbable: false }
        ];
        const initialYawRate = car.yawRate;
        const hit = resolveVehicleWorldCollision(car, colliders, null);
        expect(hit).toBe(true);
        expect(car.yawRate).toBeLessThan(initialYawRate);
    });

    test('resolveVehicleWorldCollision stops and bounces car against static world box', () => {
        const car = createTestCar({ x: 7.0, z: 28.0, yaw: 0, vx: 10.0, vz: 0, speed: 10.0 });
        const colliders = [
            { type: 'box', x: 9.5, z: 28.0, halfW: 2.3, halfD: 3.2, height: 4.5, climbable: false }
        ];
        const bounds = { minX: -13, maxX: 44, minZ: -150, maxZ: 150 };

        const hit = resolveVehicleWorldCollision(car, colliders, bounds);
        expect(hit).toBe(true);
        expect(car.vx).toBeLessThan(10.0);
    });

    test('resolveVehicleWorldCollision strictly enforces clearance against wall', () => {
        const car = createTestCar({ x: 6.0, z: 10.0, yaw: 0, vx: 5.0, vz: 0 });
        const colliders = [
            { type: 'box', x: 8.0, z: 10.0, halfW: 1.0, halfD: 5.0, height: 3.0, climbable: false }
        ];
        // Wall left edge is at x = 7.0. Car circle radius is 0.96.
        // Car must be separated so that circleX + radius <= 7.001
        resolveVehicleWorldCollision(car, colliders, null);
        const circles = getVehicleCollisionCircles(car);
        for (const c of circles) {
            expect(c.x + c.radius).toBeLessThanOrEqual(7.005);
        }
    });

    test('front bumper striking boundary wall at angle produces rotational torque away from wall', () => {
        // Car angled at yaw = 0.5 rad (~28 deg) heading toward minX boundary at -13
        const car = createTestCar({ x: -11.5, z: 0, yaw: 0.5, vx: -5.0, vz: 0, yawRate: 0 });
        const bounds = { minX: -13, maxX: 44, minZ: -150, maxZ: 150 };
        const hit = resolveVehicleWorldCollision(car, [], bounds);
        expect(hit).toBe(true);
        // Angled collision on front bumper at boundary wall imparts torque
        expect(Math.abs(car.yawRate)).toBeGreaterThan(0.1);
    });
});

describe('World Vehicle Physics & Fixed Timestep Solver', () => {
    test('createVehiclePhysicsWorld handles negative/zero fixedDt safely without freeze', () => {
        const world = createVehiclePhysicsWorld({ fixedDt: -0.05 });
        const car = createTestCar({ x: 0, z: 0 });
        // Stepping should execute cleanly using safe default fixedDt
        const events = world.step([car], 0.05, [], null, null, null);
        expect(Array.isArray(events)).toBe(true);
    });

    test('fixed-step accumulator produces consistent physical displacement across 30Hz, 60Hz, and 144Hz', () => {
        // Run identical vehicle under constant acceleration for exactly 1.0 simulated second
        function runSimulation(frameDt, totalTime = 1.0) {
            const world = createVehiclePhysicsWorld({ fixedDt: 1 / 60 });
            const car = createTestCar({ x: 0, z: 0, yaw: 0 });
            const input = { throttle: 1, steer: 0, handbrake: false, boost: false };
            const numFrames = Math.round(totalTime / frameDt);
            for (let i = 0; i < numFrames; i++) {
                world.step([car], frameDt, [], null, car, input);
            }
            return { z: car.z, vz: car.vz };
        }

        const res30 = runSimulation(1 / 30, 1.0);
        const res60 = runSimulation(1 / 60, 1.0);
        const res144 = runSimulation(1 / 144, 1.0);

        // All frame rates must yield nearly identical distance and velocity
        expect(Math.abs(res30.z - res60.z)).toBeLessThan(0.01);
        expect(Math.abs(res144.z - res60.z)).toBeLessThan(0.45);
        expect(Math.abs(res30.vz - res60.vz)).toBeLessThan(0.01);
        expect(Math.abs(res144.vz - res60.vz)).toBeLessThan(0.45);
    });

    test('three-car pileup against a static wall separates all cars with non-negative clearance', () => {
        const world = createVehiclePhysicsWorld({ fixedDt: 1 / 60 });
        // Wall at z = 10 (halfD = 1.0, wall front at z = 9.0)
        const wall = [{ type: 'box', x: 0, z: 10.0, halfW: 10.0, halfD: 1.0, height: 3.0, climbable: false }];
        // Car 1 at z = 7.5, Car 2 at z = 5.2, Car 3 at z = 2.9 (compressed tightly along Z)
        const car1 = createTestCar({ id: 'car1', x: 0, z: 7.5, yaw: 0, vz: 1.0 });
        const car2 = createTestCar({ id: 'car2', x: 0, z: 5.5, yaw: 0, vz: 2.0 });
        const car3 = createTestCar({ id: 'car3', x: 0, z: 3.5, yaw: 0, vz: 3.0 });

        world.step([car1, car2, car3], 0.1, wall, null, null, null);

        // Check that Car 1 front bumper does not penetrate wall front (z <= 9.0)
        const circles1 = getVehicleCollisionCircles(car1);
        expect(circles1[0].z + circles1[0].radius).toBeLessThanOrEqual(9.01);

        // Check that car pairs do not have deep overlaps
        const dist12 = car1.z - car2.z;
        const dist23 = car2.z - car3.z;
        expect(dist12).toBeGreaterThanOrEqual(1.8);
        expect(dist23).toBeGreaterThanOrEqual(1.8);
    });

    test('active local car receives impulse from moving remote vehicle and bounces realistically', () => {
        const world = createVehiclePhysicsWorld({ fixedDt: 1 / 60 });
        // Local car moving forward at 10 m/s
        const localCar = createTestCar({ id: 'local', x: 0, z: 0, yaw: 0, vx: 0, vz: 10.0, speed: 10.0 });
        // Remote car moving toward local car at -10 m/s
        const remoteCar = createTestCar({
            id: 'remote',
            x: 0,
            z: 2.5,
            yaw: 0,
            vx: 0,
            vz: -10.0,
            speed: -10.0,
            remoteDriver: 'other_player'
        });

        // Step physics with local input
        const input = { throttle: 1, steer: 0, handbrake: false, boost: false };
        const events = world.step([localCar, remoteCar], 0.05, [], null, localCar, input);

        expect(events.length).toBeGreaterThan(0);
        // Local car must bounce backward from head-on impact with moving remote car
        expect(localCar.vz).toBeLessThan(0);
    });
});

describe('Police Car Specs & Heavy Collision Deflection', () => {
    test('police speed limit and vehicle specs match contract', () => {
        expect(POLICE_SPEED_LIMIT_KMH).toBe(40);
        expect(POLICE_SPEED_LIMIT_MS).toBeCloseTo(40 / 3.6, 8);
        expect(POLICE_CAR_SPECS.mass).toBe(4200);
        expect(POLICE_CAR_SPECS.mass).toBeGreaterThan(CAR_SPECS.mass);
        expect(POLICE_CAR_SPECS.maxSpeedForward).toBe(CAR_SPECS.maxSpeedForward);
        expect(POLICE_CAR_SPECS.maxSpeedBoost).toBe(CAR_SPECS.maxSpeedBoost);
        expect(POLICE_CAR_SPECS.length).toBe(4.8);
        expect(POLICE_CAR_SPECS.width).toBe(2.3);
        expect(POLICE_CAR_SPECS.axleOffset).toBe(1.18);
        expect(POLICE_CAR_SPECS.collisionRadius).toBe(0.96);
        expect(POLICE_CAR_SPECS.restitution).toBe(0.25);
    });

    test('heavy police car deflects standard player car significantly more than itself in head-on collision', () => {
        const policeCar = createTestCar({
            id: 'police_car_0',
            x: 0,
            z: 0,
            yaw: 0,
            vx: 0,
            vz: 15,
            speed: 15,
            mass: POLICE_CAR_SPECS.mass,
            length: POLICE_CAR_SPECS.length,
            width: POLICE_CAR_SPECS.width,
            axleOffset: POLICE_CAR_SPECS.axleOffset,
            collisionRadius: POLICE_CAR_SPECS.collisionRadius
        });
        const playerCar = createTestCar({
            id: 'car_0',
            x: 0,
            z: 3.5,
            yaw: Math.PI,
            vx: 0,
            vz: -15,
            speed: 15,
            mass: CAR_SPECS.mass
        });

        const events = resolveVehicleToVehicleCollisions([policeCar, playerCar], 0.05);
        expect(events.length).toBeGreaterThan(0);

        const deltaVPolice = Math.abs(15 - policeCar.vz);
        const deltaVPlayer = Math.abs(-15 - playerCar.vz);
        expect(deltaVPlayer).toBeGreaterThan(deltaVPolice * 2.5);
    });

    test('isServerControlled police car keeps 4200kg finite mass without mutating its pose in stepWorldVehiclePhysics', () => {
        const world = createVehiclePhysicsWorld({ fixedDt: 1 / 60 });
        const policeCar = createTestCar({
            id: 'police_car_0',
            isPolice: true,
            isServerControlled: true,
            remoteDriver: null,
            x: 0,
            z: 0,
            yaw: 0,
            vx: 0,
            vz: 16,
            speed: 16,
            mass: POLICE_CAR_SPECS.mass,
            length: POLICE_CAR_SPECS.length,
            width: POLICE_CAR_SPECS.width,
            axleOffset: POLICE_CAR_SPECS.axleOffset,
            collisionRadius: POLICE_CAR_SPECS.collisionRadius
        });
        const playerCar = createTestCar({
            id: 'car_0',
            x: 0,
            z: 3.4,
            yaw: Math.PI,
            vx: 0,
            vz: -16,
            speed: 16,
            mass: CAR_SPECS.mass
        });

        const events = world.step([policeCar, playerCar], 1 / 60, []);
        expect(events.length).toBeGreaterThan(0);
        // Server-controlled police car pose/velocity MUST NOT be locally mutated or damped
        expect(policeCar.x).toBe(0);
        expect(policeCar.z).toBe(0);
        expect(policeCar.vx).toBe(0);
        expect(policeCar.vz).toBe(16);
        // Player car MUST be strongly deflected
        expect(playerCar.vz).toBeGreaterThan(0);
    });

    test('applyVehicleImpulse validates inputs, rejects stale sequences, and updates velocity', () => {
        const car = createTestCar({ id: 'car_0', yaw: 0, vx: 0, vz: 5, speed: 5, isAwake: false });

        expect(applyVehicleImpulse(car, { dvx: NaN, dvz: 0 }).applied).toBe(false);
        expect(applyVehicleImpulse(car, { dvx: 250, dvz: 0 }).applied).toBe(false);

        const r1 = applyVehicleImpulse(car, {
            police_car_id: 'police_car_0',
            dvx: 3,
            dvz: -10,
            dyaw_rate: 0.4,
            sequence: 5
        }, 1000);
        expect(r1.applied).toBe(true);
        expect(car.vx).toBeCloseTo(3, 6);
        expect(car.vz).toBeCloseTo(-5, 6);
        expect(car.yawRate).toBeCloseTo(0.4, 6);
        expect(car.speed).toBeCloseTo(-5, 6);
        expect(car.isAwake).toBe(true);

        // Stale sequence rejected
        const rStale = applyVehicleImpulse(car, {
            police_car_id: 'police_car_0',
            dvx: 5,
            dvz: 0,
            sequence: 5
        }, 1050);
        expect(rStale.applied).toBe(false);
        expect(rStale.reason).toBe('STALE_SEQUENCE');
    });

    test('reconciles local collision and vehicle_impulse in both client-first and server-first order', () => {
        // Order A: Client-first local collision then server vehicle_impulse
        const policeA = createTestCar({
            id: 'police_car_0',
            isPolice: true,
            isServerControlled: true,
            x: 0, z: 0, yaw: 0, vx: 0, vz: 15, speed: 15,
            mass: POLICE_CAR_SPECS.mass,
            axleOffset: POLICE_CAR_SPECS.axleOffset,
            collisionRadius: POLICE_CAR_SPECS.collisionRadius
        });
        const playerA = createTestCar({
            id: 'car_0',
            x: 0, z: 3.5, yaw: Math.PI, vx: 0, vz: -15, speed: 15,
            mass: CAR_SPECS.mass
        });

        resolveVehicleToVehicleCollisions([policeA, playerA], 0.05, 1000);
        const dvAfterLocal = playerA.vz - (-15);
        expect(dvAfterLocal).toBeGreaterThan(10);

        // Server sends same-magnitude impulse 50ms later -> must NOT double-apply (~2x)!
        const srvAfterLocal = applyVehicleImpulse(playerA, {
            police_car_id: 'police_car_0',
            dvx: 0,
            dvz: dvAfterLocal,
            dyaw_rate: 0,
            sequence: 1
        }, 1050);
        expect(srvAfterLocal.applied).toBe(true);
        expect(srvAfterLocal.dvz).toBe(0);
        expect(playerA.vz - (-15)).toBeCloseTo(dvAfterLocal, 6);

        // Order B: Server-first vehicle_impulse then local collision 50ms later
        const policeB = createTestCar({
            id: 'police_car_0',
            isPolice: true,
            isServerControlled: true,
            x: 0, z: 0, yaw: 0, vx: 0, vz: 15, speed: 15,
            mass: POLICE_CAR_SPECS.mass,
            axleOffset: POLICE_CAR_SPECS.axleOffset,
            collisionRadius: POLICE_CAR_SPECS.collisionRadius
        });
        const playerB = createTestCar({
            id: 'car_0',
            x: 0, z: 3.5, yaw: Math.PI, vx: 0, vz: -15, speed: 15,
            mass: CAR_SPECS.mass
        });

        const srvFirst = applyVehicleImpulse(playerB, {
            police_car_id: 'police_car_0',
            dvx: 0,
            dvz: dvAfterLocal,
            dyaw_rate: 0,
            sequence: 1
        }, 2000);
        expect(srvFirst.dvz).toBeCloseTo(dvAfterLocal, 6);

        resolveVehicleToVehicleCollisions([policeB, playerB], 0.05, 2050);
        // Velocity change must NOT double-apply!
        expect(playerB.vz - (-15)).toBeCloseTo(dvAfterLocal, 6);

        // A distinct subsequent impulse still applies normally.
        const nextHit = applyVehicleImpulse(playerB, {
            police_car_id: 'police_car_0',
            dvx: 0,
            dvz: 4,
            sequence: 2
        }, 2400);
        expect(nextHit.applied).toBe(true);
        expect(nextHit.dvz).toBe(4);
    });

    test('local collision ledger absorbs a matching server impulse after 600ms', () => {
        const car = createTestCar({ id: 'car_0', vx: 0, vz: 4, speed: 4 });
        car._recentLocalPoliceImpulses = new Map([['police_car_0', {
            timestamp: 1000, dvx: 0, dvz: 4, dyawRate: 0
        }]]);
        const result = applyVehicleImpulse(car, {
            police_car_id: 'police_car_0', dvx: 0, dvz: 4, sequence: 1
        }, 1600);
        expect(result.reason).toBe('ALREADY_APPLIED_LOCALLY');
        expect(result.dvz).toBe(0);
        expect(car.vz).toBe(4);
    });

    test('applyVehicleImpulse rejects extreme dyaw_rate and preserves orthogonal dvx on oblique client-first reconciliation', () => {
        const car = createTestCar({ id: 'car_0', yaw: 0, vx: 0, vz: 0, yawRate: 0, speed: 0 });

        const badYawHigh = applyVehicleImpulse(car, { dvx: 0, dvz: 0, dyaw_rate: 1e9, sequence: 1 }, 1000);
        expect(badYawHigh).toEqual({ applied: false, reason: 'INVALID_IMPULSE' });
        const badYawNeg = applyVehicleImpulse(car, { dvx: 0, dvz: 0, dyaw_rate: -50.1, sequence: 2 }, 1000);
        expect(badYawNeg).toEqual({ applied: false, reason: 'INVALID_IMPULSE' });
        expect(car.yawRate).toBe(0);

        // Oblique client-first reconciliation: local collision gives (0, 18.58), server sends (6, 10)
        const policeCar = createTestCar({
            id: 'police_car_0',
            isPolice: true,
            isServerControlled: true,
            x: 0, z: 0, yaw: 0, vx: 0, vz: 15, speed: 15,
            mass: POLICE_CAR_SPECS.mass,
            axleOffset: POLICE_CAR_SPECS.axleOffset,
            collisionRadius: POLICE_CAR_SPECS.collisionRadius
        });
        const playerCar = createTestCar({
            id: 'car_0',
            x: 0, z: 3.5, yaw: 0, vx: 0, vz: -15, speed: -15,
            mass: CAR_SPECS.mass
        });
        resolveVehicleToVehicleCollisions([policeCar, playerCar], 0.05, 3000);
        const localDvz = playerCar.vz - (-15);
        expect(localDvz).toBeGreaterThan(15);

        const obliqueRes = applyVehicleImpulse(playerCar, {
            police_car_id: 'police_car_0',
            dvx: 6,
            dvz: 10,
            dyaw_rate: 0,
            sequence: 10
        }, 3050);
        expect(obliqueRes.applied).toBe(true);
        expect(obliqueRes.dvx).toBe(6);
        expect(obliqueRes.dvz).toBe(0);
        expect(playerCar.vx).toBeCloseTo(6, 6);
        expect(playerCar.vz).toBeCloseTo(-15 + localDvz, 6);
    });
});

