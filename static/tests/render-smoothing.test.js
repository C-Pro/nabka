import { test, expect } from 'bun:test';
import { World } from '../js/world.js';

test('street light slots reuse candidates within 1.5m and fade near 45m', () => {
    const world = Object.create(World);
    const source = { x: 0, z: 0, worldPos: { x: 0, y: 5, z: 0 }, color: {}, intensity: 2, distance: 22, decay: 1.8 };
    const slot = { intensity: 0, position: { copy() {} }, color: { copy() {} } };
    world.streetLightSources = [source];
    world.streetLightPoolSlots = [slot];
    world._forceStreetLightPoolRefresh = true;

    world.updateStreetLightPool(true, { x: 30, z: 0 });
    expect(slot.intensity).toBe(2);
    source.selected = 'unchanged';
    world.updateStreetLightPool(true, { x: 31, z: 0 });
    expect(source.selected).toBe('unchanged');
    expect(slot.intensity).toBeLessThan(2);
    world.updateStreetLightPool(true, { x: 37.5, z: 0 });
    expect(slot.intensity).toBeCloseTo(1);
    world.updateStreetLightPool(false, null);
    expect(slot.intensity).toBe(0);
    slot.intensity = 7;
    world.updateStreetLightPool(false, null);
    expect(slot.intensity).toBe(7); // inactive frames do not touch slots again
});

test('shader warmup compiles both states without culling and restores scene state', () => {
    const world = Object.create(World);
    const objects = [{ frustumCulled: true }, { frustumCulled: false }];
    const states = [];
    world.scene = { traverse(fn) { objects.forEach(fn); } };
    world.camera = {};
    world.streetLightsActive = false;
    world.stadiumLightsActive = false;
    world.setStreetLights = function (enabled) { this.streetLightsActive = enabled; };
    world.setStadiumFloodlights = function (enabled) { this.stadiumLightsActive = enabled; };
    world.renderer = { compile() { states.push([world.streetLightsActive, world.stadiumLightsActive, ...objects.map(o => o.frustumCulled)]); } };
    world.warmupShaders();
    expect(states).toEqual([[false, false, false, false], [true, true, false, false]]);
    expect(objects.map(o => o.frustumCulled)).toEqual([true, false]);
    expect(world.streetLightsActive).toBe(false);
    expect(world.stadiumLightsActive).toBe(false);
});

test('unchanged time phase updates clock without reapplying scene lights', () => {
    const world = Object.create(World);
    const scene = {};
    world.scene = scene;
    world.propGroups = [{}];
    world.landmarkGroups = [];
    world.currentTimePhase = 'day';
    world._appliedPhasePropCount = 1;
    world._appliedPhaseLandmarkCount = 0;
    world._appliedPhaseScene = scene;
    world.setStreetLights = () => { throw new Error('unchanged phase reapplied'); };
    const clock = { textContent: '12:00' };
    const previousDocument = globalThis.document;
    globalThis.document = { getElementById(id) { return id === 'hud-clock' ? clock : null; } };
    try {
        world.applyTimeOfDay('day', '12:01');
        expect(clock.textContent).toBe('12:01');
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});
