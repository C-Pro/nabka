import { describe, test, expect, beforeEach } from 'bun:test';
import {
    NPC_CONFIG,
    resolveNpcToNpcCollisions,
    pickNpcHeading,
    updatePromenadeNPCs
} from '../js/entities.js';
import { PhysicsEngine } from '../js/physics.js';
import worldMap from '../data/world_map.json';

describe('NPC Collision Detection, Personal Distance, and Navigation', () => {
    beforeEach(() => {
        PhysicsEngine.clear();
        PhysicsEngine.loadFromConfig(worldMap);
    });

    test('resolveNpcToNpcCollisions pushes overlapping NPCs apart to maintain minimum distance', () => {
        const npc1 = {
            id: 'npc_1',
            position: { x: 0, y: 0, z: 10 },
            heading: 0,
            state: 'walking'
        };
        const npc2 = {
            id: 'npc_2',
            position: { x: 0, y: 0, z: 10.6 }, // only 0.6m apart (less than 1.35m)
            heading: Math.PI,
            state: 'walking'
        };

        const npcs = [npc1, npc2];
        resolveNpcToNpcCollisions(npcs, null, 1.35);

        const newDist = Math.hypot(npc1.position.x - npc2.position.x, npc1.position.z - npc2.position.z);
        expect(newDist).toBeGreaterThanOrEqual(1.349);
        expect(npc1.position.z).toBeLessThan(10);
        expect(npc2.position.z).toBeGreaterThan(10.6);
    });

    test('resolveNpcToNpcCollisions preserves position of active chatting NPC while displacing the other', () => {
        const chattingNpc = {
            id: 'chatting',
            position: { x: 2, y: 0, z: 20 },
            heading: 0,
            state: 'idle'
        };
        const walkingNpc = {
            id: 'walker',
            position: { x: 2, y: 0, z: 20.5 },
            heading: Math.PI,
            state: 'walking'
        };

        resolveNpcToNpcCollisions([chattingNpc, walkingNpc], chattingNpc, 1.35);

        // Chatting NPC must not move
        expect(chattingNpc.position.x).toBe(2);
        expect(chattingNpc.position.z).toBe(20);

        // Walking NPC must take full displacement
        expect(walkingNpc.position.z).toBeGreaterThanOrEqual(21.349);
    });

    test('resolveNpcToNpcCollisions deflects headings when two walking NPCs head towards each other', () => {
        const npcA = {
            id: 'a',
            position: { x: 0, y: 0, z: 0 },
            heading: 0, // heading south (+Z) towards B
            state: 'walking'
        };
        const npcB = {
            id: 'b',
            position: { x: 0, y: 0, z: 1.0 },
            heading: Math.PI, // heading north (-Z) towards A
            state: 'walking'
        };

        const origHeadingA = npcA.heading;
        const origHeadingB = npcB.heading;

        resolveNpcToNpcCollisions([npcA, npcB], null, 1.35);

        expect(npcA.heading).not.toBe(origHeadingA);
        expect(npcB.heading).not.toBe(origHeadingB);
    });

    test('updatePromenadeNPCs keeps NPCs strictly on paved promenade (avoids road and sea)', () => {
        // NPC placed near western sea boundary
        const nearSeaNpc = {
            id: 'sea_npc',
            position: { x: -14.0, y: 0, z: 0 },
            heading: -Math.PI / 2, // heading west into the sea
            speed: 2.0,
            state: 'walking',
            stateTimer: 5.0
        };

        // NPC placed near eastern road boundary
        const nearRoadNpc = {
            id: 'road_npc',
            position: { x: 13.5, y: 0, z: 0 },
            heading: Math.PI / 2, // heading east onto the road
            speed: 2.0,
            state: 'walking',
            stateTimer: 5.0
        };

        updatePromenadeNPCs({
            npcs: [nearSeaNpc, nearRoadNpc],
            dt: 0.1,
            playerPos: { x: 0, z: 50 },
            vehicles: []
        });

        // Must be clamped inside paved area
        expect(nearSeaNpc.position.x).toBeGreaterThanOrEqual(NPC_CONFIG.minX);
        expect(nearRoadNpc.position.x).toBeLessThanOrEqual(NPC_CONFIG.maxX);

        // Headings must be turned back inward
        // nearSeaNpc should be heading eastward (+X, sin > 0)
        expect(Math.sin(nearSeaNpc.heading)).toBeGreaterThan(0);

        // nearRoadNpc should be heading westward (-X, sin < 0)
        expect(Math.sin(nearRoadNpc.heading)).toBeLessThan(0);
    });

    test('updatePromenadeNPCs detects wall collision and changes direction to prevent getting stuck', () => {
        const pyanse = PhysicsEngine.colliders.find(c => c.id === 'pyanse');
        const stallX = pyanse ? pyanse.x : 7.3;
        const stallZ = pyanse ? pyanse.z : 36.85;
        const halfW = pyanse ? (pyanse.width / 2) : 2.3;
        // Place an NPC at western edge walking directly into the stall (+X)
        const stallNpc = {
            id: 'stall_npc',
            position: { x: stallX - halfW - 0.5, y: 0, z: stallZ },
            heading: Math.PI / 2, // heading East (+X) directly into stall
            speed: 2.0,
            state: 'walking',
            stateTimer: 5.0,
            collisionRadius: 0.55
        };

        const initialHeading = stallNpc.heading;

        updatePromenadeNPCs({
            npcs: [stallNpc],
            dt: 0.2,
            playerPos: { x: 0, z: 50 },
            vehicles: []
        });

        // The stall collider must block penetration into the stall box
        expect(stallNpc.position.x).toBeLessThan(stallX - halfW + 0.05);

        // Heading must have changed significantly to steer away from the wall
        expect(Math.abs(stallNpc.heading - initialHeading)).toBeGreaterThan(0.5);
    });

    test('updatePromenadeNPCs transitions between walking and idle states', () => {
        const npc = {
            id: 'cycle_npc',
            position: { x: 0, y: 0, z: 40 },
            heading: 0,
            speed: 1.6,
            state: 'walking',
            stateTimer: 0.05 // about to expire
        };

        // Advance past timer with randomFn that triggers idle (< 0.4)
        updatePromenadeNPCs({
            npcs: [npc],
            dt: 0.1,
            randomFn: () => 0.1
        });

        expect(npc.state).toBe('idle');
        expect(npc.stateTimer).toBeGreaterThan(0);

        // In idle, advancing past timer with randomFn resumes walking
        npc.stateTimer = 0.05;
        updatePromenadeNPCs({
            npcs: [npc],
            dt: 0.1,
            randomFn: () => 0.7
        });

        expect(npc.state).toBe('walking');
        expect(npc.stateTimer).toBeGreaterThan(0);
    });

    test('updatePromenadeNPCs halts and faces player when active in dialogue', () => {
        const dialogueNpc = {
            id: 'dialogue_npc',
            position: { x: 2, y: 0, z: 10 },
            rotationY: 0,
            heading: 0,
            speed: 1.8,
            state: 'walking',
            stateTimer: 5.0
        };

        const playerPos = { x: 5, y: 0, z: 14 }; // dx = 3, dz = 4, atan2(3, 4) ≈ 0.6435 rad

        updatePromenadeNPCs({
            npcs: [dialogueNpc],
            dt: 0.1,
            playerPos,
            activeChatNpc: dialogueNpc
        });

        // Must become idle, position unchanged
        expect(dialogueNpc.state).toBe('idle');
        expect(dialogueNpc.position.x).toBe(2);
        expect(dialogueNpc.position.z).toBe(10);

        // Must face the player
        const expectedAngle = Math.atan2(3, 4);
        expect(Math.abs(dialogueNpc.heading - expectedAngle)).toBeLessThan(0.01);
        expect(Math.abs(dialogueNpc.rotationY - expectedAngle)).toBeLessThan(0.01);
    });
});
