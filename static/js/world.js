import { GAME_STATE, DEFAULT_WALK_PITCH } from './state.js';
import { PhysicsEngine } from './physics.js';
import { TextureFactory } from './textures.js';
import { SoundManager } from './audio.js';
import { completePOI, triggerPlayerSpeech, showToast } from './ui.js';
import { updatePromenadeNPCs } from './entities.js';
import { ModelLoader, ModelBuilders, DEFAULT_LANDMARKS, generateDefaultPromenadeProps, computeModelBoundingBox } from './models.js';

export const World = {
    scene: null,
    camera: null,
    renderer: null,
    clock: null,
    sunLight: null,
    ambientLight: null,
    hemiLight: null,
    skyDomeMesh: null,
    oceanMesh: null,
    ferrisWheelGroup: null,
    fountainParticles: null,
    driftSmokeParticles: null,
    westShoreMeshes: [],
    interactables: [],
    vehicles: [],
    npcs: [],
    seagulls: [],
    distantTankers: [],
    worldLabels: [],
    landmarkGroups: [],
    stallGroups: [],
    propGroups: [],
    streetLightsActive: false,
    stadiumLightsActive: false,
    worldMap: null,
    sunMesh: null,
    currentTimePhase: null,
    forcedPhase: null,
    lastClockUpdateTime: 0,

    resetVehicles() {
        if (Array.isArray(this.vehicles)) {
            for (const v of this.vehicles) {
                if (typeof v.resetToSpawn === 'function') {
                    v.resetToSpawn();
                }
            }
        }
    },

    initThreeScene() {
        const container = document.getElementById('game-canvas-container');
        const canvas = document.getElementById('three-canvas');

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1e2942);
        this.scene.fog = new THREE.FogExp2(0xd97746, 0.0022);

        this.camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.2, 700);

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;

        this.clock = new THREE.Clock();

        const skyGeo = new THREE.SphereGeometry(480, 36, 24);
        const skyMat = (TextureFactory.createProceduralSkyMaterial && TextureFactory.createProceduralSkyMaterial()) || new THREE.MeshBasicMaterial({
            map: TextureFactory.createSkyDomeTexture(0),
            side: THREE.BackSide,
            fog: false,
            depthWrite: false
        });
        this.skyDomeMesh = new THREE.Mesh(skyGeo, skyMat);
        this.scene.add(this.skyDomeMesh);

        this.ambientLight = new THREE.AmbientLight(0xffedd5, 0.45);
        this.scene.add(this.ambientLight);

        this.hemiLight = new THREE.HemisphereLight(0x7dd3fc, 0x1e293b, 0.35);
        this.scene.add(this.hemiLight);

        this.sunLight = new THREE.DirectionalLight(0xff9e5e, 1.15);
        this.sunLight.position.set(-140, 85, -40);
        this.sunLight.castShadow = true;
        this.sunLight.shadow.mapSize.width = 2048;
        this.sunLight.shadow.mapSize.height = 2048;
        this.sunLight.shadow.camera.near = 10;
        this.sunLight.shadow.camera.far = 350;
        const d = 110;
        this.sunLight.shadow.camera.left = -d;
        this.sunLight.shadow.camera.right = d;
        this.sunLight.shadow.camera.top = d;
        this.sunLight.shadow.camera.bottom = -d;
        this.scene.add(this.sunLight);

        this.sunMesh = null;
    },

    registerWorldLabel(text, x, y, z) {
        if (typeof document === 'undefined') return;
        const container = document.getElementById('world-labels-container');
        if (!container) return;
        const el = document.createElement('div');
        el.className = 'absolute top-0 left-0 -translate-x-1/2 -translate-y-full bg-slate-950/75 border border-slate-600/60 text-slate-100 text-[11px] font-bold px-2 py-0.5 rounded-md shadow whitespace-nowrap transition-opacity duration-150';
        el.textContent = text;
        container.appendChild(el);
        this.worldLabels.push({ el, pos: new THREE.Vector3(x, y, z) });
    },

    registerPOIInteractables(worldMap) {
        if (!worldMap || !Array.isArray(worldMap.pois)) return;
        worldMap.pois.forEach(poi => {
            this.interactables.push({
                id: poi.id,
                name: poi.name,
                prompt: poi.prompt,
                x: poi.x,
                z: poi.z,
                radius: poi.radius,
                onInteract: () => {
                    if (poi.restoreHealth) GAME_STATE.health = 100;
                    if (poi.restoreStamina) GAME_STATE.stamina = 100;
                    completePOI(poi.id, poi.toast, poi.reward);
                    triggerPlayerSpeech(poi.speech);
                }
            });
            if (poi.label) {
                this.registerWorldLabel(poi.label.text, poi.label.x, poi.label.y, poi.label.z);
            }
        });
    },

    buildVladivostokNabka(worldMap) {
        this.worldMap = worldMap;
        this.terrainMeshes = [];
        this.landmarkGroups = [];
        this.stallGroups = [];
        this.propGroups = [];
        this.hillGroups = [];
        this.interactables = [];
        this.seagulls = [];
        this.distantTankers = [];
        this.worldLabels = [];
        if (typeof document !== 'undefined') {
            const labelContainer = document.getElementById('world-labels-container');
            if (labelContainer) labelContainer.innerHTML = '';
        }
        PhysicsEngine.clear();

        const defaultTerrain = [
            { id: 'ocean', name: 'Амурский залив (Океан)', type: 'ocean', x: -178, y: -1.6, z: 0, width: 320, height: 0.1, depth: 440, color: 0x0369a1 },
            { id: 'beach', name: 'Пляж Юбилейный', type: 'beach', x: -22, y: -1.1, z: 0, width: 14, height: 1.2, depth: 340, color: 0x94826a },
            { id: 'promenade', name: 'Плиточный променад Набки', type: 'promenade', x: 0, y: -0.5, z: 0, width: 30, height: 1.0, depth: 340, color: 0xcbd5e1 },
            { id: 'road', name: 'Асфальтовая дорога', type: 'road', x: 23, y: -0.5, z: 0, width: 16, height: 0.95, depth: 340, color: 0x1e293b },
            { id: 'east_ground', name: 'Восточный городской квартал', type: 'ground', x: 53, y: -0.5, z: 0, width: 45, height: 1.1, depth: 340, color: 0x334155 }
        ];
        const terrainList = (worldMap && Array.isArray(worldMap.terrain) && worldMap.terrain.length > 0)
            ? worldMap.terrain
            : defaultTerrain;

        for (const slab of terrainList) {
            const w = slab.width || 30;
            const h = slab.height || 1.0;
            const d = slab.depth || 340;
            let mesh;

            if (slab.type === 'ocean' || slab.id === 'ocean') {
                const oceanGeo = new THREE.PlaneGeometry(w, d, 48, 48);
                oceanGeo.rotateX(-Math.PI / 2);
                const oceanMat = new THREE.MeshStandardMaterial({
                    color: slab.color ?? 0x0369a1,
                    roughness: 0.22,
                    metalness: 0.75,
                    flatShading: true
                });
                mesh = new THREE.Mesh(oceanGeo, oceanMat);
                this.oceanMesh = mesh;
            } else if (slab.type === 'promenade' || slab.id === 'promenade') {
                const promTex = TextureFactory.createPromenadeTileTexture();
                const promGeo = new THREE.BoxGeometry(w, h, d);
                const promMat = new THREE.MeshStandardMaterial({ map: promTex, roughness: 0.65 });
                mesh = new THREE.Mesh(promGeo, promMat);
            } else if (slab.type === 'road' || slab.type === 'road_x' || slab.id === 'road') {
                const isX = slab.type === 'road_x' || (w > d && d <= 30);
                const roadTex = TextureFactory.createAsphaltRoadTexture(isX ? 'x' : 'z');
                if (roadTex) {
                    if (isX) {
                        roadTex.repeat.set(Math.max(1, Math.round(w / 14)), 1);
                    } else {
                        roadTex.repeat.set(1, Math.max(1, Math.round(d / 14)));
                    }
                }
                const roadGeo = new THREE.BoxGeometry(w, h, d);
                const roadMat = new THREE.MeshStandardMaterial({
                    map: roadTex,
                    color: (roadTex ? 0xffffff : (slab.color ?? 0x1e293b)),
                    roughness: 0.82
                });
                mesh = new THREE.Mesh(roadGeo, roadMat);
            } else if (slab.type === 'sidewalk') {
                const swTex = TextureFactory.createSidewalkTileTexture();
                if (swTex) {
                    swTex.repeat.set(Math.max(1, Math.round(w / 3)), Math.max(1, Math.round(d / 3)));
                }
                const swGeo = new THREE.BoxGeometry(w, h, d);
                const swMat = new THREE.MeshStandardMaterial({
                    map: swTex,
                    color: (swTex ? 0xffffff : (slab.color ?? 0xcbd5e1)),
                    roughness: 0.72
                });
                mesh = new THREE.Mesh(swGeo, swMat);
            } else if (slab.type === 'grass' || slab.type === 'lawn' || slab.type === 'park') {
                const grassTex = TextureFactory.createGrassTexture();
                if (grassTex) {
                    grassTex.repeat.set(Math.max(1, Math.round(w / 8)), Math.max(1, Math.round(d / 8)));
                }
                const grassGeo = new THREE.BoxGeometry(w, h, d);
                const grassMat = new THREE.MeshStandardMaterial({
                    map: grassTex,
                    color: (grassTex ? 0xffffff : (slab.color ?? 0x2e7d32)),
                    roughness: 0.92
                });
                mesh = new THREE.Mesh(grassGeo, grassMat);
            } else if (slab.type === 'plaza') {
                const plazaTex = TextureFactory.createPlazaPavingTexture();
                if (plazaTex) {
                    plazaTex.repeat.set(Math.max(1, Math.round(w / 6)), Math.max(1, Math.round(d / 6)));
                }
                const plazaGeo = new THREE.BoxGeometry(w, h, d);
                const plazaMat = new THREE.MeshStandardMaterial({
                    map: plazaTex,
                    color: (plazaTex ? 0xffffff : (slab.color ?? 0xa8a29e)),
                    roughness: 0.68
                });
                mesh = new THREE.Mesh(plazaGeo, plazaMat);
            } else {
                const boxGeo = new THREE.BoxGeometry(w, h, d);
                const boxMat = new THREE.MeshStandardMaterial({
                    color: slab.color ?? 0x334155,
                    roughness: 0.85
                });
                mesh = new THREE.Mesh(boxGeo, boxMat);
            }

            mesh.position.set(slab.x || 0, slab.y ?? -0.5, slab.z || 0);
            if (slab.rotY !== undefined) {
                mesh.rotation.y = slab.rotY;
            }
            mesh.receiveShadow = true;
            mesh.userData = {
                editorCategory: 'terrain',
                editorId: slab.id,
                configRef: slab
            };
            this.scene.add(mesh);
            this.terrainMeshes.push(mesh);
        }

        for (let i = 0; i < 4; i++) {
            const stepGeo = new THREE.BoxGeometry(1.4, 0.4, 260);
            const stepMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.75 });
            const step = new THREE.Mesh(stepGeo, stepMat);
            step.position.set(-15.5 - i * 1.3, -0.15 - i * 0.3, 0);
            step.receiveShadow = true;
            this.scene.add(step);
        }

        this.buildSeasideBalustrade();
        this.buildLandmarks(worldMap);
        this.buildStreetFoodRow(worldMap ? worldMap.stalls : []);
        this.buildPierAndYachts(worldMap ? worldMap.sailboats : []);
        this.buildPromenadeProps(worldMap ? worldMap.props : null);
        this.registerPOIInteractables(worldMap);
        this.buildVladivostokSopkiAndBayHorizon(worldMap);
        this.initSeagullsAndDriftParticles();
    },

    buildSeasideBalustrade() {
        const pillarMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.5 });
        for (let z = -140; z <= 140; z += 10) {
            if (Math.abs(z) < 12 || (z > 40 && z < 56)) continue;

            const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.3, 0.7), pillarMat);
            post.position.set(-14.6, 0.65, z);
            post.castShadow = true;
            this.scene.add(post);

            const cap = new THREE.Mesh(new THREE.SphereGeometry(0.38, 10, 10), pillarMat);
            cap.position.set(-14.6, 1.4, z);
            this.scene.add(cap);

            if (z + 10 <= 140 && !(Math.abs(z + 5) < 12) && !(z + 5 > 40 && z + 5 < 56)) {
                const rail = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.2, 10), pillarMat);
                rail.position.set(-14.6, 1.05, z + 5);
                this.scene.add(rail);
            }
        }
    },

    attachFountainParticles(group) {
        const dropCount = 120;
        const dropGeo = new THREE.BufferGeometry();
        const positions = new Float32Array(dropCount * 3);
        const velocities = [];

        for (let i = 0; i < dropCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const radius = Math.random() * 1.8;
            positions[i * 3] = Math.cos(angle) * radius;
            positions[i * 3 + 1] = 1.5 + Math.random() * 5.5;
            positions[i * 3 + 2] = Math.sin(angle) * radius;
            velocities.push({
                vx: Math.cos(angle) * (0.04 + Math.random() * 0.06),
                vy: 0.12 + Math.random() * 0.12,
                vz: Math.sin(angle) * (0.04 + Math.random() * 0.06)
            });
        }
        dropGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const dropMat = new THREE.PointsMaterial({ color: 0xe0f2fe, size: 0.38, transparent: true, opacity: 0.85 });
        this.fountainParticles = new THREE.Points(dropGeo, dropMat);
        this.fountainParticles.name = 'fountainParticles';
        this.fountainParticles.userData.velocities = velocities;
        group.add(this.fountainParticles);
    },

    attachBoundingBoxCordon(group, localBox, scale = 1) {
        if (!group || typeof THREE === 'undefined') return null;

        const existing = group.getObjectByName('bounding_box_cordon');
        if (existing) {
            group.remove(existing);
        }

        if (!localBox) return null;
        const minX = localBox.minX;
        const maxX = localBox.maxX;
        const minZ = localBox.minZ;
        const maxZ = localBox.maxZ;
        if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) return null;

        const width = maxX - minX;
        const depth = maxZ - minZ;
        if (width <= 0 || depth <= 0) return null;

        const s = (Number.isFinite(scale) && scale > 0) ? scale : 1;

        // Human-scale world dimensions converted to group local coordinates
        const localPoleH = 1.15 / s;
        const localPoleR = 0.035 / s;
        const localBaseR = 0.16 / s;
        const localBaseH = 0.045 / s;
        const localCapR = 0.045 / s;

        const localRibbonH = 0.15 / s;
        const localTopY = 0.90 / s;
        const localBottomY = 0.48 / s;

        const cordon = new THREE.Group();
        cordon.name = 'bounding_box_cordon';
        cordon.userData = { isCordon: true, noCollide: true };

        // Shared geometries and materials for stanchion poles
        const baseGeo = new THREE.CylinderGeometry(localBaseR * 0.85, localBaseR, localBaseH, 12);
        const postGeo = new THREE.CylinderGeometry(localPoleR, localPoleR, localPoleH, 8);
        const capGeo = new THREE.SphereGeometry(localCapR, 8, 8);

        const darkMat = new THREE.MeshStandardMaterial({
            color: 0x18181b,
            roughness: 0.85,
            metalness: 0.2
        });

        const poleTex = (TextureFactory.createHazardPoleTexture && TextureFactory.createHazardPoleTexture()) || null;
        const poleMat = poleTex
            ? new THREE.MeshStandardMaterial({ map: poleTex, roughness: 0.4, metalness: 0.1 })
            : new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.4, metalness: 0.1 });

        const ribbonTex = (TextureFactory.createPoliceRibbonTexture && TextureFactory.createPoliceRibbonTexture()) || null;
        const ribbonMat = ribbonTex
            ? new THREE.MeshStandardMaterial({ map: ribbonTex, roughness: 0.35, metalness: 0.05, side: THREE.DoubleSide })
            : new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.35, side: THREE.DoubleSide });

        function createPole(px, pz) {
            const poleGroup = new THREE.Group();
            poleGroup.position.set(px, 0, pz);
            poleGroup.userData = { isCordon: true, noCollide: true };

            const baseMesh = new THREE.Mesh(baseGeo, darkMat);
            baseMesh.position.y = localBaseH / 2;
            baseMesh.userData = { isCordon: true, noCollide: true };
            poleGroup.add(baseMesh);

            const postMesh = new THREE.Mesh(postGeo, poleMat);
            postMesh.position.y = localBaseH + localPoleH / 2;
            postMesh.userData = { isCordon: true, noCollide: true };
            poleGroup.add(postMesh);

            const capMesh = new THREE.Mesh(capGeo, darkMat);
            capMesh.position.y = localBaseH + localPoleH + localCapR * 0.65;
            capMesh.userData = { isCordon: true, noCollide: true };
            poleGroup.add(capMesh);

            return poleGroup;
        }

        // 4 sides around the bounding box perimeter
        const sides = [
            // North: along X at Z = minZ
            { x0: minX, z0: minZ, x1: maxX, z1: minZ, len: width, cx: (minX + maxX) / 2, cz: minZ, rotY: 0 },
            // East: along Z at X = maxX
            { x0: maxX, z0: minZ, x1: maxX, z1: maxZ, len: depth, cx: maxX, cz: (minZ + maxZ) / 2, rotY: Math.PI / 2 },
            // South: along X at Z = maxZ
            { x0: maxX, z0: maxZ, x1: minX, z1: maxZ, len: width, cx: (minX + maxX) / 2, cz: maxZ, rotY: 0 },
            // West: along Z at X = minX
            { x0: minX, z0: maxZ, x1: minX, z1: minZ, len: depth, cx: minX, cz: (minZ + maxZ) / 2, rotY: Math.PI / 2 }
        ];

        // 1. Place evenly-spaced stanchion poles along each side
        for (const side of sides) {
            const worldSideLen = side.len * s;
            const numSegs = Math.max(1, Math.round(worldSideLen / 3.8));
            for (let i = 0; i < numSegs; i++) {
                const t = i / numSegs;
                const px = side.x0 + (side.x1 - side.x0) * t;
                const pz = side.z0 + (side.z1 - side.z0) * t;
                cordon.add(createPole(px, pz));
            }
        }

        // 2. Build dual-tier yellow/black banded hazard ribbons on each of the 4 sides
        for (const side of sides) {
            const worldSideLen = side.len * s;
            const uRepeats = Math.max(1, Math.round((worldSideLen / 2.0) * 10) / 10);

            function buildRibbonQuad(yCenter) {
                const geo = new THREE.PlaneGeometry(side.len, localRibbonH);
                const uvAttr = geo.getAttribute('uv');
                if (uvAttr) {
                    for (let i = 0; i < uvAttr.count; i++) {
                        uvAttr.setX(i, uvAttr.getX(i) * uRepeats);
                    }
                    uvAttr.needsUpdate = true;
                }
                const mesh = new THREE.Mesh(geo, ribbonMat);
                mesh.position.set(side.cx, yCenter, side.cz);
                mesh.rotation.y = side.rotY;
                mesh.userData = { isCordon: true, noCollide: true };
                return mesh;
            }

            cordon.add(buildRibbonQuad(localTopY));
            cordon.add(buildRibbonQuad(localBottomY));
        }

        group.add(cordon);
        return cordon;
    },

    attachBoundingBoxFence(group, localBox, scale = 1) {
        if (!group || typeof THREE === 'undefined') return null;

        const existing = group.getObjectByName('bounding_box_fence');
        if (existing) {
            group.remove(existing);
        }

        if (!localBox) return null;
        const minX = localBox.minX;
        const maxX = localBox.maxX;
        const minZ = localBox.minZ;
        const maxZ = localBox.maxZ;
        if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) return null;

        const width = maxX - minX;
        const depth = maxZ - minZ;
        if (width <= 0 || depth <= 0) return null;

        const s = (Number.isFinite(scale) && scale > 0) ? scale : 1;

        // Human-scale world dimensions converted to group local coordinates
        const localPostH = 1.35 / s;
        const localPostR = 0.08 / s;
        const localCapR = 0.10 / s;

        const localRailH = 0.06 / s;
        const localRailW = 0.05 / s;
        const localTopRailY = 1.15 / s;
        const localBottomRailY = 0.20 / s;

        const localPicketH = 1.05 / s;
        const localPicketR = 0.02 / s;
        const localSpearH = 0.12 / s;
        const localSpearR = 0.035 / s;

        const fence = new THREE.Group();
        fence.name = 'bounding_box_fence';
        fence.userData = { isFence: true, noCollide: true };

        // Shared materials & geometries for wrought iron park fence
        const ironMat = new THREE.MeshStandardMaterial({
            color: 0x18181b,
            roughness: 0.45,
            metalness: 0.85
        });

        const postGeo = new THREE.CylinderGeometry(localPostR * 0.9, localPostR, localPostH, 8);
        const capGeo = new THREE.SphereGeometry(localCapR, 8, 8);
        const picketGeo = new THREE.CylinderGeometry(localPicketR, localPicketR, localPicketH, 6);
        const spearGeo = new THREE.CylinderGeometry(0, localSpearR, localSpearH, 6);

        function createPost(px, pz) {
            const postGroup = new THREE.Group();
            postGroup.position.set(px, 0, pz);
            postGroup.userData = { isFence: true, noCollide: true };

            const shaft = new THREE.Mesh(postGeo, ironMat);
            shaft.position.y = localPostH / 2;
            shaft.userData = { isFence: true, noCollide: true };
            postGroup.add(shaft);

            const cap = new THREE.Mesh(capGeo, ironMat);
            cap.position.y = localPostH + localCapR * 0.65;
            cap.userData = { isFence: true, noCollide: true };
            postGroup.add(cap);

            return postGroup;
        }

        function createPicket(px, pz) {
            const picketGroup = new THREE.Group();
            picketGroup.position.set(px, 0, pz);
            picketGroup.userData = { isFence: true, noCollide: true };

            const shaft = new THREE.Mesh(picketGeo, ironMat);
            shaft.position.y = localBottomRailY + localPicketH / 2;
            shaft.userData = { isFence: true, noCollide: true };
            picketGroup.add(shaft);

            const spear = new THREE.Mesh(spearGeo, ironMat);
            spear.position.y = localBottomRailY + localPicketH + localSpearH / 2;
            spear.userData = { isFence: true, noCollide: true };
            picketGroup.add(spear);

            return picketGroup;
        }

        // 4 sides around the bounding box perimeter
        const sides = [
            // North: along X at Z = minZ
            { x0: minX, z0: minZ, x1: maxX, z1: minZ, len: width, cx: (minX + maxX) / 2, cz: minZ, isX: true },
            // East: along Z at X = maxX
            { x0: maxX, z0: minZ, x1: maxX, z1: maxZ, len: depth, cx: maxX, cz: (minZ + maxZ) / 2, isX: false },
            // South: along X at Z = maxZ
            { x0: maxX, z0: maxZ, x1: minX, z1: maxZ, len: width, cx: (minX + maxX) / 2, cz: maxZ, isX: true },
            // West: along Z at X = minX
            { x0: minX, z0: maxZ, x1: minX, z1: minZ, len: depth, cx: minX, cz: (minZ + maxZ) / 2, isX: false }
        ];

        for (const side of sides) {
            const worldSideLen = side.len * s;

            // 1. Posts every ~2.5m
            const numPosts = Math.max(1, Math.round(worldSideLen / 2.5));
            for (let i = 0; i < numPosts; i++) {
                const t = i / numPosts;
                const px = side.x0 + (side.x1 - side.x0) * t;
                const pz = side.z0 + (side.z1 - side.z0) * t;
                fence.add(createPost(px, pz));
            }

            // 2. Dual horizontal rails (top and bottom)
            const railGeo = side.isX
                ? new THREE.BoxGeometry(side.len, localRailH, localRailW)
                : new THREE.BoxGeometry(localRailW, localRailH, side.len);

            const topRail = new THREE.Mesh(railGeo, ironMat);
            topRail.position.set(side.cx, localTopRailY, side.cz);
            topRail.userData = { isFence: true, noCollide: true };
            fence.add(topRail);

            const bottomRail = new THREE.Mesh(railGeo, ironMat);
            bottomRail.position.set(side.cx, localBottomRailY, side.cz);
            bottomRail.userData = { isFence: true, noCollide: true };
            fence.add(bottomRail);

            // 3. Vertical iron pickets with pointed spearheads every ~0.35m
            const numPickets = Math.max(1, Math.round(worldSideLen / 0.35));
            for (let i = 1; i < numPickets; i++) {
                const t = i / numPickets;
                const px = side.x0 + (side.x1 - side.x0) * t;
                const pz = side.z0 + (side.z1 - side.z0) * t;
                const nearPost = (i % Math.round(numPickets / numPosts)) === 0;
                if (!nearPost) {
                    fence.add(createPicket(px, pz));
                }
            }
        }

        group.add(fence);
        return fence;
    },

    attachStadiumFloodlights(group) {
        if (!group || typeof THREE === 'undefined') return null;

        const towers = [
            { key: 'nw', x: 14.5, y: 18.06, z: -23.5 },
            { key: 'ne', x: 14.5, y: 18.06, z: 23.5 },
            { key: 'sw', x: -14.5, y: 18.06, z: -23.5 },
            { key: 'se', x: -14.5, y: 18.06, z: 23.5 }
        ];

        towers.forEach(t => {
            const bankNode = group.getObjectByName(`floodlight_bank_${t.key}`);
            const posX = bankNode ? bankNode.position.x : t.x;
            const posY = bankNode ? bankNode.position.y : t.y;
            const posZ = bankNode ? bankNode.position.z : t.z;

            // SpotLight aimed downwards onto the stadium pitch
            if (!group.getObjectByName(`stadium_floodlight_${t.key}`)) {
                const spot = new THREE.SpotLight(0xfffaed, 2.5, 85, Math.PI / 4, 0.5, 1.2);
                spot.name = `stadium_floodlight_${t.key}`;
                spot.position.set(posX, posY, posZ);
                spot.castShadow = false;

                const target = new THREE.Object3D();
                target.name = `stadium_floodlight_target_${t.key}`;
                target.position.set(0, 0.5, posZ * 0.35);
                spot.target = target;

                group.add(spot);
                group.add(target);
            }

            // Omnidirectional radiant glow at mast top
            if (!group.getObjectByName(`stadium_pointlight_${t.key}`)) {
                const pt = new THREE.PointLight(0xfffaed, 1.8, 40, 1.4);
                pt.name = `stadium_pointlight_${t.key}`;
                pt.position.set(posX, posY, posZ);
                pt.castShadow = false;
                group.add(pt);
            }

            if (bankNode && bankNode.material) {
                if (!bankNode.userData._hasClonedMat) {
                    bankNode.material = bankNode.material.clone();
                    bankNode.userData._hasClonedMat = true;
                }
                if (bankNode.material.emissive !== undefined) {
                    bankNode.material.emissive = new THREE.Color(0xfffbeb);
                }
            }
        });

        // Add illuminated field pool decal across the pitch and running track
        if (!group.getObjectByName('stadium_pitch_pool') && TextureFactory && TextureFactory.createLightPoolTexture) {
            const poolTex = TextureFactory.createLightPoolTexture('rgba(255, 252, 235, 0.45)', 'rgba(254, 240, 138, 0)');
            if (poolTex) {
                const poolGeo = new THREE.PlaneGeometry(32, 54);
                poolGeo.rotateX(-Math.PI / 2);
                const poolMat = new THREE.MeshBasicMaterial({
                    map: poolTex,
                    transparent: true,
                    depthWrite: false,
                    blending: THREE.AdditiveBlending
                });
                const poolMesh = new THREE.Mesh(poolGeo, poolMat);
                poolMesh.name = 'stadium_pitch_pool';
                poolMesh.position.set(0, 0.52, 0);
                poolMesh.userData = { noCollide: true };
                group.add(poolMesh);
            }
        }

        const lightsOn = (this.currentTimePhase === 'sunset' || this.currentTimePhase === 'dusk' || this.currentTimePhase === 'night');
        this.setStadiumFloodlights(lightsOn);
        return group;
    },

    resolveLandmarkFallbackBuilder(lm) {
        const id = lm.id || '';
        const model = lm.model || '';
        if (ModelBuilders[id]) return () => ModelBuilders[id]();
        if (id.startsWith('bridge_pylon') || model.includes('bridge_pylon')) return () => ModelBuilders.bridge_pylon();
        const baseName = model.replace(/^.*\/|\.glb$/g, '');
        if (ModelBuilders[baseName]) return () => ModelBuilders[baseName]();
        return () => new THREE.Group();
    },

    buildLandmarks(worldMap) {
        const landmarks = (worldMap && Array.isArray(worldMap.landmarks)) ? worldMap.landmarks : DEFAULT_LANDMARKS;
        for (const lm of landmarks) {
            if (!lm) continue;
            const fallbackFn = this.resolveLandmarkFallbackBuilder(lm);
            const group = ModelLoader.instantiate(lm.model, fallbackFn) || fallbackFn();
            const localBox = (group.userData && group.userData.boundingBox) || computeModelBoundingBox(group);
            group.position.set(lm.x || 0, lm.y || 0, lm.z || 0);
            group.rotation.y = lm.rotY || 0;
            if (lm.scale !== undefined && lm.scale !== 1) {
                group.scale.setScalar(lm.scale);
            }
            const computedCollider = PhysicsEngine.addModelCollider(lm, 'landmarks', localBox);
            group.userData = {
                ...group.userData,
                boundingBox: localBox,
                computedCollider,
                editorCategory: 'landmarks',
                editorId: lm.id,
                configRef: lm
            };

            if (lm.hasFountainParticles || lm.id === 'fountain') {
                this.attachFountainParticles(group);
            }
            if (lm.isFerrisWheel || lm.id === 'ferris_wheel') {
                const wheelNode = group.getObjectByName ? group.getObjectByName('ferrisWheelGroup') : null;
                if (wheelNode) this.ferrisWheelGroup = wheelNode;
            }
            if (lm.id === 'fountain' || lm.id === 'ferris_wheel' || lm.isFerrisWheel || lm.hasFountainParticles || lm.hasPoliceTape || lm.hasBoundingBoxCordon) {
                this.attachBoundingBoxCordon(group, localBox, lm.scale || 1);
            }
            if (lm.id === 'oceanarium' || lm.hasFence || lm.hasBoundingBoxFence) {
                this.attachBoundingBoxFence(group, localBox, lm.scale || 1);
            }
            if (lm.id === 'dynamo_stadium') {
                this.attachStadiumFloodlights(group);
            }
            if (lm.label && lm.label.text) {
                this.registerWorldLabel(lm.label.text, lm.label.x, lm.label.y, lm.label.z);
            }

            this.scene.add(group);
            this.landmarkGroups.push(group);
        }
    },

    buildCentralFountain(x, z) {
        const group = ModelLoader.instantiate('models/fountain.glb', () => ModelBuilders.fountain());
        group.position.set(x, 0, z);
        this.attachFountainParticles(group);
        this.scene.add(group);
        return group;
    },

    buildBronzeTigerStatue(x, z) {
        const group = ModelLoader.instantiate('models/tiger_statue.glb', () => ModelBuilders.tiger_statue());
        group.position.set(x, 0, z);
        this.scene.add(group);
        return group;
    },

    buildStreetFoodRow(stalls = []) {
        stalls.forEach(s => {
            const modelUrl = s.model || `models/stall_${s.id}.glb`;
            const group = ModelLoader.instantiate(modelUrl, () => ModelBuilders.stall(s));
            const localBox = (group.userData && group.userData.boundingBox) || computeModelBoundingBox(group);
            group.position.set(s.x || 0, s.y || 0, s.z || 0);
            group.rotation.y = s.rotY || 0;
            if (s.scale !== undefined && s.scale !== 1) {
                group.scale.setScalar(s.scale);
            }
            const computedCollider = PhysicsEngine.addModelCollider(s, 'stalls', localBox);
            group.userData = {
                ...group.userData,
                boundingBox: localBox,
                computedCollider,
                editorCategory: 'stalls',
                editorId: s.id,
                configRef: s
            };
            this.scene.add(group);
            this.stallGroups.push(group);

            this.interactables.push({
                id: s.id,
                name: s.title,
                prompt: s.prompt,
                x: s.x - 3.6,
                z: s.z,
                radius: 4.5,
                onInteract: () => {
                    GAME_STATE.health = 100;
                    GAME_STATE.stamina = 100;
                    completePOI(s.id === 'pyanse' ? 'pyanse' : s.id, `🥟 ${s.title}: Здоровье и бодрость @${GAME_STATE.username || 'Игрок'} полностью восстановлены!`, s.reward);
                    triggerPlayerSpeech(s.speech);
                }
            });
        });
        this.registerWorldLabel('🥟 Стритфуд «Пян-се» (★ 4.6)', 9.5, 6.2, 28);
    },

    buildPierAndYachts(boatPositions = []) {
        boatPositions.forEach((entry, idx) => {
            const isArray = Array.isArray(entry);
            const bx = isArray ? entry[0] : (entry.x || 0);
            const by = isArray ? -1.1 : (entry.y !== undefined ? entry.y : -1.1);
            const bz = isArray ? entry[1] : (entry.z || 0);
            const rotY = (!isArray && entry.rotY !== undefined) ? entry.rotY : 0;
            const scale = (!isArray && entry.scale !== undefined) ? entry.scale : 1;
            const sailColor = idx % 2 === 0 ? 0xffffff : 0x38bdf8;
            const defaultModel = idx % 2 === 0 ? 'models/sailboat_white.glb' : 'models/sailboat_blue.glb';
            const modelUrl = (!isArray && entry.model) ? entry.model : defaultModel;

            const boat = ModelLoader.instantiate(modelUrl, () => ModelBuilders.sailboat(sailColor));
            const localBox = (boat.userData && boat.userData.boundingBox) || computeModelBoundingBox(boat);
            boat.position.set(bx, by, bz);
            boat.rotation.y = rotY;
            if (scale !== 1) boat.scale.setScalar(scale);
            boat.userData = {
                ...boat.userData,
                boundingBox: localBox,
                editorCategory: 'sailboats',
                editorId: `sailboat_${idx}`,
                editorIndex: idx,
                configRef: entry
            };
            this.scene.add(boat);
        });
    },

    buildFerrisWheel(x, z) {
        const supportGroup = ModelLoader.instantiate('models/ferris_wheel.glb', () => ModelBuilders.ferris_wheel());
        supportGroup.position.set(x, 0, z);
        const wheelNode = supportGroup.getObjectByName ? supportGroup.getObjectByName('ferrisWheelGroup') : null;
        if (wheelNode) this.ferrisWheelGroup = wheelNode;
        this.scene.add(supportGroup);
        return supportGroup;
    },

    buildDynamoStadium(x, z) {
        const group = ModelLoader.instantiate('models/dynamo_stadium.glb', () => ModelBuilders.dynamo_stadium());
        group.position.set(x, 0, z);
        this.scene.add(group);
        this.registerWorldLabel('🏟️ Стадион «Динамо» (Фокина, 1 • ★ 4.1)', x - 8, 14.5, z);
        return group;
    },

    buildOceanCinema(x, z) {
        const group = ModelLoader.instantiate('models/ocean_cinema.glb', () => ModelBuilders.ocean_cinema());
        group.position.set(x, 0, z);
        this.scene.add(group);
        this.registerWorldLabel('🎬 К/Т «Океан IMAX» (Набережная, 3 • ★ 4.7)', x - 10, 18.5, z);
        return group;
    },

    buildPromenadeProps(propsList = null) {
        const props = Array.isArray(propsList) ? propsList : generateDefaultPromenadeProps();
        for (const p of props) {
            if (!p) continue;
            const isBench = p.type === 'bench' || (p.model && p.model.includes('bench'));
            const isRoadLamp = p.type === 'road_lamp' || (p.model && p.model.includes('road_lamp'));
            const isStreetLamp = !isBench && !isRoadLamp;

            const defaultModel = isBench
                ? 'models/bench.glb'
                : (isRoadLamp ? 'models/road_lamp.glb' : 'models/street_lamp.glb');
            const fallbackFn = isBench
                ? () => ModelBuilders.bench()
                : (isRoadLamp ? () => ModelBuilders.road_lamp() : () => ModelBuilders.street_lamp());

            const obj = ModelLoader.instantiate(p.model || defaultModel, fallbackFn);
            const localBox = (obj.userData && obj.userData.boundingBox) || computeModelBoundingBox(obj);
            obj.position.set(p.x || 0, p.y !== undefined ? p.y : (isBench ? 0.325 : 0), p.z || 0);
            obj.rotation.y = p.rotY || 0;
            if (p.scale !== undefined && p.scale !== 1) {
                obj.scale.setScalar(p.scale);
            }

            // Real illumination for lamps
            if (isStreetLamp) {
                // Warm golden light for promenade lamp
                if (!obj.getObjectByName('lamp_point_light')) {
                    const light = new THREE.PointLight(0xfef08a, 1.4, 22, 1.8);
                    light.position.set(0, 5.2, 0);
                    light.name = 'lamp_point_light';
                    light.castShadow = false;
                    obj.add(light);
                }
                // Emissive warm glow on globe if supported by material type
                obj.traverse((child) => {
                    if (child.isMesh && child.material && (child.name === 'globe' || (child.material.color && child.material.color.getHex() === 0xfde68a))) {
                        if (child.material.emissive !== undefined && !child.material.isMeshBasicMaterial) {
                            child.material.emissive = new THREE.Color(0xfef08a);
                            child.material.emissiveIntensity = 1.0;
                        }
                    }
                });
                // Soft ground light pool decal
                if (!obj.getObjectByName('lamp_ground_pool') && TextureFactory && TextureFactory.createLightPoolTexture) {
                    const poolTex = TextureFactory.createLightPoolTexture('rgba(254, 240, 138, 0.45)', 'rgba(250, 204, 21, 0)');
                    if (poolTex) {
                        const poolGeo = new THREE.PlaneGeometry(8, 8);
                        poolGeo.rotateX(-Math.PI / 2);
                        const poolMat = new THREE.MeshBasicMaterial({
                            map: poolTex,
                            transparent: true,
                            depthWrite: false,
                            blending: THREE.AdditiveBlending
                        });
                        const poolMesh = new THREE.Mesh(poolGeo, poolMat);
                        poolMesh.name = 'lamp_ground_pool';
                        poolMesh.position.set(0, 0.02, 0);
                        poolMesh.userData = { noCollide: true };
                        obj.add(poolMesh);
                    }
                }
            } else if (isRoadLamp) {
                // Bright high-altitude light for highway road lamp
                if (!obj.getObjectByName('road_lamp_point_light')) {
                    const light = new THREE.PointLight(0xfffbeb, 2.2, 36, 1.4);
                    light.position.set(2.4, 8.2, 0);
                    light.name = 'road_lamp_point_light';
                    light.castShadow = false;
                    obj.add(light);
                }
                // Wide roadway light pool decal
                if (!obj.getObjectByName('road_lamp_ground_pool') && TextureFactory && TextureFactory.createLightPoolTexture) {
                    const poolTex = TextureFactory.createLightPoolTexture('rgba(255, 252, 235, 0.45)', 'rgba(254, 240, 138, 0)');
                    if (poolTex) {
                        const poolGeo = new THREE.PlaneGeometry(14, 14);
                        poolGeo.rotateX(-Math.PI / 2);
                        const poolMat = new THREE.MeshBasicMaterial({
                            map: poolTex,
                            transparent: true,
                            depthWrite: false,
                            blending: THREE.AdditiveBlending
                        });
                        const poolMesh = new THREE.Mesh(poolGeo, poolMat);
                        poolMesh.name = 'road_lamp_ground_pool';
                        poolMesh.position.set(2.4, 0.02, 0);
                        poolMesh.userData = { noCollide: true };
                        obj.add(poolMesh);
                    }
                }
            }

            const computedCollider = p.hasCollider !== false
                ? PhysicsEngine.addModelCollider(p, 'props', localBox)
                : null;
            obj.userData = {
                ...obj.userData,
                boundingBox: localBox,
                computedCollider,
                editorCategory: 'props',
                editorId: p.id,
                configRef: p
            };
            this.scene.add(obj);
            this.propGroups.push(obj);
        }

        const lightsOn = (this.currentTimePhase === 'sunset' || this.currentTimePhase === 'dusk' || this.currentTimePhase === 'night');
        this.setStreetLights(lightsOn);
    },

    buildOceanarium(x, z) {
        const group = ModelLoader.instantiate('models/oceanarium.glb', () => ModelBuilders.oceanarium());
        const localBox = (group.userData && group.userData.boundingBox) || computeModelBoundingBox(group);
        this.attachBoundingBoxFence(group, localBox, 1);
        group.position.set(x, 0, z);
        this.scene.add(group);
        return group;
    },

    buildGoogleMapsAuthenticPOIs() {
        const ids = ['arbat_paving', 'supra_restaurant', 'fortress_museum', 'olympiets_complex', 'azimut_hotel', 'yacht_club_pier', 'yacht_club_boathouse'];
        const landmarks = DEFAULT_LANDMARKS.filter(l => ids.includes(l.id));
        this.buildLandmarks({ landmarks });
    },

    buildVladivostokSopkiAndBayHorizon(worldMap) {
        const createGreenSopka = (h, categoryKey, idx) => {
            const x = h.x || 0;
            const y = h.y !== undefined ? h.y : -0.5;
            const z = h.z || 0;
            const radius = h.r || 32;
            const rx = h.rx !== undefined ? h.rx : radius;
            const rz = h.rz !== undefined ? h.rz : radius;
            const height = h.h || 48;
            const label = h.label || '';

            const hillGroup = ModelLoader.instantiate('models/sopka.glb', () => ModelBuilders.sopka(32, 48));
            const localBox = (hillGroup.userData && hillGroup.userData.boundingBox) || computeModelBoundingBox(hillGroup);
            hillGroup.position.set(x, y, z);
            if (h.rotY !== undefined) {
                hillGroup.rotation.y = h.rotY;
            }
            hillGroup.scale.set(rx / 32, height / 48, rz / 32);
            const computedCollider = PhysicsEngine.addModelCollider(h, 'hills', localBox);
            hillGroup.userData = {
                ...hillGroup.userData,
                boundingBox: localBox,
                computedCollider,
                editorCategory: `hills.${categoryKey}`,
                editorSubGroup: categoryKey,
                editorIndex: idx,
                editorId: `${categoryKey}_${idx}`,
                configRef: h
            };
            this.scene.add(hillGroup);
            this.hillGroups.push(hillGroup);

            if (label) {
                this.registerWorldLabel(label, x, y + height + 3.5, z);
            }
        };

        const hills = (worldMap && worldMap.hills) || {};
        (hills.east || []).forEach((h, idx) => createGreenSopka(h, 'east', idx));
        (hills.north || []).forEach((h, idx) => createGreenSopka(h, 'north', idx));
        (hills.south || []).forEach((h, idx) => createGreenSopka(h, 'south', idx));

        this.westShoreMeshes = [];
        const westShoreRidgeData = hills.westShoreRidge || [];

        const westShoreMat = new THREE.MeshBasicMaterial({
            color: 0x64748b,
            transparent: true,
            opacity: 0.34,
            fog: false
        });
        const westShoreSecondLayerMat = new THREE.MeshBasicMaterial({
            color: 0x475569,
            transparent: true,
            opacity: 0.24,
            fog: false
        });
        this.westShoreMeshes.push(westShoreMat, westShoreSecondLayerMat);

        westShoreRidgeData.forEach((peak, idx) => {
            const distSopka = new THREE.Mesh(
                new THREE.ConeGeometry(peak.r, peak.h, 10),
                idx % 2 === 0 ? westShoreMat : westShoreSecondLayerMat
            );
            distSopka.scale.set(0.45, 1.0, 1.35);
            distSopka.position.set(-345 - (idx % 3) * 18, peak.h * 0.42 - 2.0, peak.z);
            this.scene.add(distSopka);
        });
        this.registerWorldLabel('🌫️ Западный берег Амурского залива (Песчаный • 20 км)', -290, 26, -35);

        const tankerSpecs = (worldMap && worldMap.tankers) || [];
        tankerSpecs.forEach((spec, idx) => {
            const ship = ModelLoader.instantiate(spec.model || 'models/tanker.glb', () => ModelBuilders.tanker(spec.hullColor));
            const hullNode = ship.getObjectByName ? ship.getObjectByName('hull') : null;
            if (hullNode && hullNode.material && spec.hullColor !== undefined) {
                hullNode.material = hullNode.material.clone();
                hullNode.material.color.setHex(spec.hullColor);
            }
            ship.position.set(spec.x || 0, spec.y !== undefined ? spec.y : -1.35, spec.z || 0);
            ship.scale.setScalar(spec.scale || 1);
            ship.rotation.y = spec.rotY !== undefined ? spec.rotY : (spec.dir > 0 ? 0 : Math.PI);
            ship.userData = {
                editorCategory: 'tankers',
                editorId: `tanker_${idx}`,
                configRef: spec
            };
            this.scene.add(ship);

            this.distantTankers.push({
                group: ship,
                speed: spec.speed,
                dir: spec.dir,
                baseX: spec.x
            });
        });
    },

    initSeagullsAndDriftParticles() {
        for (let i = 0; i < 26; i++) {
            const bird = ModelLoader.instantiate('models/seagull.glb', () => ModelBuilders.seagull());
            bird.scale.setScalar(1.25);

            const leftWingPivot = (bird.getObjectByName && bird.getObjectByName('leftWing')) || new THREE.Group();
            const rightWingPivot = (bird.getObjectByName && bird.getObjectByName('rightWing')) || new THREE.Group();

            const overPromenade = i < 14;
            const centerX = overPromenade ? (-12 + (i % 4) * 6.5) : (-34 - (i % 4) * 14);
            const centerZ = -105 + i * 8.5;
            const altitude = overPromenade ? (5.2 + (i % 4) * 1.8) : (8.5 + (i % 5) * 2.4);
            this.scene.add(bird);

            this.seagulls.push({
                group: bird,
                leftWing: leftWingPivot,
                rightWing: rightWingPivot,
                cx: centerX,
                cz: centerZ,
                y: altitude,
                radius: overPromenade ? (7 + (i % 4) * 3.5) : (12 + (i % 4) * 5),
                angle: i * 0.75,
                speed: 0.65 + (i % 4) * 0.18
            });
        }

        const smokeCount = 80;
        const smokeGeo = new THREE.BufferGeometry();
        const smokePos = new Float32Array(smokeCount * 3);
        const smokeData = [];
        for (let i = 0; i < smokeCount; i++) {
            smokePos[i * 3] = 0;
            smokePos[i * 3 + 1] = -50;
            smokePos[i * 3 + 2] = 0;
            smokeData.push({ life: 0, vx: 0, vy: 0, vz: 0 });
        }
        smokeGeo.setAttribute('position', new THREE.BufferAttribute(smokePos, 3));
        const smokeMat = new THREE.PointsMaterial({
            color: 0xe2e8f0,
            size: 1.35,
            transparent: true,
            opacity: 0.55
        });
        this.driftSmokeParticles = new THREE.Points(smokeGeo, smokeMat);
        this.driftSmokeParticles.userData.pool = smokeData;
        this.driftSmokeParticles.userData.cursor = 0;
        this.scene.add(this.driftSmokeParticles);
    },

    spawnDriftSmoke(x, z) {
        if (!this.driftSmokeParticles) return;
        const posAttr = this.driftSmokeParticles.geometry.attributes.position;
        const pool = this.driftSmokeParticles.userData.pool;
        const idx = this.driftSmokeParticles.userData.cursor;
        this.driftSmokeParticles.userData.cursor = (idx + 1) % pool.length;

        posAttr.setXYZ(idx, x + (Math.random() - 0.5) * 1.2, 0.25, z + (Math.random() - 0.5) * 1.2);
        pool[idx].life = 1.0;
        pool[idx].vx = (Math.random() - 0.5) * 1.6;
        pool[idx].vy = 0.9 + Math.random() * 0.8;
        pool[idx].vz = (Math.random() - 0.5) * 1.6;
        posAttr.needsUpdate = true;
    },

    setStreetLights(enabled) {
        this.streetLightsActive = Boolean(enabled);
        if (!Array.isArray(this.propGroups)) return;

        for (const obj of this.propGroups) {
            if (!obj) continue;
            const ptLight = obj.getObjectByName('lamp_point_light') || obj.getObjectByName('road_lamp_point_light');
            if (ptLight) {
                ptLight.visible = this.streetLightsActive;
            }
            const groundPool = obj.getObjectByName('lamp_ground_pool') || obj.getObjectByName('road_lamp_ground_pool');
            if (groundPool) {
                groundPool.visible = this.streetLightsActive;
            }

            obj.traverse((child) => {
                if (!child.isMesh || !child.material) return;
                if (child.name === 'globe') {
                    if (child.material.emissive !== undefined && !child.material.isMeshBasicMaterial) {
                        child.material.emissiveIntensity = this.streetLightsActive ? 1.0 : 0.0;
                    } else if (child.material.color) {
                        child.material.color.setHex(this.streetLightsActive ? 0xfef08a : 0x94a3b8);
                    }
                } else if (child.name === 'ledPanel') {
                    if (child.material.color) {
                        child.material.color.setHex(this.streetLightsActive ? 0xffffff : 0x475569);
                    }
                }
            });
        }

        this.setStadiumFloodlights(this.streetLightsActive);
    },

    setStadiumFloodlights(enabled) {
        this.stadiumLightsActive = Boolean(enabled);
        const stadiumGroup = this.landmarkGroups?.find(g => g.userData?.editorId === 'dynamo_stadium' || g.name === 'dynamo_stadium')
            || (this.scene && this.scene.getObjectByName && (this.scene.getObjectByName('dynamo_stadium') || (Array.isArray(this.scene.children) && this.scene.children.find(c => c.name === 'dynamo_stadium'))));
        if (!stadiumGroup) return;

        stadiumGroup.traverse((child) => {
            if (child.name?.startsWith('stadium_floodlight_') || child.name?.startsWith('stadium_pointlight_') || child.name === 'stadium_pitch_pool') {
                child.visible = this.stadiumLightsActive;
            }
            if (child.name?.startsWith('floodlight_bank_')) {
                if (child.material && child.material.emissive !== undefined) {
                    if (!child.material.emissive.isColor || child.material.emissive.getHex() === 0) {
                        child.material.emissive = new THREE.Color(0xfffbeb);
                    }
                    child.material.emissiveIntensity = this.stadiumLightsActive ? 2.5 : 0.0;
                }
            }
        });
    },

    applyTimeOfDay(timeOrPhase, explicitTimeString = null) {
        let phase = 'day';
        let timeString = explicitTimeString;

        if (typeof timeOrPhase === 'string') {
            phase = timeOrPhase;
            this.forcedPhase = phase;
            if (!timeString) {
                const defaults = { dawn: '06:15', day: '13:30', sunset: '19:45', dusk: '21:15', night: '23:30' };
                timeString = defaults[phase] || '12:00';
            }
        } else if (typeof timeOrPhase === 'number') {
            phase = getTimeOfDayPhase(timeOrPhase);
            if (!timeString) {
                const h = Math.floor(timeOrPhase);
                const m = Math.floor((timeOrPhase - h) * 60);
                timeString = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            }
        } else if (timeOrPhase === null) {
            this.forcedPhase = null;
        }

        const clockEl = (typeof document !== 'undefined') ? document.getElementById('hud-clock') : null;
        if (clockEl && timeString) {
            clockEl.textContent = timeString;
        }

        const sunPos = new THREE.Vector3();
        let skyTopColor = 0x0284c7;
        let skyHorizonColor = 0x7dd3fc;
        let skyGroundColor = 0x1e293b;
        let sunColorHex = 0xffffff;
        let glowColorHex = 0xfef08a;
        let sunGlow = 1.0;
        let starIntensity = 0.0;

        if (phase === 'dawn') {
            // Dawn mode: Red sky on the east (+X), blue sky on the west (-X), sun rising in east
            if (this.scene && this.scene.background && this.scene.background.setHex) this.scene.background.setHex(0x1e1b4b);
            if (this.scene && this.scene.fog && this.scene.fog.color) {
                this.scene.fog.color.setHex(0x312e81);
                this.scene.fog.density = 0.0020;
            }

            sunPos.set(240, 32, -20);
            if (this.sunLight) {
                this.sunLight.position.copy(sunPos);
                this.sunLight.color.setHex(0xff7043);
                this.sunLight.intensity = 1.0;
            }
            if (this.ambientLight) {
                this.ambientLight.color.setHex(0xffd1b3);
                this.ambientLight.intensity = 0.45;
            }
            if (this.hemiLight) {
                this.hemiLight.color.setHex(0xff8a65);
                this.hemiLight.groundColor.setHex(0x1e293b);
                this.hemiLight.intensity = 0.35;
            }

            skyTopColor = 0x1e1b4b;
            skyHorizonColor = 0x312e81;
            skyGroundColor = 0x0f172a;
            sunColorHex = 0xff7043;
            glowColorHex = 0xff3300;
            sunGlow = 1.25;
            starIntensity = 0.25;

            const westTint = 0x1e293b;
            const westOpacity = 0.30;
            this.westShoreMeshes.forEach((m, idx) => {
                if (m && m.color) m.color.setHex(westTint);
                if (m) m.opacity = idx === 0 ? westOpacity : westOpacity * 0.72;
            });
        } else if (phase === 'sunset') {
            // Sunset mode: Sun setting over mountains on the west (-X) across Amur Bay
            if (this.scene && this.scene.background && this.scene.background.setHex) this.scene.background.setHex(0x1e2942);
            if (this.scene && this.scene.fog && this.scene.fog.color) {
                this.scene.fog.color.setHex(0xd97746);
                this.scene.fog.density = 0.0022;
            }

            sunPos.set(-260, 26, -20);
            if (this.sunLight) {
                this.sunLight.position.copy(sunPos);
                this.sunLight.color.setHex(0xff7a33);
                this.sunLight.intensity = 1.15;
            }
            if (this.ambientLight) {
                this.ambientLight.color.setHex(0xffd5b8);
                this.ambientLight.intensity = 0.50;
            }
            if (this.hemiLight) {
                this.hemiLight.color.setHex(0xfb923c);
                this.hemiLight.groundColor.setHex(0x1e293b);
                this.hemiLight.intensity = 0.35;
            }

            skyTopColor = 0x1e2942;
            skyHorizonColor = 0xd97746;
            skyGroundColor = 0x1e293b;
            sunColorHex = 0xff7a33;
            glowColorHex = 0xf97316;
            sunGlow = 1.45;
            starIntensity = 0.0;

            const westTint = 0x581c87;
            const westOpacity = 0.45;
            this.westShoreMeshes.forEach((m, idx) => {
                if (m && m.color) m.color.setHex(westTint);
                if (m) m.opacity = idx === 0 ? westOpacity : westOpacity * 0.72;
            });
        } else if (phase === 'day') {
            // Day mode: Balanced maritime coastal daylight, rich natural colors without highlight blowout
            if (this.scene && this.scene.background && this.scene.background.setHex) this.scene.background.setHex(0x0284c7);
            if (this.scene && this.scene.fog && this.scene.fog.color) {
                this.scene.fog.color.setHex(0xbae6fd);
                this.scene.fog.density = 0.0014;
            }

            sunPos.set(-70, 180, -35);
            if (this.sunLight) {
                this.sunLight.position.copy(sunPos);
                this.sunLight.color.setHex(0xfffaed);
                this.sunLight.intensity = 0.95;
            }
            if (this.ambientLight) {
                this.ambientLight.color.setHex(0xe0f2fe);
                this.ambientLight.intensity = 0.35;
            }
            if (this.hemiLight) {
                this.hemiLight.color.setHex(0xbae6fd);
                this.hemiLight.groundColor.setHex(0x334155);
                this.hemiLight.intensity = 0.35;
            }

            skyTopColor = 0x0284c7;
            skyHorizonColor = 0x7dd3fc;
            skyGroundColor = 0x1e293b;
            sunColorHex = 0xffffff;
            glowColorHex = 0xfef08a;
            sunGlow = 1.0;
            starIntensity = 0.0;

            const westTint = 0x38bdf8;
            const westOpacity = 0.36;
            this.westShoreMeshes.forEach((m, idx) => {
                if (m && m.color) m.color.setHex(westTint);
                if (m) m.opacity = idx === 0 ? westOpacity : westOpacity * 0.72;
            });
        } else if (phase === 'dusk') {
            // Dusk / Twilight mode
            if (this.scene && this.scene.background && this.scene.background.setHex) this.scene.background.setHex(0x0c0a2a);
            if (this.scene && this.scene.fog && this.scene.fog.color) {
                this.scene.fog.color.setHex(0x1e1b4b);
                this.scene.fog.density = 0.0025;
            }

            sunPos.set(-260, -15, -20);
            if (this.sunLight) {
                this.sunLight.position.copy(sunPos);
                this.sunLight.color.setHex(0x818cf8);
                this.sunLight.intensity = 0.30;
            }
            if (this.ambientLight) {
                this.ambientLight.color.setHex(0x4338ca);
                this.ambientLight.intensity = 0.38;
            }
            if (this.hemiLight) {
                this.hemiLight.color.setHex(0x6366f1);
                this.hemiLight.groundColor.setHex(0x0f172a);
                this.hemiLight.intensity = 0.25;
            }

            skyTopColor = 0x0c0a2a;
            skyHorizonColor = 0x1e1b4b;
            skyGroundColor = 0x070b16;
            sunColorHex = 0x818cf8;
            glowColorHex = 0x4338ca;
            sunGlow = 0.2;
            starIntensity = 0.55;

            const westTint = 0x312e81;
            const westOpacity = 0.30;
            this.westShoreMeshes.forEach((m, idx) => {
                if (m && m.color) m.color.setHex(westTint);
                if (m) m.opacity = idx === 0 ? westOpacity : westOpacity * 0.72;
            });
        } else {
            // Night mode
            if (this.scene && this.scene.background && this.scene.background.setHex) this.scene.background.setHex(0x050811);
            if (this.scene && this.scene.fog && this.scene.fog.color) {
                this.scene.fog.color.setHex(0x070b16);
                this.scene.fog.density = 0.0028;
            }

            sunPos.set(-140, -40, -40);
            if (this.sunLight) {
                this.sunLight.position.copy(sunPos);
                this.sunLight.color.setHex(0x38bdf8);
                this.sunLight.intensity = 0.18;
            }
            if (this.ambientLight) {
                this.ambientLight.color.setHex(0x1e293b);
                this.ambientLight.intensity = 0.28;
            }
            if (this.hemiLight) {
                this.hemiLight.color.setHex(0x38bdf8);
                this.hemiLight.groundColor.setHex(0x020617);
                this.hemiLight.intensity = 0.20;
            }

            skyTopColor = 0x050811;
            skyHorizonColor = 0x070b16;
            skyGroundColor = 0x020617;
            sunColorHex = 0x38bdf8;
            glowColorHex = 0x1e293b;
            sunGlow = 0.0;
            starIntensity = 0.85;

            const westTint = 0x0f172a;
            const westOpacity = 0.35;
            this.westShoreMeshes.forEach((m, idx) => {
                if (m && m.color) m.color.setHex(westTint);
                if (m) m.opacity = idx === 0 ? westOpacity : westOpacity * 0.72;
            });
        }

        // Only turn on street lights when sun sets (sunset, dusk, night)
        const lightsOn = (phase === 'sunset' || phase === 'dusk' || phase === 'night');
        this.setStreetLights(lightsOn);

        if (this.sunMesh) {
            this.sunMesh.visible = false;
        }

        if (this.skyDomeMesh && this.skyDomeMesh.material) {
            if (this.skyDomeMesh.material.uniforms) {
                const u = this.skyDomeMesh.material.uniforms;
                u.sunPosition.value.copy(sunPos);
                u.topColor.value.setHex(skyTopColor);
                u.horizonColor.value.setHex(skyHorizonColor);
                u.groundColor.value.setHex(skyGroundColor);
                u.sunColor.value.setHex(sunColorHex);
                u.sunsetGlowColor.value.setHex(glowColorHex);
                u.sunGlowIntensity.value = sunGlow;
                u.isDawn.value = (phase === 'dawn') ? 1.0 : 0.0;
                u.starIntensity.value = starIntensity;
                this.currentTimePhase = phase;
            } else if (this.currentTimePhase !== phase) {
                if (this.skyDomeMesh.material.map) this.skyDomeMesh.material.map.dispose();
                this.skyDomeMesh.material.map = TextureFactory.createSkyDomeTexture(phase);
                this.skyDomeMesh.material.needsUpdate = true;
                this.currentTimePhase = phase;
            }
        }
    },

    updateVladivostokClockAndTimeOfDay() {
        const vvo = getVladivostokTime();
        this.applyTimeOfDay(vvo.decimalHour, vvo.timeString);
    },

    cycleWeather() {
        const phases = ['dawn', 'day', 'sunset', 'dusk', 'night'];
        const currentIdx = phases.indexOf(this.currentTimePhase);
        const nextPhase = phases[(currentIdx + 1) % phases.length];
        this.applyTimeOfDay(nextPhase);
    },

    cycleCameraMode() {
        GAME_STATE.cameraMode = (GAME_STATE.cameraMode + 1) % GAME_STATE.cameraModes.length;
        const mode = GAME_STATE.cameraModes[GAME_STATE.cameraMode];
        GAME_STATE.cameraDistance = mode.dist;
        document.getElementById('cam-mode-label').textContent = `Камера: ${mode.name}`;
        showToast(`🎥 Ракурс камеры: ${mode.name}`, 'sky');
    },

    toggleCarHeadlights() {
        if (!GAME_STATE.inVehicle) return;
        GAME_STATE.headlightsOn = !GAME_STATE.headlightsOn;
        const car = GAME_STATE.inVehicle;
        if (car.headBeam) {
            car.headBeam.intensity = GAME_STATE.headlightsOn ? 1.8 : 0;
        }
        SoundManager.playActionSound('car');
        showToast(GAME_STATE.headlightsOn ? '💡 Фары JDM включены' : '🌑 Фары выключены', 'amber');
    },

    animateEnvironment(time, dt, playerPos) {
        if (!this.forcedPhase && (!this.lastClockUpdateTime || performance.now() - this.lastClockUpdateTime > 1000)) {
            this.lastClockUpdateTime = performance.now();
            this.updateVladivostokClockAndTimeOfDay();
        }

        if (this.fountainParticles) {
            const posAttr = this.fountainParticles.geometry.attributes.position;
            const vels = this.fountainParticles.userData.velocities;
            for (let i = 0; i < vels.length; i++) {
                let px = posAttr.getX(i);
                let py = posAttr.getY(i);
                let pz = posAttr.getZ(i);

                px += vels[i].vx * (dt * 60);
                py += vels[i].vy * (dt * 60);
                pz += vels[i].vz * (dt * 60);
                vels[i].vy -= 0.0052 * (dt * 60);

                if (py < 0.85) {
                    const angle = Math.random() * Math.PI * 2;
                    const nozzleRing = (i % 3 === 0) ? 0.35 : 1.75;
                    px = Math.cos(angle) * nozzleRing;
                    py = 1.45;
                    pz = Math.sin(angle) * nozzleRing;
                    const speedSpread = 0.035 + Math.random() * 0.055;
                    vels[i].vx = Math.cos(angle) * speedSpread;
                    vels[i].vy = 0.14 + Math.random() * 0.13 + Math.sin(time * 2.5) * 0.03;
                    vels[i].vz = Math.sin(angle) * speedSpread;
                }

                posAttr.setXYZ(i, px, py, pz);
            }
            posAttr.needsUpdate = true;
        }

        if (this.ferrisWheelGroup) {
            this.ferrisWheelGroup.rotation.z += dt * 0.22;
        }

        if (this.driftSmokeParticles) {
            const posAttr = this.driftSmokeParticles.geometry.attributes.position;
            const pool = this.driftSmokeParticles.userData.pool;
            for (let i = 0; i < pool.length; i++) {
                if (pool[i].life > 0) {
                    pool[i].life -= dt * 1.2;
                    const sx = posAttr.getX(i) + pool[i].vx * dt;
                    const sy = posAttr.getY(i) + pool[i].vy * dt;
                    const sz = posAttr.getZ(i) + pool[i].vz * dt;
                    posAttr.setXYZ(i, sx, pool[i].life > 0 ? sy : -50, sz);
                }
            }
            posAttr.needsUpdate = true;
        }

        if (this.oceanMesh) {
            const pos = this.oceanMesh.geometry.attributes.position;
            for (let i = 0; i < pos.count; i++) {
                const vx = pos.getX(i);
                const vz = pos.getZ(i);
                const waveY = Math.sin(vx * 0.08 + time * 1.8) * 0.22 + Math.cos(vz * 0.06 + time * 1.4) * 0.18;
                pos.setY(i, waveY);
            }
            pos.needsUpdate = true;
        }

        SoundManager.updateSpatialAmbience(playerPos);

        this.seagulls.forEach((b, idx) => {
            b.angle += b.speed * dt;
            const bx = b.cx + Math.cos(b.angle) * b.radius;
            const bz = b.cz + Math.sin(b.angle) * b.radius;
            b.group.position.set(bx, b.y + Math.sin(time * 2.2 + idx) * 0.55, bz);
            const dx = -Math.sin(b.angle);
            const dz = Math.cos(b.angle);
            b.group.rotation.y = Math.atan2(dx, dz);
            const glidePhase = Math.sin(time * 0.9 + idx);
            const flap = glidePhase > -0.2 ? Math.sin(time * 8.5 + idx) * 0.48 : 0.08;
            b.leftWing.rotation.z = flap;
            b.rightWing.rotation.z = -flap;
        });

        this.distantTankers.forEach((ship, idx) => {
            ship.group.position.z += ship.dir * ship.speed * dt;
            ship.group.position.y = -1.35 + Math.sin(time * 0.9 + idx) * 0.12;
            ship.group.rotation.z = Math.sin(time * 0.7 + idx) * 0.015;
            if (ship.group.position.z > 210) ship.dir = -1;
            if (ship.group.position.z < -210) ship.dir = 1;
            ship.group.rotation.y = ship.dir > 0 ? 0 : Math.PI;
        });

        updatePromenadeNPCs({
            npcs: this.npcs,
            dt,
            playerPos,
            inVehicle: !!GAME_STATE.inVehicle,
            vehicles: this.vehicles,
            activeChatNpc: GAME_STATE.activeNpcChat
        });
    },

    updateThirdPersonCamera(dt = 0.016, player) {
        const mode = GAME_STATE.cameraModes[GAME_STATE.cameraMode];
        const targetBase = GAME_STATE.inVehicle ? GAME_STATE.inVehicle.group.position : player.position;

        if (GAME_STATE.inVehicle) {
            const car = GAME_STATE.inVehicle.group;
            const targetCarCamYaw = car.rotation.y + Math.PI;
            const yawDiff = Math.atan2(Math.sin(targetCarCamYaw - GAME_STATE.cameraYaw), Math.cos(targetCarCamYaw - GAME_STATE.cameraYaw));
            GAME_STATE.cameraYaw += yawDiff * Math.min(1, dt * 14);
            GAME_STATE.cameraPitch += (0.28 - GAME_STATE.cameraPitch) * Math.min(1, dt * 10);
        } else {
            const timeSinceMouse = performance.now() - GAME_STATE.lastMouseMoveTime;
            if (timeSinceMouse > 1000) {
                const targetWalkYaw = player.rotationY + Math.PI;
                const yawDiff = Math.atan2(Math.sin(targetWalkYaw - GAME_STATE.cameraYaw), Math.cos(targetWalkYaw - GAME_STATE.cameraYaw));
                GAME_STATE.cameraYaw += yawDiff * Math.min(1, dt * 3.2);
                GAME_STATE.cameraPitch += (DEFAULT_WALK_PITCH - GAME_STATE.cameraPitch) * Math.min(1, dt * 3.5);
            }
        }

        if (GAME_STATE.cameraMode === 3) {
            player.group.visible = false;
            if (GAME_STATE.inVehicle) {
                const car = GAME_STATE.inVehicle.group;
                const seatOffset = new THREE.Vector3(-0.45, 1.38, 0.15).applyAxisAngle(new THREE.Vector3(0, 1, 0), car.rotation.y);
                const camPos = car.position.clone().add(seatOffset);
                this.camera.position.copy(camPos);
                const forwardDir = new THREE.Vector3(Math.sin(car.rotation.y), -0.04, Math.cos(car.rotation.y));
                this.camera.lookAt(camPos.clone().add(forwardDir.multiplyScalar(25)));
            } else {
                const eyePos = new THREE.Vector3(targetBase.x, targetBase.y + 2.35, targetBase.z);
                this.camera.position.copy(eyePos);
                const lookDir = new THREE.Vector3(
                    -Math.sin(GAME_STATE.cameraYaw) * Math.cos(GAME_STATE.cameraPitch),
                    -Math.sin(GAME_STATE.cameraPitch - 0.25),
                    -Math.cos(GAME_STATE.cameraYaw) * Math.cos(GAME_STATE.cameraPitch)
                );
                this.camera.lookAt(eyePos.clone().add(lookDir.multiplyScalar(20)));
            }
            return;
        }

        const dist = GAME_STATE.inVehicle ? GAME_STATE.cameraDistance * 1.25 : GAME_STATE.cameraDistance;

        const lookTarget = new THREE.Vector3(
            targetBase.x,
            targetBase.y + (GAME_STATE.inVehicle ? 1.45 : mode.heightOffset),
            targetBase.z
        );

        const horizDist = dist * Math.cos(GAME_STATE.cameraPitch);
        const vertDist = dist * Math.sin(GAME_STATE.cameraPitch);

        const camX = lookTarget.x + Math.sin(GAME_STATE.cameraYaw) * horizDist;
        const camZ = lookTarget.z + Math.cos(GAME_STATE.cameraYaw) * horizDist;
        const camY = Math.max(0.8, lookTarget.y + vertDist);

        this.camera.position.lerp(new THREE.Vector3(camX, camY, camZ), GAME_STATE.inVehicle ? 0.35 : 0.22);
        this.camera.lookAt(lookTarget);
    }
};

export function getVladivostokTime(date = new Date()) {
    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Vladivostok',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            hour12: false
        });
        const parts = formatter.formatToParts(date);
        let hours = 0, minutes = 0, seconds = 0;
        for (const p of parts) {
            if (p.type === 'hour') hours = parseInt(p.value, 10);
            if (p.type === 'minute') minutes = parseInt(p.value, 10);
            if (p.type === 'second') seconds = parseInt(p.value, 10);
        }
        if (hours === 24) hours = 0;
        const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        const decimalHour = hours + minutes / 60 + seconds / 3600;
        return { hours, minutes, seconds, timeString, decimalHour };
    } catch (e) {
        const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
        const vvoDate = new Date(utc + (10 * 3600000));
        const hours = vvoDate.getHours();
        const minutes = vvoDate.getMinutes();
        const seconds = vvoDate.getSeconds();
        const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        const decimalHour = hours + minutes / 60 + seconds / 3600;
        return { hours, minutes, seconds, timeString, decimalHour };
    }
}

export function getTimeOfDayPhase(decimalHour) {
    if (decimalHour >= 5.0 && decimalHour < 7.5) {
        return 'dawn';
    } else if (decimalHour >= 7.5 && decimalHour < 17.5) {
        return 'day';
    } else if (decimalHour >= 17.5 && decimalHour < 20.5) {
        return 'sunset';
    } else if (decimalHour >= 20.5 && decimalHour < 22.0) {
        return 'dusk';
    } else {
        return 'night';
    }
}
