import { describe, test, expect } from 'bun:test';
import { createColliderStore } from '../js/physics.js';
import worldMap from '../data/world_map.json';

describe('PhysicsEngine & world_map.json colliders', () => {
    test('loads static colliders from world_map.json', () => {
        const physics = createColliderStore();
        physics.loadFromConfig(worldMap);
        expect(physics.colliders.length).toBe(worldMap.staticColliders.length);
        expect(physics.colliders.length).toBeGreaterThanOrEqual(20);
    });

    test('resolves horizontal collision against non-climbable building box', () => {
        const physics = createColliderStore();
        physics.loadFromConfig(worldMap);

        // Pyansye stall is at x=9.5, z=28, w=4.6 (halfW=2.3), d=6.4, height=4.5
        const pos = { x: 7.0, z: 28.0 };
        const hit = physics.resolveWorldCollision(pos, 0.55, 0);
        expect(hit).toBe(true);
        // Should be pushed out to x = 9.5 - 2.3 - 0.55 = 6.65
        expect(pos.x).toBeCloseTo(6.65, 2);
    });

    test('allows stepping onto climbable fountain rim when jumped high enough and returns support height', () => {
        const physics = createColliderStore();
        physics.loadFromConfig(worldMap);

        // Central fountain outer rim at (0, 0) has radius 9.8 and height 1.05
        // When player jumps to currentY = 0.85 (>= 1.05 - 0.35 = 0.70), horizontal collision is bypassed
        const pos = { x: 5.0, z: 0.0 };
        const hit = physics.resolveWorldCollision(pos, 0.55, 0.85);
        expect(hit).toBe(false);
        expect(pos.x).toBeCloseTo(5.0, 4);

        const supportY = physics.getSupportHeightAt(5.0, 0.0, 0.85);
        expect(supportY).toBeCloseTo(1.05, 4);

        // From the outer rim, jumping to currentY = 1.65 at (0, 0) lands on inner tier (height = 1.85)
        const innerSupportY = physics.getSupportHeightAt(0.0, 0.0, 1.65);
        expect(innerSupportY).toBeCloseTo(1.85, 4);
    });

    test('calculates support height on parked vehicle roof when jumping', () => {
        const physics = createColliderStore();
        const vehicles = [
            {
                id: 'car_0',
                group: {
                    position: { x: 19.5, y: 0.02, z: 14.0 },
                    rotation: { y: Math.PI }
                }
            }
        ];

        // When currentY >= 1.25 within radius 2.1 of a parked car, support height is 1.55
        const roofHeight = physics.getSupportHeightAt(19.5, 14.0, 1.35, 0.45, vehicles, null);
        expect(roofHeight).toBeCloseTo(1.55, 2);
    });
});
