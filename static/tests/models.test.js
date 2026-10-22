import { describe, test, expect, beforeAll } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseGLB, cloneModelHierarchy, ModelLoader, DEFAULT_LANDMARKS, computeModelBoundingBox } from '../js/models.js';
import { exportObjectToGLB } from '../../editor/export_glb.js';
import { createJDMCar } from '../js/entities.js';

const STATIC_DIR = resolve(import.meta.dir, '..');
const MODELS_DIR = join(STATIC_DIR, 'models');
const WORLD_MAP_PATH = join(STATIC_DIR, 'data', 'world_map.json');

function installMockThree() {
    class Color {
        constructor(r = 0xffffff, g, b) {
            this.r = 1;
            this.g = 1;
            this.b = 1;
            if (typeof g === 'number' && typeof b === 'number') {
                this.setRGB(r, g, b);
            } else {
                this.set(r);
            }
        }
        set(c) {
            if (c && typeof c === 'object') {
                if (typeof c.r === 'number') this.r = c.r;
                if (typeof c.g === 'number') this.g = c.g;
                if (typeof c.b === 'number') this.b = c.b;
            } else if (typeof c === 'number') {
                this.r = ((c >> 16) & 255) / 255;
                this.g = ((c >> 8) & 255) / 255;
                this.b = (c & 255) / 255;
            }
            return this;
        }
        setHex(hex) {
            return this.set(hex);
        }
        setRGB(r, g, b) {
            this.r = r;
            this.g = g;
            this.b = b;
            return this;
        }
        getHex() {
            return (Math.round(this.r * 255) << 16) | (Math.round(this.g * 255) << 8) | Math.round(this.b * 255);
        }
        clone() {
            const c = new Color();
            c.r = this.r;
            c.g = this.g;
            c.b = this.b;
            return c;
        }
    }

    class Vector3 {
        constructor(x = 0, y = 0, z = 0) {
            this.x = x;
            this.y = y;
            this.z = z;
        }
        set(x, y, z) {
            this.x = x;
            this.y = y;
            this.z = z;
            return this;
        }
        setScalar(s) {
            this.x = s;
            this.y = s;
            this.z = s;
            return this;
        }
        copy(v) {
            this.x = v.x;
            this.y = v.y;
            this.z = v.z;
            return this;
        }
        fromArray(arr) {
            this.x = arr[0] || 0;
            this.y = arr[1] || 0;
            this.z = arr[2] || 0;
            return this;
        }
        lengthSq() {
            return this.x * this.x + this.y * this.y + this.z * this.z;
        }
    }

    class Quaternion {
        constructor(x = 0, y = 0, z = 0, w = 1) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.w = w;
        }
        set(x, y, z, w) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.w = w;
            return this;
        }
        copy(q) {
            this.x = q.x;
            this.y = q.y;
            this.z = q.z;
            this.w = q.w;
            return this;
        }
        fromArray(arr) {
            this.x = arr[0] || 0;
            this.y = arr[1] || 0;
            this.z = arr[2] || 0;
            this.w = arr[3] !== undefined ? arr[3] : 1;
            return this;
        }
        setFromEuler(euler) {
            const c1 = Math.cos((euler.x || 0) / 2);
            const c2 = Math.cos((euler.y || 0) / 2);
            const c3 = Math.cos((euler.z || 0) / 2);
            const s1 = Math.sin((euler.x || 0) / 2);
            const s2 = Math.sin((euler.y || 0) / 2);
            const s3 = Math.sin((euler.z || 0) / 2);
            this.x = s1 * c2 * c3 + c1 * s2 * s3;
            this.y = c1 * s2 * c3 - s1 * c2 * s3;
            this.z = c1 * c2 * s3 + s1 * s2 * c3;
            this.w = c1 * c2 * c3 - s1 * s2 * s3;
            return this;
        }
    }

    class Euler {
        constructor(x = 0, y = 0, z = 0) {
            this.x = x;
            this.y = y;
            this.z = z;
        }
        copy(e) {
            this.x = e.x;
            this.y = e.y;
            this.z = e.z;
            return this;
        }
        setFromQuaternion(q) {
            const sinr = 2 * (q.w * q.x + q.y * q.z);
            const cosr = 1 - 2 * (q.x * q.x + q.y * q.y);
            this.x = Math.atan2(sinr, cosr);
            const sinp = 2 * (q.w * q.y - q.z * q.x);
            this.y = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
            const siny = 2 * (q.w * q.z + q.x * q.y);
            const cosy = 1 - 2 * (q.y * q.y + q.z * q.z);
            this.z = Math.atan2(siny, cosy);
            return this;
        }
    }

    class Object3D {
        constructor() {
            this.name = '';
            this.children = [];
            this.parent = null;
            this.userData = {};
            this.visible = true;
            this.castShadow = false;
            this.receiveShadow = false;
            this.position = new Vector3(0, 0, 0);
            const rawEuler = new Euler(0, 0, 0);
            const rawQuat = new Quaternion(0, 0, 0, 1);
            let syncing = false;
            this.rotation = new Proxy(rawEuler, {
                set(target, prop, value) {
                    target[prop] = value;
                    if (!syncing && (prop === 'x' || prop === 'y' || prop === 'z')) {
                        syncing = true;
                        rawQuat.setFromEuler(target);
                        syncing = false;
                    }
                    return true;
                }
            });
            this.quaternion = new Proxy(rawQuat, {
                set(target, prop, value) {
                    target[prop] = value;
                    if (!syncing && (prop === 'x' || prop === 'y' || prop === 'z' || prop === 'w')) {
                        syncing = true;
                        rawEuler.setFromQuaternion(target);
                        syncing = false;
                    }
                    return true;
                }
            });
            this.scale = new Vector3(1, 1, 1);
        }
        add(...objs) {
            for (const o of objs) {
                if (!o) continue;
                o.parent = this;
                this.children.push(o);
            }
            return this;
        }
        traverse(cb) {
            cb(this);
            for (const c of this.children) {
                c.traverse(cb);
            }
        }
        getObjectByName(name) {
            if (this.name === name) return this;
            for (const c of this.children) {
                const found = c.getObjectByName(name);
                if (found) return found;
            }
            return null;
        }
        clone(recursive = true) {
            const c = new this.constructor();
            c.name = this.name;
            c.position.copy(this.position);
            c.quaternion.copy(this.quaternion);
            c.scale.copy(this.scale);
            c.visible = this.visible;
            c.castShadow = this.castShadow;
            c.receiveShadow = this.receiveShadow;
            c.userData = { ...this.userData };
            if (recursive) {
                for (const child of this.children) {
                    c.add(child.clone(true));
                }
            }
            return c;
        }
    }

    class Group extends Object3D {
        constructor() {
            super();
            this.isGroup = true;
            this.type = 'Group';
        }
    }

    class BufferAttribute {
        constructor(array, itemSize) {
            this.array = array;
            this.itemSize = itemSize;
            this.count = array ? array.length / itemSize : 0;
        }
        getX(i) { return this.array[i * this.itemSize]; }
        getY(i) { return this.array[i * this.itemSize + 1]; }
        getZ(i) { return this.array[i * this.itemSize + 2]; }
    }

    class BufferGeometry {
        constructor() {
            this.attributes = {};
            this.index = null;
        }
        setAttribute(name, attr) {
            this.attributes[name] = attr;
            return this;
        }
        getAttribute(name) {
            return this.attributes[name] || null;
        }
        setIndex(attr) {
            this.index = attr instanceof BufferAttribute ? attr : new BufferAttribute(attr, 1);
            return this;
        }
        getIndex() {
            return this.index;
        }
        computeVertexNormals() {
            const pos = this.getAttribute('position');
            if (pos && !this.getAttribute('normal')) {
                this.setAttribute('normal', new BufferAttribute(new Float32Array(pos.count * 3), 3));
            }
        }
        rotateX() { return this; }
        rotateY() { return this; }
        rotateZ() { return this; }
        translate() { return this; }
        scale() { return this; }
        clone() {
            const g = new BufferGeometry();
            for (const [k, v] of Object.entries(this.attributes)) {
                g.setAttribute(k, new BufferAttribute(v.array.slice(), v.itemSize));
            }
            if (this.index) {
                g.setIndex(new BufferAttribute(this.index.array.slice(), 1));
            }
            return g;
        }
    }

    class Material {
        constructor(opts = {}) {
            this.name = opts.name || '';
            this.color = new Color(opts.color !== undefined ? opts.color : 0xffffff);
            this.roughness = opts.roughness !== undefined ? opts.roughness : 0.7;
            this.metalness = opts.metalness !== undefined ? opts.metalness : 0.0;
            this.transparent = Boolean(opts.transparent);
            this.opacity = opts.opacity !== undefined ? opts.opacity : 1.0;
            this.side = opts.side || 0;
            this.map = opts.map || null;
            this.emissive = new Color(opts.emissive !== undefined ? opts.emissive : 0x000000);
            this.emissiveIntensity = opts.emissiveIntensity !== undefined ? opts.emissiveIntensity : 1.0;
        }
        clone() {
            return new this.constructor({
                name: this.name,
                color: this.color.getHex(),
                roughness: this.roughness,
                metalness: this.metalness,
                transparent: this.transparent,
                opacity: this.opacity,
                side: this.side,
                map: this.map,
                emissive: this.emissive.getHex(),
                emissiveIntensity: this.emissiveIntensity
            });
        }
    }

    class MeshStandardMaterial extends Material {
        constructor(opts) {
            super(opts);
            this.isMeshStandardMaterial = true;
        }
    }

    class MeshBasicMaterial extends Material {
        constructor(opts) {
            super(opts);
            this.isMeshBasicMaterial = true;
        }
    }

    class Mesh extends Object3D {
        constructor(geometry = new BufferGeometry(), material = new MeshStandardMaterial()) {
            super();
            this.isMesh = true;
            this.type = 'Mesh';
            this.geometry = geometry;
            this.material = material;
        }
        clone(recursive = true) {
            const m = super.clone(recursive);
            m.geometry = this.geometry ? this.geometry.clone() : null;
            m.material = this.material ? this.material.clone() : null;
            return m;
        }
    }

    class Texture {
        constructor(image = null) {
            this.image = image;
            this.flipY = true;
            this.needsUpdate = false;
            this.wrapS = 1001;
            this.wrapT = 1001;
        }
    }

    class CylinderGeometry extends BufferGeometry {}
    class SphereGeometry extends BufferGeometry {}
    class PlaneGeometry extends BufferGeometry {}
    class BoxGeometry extends BufferGeometry {}

    class Scene extends Object3D {
        constructor() {
            super();
            this.background = new Color(0);
            this.fog = { color: new Color(0), density: 0.002 };
        }
    }
    class Light extends Object3D {
        constructor(color = 0xffffff, intensity = 1.0) {
            super();
            this.color = new Color(color);
            this.intensity = intensity;
        }
    }
    class DirectionalLight extends Light {}
    class PointLight extends Light {}
    class AmbientLight extends Light {}
    class SpotLight extends Light {
        constructor(color, intensity = 1.0) {
            super(color, intensity);
            this.target = new Object3D();
        }
    }
    class HemisphereLight extends Light {
        constructor(skyColor, groundColor, intensity = 1.0) {
            super(skyColor, intensity);
            this.groundColor = new Color(groundColor);
        }
    }

    globalThis.THREE = {
        Color,
        Vector3,
        Quaternion,
        Euler,
        Object3D,
        Group,
        Mesh,
        Scene,
        Light,
        DirectionalLight,
        PointLight,
        SpotLight,
        AmbientLight,
        HemisphereLight,
        BufferGeometry,
        BufferAttribute,
        CylinderGeometry,
        SphereGeometry,
        PlaneGeometry,
        BoxGeometry,
        MeshStandardMaterial,
        MeshBasicMaterial,
        Texture,
        CanvasTexture: Texture,
        FrontSide: 0,
        DoubleSide: 2,
        RepeatWrapping: 1000,
        ClampToEdgeWrapping: 1001,
        MirroredRepeatWrapping: 1002
    };
}

beforeAll(() => {
    installMockThree();
});

describe('GLB 2.0 Exporter & Loader Interoperability', () => {
    test('round-trips a multi-node hierarchy with named children, transforms, and PBR materials through GLB binary format', async () => {
        const root = new THREE.Group();
        root.name = 'test_vehicle';

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
            0, 0, 0,
            1, 0, 0,
            0, 1, 0
        ]), 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
            0, 0, 1,
            0, 0, 1,
            0, 0, 1
        ]), 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
            0, 0,
            1, 0,
            0, 1
        ]), 2));
        geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));

        const mat = new THREE.MeshStandardMaterial({
            color: 0x38bdf8,
            roughness: 0.35,
            metalness: 0.8
        });

        const bodyMesh = new THREE.Mesh(geo, mat);
        bodyMesh.name = 'chassis';
        bodyMesh.position.set(2.5, 1.25, -4.0);
        bodyMesh.scale.set(1.5, 1.0, 2.0);
        root.add(bodyMesh);

        const wheelNode = new THREE.Group();
        wheelNode.name = 'wheel_0';
        wheelNode.position.set(-1.1, 0.4, 1.4);
        const wheelMesh = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color: 0xfbbf24 }));
        wheelNode.add(wheelMesh);
        root.add(wheelNode);

        const glbBytes = exportObjectToGLB(root);
        expect(glbBytes).toBeInstanceOf(Uint8Array);
        expect(glbBytes.byteLength).toBeGreaterThan(100);

        // Verify GLB magic ("glTF" = 0x46546C67) and version 2
        const dv = new DataView(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength);
        expect(dv.getUint32(0, true)).toBe(0x46546C67);
        expect(dv.getUint32(4, true)).toBe(2);
        expect(dv.getUint32(8, true)).toBe(glbBytes.byteLength);

        // Parse back with parseGLB
        const parsed = await parseGLB(glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength));
        expect(parsed).toBeTruthy();

        const parsedChassis = parsed.getObjectByName('chassis');
        expect(parsedChassis).toBeTruthy();
        expect(parsedChassis.position.x).toBeCloseTo(2.5, 4);
        expect(parsedChassis.position.y).toBeCloseTo(1.25, 4);
        expect(parsedChassis.position.z).toBeCloseTo(-4.0, 4);
        expect(parsedChassis.scale.x).toBeCloseTo(1.5, 4);
        expect(parsedChassis.scale.z).toBeCloseTo(2.0, 4);

        const parsedWheel = parsed.getObjectByName('wheel_0');
        expect(parsedWheel).toBeTruthy();
        expect(parsedWheel.position.x).toBeCloseTo(-1.1, 4);
        expect(parsedWheel.position.y).toBeCloseTo(0.4, 4);
        expect(parsedWheel.position.z).toBeCloseTo(1.4, 4);
    });

    test('all 35 exported .glb files in static/models/ exist, have valid GLB headers, and parse cleanly', async () => {
        expect(existsSync(MODELS_DIR)).toBe(true);
        const files = readdirSync(MODELS_DIR).filter(f => f.endsWith('.glb')).sort();
        expect(files.length).toBeGreaterThanOrEqual(35);

        for (const file of files) {
            const fullPath = join(MODELS_DIR, file);
            const buf = readFileSync(fullPath);
            expect(buf.byteLength).toBeGreaterThan(100);

            const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            const dv = new DataView(arrayBuffer);
            expect(dv.getUint32(0, true)).toBe(0x46546C67); // 'glTF'
            expect(dv.getUint32(4, true)).toBe(2);

            const model = await parseGLB(arrayBuffer);
            expect(model).toBeTruthy();

            let meshCount = 0;
            model.traverse((obj) => {
                if (obj.isMesh) {
                    meshCount++;
                    const pos = obj.geometry.getAttribute('position');
                    expect(pos).toBeTruthy();
                    expect(pos.count).toBeGreaterThan(0);
                }
            });
            expect(meshCount).toBeGreaterThan(0);
        }
    });

    test('animated models preserve named sub-nodes required by game animations (ferrisWheelGroup, wheels, legL/legR, wingL/wingR)', async () => {
        const readModel = async (name) => {
            const buf = readFileSync(join(MODELS_DIR, name));
            return parseGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        };

        const ferris = await readModel('ferris_wheel.glb');
        expect(ferris.getObjectByName('ferrisWheelGroup')).toBeTruthy();

        const car0 = await readModel('car_0.glb');
        expect(car0.getObjectByName('chassis')).toBeTruthy();
        expect(car0.getObjectByName('wheel_0')).toBeTruthy();
        expect(car0.getObjectByName('wheel_3')).toBeTruthy();
        expect(car0.getObjectByName('headlight_0')).toBeTruthy();
        expect(car0.getObjectByName('taillight_0')).toBeTruthy();

        const player = await readModel('player.glb');
        expect(player.getObjectByName('leftLeg')).toBeTruthy();
        expect(player.getObjectByName('rightLeg')).toBeTruthy();
        expect(player.getObjectByName('leftArm')).toBeTruthy();
        expect(player.getObjectByName('rightArm')).toBeTruthy();

        const seagull = await readModel('seagull.glb');
        expect(seagull.getObjectByName('leftWing')).toBeTruthy();
        expect(seagull.getObjectByName('rightWing')).toBeTruthy();
    });

    test('cloneModelHierarchy clones materials and geometry independently for instancing', async () => {
        const buf = readFileSync(join(MODELS_DIR, 'car_0.glb'));
        const template = await parseGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        ModelLoader.cache.set('models/car_0.glb', template);

        const instA = ModelLoader.instantiate('models/car_0.glb');
        const instB = ModelLoader.instantiate('models/car_0.glb');
        expect(instA).not.toBe(instB);

        const bodyA = instA.getObjectByName('chassis');
        const bodyB = instB.getObjectByName('chassis');
        expect(bodyA).toBeTruthy();
        expect(bodyB).toBeTruthy();
        expect(bodyA.material).not.toBe(bodyB.material);

        bodyA.material.color.set(0xff0000);
        expect(bodyB.material.color.getHex()).not.toBe(0xff0000);
    });

    test('world_map.json landmarks, stalls, vehicles, and props reference existing .glb models', () => {
        const worldMap = JSON.parse(readFileSync(WORLD_MAP_PATH, 'utf8'));
        expect(Array.isArray(worldMap.landmarks)).toBe(true);
        expect(worldMap.landmarks.length).toBeGreaterThanOrEqual(DEFAULT_LANDMARKS.length);
        expect(Array.isArray(worldMap.props)).toBe(true);
        expect(worldMap.props.length).toBeGreaterThan(0);

        const checkModelRef = (modelPath) => {
            expect(typeof modelPath).toBe('string');
            const fullPath = join(STATIC_DIR, modelPath);
            expect(existsSync(fullPath)).toBe(true);
        };

        for (const lm of worldMap.landmarks) {
            checkModelRef(lm.model);
        }
        for (const stall of worldMap.stalls) {
            checkModelRef(stall.model || `models/stall_${stall.id}.glb`);
        }
        for (const veh of worldMap.vehicles) {
            checkModelRef(veh.model || `models/${veh.id}.glb`);
        }
        for (const prop of worldMap.props) {
            checkModelRef(prop.model);
        }
    });

    test('computes local 3D boundingBox on model load from GLB geometry for all models', async () => {
        const files = readdirSync(MODELS_DIR).filter(f => f.endsWith('.glb')).sort();
        for (const file of files) {
            const buf = readFileSync(join(MODELS_DIR, file));
            const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            const model = await parseGLB(arrayBuffer);

            const bbox = model.userData.boundingBox;
            expect(bbox).toBeTruthy();
            expect(Number.isFinite(bbox.minX)).toBe(true);
            expect(Number.isFinite(bbox.maxX)).toBe(true);
            expect(Number.isFinite(bbox.minY)).toBe(true);
            expect(Number.isFinite(bbox.maxY)).toBe(true);
            expect(Number.isFinite(bbox.minZ)).toBe(true);
            expect(Number.isFinite(bbox.maxZ)).toBe(true);
            expect(bbox.width).toBeGreaterThan(0);
            expect(bbox.height).toBeGreaterThan(0);
            expect(bbox.depth).toBeGreaterThan(0);

            ModelLoader.cache.set(`models/${file}`, model);
            const inst = ModelLoader.instantiate(`models/${file}`);
            expect(inst.userData.boundingBox).toBeTruthy();
            expect(inst.userData.boundingBox.width).toBeCloseTo(bbox.width, 3);
            expect(inst.userData.boundingBox.height).toBeCloseTo(bbox.height, 3);
            expect(inst.userData.boundingBox.depth).toBeCloseTo(bbox.depth, 3);
        }
    });

    test('physics fallback bounding boxes match geometry computed from every .glb file', async () => {
        const { DEFAULT_MODEL_BOUNDS } = await import('../js/physics.js');
        const files = readdirSync(MODELS_DIR).filter(f => f.endsWith('.glb')).sort();
        const mismatches = [];
        for (const file of files) {
            const buf = readFileSync(join(MODELS_DIR, file));
            const model = await parseGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
            const actual = model.userData.boundingBox;
            const expected = DEFAULT_MODEL_BOUNDS[`models/${file}`];
            if (!expected) {
                mismatches.push(`${file}: missing ${JSON.stringify(actual)}`);
                continue;
            }
            for (const k of ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ']) {
                if (Math.abs(expected[k] - actual[k]) > 0.01) {
                    mismatches.push(`${file}: ${k} expected ${expected[k]} got ${actual[k]}`);
                }
            }
        }
        expect(mismatches).toEqual([]);
    });

    test('attachBoundingBoxCordon places police ribbon and poles around fountain and ferris wheel matching bounding box', async () => {
        const { World } = await import('../js/world.js');
        const bufFountain = readFileSync(join(MODELS_DIR, 'fountain.glb'));
        const fountainModel = await parseGLB(bufFountain.buffer.slice(bufFountain.byteOffset, bufFountain.byteOffset + bufFountain.byteLength));
        const localBoxFountain = fountainModel.userData.boundingBox;
        expect(localBoxFountain).toBeTruthy();

        const cordon = World.attachBoundingBoxCordon(fountainModel, localBoxFountain, 1.95);
        expect(cordon).toBeTruthy();
        expect(cordon.name).toBe('bounding_box_cordon');
        expect(fountainModel.getObjectByName('bounding_box_cordon')).toBe(cordon);

        // Verify corner poles are placed at the 4 corners of localBoxFountain
        const polePositions = [];
        cordon.traverse((child) => {
            if (child.isGroup && child.children.length === 3 && child !== cordon) {
                polePositions.push({ x: child.position.x, z: child.position.z });
            }
        });
        expect(polePositions.length).toBeGreaterThanOrEqual(20);

        const hasCornerNW = polePositions.some(p => Math.abs(p.x - localBoxFountain.minX) < 0.01 && Math.abs(p.z - localBoxFountain.minZ) < 0.01);
        const hasCornerNE = polePositions.some(p => Math.abs(p.x - localBoxFountain.maxX) < 0.01 && Math.abs(p.z - localBoxFountain.minZ) < 0.01);
        const hasCornerSE = polePositions.some(p => Math.abs(p.x - localBoxFountain.maxX) < 0.01 && Math.abs(p.z - localBoxFountain.maxZ) < 0.01);
        const hasCornerSW = polePositions.some(p => Math.abs(p.x - localBoxFountain.minX) < 0.01 && Math.abs(p.z - localBoxFountain.maxZ) < 0.01);
        expect(hasCornerNW).toBe(true);
        expect(hasCornerNE).toBe(true);
        expect(hasCornerSE).toBe(true);
        expect(hasCornerSW).toBe(true);

        // Verify computeModelBoundingBox skips the cordon and preserves exact model bounds
        const recalculatedBox = computeModelBoundingBox(fountainModel);
        expect(recalculatedBox.width).toBeCloseTo(localBoxFountain.width, 3);
        expect(recalculatedBox.height).toBeCloseTo(localBoxFountain.height, 3);
        expect(recalculatedBox.depth).toBeCloseTo(localBoxFountain.depth, 3);
    });

    test('attachBoundingBoxFence places wrought iron park fence around oceanarium matching its bounding box', async () => {
        const { World } = await import('../js/world.js');
        const bufOceanarium = readFileSync(join(MODELS_DIR, 'oceanarium.glb'));
        const oceanariumModel = await parseGLB(bufOceanarium.buffer.slice(bufOceanarium.byteOffset, bufOceanarium.byteOffset + bufOceanarium.byteLength));
        const localBoxOceanarium = oceanariumModel.userData.boundingBox;
        expect(localBoxOceanarium).toBeTruthy();

        const fence = World.attachBoundingBoxFence(oceanariumModel, localBoxOceanarium, 1.0);
        expect(fence).toBeTruthy();
        expect(fence.name).toBe('bounding_box_fence');
        expect(oceanariumModel.getObjectByName('bounding_box_fence')).toBe(fence);

        // Verify corner posts are placed at the 4 corners of localBoxOceanarium
        const postPositions = [];
        fence.traverse((child) => {
            if (child.isGroup && child.children.length === 2 && child !== fence) {
                postPositions.push({ x: child.position.x, z: child.position.z });
            }
        });
        expect(postPositions.length).toBeGreaterThanOrEqual(16);

        const hasCornerNW = postPositions.some(p => Math.abs(p.x - localBoxOceanarium.minX) < 0.05 && Math.abs(p.z - localBoxOceanarium.minZ) < 0.05);
        const hasCornerNE = postPositions.some(p => Math.abs(p.x - localBoxOceanarium.maxX) < 0.05 && Math.abs(p.z - localBoxOceanarium.minZ) < 0.05);
        const hasCornerSE = postPositions.some(p => Math.abs(p.x - localBoxOceanarium.maxX) < 0.05 && Math.abs(p.z - localBoxOceanarium.maxZ) < 0.05);
        const hasCornerSW = postPositions.some(p => Math.abs(p.x - localBoxOceanarium.minX) < 0.05 && Math.abs(p.z - localBoxOceanarium.maxZ) < 0.05);
        expect(hasCornerNW).toBe(true);
        expect(hasCornerNE).toBe(true);
        expect(hasCornerSE).toBe(true);
        expect(hasCornerSW).toBe(true);

        // All fence components must be marked noCollide
        fence.traverse((child) => {
            if (child !== fence) {
                expect(child.userData && child.userData.noCollide).toBe(true);
            }
        });

        // Verify computeModelBoundingBox skips the fence and preserves original bounds
        const recalculatedBox = computeModelBoundingBox(oceanariumModel);
        expect(recalculatedBox.width).toBeCloseTo(localBoxOceanarium.width, 3);
        expect(recalculatedBox.height).toBeCloseTo(localBoxOceanarium.height, 3);
        expect(recalculatedBox.depth).toBeCloseTo(localBoxOceanarium.depth, 3);
    });

    test('road_lamp.glb has small pole-only bounding box ignoring cantilever outreach arm', async () => {
        const bufLamp = readFileSync(join(MODELS_DIR, 'road_lamp.glb'));
        const lampModel = await parseGLB(bufLamp.buffer.slice(bufLamp.byteOffset, bufLamp.byteOffset + bufLamp.byteLength));
        const bbox = lampModel.userData.boundingBox;
        expect(bbox).toBeTruthy();

        // Small base footprint around pole (~0.56m x 0.56m), ignoring overhead arm extending 2.4m
        expect(bbox.width).toBeCloseTo(0.56, 2);
        expect(bbox.depth).toBeCloseTo(0.56, 2);
        expect(bbox.minX).toBeCloseTo(-0.28, 2);
        expect(bbox.maxX).toBeCloseTo(0.28, 2);
        expect(bbox.minZ).toBeCloseTo(-0.28, 2);
        expect(bbox.maxZ).toBeCloseTo(0.28, 2);
    });

    test('roadster is metallic gray, forrester is red, and subaru wrx is blue in world_map.json and 3D models', async () => {
        const worldMap = JSON.parse(readFileSync(WORLD_MAP_PATH, 'utf8'));
        const roadsterDef = worldMap.vehicles.find(v => v.id === 'car_1');
        const forresterDef = worldMap.vehicles.find(v => v.id === 'car_2');
        const wrxDef = worldMap.vehicles.find(v => v.id === 'car_4');

        expect(roadsterDef).toBeTruthy();
        expect(forresterDef).toBeTruthy();
        expect(wrxDef).toBeTruthy();

        // 1. world_map.json color hex values
        expect(roadsterDef.colorHex).toBe(9741240); // 0x94a3b8 (Metallic Gray)
        expect(forresterDef.colorHex).toBe(14427686); // 0xdc2626 (Vivid Red)
        expect(wrxDef.colorHex).toBe(1920728); // 0x1d4ed8 (Subaru World Rally Blue)

        // 2. Parsed .glb materials and clamped metalness
        const bufRoadster = readFileSync(join(MODELS_DIR, 'roadster.glb'));
        const roadsterModel = await parseGLB(bufRoadster.buffer.slice(bufRoadster.byteOffset, bufRoadster.byteOffset + bufRoadster.byteLength));
        let roadsterBodyMat = null;
        roadsterModel.traverse((c) => {
            if (c.isMesh && c.material && (c.material.name === 'mat_body' || c.name === 'chassis')) roadsterBodyMat = c.material;
        });
        expect(roadsterBodyMat).toBeTruthy();
        // Gray tone: R, G, B channels are close and bright (> 0.65)
        expect(roadsterBodyMat.color.r).toBeGreaterThan(0.65);
        expect(roadsterBodyMat.color.g).toBeGreaterThan(0.65);
        expect(roadsterBodyMat.color.b).toBeGreaterThan(0.65);
        expect(Math.abs(roadsterBodyMat.color.r - roadsterBodyMat.color.g)).toBeLessThan(0.1);
        expect(roadsterBodyMat.metalness).toBeLessThanOrEqual(0.6); // Clamped so it doesn't appear pitch black without IBL

        const bufForrester = readFileSync(join(MODELS_DIR, 'forrester.glb'));
        const forresterModel = await parseGLB(bufForrester.buffer.slice(bufForrester.byteOffset, bufForrester.byteOffset + bufForrester.byteLength));
        let forresterBodyMat = null;
        forresterModel.traverse((c) => {
            if (c.isMesh && c.material && (c.material.name === 'mat_body' || c.name === 'chassis')) forresterBodyMat = c.material;
        });
        expect(forresterBodyMat).toBeTruthy();
        // Red tone: R channel dominant over G and B
        expect(forresterBodyMat.color.r).toBeGreaterThan(0.75);
        expect(forresterBodyMat.color.g).toBeLessThan(0.3);
        expect(forresterBodyMat.color.b).toBeLessThan(0.3);

        const bufWrx = readFileSync(join(MODELS_DIR, 'impreza_wrx.glb'));
        const wrxModel = await parseGLB(bufWrx.buffer.slice(bufWrx.byteOffset, bufWrx.byteOffset + bufWrx.byteLength));
        let wrxBodyMat = null;
        let wrxGoldMat = null;
        wrxModel.traverse((c) => {
            if (c.isMesh && c.material) {
                if (c.material.name === 'mat_body' || c.name === 'chassis') wrxBodyMat = c.material;
                if (c.material.name === 'mat_gold') wrxGoldMat = c.material;
            }
        });
        expect(wrxBodyMat).toBeTruthy();
        // Rally Blue: B channel dominant over R
        expect(wrxBodyMat.color.b).toBeGreaterThan(0.75);
        expect(wrxBodyMat.color.r).toBeLessThan(0.25);
        expect(wrxGoldMat).toBeTruthy();
        expect(wrxGoldMat.color.r).toBeGreaterThan(0.75);
    });

    test('street lights only turn on when sun sets (sunset, dusk, night) and daylight illumination is balanced', async () => {
        const { World } = await import('../js/world.js');

        // Create a mock scene with lights
        const scene = new globalThis.THREE.Scene();
        const sunLight = new globalThis.THREE.DirectionalLight(0xfffaed, 1.0);
        const ambientLight = new globalThis.THREE.AmbientLight(0xe0f2fe, 0.4);
        const hemiLight = new globalThis.THREE.HemisphereLight(0xbae6fd, 0x334155, 0.35);
        scene.add(sunLight);
        scene.add(ambientLight);
        scene.add(hemiLight);

        World.scene = scene;
        World.sunLight = sunLight;
        World.ambientLight = ambientLight;
        World.hemiLight = hemiLight;
        World.westShoreMeshes = [];

        // Build a mock promenade lamp with point light and pool decal
        const lamp = new globalThis.THREE.Group();
        const ptLight = new globalThis.THREE.PointLight(0xfef08a, 1.4);
        ptLight.name = 'lamp_point_light';
        lamp.add(ptLight);

        const poolGeo = new globalThis.THREE.BufferGeometry();
        const poolMesh = new globalThis.THREE.Mesh(poolGeo, new globalThis.THREE.MeshBasicMaterial());
        poolMesh.name = 'lamp_ground_pool';
        lamp.add(poolMesh);

        const globeMat = new globalThis.THREE.MeshStandardMaterial({ color: 0xfef08a });
        globeMat.emissive = new globalThis.THREE.Color(0xfef08a);
        const globeMesh = new globalThis.THREE.Mesh(new globalThis.THREE.BufferGeometry(), globeMat);
        globeMesh.name = 'globe';
        lamp.add(globeMesh);

        World.propGroups = [lamp];

        // 1. Daylight: lights must be OFF, sun light not blown out
        World.applyTimeOfDay('day');
        expect(World.streetLightsActive).toBe(false);
        expect(ptLight.visible).toBe(false);
        expect(poolMesh.visible).toBe(false);
        expect(globeMat.emissiveIntensity).toBe(0.0);
        // Daylight intensity is balanced (not blown out > 1.0)
        expect(World.sunLight.intensity).toBeLessThanOrEqual(1.0);
        expect(World.ambientLight.intensity).toBeLessThanOrEqual(0.45);

        // 2. Dawn: lights must be OFF
        World.applyTimeOfDay('dawn');
        expect(World.streetLightsActive).toBe(false);
        expect(ptLight.visible).toBe(false);
        expect(poolMesh.visible).toBe(false);

        // 3. Sunset: sun sets -> lights turn ON!
        World.applyTimeOfDay('sunset');
        expect(World.streetLightsActive).toBe(true);
        expect(ptLight.visible).toBe(true);
        expect(poolMesh.visible).toBe(true);
        expect(globeMat.emissiveIntensity).toBe(1.0);

        // 4. Dusk: lights ON
        World.applyTimeOfDay('dusk');
        expect(World.streetLightsActive).toBe(true);
        expect(ptLight.visible).toBe(true);
        expect(poolMesh.visible).toBe(true);

        // 5. Night: lights ON
        World.applyTimeOfDay('night');
        expect(World.streetLightsActive).toBe(true);
        expect(ptLight.visible).toBe(true);
        expect(poolMesh.visible).toBe(true);

        // 6. Transition back to day: lights turn OFF again
        World.applyTimeOfDay('day');
        expect(World.streetLightsActive).toBe(false);
        expect(ptLight.visible).toBe(false);
        expect(poolMesh.visible).toBe(false);
    });

    test('ModelLoader.preloadAll includes models/berik.glb alongside models/dunya.glb', async () => {
        const loadedUrls = [];
        const originalLoad = ModelLoader.load;
        ModelLoader.load = async (url) => {
            loadedUrls.push(url);
            return new globalThis.THREE.Group();
        };
        try {
            await ModelLoader.preloadAll({ landmarks: [], stalls: [], vehicles: [], props: [] });
            expect(loadedUrls).toContain('models/berik.glb');
            expect(loadedUrls).toContain('models/dunya.glb');
            expect(loadedUrls).toContain('models/player.glb');
        } finally {
            ModelLoader.load = originalLoad;
        }
    });

    test('createJDMCar initializes simulation, group, and spawn height from configured y and resetToSpawn preserves it', () => {
        const car = createJDMCar('Suzuki Jimny', 0xf59e0b, 40.05, 10.5, 0, null, 'car_jimny', null, 0.27);
        expect(car.y).toBe(0.27);
        expect(car.spawnY).toBe(0.27);
        expect(car.group.position.y).toBe(0.27);

        // Move car during gameplay
        car.y = 1.5;
        car.group.position.y = 1.5;

        // Reset to spawn must restore configured height
        car.resetToSpawn();
        expect(car.y).toBe(0.27);
        expect(car.group.position.y).toBe(0.27);
    });

    test('buildVladivostokSopkiAndBayHorizon scales mountains with independent rx and rz axes', async () => {
        const { World } = await import('../js/world.js');
        const scene = new globalThis.THREE.Scene();
        World.scene = scene;
        World.hillGroups = [];
        World.westShoreMeshes = [];

        const testMap = {
            hills: {
                east: [
                    { x: 10, y: -0.5, z: 20, rx: 64, rz: 16, h: 96, rotY: 0.5 }
                ]
            }
        };

        World.buildVladivostokSopkiAndBayHorizon(testMap);
        expect(World.hillGroups.length).toBe(1);

        const mountain = World.hillGroups[0];
        // Base sopka model has radius 32, height 48
        // scale.x = rx / 32 = 64 / 32 = 2.0
        // scale.y = h / 48 = 96 / 48 = 2.0
        // scale.z = rz / 32 = 16 / 32 = 0.5
        expect(mountain.scale.x).toBeCloseTo(2.0, 3);
        expect(mountain.scale.y).toBeCloseTo(2.0, 3);
        expect(mountain.scale.z).toBeCloseTo(0.5, 3);
        expect(mountain.rotation.y).toBeCloseTo(0.5, 3);
    });

    test('dynamo_stadium floodlights activate at night, illuminating pitch and stands', async () => {
        const { World } = await import('../js/world.js');
        const { ModelBuilders } = await import('../js/models.js');

        const originalDoc = globalThis.document;
        globalThis.document = {
            getElementById: () => null,
            createElement: () => ({
                width: 0,
                height: 0,
                getContext: () => ({
                    createRadialGradient: () => ({ addColorStop: () => {} }),
                    fillRect: () => {},
                    strokeRect: () => {},
                    fillText: () => {},
                    fillStyle: '',
                    strokeStyle: '',
                    lineWidth: 1
                })
            })
        };

        try {
            const scene = new globalThis.THREE.Scene();
            World.scene = scene;
            World.landmarkGroups = [];
            World.propGroups = [];
            World.currentTimePhase = 'day';

            // Instantiate stadium group using fallback builder (which includes floodlight masts & banks)
            const stadium = ModelBuilders.dynamo_stadium();
            stadium.name = 'dynamo_stadium';
            stadium.userData = { editorId: 'dynamo_stadium' };
            scene.add(stadium);
            World.landmarkGroups.push(stadium);

            // Attach stadium floodlights
            World.attachStadiumFloodlights(stadium);

            const nwSpot = stadium.getObjectByName('stadium_floodlight_nw');
            const neSpot = stadium.getObjectByName('stadium_floodlight_ne');
            const swSpot = stadium.getObjectByName('stadium_floodlight_sw');
            const seSpot = stadium.getObjectByName('stadium_floodlight_se');

            const nwPt = stadium.getObjectByName('stadium_pointlight_nw');
            const nePt = stadium.getObjectByName('stadium_pointlight_ne');
            const swPt = stadium.getObjectByName('stadium_pointlight_sw');
            const sePt = stadium.getObjectByName('stadium_pointlight_se');

            const pitchPool = stadium.getObjectByName('stadium_pitch_pool');
            const nwBank = stadium.getObjectByName('floodlight_bank_nw');

            expect(nwSpot).toBeTruthy();
            expect(neSpot).toBeTruthy();
            expect(swSpot).toBeTruthy();
            expect(seSpot).toBeTruthy();
            expect(nwPt).toBeTruthy();
            expect(nePt).toBeTruthy();
            expect(swPt).toBeTruthy();
            expect(sePt).toBeTruthy();
            expect(pitchPool).toBeTruthy();
            expect(nwBank).toBeTruthy();

            // 1. Day / Dawn: floodlights must be OFF
            World.applyTimeOfDay('day');
            expect(World.stadiumLightsActive).toBe(false);
            expect(nwSpot.visible).toBe(false);
            expect(seSpot.visible).toBe(false);
            expect(nwPt.visible).toBe(false);
            expect(pitchPool.visible).toBe(false);
            expect(nwBank.material.emissiveIntensity).toBe(0.0);

            World.applyTimeOfDay('dawn');
            expect(World.stadiumLightsActive).toBe(false);
            expect(nwSpot.visible).toBe(false);

            // 2. Sunset: sun sets -> stadium floodlights turn ON!
            World.applyTimeOfDay('sunset');
            expect(World.stadiumLightsActive).toBe(true);
            expect(nwSpot.visible).toBe(true);
            expect(neSpot.visible).toBe(true);
            expect(swSpot.visible).toBe(true);
            expect(seSpot.visible).toBe(true);
            expect(nwPt.visible).toBe(true);
            expect(pitchPool.visible).toBe(true);
            expect(nwBank.material.emissiveIntensity).toBe(2.5);

            // 3. Dusk: floodlights remain ON
            World.applyTimeOfDay('dusk');
            expect(World.stadiumLightsActive).toBe(true);
            expect(nwSpot.visible).toBe(true);
            expect(pitchPool.visible).toBe(true);

            // 4. Night: floodlights illuminate stadium brightly
            World.applyTimeOfDay('night');
            expect(World.stadiumLightsActive).toBe(true);
            expect(nwSpot.visible).toBe(true);
            expect(seSpot.visible).toBe(true);
            expect(pitchPool.visible).toBe(true);
            expect(nwBank.material.emissiveIntensity).toBe(2.5);

            // 5. Back to day: floodlights turn OFF
            World.applyTimeOfDay('day');
            expect(World.stadiumLightsActive).toBe(false);
            expect(nwSpot.visible).toBe(false);
            expect(seSpot.visible).toBe(false);
            expect(pitchPool.visible).toBe(false);
            expect(nwBank.material.emissiveIntensity).toBe(0.0);
        } finally {
            globalThis.document = originalDoc;
        }
    });
});


