import { describe, test, expect } from 'bun:test';
import { createColliderStore, computeWorldColliderFromEntity } from '../js/physics.js';
import worldMap from '../data/world_map.json';

describe('PhysicsEngine & model-computed world_map.json colliders', () => {
    test('computes colliders from world_map.json models (landmarks, stalls, props, hills) without staticColliders', () => {
        expect(worldMap.staticColliders).toBeUndefined();
        const physics = createColliderStore();
        physics.loadFromConfig(worldMap);
        const expectedCount =
            (worldMap.landmarks?.length || 0) +
            (worldMap.stalls?.length || 0) +
            (worldMap.props?.length || 0) +
            (worldMap.hills?.east?.length || 0) +
            (worldMap.hills?.north?.length || 0) +
            (worldMap.hills?.south?.length || 0);
        expect(physics.colliders.length).toBe(expectedCount);
        expect(physics.colliders.length).toBeGreaterThanOrEqual(40);
    });

    test('resolves horizontal collision against non-climbable stall bounding box computed from model', () => {
        const physics = createColliderStore();
        physics.loadFromConfig(worldMap);

        const pyanseStall = worldMap.stalls.find(s => s.id === 'pyanse');
        const pyanseCol = computeWorldColliderFromEntity(pyanseStall, 'stalls');
        expect(pyanseCol).toBeTruthy();

        const pos = { x: pyanseCol.x - pyanseCol.width / 2 - 0.2, z: pyanseCol.z };
        const hit = physics.resolveWorldCollision(pos, 0.55, 0);
        expect(hit).toBe(true);
        expect(pos.x).toBeCloseTo(pyanseCol.x - pyanseCol.width / 2 - 0.55, 2);
    });

    test('allows stepping onto a low climbable bench and blocks walking into the tall fountain', () => {
        const physics = createColliderStore();
        physics.loadFromConfig(worldMap);

        const bench = worldMap.props.find(p => p.type === 'bench');
        const benchCol = computeWorldColliderFromEntity(bench, 'props');
        expect(benchCol.climbable).toBe(true);
        expect(benchCol.height).toBeCloseTo(0.65, 3);

        const jumpY = 0.45;
        const pos = { x: benchCol.x, z: benchCol.z };
        expect(physics.resolveWorldCollision(pos, 0.55, jumpY)).toBe(false);
        expect(physics.getSupportHeightAt(benchCol.x, benchCol.z, jumpY)).toBeCloseTo(benchCol.height, 4);

        // Fountain model scaled 1.95x is ~3.9m tall: too high to step onto, so it blocks.
        const fountain = worldMap.landmarks.find(l => l.id === 'fountain');
        const fountainCol = computeWorldColliderFromEntity(fountain, 'landmarks');
        expect(fountainCol.climbable).toBe(false);
        const edgePos = { x: fountainCol.x + fountainCol.width / 2 - 0.2, z: fountainCol.z };
        expect(physics.resolveWorldCollision(edgePos, 0.55, 0)).toBe(true);
        expect(edgePos.x).toBeGreaterThanOrEqual(fountainCol.x + fountainCol.width / 2 + 0.5);
    });

    test('allows walking onto low-profile piers and under the high overhead bridge deck', () => {
        const physics = createColliderStore();
        physics.loadFromConfig(worldMap);

        const pier = worldMap.landmarks.find(l => l.id === 'pier');
        const pierCol = computeWorldColliderFromEntity(pier, 'landmarks');
        expect(pierCol.height).toBeLessThan(0.52);
        const pierPos = { x: pierCol.x, z: pierCol.z };
        expect(physics.resolveWorldCollision(pierPos, 0.55, 0)).toBe(false);

        const bridgeDeck = worldMap.landmarks.find(l => l.id === 'bridge_deck');
        const deckCol = computeWorldColliderFromEntity(bridgeDeck, 'landmarks');
        expect(deckCol.minY).toBeGreaterThan(15);
        const underBridgePos = { x: deckCol.x, z: deckCol.z };
        expect(physics.resolveWorldCollision(underBridgePos, 0.55, 0)).toBe(false);
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

    test('resolves oriented bounding box (OBB) collision with rotY', () => {
        const physics = createColliderStore();
        // Box with width=10, depth=40, rotY=Math.PI/2 (90 degrees) centered at (0, 0)
        // In local space: X in [-5, 5], Z in [-20, 20]
        // In world space rotated 90 deg: X in [-20, 20], Z in [-5, 5]
        physics.addBoxCollider(0, 0, 10, 40, 12, false, 'rotated_box', Math.PI / 2);

        // Player at (-18, 0) is inside rotated box X extent [-20, 20]
        const pos1 = { x: -18, z: 0 };
        const hit1 = physics.resolveWorldCollision(pos1, 0.55, 0);
        expect(hit1).toBe(true);
        expect(pos1.x).toBeCloseTo(-20.55, 2);

        // Player at (0, 15) is OUTSIDE rotated box Z extent [-5, 5]
        const pos2 = { x: 0, z: 15 };
        const hit2 = physics.resolveWorldCollision(pos2, 0.55, 0);
        expect(hit2).toBe(false);
        expect(pos2.x).toBe(0);
        expect(pos2.z).toBe(15);
    });
});

