import { GAME_STATE, DEFAULT_WALK_PITCH } from './state.js';
import { PhysicsEngine } from './physics.js';
import { TextureFactory } from './textures.js';
import { SoundManager } from './audio.js';
import { completePOI, triggerPlayerSpeech, showToast } from './ui.js';
import { updatePromenadeNPCs } from './entities.js';

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

        this.ambientLight = new THREE.AmbientLight(0xffedd5, 0.65);
        this.scene.add(this.ambientLight);

        this.hemiLight = new THREE.HemisphereLight(0x7dd3fc, 0x1e293b, 0.45);
        this.scene.add(this.hemiLight);

        this.sunLight = new THREE.DirectionalLight(0xff9e5e, 1.35);
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
        PhysicsEngine.clear();
        if (worldMap && Array.isArray(worldMap.staticColliders)) {
            PhysicsEngine.loadFromConfig(worldMap.staticColliders);
        }

        // 1. Amur Bay Ocean
        const oceanGeo = new THREE.PlaneGeometry(320, 440, 48, 48);
        oceanGeo.rotateX(-Math.PI / 2);
        const oceanMat = new THREE.MeshStandardMaterial({
            color: 0x0369a1,
            roughness: 0.22,
            metalness: 0.75,
            flatShading: true
        });
        this.oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
        this.oceanMesh.position.set(-178, -1.6, 0);
        this.oceanMesh.receiveShadow = true;
        this.scene.add(this.oceanMesh);

        // 2. Sandy & Pebble Beach
        const beachGeo = new THREE.BoxGeometry(14, 1.2, 340);
        const beachMat = new THREE.MeshStandardMaterial({ color: 0x94826a, roughness: 0.9 });
        const beachMesh = new THREE.Mesh(beachGeo, beachMat);
        beachMesh.position.set(-22, -1.1, 0);
        beachMesh.receiveShadow = true;
        this.scene.add(beachMesh);

        for (let i = 0; i < 4; i++) {
            const stepGeo = new THREE.BoxGeometry(1.4, 0.4, 260);
            const stepMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.75 });
            const step = new THREE.Mesh(stepGeo, stepMat);
            step.position.set(-15.5 - i * 1.3, -0.15 - i * 0.3, 0);
            step.receiveShadow = true;
            this.scene.add(step);
        }

        // 3. Main Tiled Promenade
        const promTex = TextureFactory.createPromenadeTileTexture();
        const promGeo = new THREE.BoxGeometry(30, 1.0, 340);
        const promMat = new THREE.MeshStandardMaterial({ map: promTex, roughness: 0.65 });
        const promMesh = new THREE.Mesh(promGeo, promMat);
        promMesh.position.set(0, -0.5, 0);
        promMesh.receiveShadow = true;
        this.scene.add(promMesh);

        // 4. Eastern Asphalt Roadway
        const roadGeo = new THREE.BoxGeometry(16, 0.95, 340);
        const roadMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.85 });
        const roadMesh = new THREE.Mesh(roadGeo, roadMat);
        roadMesh.position.set(23, -0.5, 0);
        roadMesh.receiveShadow = true;
        this.scene.add(roadMesh);

        for (let z = -150; z <= 150; z += 12) {
            const lineGeo = new THREE.PlaneGeometry(0.35, 5);
            lineGeo.rotateX(-Math.PI / 2);
            const lineMat = new THREE.MeshBasicMaterial({ color: 0xf8fafc });
            const line = new THREE.Mesh(lineGeo, lineMat);
            line.position.set(23, 0.02, z);
            this.scene.add(line);
        }

        const eastWalkGeo = new THREE.BoxGeometry(45, 1.1, 340);
        const eastWalkMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.85 });
        const eastWalk = new THREE.Mesh(eastWalkGeo, eastWalkMat);
        eastWalk.position.set(53, -0.5, 0);
        eastWalk.receiveShadow = true;
        this.scene.add(eastWalk);

        this.buildSeasideBalustrade();
        this.buildCentralFountain(0, 0);
        this.buildBronzeTigerStatue(-10, -32);
        this.buildStreetFoodRow(worldMap ? worldMap.stalls : []);
        this.buildPierAndYachts(worldMap ? worldMap.sailboats : []);
        this.buildFerrisWheel(-4, -88);
        this.buildDynamoStadium(38, -45);
        this.buildOceanCinema(38, 92);
        this.buildPromenadeProps();
        this.buildOceanarium(6, -118);
        this.buildGoogleMapsAuthenticPOIs();
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

    buildCentralFountain(x, z) {
        const group = new THREE.Group();
        group.position.set(x, 0, z);

        const outerRim = new THREE.Mesh(
            new THREE.CylinderGeometry(9.5, 10.2, 1.1, 32),
            new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.4 })
        );
        outerRim.position.y = 0.55;
        outerRim.castShadow = true;
        outerRim.receiveShadow = true;
        group.add(outerRim);

        const poolWater = new THREE.Mesh(
            new THREE.CylinderGeometry(8.8, 8.8, 0.95, 32),
            new THREE.MeshStandardMaterial({ color: 0x0ea5e9, emissive: 0x0284c7, emissiveIntensity: 0.45, roughness: 0.15 })
        );
        poolWater.position.y = 0.62;
        group.add(poolWater);

        const centerTier = new THREE.Mesh(
            new THREE.CylinderGeometry(2.5, 3.2, 1.8, 20),
            new THREE.MeshStandardMaterial({ color: 0xcbd5e1, metalness: 0.5, roughness: 0.3 })
        );
        centerTier.position.y = 1.1;
        group.add(centerTier);

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
        this.fountainParticles.userData.velocities = velocities;
        group.add(this.fountainParticles);

        this.scene.add(group);
    },

    buildBronzeTigerStatue(x, z) {
        const group = new THREE.Group();
        group.position.set(x, 0, z);

        const ped = new THREE.Mesh(
            new THREE.BoxGeometry(3.6, 1.1, 2.4),
            new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.7 })
        );
        ped.position.y = 0.55;
        ped.castShadow = true;
        group.add(ped);

        const bronzeMat = new THREE.MeshStandardMaterial({
            color: 0xb45309,
            metalness: 0.85,
            roughness: 0.28
        });

        const body = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.85, 0.85), bronzeMat);
        body.position.set(0, 1.65, 0);
        body.castShadow = true;
        group.add(body);

        const head = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.7, 0.75), bronzeMat);
        head.position.set(-1.15, 2.0, 0);
        group.add(head);

        [[-0.75, 0.3], [-0.75, -0.3], [0.75, 0.3], [0.75, -0.3]].forEach(([lx, lz]) => {
            const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.8, 0.3), bronzeMat);
            leg.position.set(lx, 1.25, lz);
            group.add(leg);
        });

        const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 1.3), bronzeMat);
        tail.rotation.z = -0.8;
        tail.position.set(1.35, 1.55, 0);
        group.add(tail);

        this.scene.add(group);
    },

    buildStreetFoodRow(stalls = []) {
        stalls.forEach(s => {
            const group = new THREE.Group();
            group.position.set(s.x, 0, s.z);

            const booth = new THREE.Mesh(
                new THREE.BoxGeometry(4.4, 3.4, 6.2),
                new THREE.MeshStandardMaterial({ color: s.bodyColor, roughness: 0.5 })
            );
            booth.position.y = 1.7;
            booth.castShadow = true;
            booth.receiveShadow = true;
            group.add(booth);

            const win = new THREE.Mesh(
                new THREE.PlaneGeometry(4.2, 1.5),
                new THREE.MeshBasicMaterial({ color: 0xfef3c7 })
            );
            win.rotation.y = -Math.PI / 2;
            win.position.set(-2.22, 1.85, 0);
            group.add(win);

            const signTex = TextureFactory.createSignTexture(s.title, s.sub, s.bg, s.accent);
            const signBoard = new THREE.Mesh(
                new THREE.BoxGeometry(0.4, 1.5, 5.8),
                new THREE.MeshBasicMaterial({ map: signTex })
            );
            signBoard.position.set(-2.1, 4.15, 0);
            group.add(signBoard);

            this.scene.add(group);

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
        const pierGeo = new THREE.BoxGeometry(36, 0.6, 7);
        const pierMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.8 });
        const pier = new THREE.Mesh(pierGeo, pierMat);
        pier.position.set(-32, 0.1, 48);
        pier.receiveShadow = true;
        this.scene.add(pier);

        boatPositions.forEach(([bx, bz], idx) => {
            const boat = new THREE.Group();
            boat.position.set(bx, -1.1, bz);

            const hull = new THREE.Mesh(
                new THREE.BoxGeometry(7.5, 1.4, 2.8),
                new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.3 })
            );
            boat.add(hull);

            const mast = new THREE.Mesh(
                new THREE.CylinderGeometry(0.1, 0.12, 11),
                new THREE.MeshStandardMaterial({ color: 0xe2e8f0 })
            );
            mast.position.y = 5.5;
            boat.add(mast);

            const sail = new THREE.Mesh(
                new THREE.PlaneGeometry(4.5, 8.5),
                new THREE.MeshStandardMaterial({ color: idx % 2 === 0 ? 0xffffff : 0x38bdf8, side: THREE.DoubleSide })
            );
            sail.position.set(1.2, 5.5, 0);
            boat.add(sail);

            this.scene.add(boat);
        });
    },

    buildFerrisWheel(x, z) {
        const supportGroup = new THREE.Group();
        supportGroup.position.set(x, 0, z);

        const legMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.6, roughness: 0.3 });
        [-2.2, 2.2].forEach(lz => {
            const legA = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 22), legMat);
            legA.position.set(-4, 10, lz);
            legA.rotation.z = -0.22;
            supportGroup.add(legA);

            const legB = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 22), legMat);
            legB.position.set(4, 10, lz);
            legB.rotation.z = 0.22;
            supportGroup.add(legB);
        });

        this.ferrisWheelGroup = new THREE.Group();
        this.ferrisWheelGroup.position.set(0, 19.5, 0);

        const rim = new THREE.Mesh(
            new THREE.TorusGeometry(13.5, 0.35, 12, 36),
            new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0284c7, emissiveIntensity: 0.6 })
        );
        this.ferrisWheelGroup.add(rim);

        const cabinColors = [0xf43f5e, 0xf59e0b, 0x10b981, 0x3b82f6, 0xa855f7];
        for (let i = 0; i < 12; i++) {
            const angle = (i / 12) * Math.PI * 2;
            const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 27), legMat);
            spoke.rotation.z = angle;
            this.ferrisWheelGroup.add(spoke);

            const cabin = new THREE.Mesh(
                new THREE.BoxGeometry(1.8, 1.8, 1.8),
                new THREE.MeshStandardMaterial({ color: cabinColors[i % cabinColors.length], roughness: 0.3 })
            );
            cabin.position.set(Math.cos(angle) * 13.5, Math.sin(angle) * 13.5, 0);
            this.ferrisWheelGroup.add(cabin);
        }

        supportGroup.add(this.ferrisWheelGroup);
        this.scene.add(supportGroup);
    },

    buildDynamoStadium(x, z) {
        const group = new THREE.Group();
        group.position.set(x, 0, z);

        const tex = TextureFactory.createBuildingFacadeTexture('#1e3a8a', '#93c5fd', 8, 4);
        const mainStand = new THREE.Mesh(
            new THREE.BoxGeometry(16, 13, 56),
            new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 })
        );
        mainStand.position.y = 6.5;
        mainStand.castShadow = true;
        group.add(mainStand);

        const signTex = TextureFactory.createSignTexture('ДИНАМО', 'СТАДИОН • ВЛАДИВОСТОК', '#172554', '#60a5fa');
        const sign = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 3.2, 16),
            new THREE.MeshBasicMaterial({ map: signTex })
        );
        sign.position.set(-8.2, 11.5, 0);
        group.add(sign);

        this.scene.add(group);
        this.registerWorldLabel('🏟️ Стадион «Динамо» (Фокина, 1 • ★ 4.1)', x - 8, 14.5, z);
    },

    buildOceanCinema(x, z) {
        const group = new THREE.Group();
        group.position.set(x, 0, z);

        const base = new THREE.Mesh(
            new THREE.BoxGeometry(20, 6, 28),
            new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.6 })
        );
        base.position.y = 3;
        group.add(base);

        const rotundaTex = TextureFactory.createBuildingFacadeTexture('#0f172a', '#38bdf8', 12, 5);
        const rotunda = new THREE.Mesh(
            new THREE.CylinderGeometry(11, 11, 12, 28),
            new THREE.MeshStandardMaterial({ map: rotundaTex, roughness: 0.35, metalness: 0.4 })
        );
        rotunda.position.y = 11;
        group.add(rotunda);

        const signTex = TextureFactory.createSignTexture('ОКЕАН', 'КИНОТЕАТР IMAX • НАБКА', '#0284c7', '#ffffff');
        const sign = new THREE.Mesh(
            new THREE.BoxGeometry(0.6, 3.0, 14),
            new THREE.MeshBasicMaterial({ map: signTex })
        );
        sign.position.set(-11.2, 15.8, 0);
        group.add(sign);

        this.scene.add(group);
        this.registerWorldLabel('🎬 К/Т «Океан IMAX» (Набережная, 3 • ★ 4.7)', x - 10, 18.5, z);
    },

    buildPromenadeProps() {
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.7 });
        const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfde68a });

        for (let z = -120; z <= 120; z += 24) {
            const lamp = new THREE.Group();
            lamp.position.set(-12, 0, z);

            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 5.2), poleMat);
            pole.position.y = 2.6;
            lamp.add(pole);

            const globe = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 10), bulbMat);
            globe.position.y = 5.3;
            lamp.add(globe);

            this.scene.add(lamp);

            if (Math.abs(z) > 14) {
                const bench = new THREE.Mesh(
                    new THREE.BoxGeometry(0.9, 0.65, 2.6),
                    new THREE.MeshStandardMaterial({ color: 0x92400e })
                );
                bench.position.set(-11.2, 0.325, z + 6);
                this.scene.add(bench);
                PhysicsEngine.addBoxCollider(-11.2, z + 6, 1.0, 2.7, 0.65, true, 'Лавочка');
            }
        }
    },

    buildOceanarium(x, z) {
        const group = new THREE.Group();
        group.position.set(x, 0, z);

        const baseCyl = new THREE.Mesh(
            new THREE.CylinderGeometry(11.5, 12, 5.5, 28),
            new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 })
        );
        baseCyl.position.y = 2.75;
        baseCyl.castShadow = true;
        group.add(baseCyl);

        const dome = new THREE.Mesh(
            new THREE.SphereGeometry(11.4, 28, 16, 0, Math.PI * 2, 0, Math.PI / 2),
            new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.25, metalness: 0.35 })
        );
        dome.position.y = 5.4;
        group.add(dome);

        const signTex = TextureFactory.createSignTexture('ОКЕАНАРИУМ', 'УЛ. БАТАРЕЙНАЯ • НАБКА', '#0c4a6e', '#38bdf8');
        const sign = new THREE.Mesh(
            new THREE.BoxGeometry(12, 2.6, 0.5),
            new THREE.MeshBasicMaterial({ map: signTex })
        );
        sign.position.set(0, 6.5, 11.8);
        group.add(sign);

        this.scene.add(group);
    },

    buildGoogleMapsAuthenticPOIs() {
        const arbatPaving = new THREE.Mesh(
            new THREE.BoxGeometry(28, 0.12, 14),
            new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.6 })
        );
        arbatPaving.position.set(36, 0.06, 2);
        this.scene.add(arbatPaving);
        this.registerWorldLabel('🚶 Ул. Адмирала Фокина (Арбат)', 34, 4.5, 2);

        // Supra Restaurant
        const supraGroup = new THREE.Group();
        supraGroup.position.set(36, 0, 16);

        const supraTex = TextureFactory.createBuildingFacadeTexture('#7c2d12', '#fde68a', 5, 3);
        const supraBuilding = new THREE.Mesh(
            new THREE.BoxGeometry(11, 7.5, 13),
            new THREE.MeshStandardMaterial({ map: supraTex, roughness: 0.55 })
        );
        supraBuilding.position.y = 3.75;
        supraBuilding.castShadow = true;
        supraGroup.add(supraBuilding);

        const supraSignTex = TextureFactory.createSignTexture('СУПРА', 'ФОКИНА, 1Б • ГРУЗИНСКИЙ ДОМ', '#451a03', '#fbbf24');
        const supraSign = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 2.4, 10.5),
            new THREE.MeshBasicMaterial({ map: supraSignTex })
        );
        supraSign.position.set(-5.6, 6.2, 0);
        supraGroup.add(supraSign);

        const terrace = new THREE.Mesh(
            new THREE.BoxGeometry(3.2, 0.75, 11),
            new THREE.MeshStandardMaterial({ color: 0x78350f })
        );
        terrace.position.set(-7.1, 0.375, 0);
        supraGroup.add(terrace);
        this.scene.add(supraGroup);

        // Vladivostok Fortress Museum
        const fortGroup = new THREE.Group();
        fortGroup.position.set(35, 0, -92);

        const parapet = new THREE.Mesh(
            new THREE.BoxGeometry(9, 1.25, 22),
            new THREE.MeshStandardMaterial({ color: 0x7f1d1d, roughness: 0.85 })
        );
        parapet.position.y = 0.625;
        parapet.castShadow = true;
        fortGroup.add(parapet);

        const bunker = new THREE.Mesh(
            new THREE.BoxGeometry(10, 5.5, 16),
            new THREE.MeshStandardMaterial({ color: 0x991b1b, roughness: 0.8 })
        );
        bunker.position.set(6, 2.75, 0);
        fortGroup.add(bunker);

        const cannonMat = new THREE.MeshStandardMaterial({ color: 0x14532d, metalness: 0.6, roughness: 0.4 });
        [-5, 5].forEach(cz => {
            const mount = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.9, 1.8), cannonMat);
            mount.position.set(-1.5, 1.7, cz);
            fortGroup.add(mount);

            const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.26, 4.6), cannonMat);
            barrel.rotation.z = Math.PI / 2.2;
            barrel.position.set(-3.2, 2.2, cz);
            fortGroup.add(barrel);
        });

        const fortSignTex = TextureFactory.createSignTexture('КРЕПОСТЬ', 'МУЗЕЙ • БАТАРЕЙНАЯ, 4А', '#450a0a', '#fca5a5');
        const fortSign = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 2.2, 11),
            new THREE.MeshBasicMaterial({ map: fortSignTex })
        );
        fortSign.position.set(0.8, 6.2, 0);
        fortGroup.add(fortSign);
        this.scene.add(fortGroup);

        // SC Olympiets
        const olympGroup = new THREE.Group();
        olympGroup.position.set(38, 0, -134);

        const olympTex = TextureFactory.createBuildingFacadeTexture('#0f172a', '#38bdf8', 8, 4);
        const olympHall = new THREE.Mesh(
            new THREE.BoxGeometry(18, 11, 28),
            new THREE.MeshStandardMaterial({ map: olympTex, roughness: 0.5 })
        );
        olympHall.position.y = 5.5;
        olympHall.castShadow = true;
        olympGroup.add(olympHall);

        const olympSignTex = TextureFactory.createSignTexture('СК ОЛИМПИЕЦ', 'БАТАРЕЙНАЯ, 2 • СПОРТКОМПЛЕКС', '#0369a1', '#fde047');
        const olympSign = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 2.8, 15),
            new THREE.MeshBasicMaterial({ map: olympSignTex })
        );
        olympSign.position.set(-9.2, 9.8, 0);
        olympGroup.add(olympSign);
        this.scene.add(olympGroup);

        // AZIMUT Hotel
        const azimutGroup = new THREE.Group();
        azimutGroup.position.set(42, 0, 130);

        const azimutTex = TextureFactory.createBuildingFacadeTexture('#cbd5e1', '#fef08a', 10, 10);
        const azimutTower = new THREE.Mesh(
            new THREE.BoxGeometry(14, 28, 30),
            new THREE.MeshStandardMaterial({ map: azimutTex, roughness: 0.45 })
        );
        azimutTower.position.y = 14;
        azimutTower.castShadow = true;
        azimutGroup.add(azimutTower);

        const azimutSignTex = TextureFactory.createSignTexture('AZIMUT ОТЕЛЬ', 'УЛ. НАБЕРЕЖНАЯ, 10 • ВЛАДИВОСТОК', '#991b1b', '#ffffff');
        const azimutSign = new THREE.Mesh(
            new THREE.BoxGeometry(0.6, 3.2, 16),
            new THREE.MeshBasicMaterial({ map: azimutSignTex })
        );
        azimutSign.position.set(-7.2, 26.2, 0);
        azimutGroup.add(azimutSign);
        this.scene.add(azimutGroup);

        // Seven Feet Yacht Club
        const marinaPier = new THREE.Mesh(
            new THREE.BoxGeometry(30, 0.7, 8),
            new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.7 })
        );
        marinaPier.position.set(-28, 0.15, 118);
        this.scene.add(marinaPier);

        const clubBoathouse = new THREE.Mesh(
            new THREE.BoxGeometry(7, 4.5, 9),
            new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.4 })
        );
        clubBoathouse.position.set(-10, 2.25, 118);
        this.scene.add(clubBoathouse);
    },

    buildVladivostokSopkiAndBayHorizon(worldMap) {
        const sopkaGreenMat = new THREE.MeshStandardMaterial({
            color: 0x15803d,
            roughness: 0.88,
            flatShading: true
        });
        const sopkaDarkForestMat = new THREE.MeshStandardMaterial({
            color: 0x166534,
            roughness: 0.92,
            flatShading: true
        });
        const cliffRockMat = new THREE.MeshStandardMaterial({
            color: 0x475569,
            roughness: 0.85,
            flatShading: true
        });

        const createGreenSopka = (x, z, radius, height, addCollider = true, label = '') => {
            const hillGroup = new THREE.Group();
            hillGroup.position.set(x, -0.5, z);

            const cone = new THREE.Mesh(
                new THREE.ConeGeometry(radius, height, 14, 3),
                sopkaGreenMat
            );
            cone.position.y = height / 2;
            cone.castShadow = true;
            cone.receiveShadow = true;
            hillGroup.add(cone);

            const shoulder = new THREE.Mesh(
                new THREE.DodecahedronGeometry(radius * 0.68, 1),
                sopkaDarkForestMat
            );
            shoulder.scale.set(1.15, (height * 0.55) / (radius * 0.68), 1.1);
            shoulder.position.set(-radius * 0.22, height * 0.28, radius * 0.15);
            hillGroup.add(shoulder);

            const cliff = new THREE.Mesh(
                new THREE.CylinderGeometry(radius * 0.82, radius * 0.98, Math.min(7, height * 0.22), 12),
                cliffRockMat
            );
            cliff.position.y = Math.min(3.5, height * 0.11);
            hillGroup.add(cliff);

            const treeCount = Math.min(28, Math.floor(radius * 0.55));
            for (let t = 0; t < treeCount; t++) {
                const angle = (t / treeCount) * Math.PI * 2 + (t * 1.7);
                const distFrac = 0.28 + (t % 5) * 0.13;
                const r = radius * distFrac;
                const tx = Math.cos(angle) * r;
                const tz = Math.sin(angle) * r;
                const ty = Math.max(1.5, height * (1 - distFrac * 0.92) - 1.5);

                const foliage = new THREE.Mesh(
                    new THREE.ConeGeometry(2.1 + (t % 3) * 0.6, 5.5 + (t % 3) * 1.4, 7),
                    sopkaDarkForestMat
                );
                foliage.position.set(tx, ty, tz);
                hillGroup.add(foliage);
            }

            this.scene.add(hillGroup);

            if (addCollider) {
                PhysicsEngine.addCircleCollider(x, z, radius * 0.78, height, false, label || 'Сопка Владивостока');
            }
            if (label) {
                this.registerWorldLabel(label, x, height + 3, z);
            }
        };

        const hills = (worldMap && worldMap.hills) || {};
        (hills.east || []).forEach(h => createGreenSopka(h.x, h.z, h.r, h.h, true, h.label));
        (hills.north || []).forEach(h => createGreenSopka(h.x, h.z, h.r, h.h, true, h.label));
        (hills.south || []).forEach(h => createGreenSopka(h.x, h.z, h.r, h.h, true, h.label));

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
        tankerSpecs.forEach(spec => {
            const ship = new THREE.Group();
            ship.position.set(spec.x, -1.35, spec.z);
            ship.scale.setScalar(spec.scale);

            const hull = new THREE.Mesh(
                new THREE.BoxGeometry(6.8, 2.6, 34),
                new THREE.MeshStandardMaterial({ color: spec.hullColor, roughness: 0.6 })
            );
            hull.position.y = 1.1;
            ship.add(hull);

            const waterline = new THREE.Mesh(
                new THREE.BoxGeometry(7.0, 0.8, 34.2),
                new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.7 })
            );
            waterline.position.y = 0.25;
            ship.add(waterline);

            const deckPipe = new THREE.Mesh(
                new THREE.CylinderGeometry(0.35, 0.35, 22),
                new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.5 })
            );
            deckPipe.rotation.x = Math.PI / 2;
            deckPipe.position.set(0, 2.65, 2);
            ship.add(deckPipe);

            const bridge = new THREE.Mesh(
                new THREE.BoxGeometry(5.6, 5.2, 6.2),
                new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 })
            );
            bridge.position.set(0, 4.8, -11.5);
            ship.add(bridge);

            const funnel = new THREE.Mesh(
                new THREE.CylinderGeometry(0.85, 1.05, 3.2, 12),
                new THREE.MeshStandardMaterial({ color: 0xea580c })
            );
            funnel.position.set(0, 8.2, -12.5);
            ship.add(funnel);

            const navLight = new THREE.Mesh(
                new THREE.SphereGeometry(0.45, 8, 8),
                new THREE.MeshBasicMaterial({ color: 0xfef08a, fog: false })
            );
            navLight.position.set(0, 9.8, -11.0);
            ship.add(navLight);

            const bowLight = new THREE.Mesh(
                new THREE.SphereGeometry(0.38, 8, 8),
                new THREE.MeshBasicMaterial({ color: 0x38bdf8, fog: false })
            );
            bowLight.position.set(0, 4.2, 15.5);
            ship.add(bowLight);

            ship.rotation.y = spec.dir > 0 ? 0 : Math.PI;
            this.scene.add(ship);

            this.distantTankers.push({
                group: ship,
                speed: spec.speed,
                dir: spec.dir,
                baseX: spec.x
            });
        });

        // Tokarevsky Lighthouse
        const lighthouseGroup = new THREE.Group();
        lighthouseGroup.position.set(-105, -1.2, 125);

        const spit = new THREE.Mesh(
            new THREE.BoxGeometry(55, 1.2, 6),
            new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.9 })
        );
        spit.position.set(22, 0.2, 0);
        lighthouseGroup.add(spit);

        const tower = new THREE.Mesh(
            new THREE.CylinderGeometry(1.4, 2.2, 14, 16),
            new THREE.MeshStandardMaterial({ color: 0xf8fafc })
        );
        tower.position.y = 7;
        lighthouseGroup.add(tower);

        const redTop = new THREE.Mesh(
            new THREE.CylinderGeometry(1.6, 1.6, 2.8, 16),
            new THREE.MeshStandardMaterial({ color: 0xdc2626 })
        );
        redTop.position.y = 14.8;
        lighthouseGroup.add(redTop);

        const beacon = new THREE.Mesh(
            new THREE.SphereGeometry(1.2, 12, 12),
            new THREE.MeshBasicMaterial({ color: 0xfef08a })
        );
        beacon.position.y = 16.8;
        lighthouseGroup.add(beacon);

        this.scene.add(lighthouseGroup);
        this.registerWorldLabel('🚨 Токаревский Маяк', -105, 20, 125);

        // V-shaped Cable-Stayed Bridge Pylons
        const pylonMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.4, metalness: 0.5 });
        [-35, 35].forEach(px => {
            const pylon = new THREE.Group();
            pylon.position.set(px, 0, 235);

            const legL = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.6, 68), pylonMat);
            legL.position.set(-6, 32, 0);
            legL.rotation.z = -0.14;
            pylon.add(legL);

            const legR = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.6, 68), pylonMat);
            legR.position.set(6, 32, 0);
            legR.rotation.z = 0.14;
            pylon.add(legR);

            const crossBar = new THREE.Mesh(new THREE.BoxGeometry(18, 2.2, 2.5), pylonMat);
            crossBar.position.set(0, 26, 0);
            pylon.add(crossBar);

            this.scene.add(pylon);
        });

        const bridgeDeck = new THREE.Mesh(
            new THREE.BoxGeometry(160, 1.8, 6),
            new THREE.MeshStandardMaterial({ color: 0x334155 })
        );
        bridgeDeck.position.set(0, 24, 235);
        this.scene.add(bridgeDeck);
    },

    initSeagullsAndDriftParticles() {
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
        const wingMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, side: THREE.DoubleSide, roughness: 0.45 });
        const wingTipMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, side: THREE.DoubleSide });
        const beakMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b });

        for (let i = 0; i < 26; i++) {
            const bird = new THREE.Group();

            const torso = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.2, 0.68), bodyMat);
            bird.add(torso);

            const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), bodyMat);
            head.position.set(0, 0.08, 0.36);
            bird.add(head);

            const beak = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.2, 6), beakMat);
            beak.rotation.x = Math.PI / 2;
            beak.position.set(0, 0.06, 0.50);
            bird.add(beak);

            const tail = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 0.26), wingTipMat);
            tail.position.set(0, 0.02, -0.42);
            bird.add(tail);

            const leftWingPivot = new THREE.Group();
            leftWingPivot.position.set(0.11, 0.05, 0.02);
            const leftInner = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.04, 0.28), wingMat);
            leftInner.position.x = 0.34;
            const leftTip = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.035, 0.22), wingTipMat);
            leftTip.position.x = 0.80;
            leftWingPivot.add(leftInner, leftTip);

            const rightWingPivot = new THREE.Group();
            rightWingPivot.position.set(-0.11, 0.05, 0.02);
            const rightInner = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.04, 0.28), wingMat);
            rightInner.position.x = -0.34;
            const rightTip = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.035, 0.22), wingTipMat);
            rightTip.position.x = -0.80;
            rightWingPivot.add(rightInner, rightTip);

            bird.add(leftWingPivot, rightWingPivot);
            bird.scale.setScalar(1.25);

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

        const clockEl = document.getElementById('hud-clock');
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
            this.scene.background.setHex(0x1e1b4b);
            this.scene.fog.color.setHex(0x312e81);
            this.scene.fog.density = 0.0020;

            sunPos.set(240, 32, -20);
            this.sunLight.position.copy(sunPos);
            this.sunLight.color.setHex(0xff7043);
            this.sunLight.intensity = 1.15;
            this.ambientLight.color.setHex(0xffd1b3);
            this.ambientLight.intensity = 0.55;
            if (this.hemiLight) {
                this.hemiLight.color.setHex(0xff8a65);
                this.hemiLight.groundColor.setHex(0x1e293b);
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
                m.color.setHex(westTint);
                m.opacity = idx === 0 ? westOpacity : westOpacity * 0.72;
            });
        } else if (phase === 'sunset') {
            // Sunset mode: Sun setting over mountains on the west (-X) across Amur Bay
            this.scene.background.setHex(0x1e2942);
            this.scene.fog.color.setHex(0xd97746);
            this.scene.fog.density = 0.0022;

            sunPos.set(-260, 26, -20);
            this.sunLight.position.copy(sunPos);
            this.sunLight.color.setHex(0xff7a33);
            this.sunLight.intensity = 1.35;
            this.ambientLight.color.setHex(0xffd5b8);
            this.ambientLight.intensity = 0.65;
            if (this.hemiLight) {
                this.hemiLight.color.setHex(0xfb923c);
                this.hemiLight.groundColor.setHex(0x1e293b);
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
                m.color.setHex(westTint);
                m.opacity = idx === 0 ? westOpacity : westOpacity * 0.72;
            });
        } else if (phase === 'day') {
            // Day mode: Bright maritime sky, sun high overhead
            this.scene.background.setHex(0x0284c7);
            this.scene.fog.color.setHex(0xbae6fd);
            this.scene.fog.density = 0.0014;

            sunPos.set(-70, 180, -35);
            this.sunLight.position.copy(sunPos);
            this.sunLight.color.setHex(0xffffff);
            this.sunLight.intensity = 1.5;
            this.ambientLight.color.setHex(0xffffff);
            this.ambientLight.intensity = 0.85;
            if (this.hemiLight) {
                this.hemiLight.color.setHex(0x7dd3fc);
                this.hemiLight.groundColor.setHex(0x1e293b);
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
                m.color.setHex(westTint);
                m.opacity = idx === 0 ? westOpacity : westOpacity * 0.72;
            });
        } else if (phase === 'dusk') {
            // Dusk / Twilight mode
            this.scene.background.setHex(0x0c0a2a);
            this.scene.fog.color.setHex(0x1e1b4b);
            this.scene.fog.density = 0.0025;

            sunPos.set(-260, -15, -20);
            this.sunLight.position.copy(sunPos);
            this.sunLight.color.setHex(0x818cf8);
            this.sunLight.intensity = 0.35;
            this.ambientLight.color.setHex(0x4338ca);
            this.ambientLight.intensity = 0.45;
            if (this.hemiLight) {
                this.hemiLight.color.setHex(0x6366f1);
                this.hemiLight.groundColor.setHex(0x0f172a);
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
                m.color.setHex(westTint);
                m.opacity = idx === 0 ? westOpacity : westOpacity * 0.72;
            });
        } else {
            // Night mode
            this.scene.background.setHex(0x050811);
            this.scene.fog.color.setHex(0x070b16);
            this.scene.fog.density = 0.0028;

            sunPos.set(-140, -40, -40);
            this.sunLight.position.copy(sunPos);
            this.sunLight.color.setHex(0x38bdf8);
            this.sunLight.intensity = 0.22;
            this.ambientLight.color.setHex(0x1e293b);
            this.ambientLight.intensity = 0.38;
            if (this.hemiLight) {
                this.hemiLight.color.setHex(0x38bdf8);
                this.hemiLight.groundColor.setHex(0x020617);
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
                m.color.setHex(westTint);
                m.opacity = idx === 0 ? westOpacity : westOpacity * 0.72;
            });
        }

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
