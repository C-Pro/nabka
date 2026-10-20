import { describe, test, expect } from 'bun:test';
import {
    stepVehicleDynamics,
    stepSingleVehicleDynamics,
    resolveVehicleToVehicleCollisions,
    resolveVehicleWorldCollision,
    getVehicleCollisionCircles,
    createVehiclePhysicsWorld,
    stepWorldVehiclePhysics,
    crossYaw,
    rotationalVelocity,
    CAR_SPECS
} from '../js/physics.js';

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
        axleOffset: overrides.axleOffset || 1.25,
        collisionRadius: overrides.collisionRadius || 1.15,
        isAwake: overrides.isAwake !== undefined ? overrides.isAwake : true,
        isDrifting: overrides.isDrifting || false,
        isBraking: overrides.isBraking || false,
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
        // Should cap near maxSpeedForward (25 m/s)
        expect(car.vz).toBeLessThanOrEqual(25.5);
        expect(car.vz).toBeGreaterThanOrEqual(24.5);
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

    test('boost release does not delete existing velocity; car coasts down naturally', () => {
        const car = createTestCar({ yaw: 0, vz: 33.0, speed: 33.0 });
        // Throttle held, but boost released
        const normalThrottleInput = { throttle: 1, steer: 0, handbrake: false, boost: false };
        stepVehicleDynamics(car, normalThrottleInput, 0.05);
        // Velocity should NOT drop immediately to maxSpeedForward (25 m/s)
        expect(car.vz).toBeGreaterThan(32.0);
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
        const car = createTestCar({ x: 10, z: 20, yaw: 0, axleOffset: 1.25, collisionRadius: 1.15 });
        const circles = getVehicleCollisionCircles(car);
        expect(circles.length).toBe(3);
        // Front circle along +Z (yaw = 0)
        expect(circles[0].x).toBeCloseTo(10, 4);
        expect(circles[0].z).toBeCloseTo(21.25, 4);
        expect(circles[0].radius).toBe(1.15);
        // Center circle at chassis midpoint
        expect(circles[1].x).toBeCloseTo(10, 4);
        expect(circles[1].z).toBeCloseTo(20.0, 4);
        expect(circles[1].radius).toBe(1.15);
        // Rear circle along -Z
        expect(circles[2].x).toBeCloseTo(10, 4);
        expect(circles[2].z).toBeCloseTo(18.75, 4);
        expect(circles[2].radius).toBe(1.15);
    });

    test('center circle detects obstacle positioned at car chassis waist', () => {
        const car = createTestCar({ x: 0, z: 0, yaw: 0, vx: 5, vz: 0 });
        const colliders = [
            { type: 'circle', x: 1.5, z: 0, radius: 0.5, height: 2.0, climbable: false }
        ];
        const hit = resolveVehicleWorldCollision(car, colliders, null);
        expect(hit).toBe(true);
    });

    test('rotating car front bumper hitting a wall receives opposing angular impulse', () => {
        const car = createTestCar({ x: 1.0, z: 0, yaw: 0, vx: 0, vz: 0, yawRate: 4.0 });
        const colliders = [
            { type: 'box', x: 3.0, z: 1.25, halfW: 1.0, halfD: 2.0, height: 4.0, climbable: false }
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
        // Wall left edge is at x = 7.0. Car circle radius is 1.15.
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
        expect(Math.abs(res144.z - res60.z)).toBeLessThan(0.35);
        expect(Math.abs(res30.vz - res60.vz)).toBeLessThan(0.01);
        expect(Math.abs(res144.vz - res60.vz)).toBeLessThan(0.35);
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

