import { World } from '../static/js/world.js';
import { ModelBuilders, ModelLoader, parseGLB, computeModelBoundingBox } from '../static/js/models.js';
import { computeWorldColliderFromEntity } from '../static/js/physics.js';
import { buildAllExportableModels, exportObjectToGLB } from './export_glb.js';

const CATEGORIES = [
    { key: 'terrain', label: 'Base Terrain Slabs', icon: 'fa-layer-group' },
    { key: 'bounds', label: 'Playable Map Bounds', icon: 'fa-border-all', noAdd: true },
    { key: 'landmarks', label: 'Landmarks & Buildings', icon: 'fa-building' },
    { key: 'stalls', label: 'Food Stalls', icon: 'fa-store' },
    { key: 'vehicles', label: 'Vehicles (Cars)', icon: 'fa-car-side' },
    { key: 'props', label: 'Props (Lamps & Benches)', icon: 'fa-chair' },
    { key: 'hills', label: 'Sopka Hills', icon: 'fa-mountain' },
    { key: 'pois', label: 'Points of Interest (POIs)', icon: 'fa-location-dot' },
    { key: 'sailboats', label: 'Sailboats', icon: 'fa-sailboat' },
    { key: 'tankers', label: 'Cargo Ships', icon: 'fa-ship' },
    { key: 'spawnPoints', label: 'Player Spawns', icon: 'fa-person-rays' }
];

const TELEPORT_KEY_BY_PARENT_ID = {
    fountain: 'fountain',
    supra_restaurant: 'supra',
    tiger_statue: 'tiger',
    pyanse: 'pyanse',
    pier: 'pier',
    fortress_museum: 'fortress',
    oceanarium: 'oceanarium',
    olympiets_complex: 'olympiets',
    ocean_cinema: 'okean',
    azimut_hotel: 'azimut',
    yacht_club_boathouse: 'yachtclub'
};

class NabkaWorldEditor {
    constructor() {
        this.worldMap = null;
        this.availableModels = [];
        this.selected = null; // { category, index, data, object3d }
        this.transformMode = 'translate';
        this.panModeActive = false;
        this.spaceKeyHeld = false;
        this.rightMouseHeld = false;
        this.keysPressed = new Set();

        this.groupColliders = true;
        this.showColliders = true;
        this.showPois = true;
        this.showBounds = true;
        this.filterText = '';

        this.isDraggingGizmo = false;
        this._preDragSnapshot = null;
        this._dragStartState = null;

        this.undoStack = [];
        this.redoStack = [];
        this.maxUndoSteps = 50;

        this.editableObjects = []; // Array of { category, index, data, object3d }
        this.colliderGroup = new THREE.Group();
        this.poiGroup = new THREE.Group();
        this.boundsGroup = new THREE.Group();
        this.spawnGroup = new THREE.Group();
        this.vehicleGroup = new THREE.Group();
        this.selectionBox = null;
    }

    async init() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('exportAll') === '1') {
            const res = await fetch('/data/world_map.json?t=' + Date.now());
            this.worldMap = await res.json();
            const result = await this.exportAllModelsToServer(true);
            document.body.dataset.exportComplete = 'true';
            await fetch('/api/export-done', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(result)
            }).catch(() => {});
        }

        this.setupScene();
        await this.refreshAvailableModels();
        await this.loadWorld();
        this.bindUI();
        this.animate();
    }

    setupScene() {
        const container = document.getElementById('viewport-container');
        const width = container.clientWidth || window.innerWidth - 630;
        const height = container.clientHeight || window.innerHeight - 50;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0f172a);

        this.camera = new THREE.PerspectiveCamera(50, width / height, 0.5, 2500);
        this.camera.position.set(110, 160, 180);
        this.camera.lookAt(45, 0, 0);

        try {
            this.renderer = new THREE.WebGLRenderer({ antialias: true });
            this.renderer.setSize(width, height);
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            this.renderer.shadowMap.enabled = true;
            this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
            this.renderer.toneMappingExposure = 1.0;
            container.appendChild(this.renderer.domElement);
        } catch {
            const canvas = document.createElement('canvas');
            container.appendChild(canvas);
            this.renderer = { domElement: canvas, render: () => {}, setSize: () => {} };
        }

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffedd5, 0.45);
        this.scene.add(ambientLight);
        const hemiLight = new THREE.HemisphereLight(0x7dd3fc, 0x1e293b, 0.35);
        this.scene.add(hemiLight);
        const sunLight = new THREE.DirectionalLight(0xff9e5e, 1.05);
        sunLight.position.set(-140, 95, -40);
        this.scene.add(sunLight);
        this.persistentLights = [ambientLight, hemiLight, sunLight];

        // Grid helper on ground plane
        this.gridHelper = new THREE.GridHelper(800, 80, 0x38bdf8, 0x1e293b);
        this.gridHelper.position.y = 0.03;
        this.scene.add(this.gridHelper);

        this.scene.add(this.colliderGroup);
        this.scene.add(this.poiGroup);
        this.scene.add(this.boundsGroup);
        this.scene.add(this.spawnGroup);
        this.scene.add(this.vehicleGroup);

        this.selectionBox = new THREE.BoxHelper(new THREE.Mesh(), 0xfbbf24);
        this.selectionBox.visible = false;
        this.scene.add(this.selectionBox);

        // Orbit Controls with ground-plane panning & zoom-to-cursor
        if (typeof THREE.OrbitControls === 'function') {
            this.orbit = new THREE.OrbitControls(this.camera, this.renderer.domElement);
            this.orbit.enableDamping = true;
            this.orbit.dampingFactor = 0.08;
            this.orbit.enablePan = true;
            this.orbit.screenSpacePanning = false; // Pan across horizontal XZ map plane
            this.orbit.panSpeed = 1.35;
            this.orbit.keyPanSpeed = 18.0;
            this.orbit.maxPolarAngle = Math.PI * 0.49;
            this.orbit.target.set(45, 0, 0);
            if (THREE.MOUSE) {
                this.orbit.mouseButtons = {
                    LEFT: THREE.MOUSE.ROTATE,
                    MIDDLE: THREE.MOUSE.PAN,
                    RIGHT: THREE.MOUSE.PAN
                };
            }
        } else {
            this.setupFallbackOrbit(this.renderer.domElement);
        }

        // Transform Controls
        if (typeof THREE.TransformControls === 'function') {
            this.transformControl = new THREE.TransformControls(this.camera, this.renderer.domElement);
            this.transformControl.addEventListener('dragging-changed', (event) => {
                this.isDraggingGizmo = Boolean(event.value);
                if (this.orbit) this.orbit.enabled = !event.value && !this.panModeActive;
                if (event.value) {
                    this._preDragSnapshot = this.serializeWorldMap();
                    this._dragStartState = this.captureDragStartState(this.selected);
                } else {
                    if (this.selected) {
                        this.finalizeGizmoDrag(this.selected);
                    }
                    if (this._preDragSnapshot) {
                        const after = this.serializeWorldMap();
                        if (after !== this._preDragSnapshot) {
                            this.pushUndoSnapshot(this._preDragSnapshot);
                        }
                    }
                    this._preDragSnapshot = null;
                    this._dragStartState = null;
                    this.renderOutliner();
                }
            });
            this.transformControl.addEventListener('change', () => {
                if (!this.isDraggingGizmo) return;
                if (this.selected && this.transformControl.object === this.selected.object3d) {
                    this.syncObject3DToData(this.selected);
                    if (this.selectionBox.visible) {
                        this.selectionBox.update();
                    }
                }
            });
            this.scene.add(this.transformControl);
        }

        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

        // Zoom toward cursor on wheel so zooming doesn't stay locked to (0,0,0)
        this.renderer.domElement.addEventListener('wheel', (e) => {
            if (!this.orbit || !this.orbit.target) return;
            const rect = this.renderer.domElement.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            this.raycaster.setFromCamera(this.pointer, this.camera);
            const hitPoint = new THREE.Vector3();
            if (this.raycaster.ray.intersectPlane(this.groundPlane, hitPoint)) {
                const factor = e.deltaY < 0 ? 0.14 : 0.05;
                const dx = (hitPoint.x - this.orbit.target.x) * factor;
                const dz = (hitPoint.z - this.orbit.target.z) * factor;
                if (Math.hypot(dx, dz) < 120) {
                    this.orbit.target.x += dx;
                    this.orbit.target.z += dz;
                    this.camera.position.x += dx;
                    this.camera.position.z += dz;
                }
            }
        }, { passive: true });

        let pointerDownPos = { x: 0, y: 0 };
        this.renderer.domElement.addEventListener('pointerdown', (e) => {
            pointerDownPos = { x: e.clientX, y: e.clientY };
            if (e.button === 2) this.rightMouseHeld = true;
            this.updateOrbitMouseMapping(e.shiftKey || this.spaceKeyHeld || this.panModeActive);
        });
        window.addEventListener('pointerup', (e) => {
            if (e.button === 2) this.rightMouseHeld = false;
            this.updateOrbitMouseMapping(this.spaceKeyHeld || this.panModeActive);
        });
        this.renderer.domElement.addEventListener('pointerup', (e) => {
            if (e.button !== 0) return;
            if (this.panModeActive || this.spaceKeyHeld || e.shiftKey) return;
            const dx = e.clientX - pointerDownPos.x;
            const dy = e.clientY - pointerDownPos.y;
            if (Math.hypot(dx, dy) > 5) return;
            if (this.transformControl && this.transformControl.axis) return;
            this.handleViewportClick(e);
        });

        window.addEventListener('resize', () => {
            const w = container.clientWidth;
            const h = container.clientHeight;
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, h);
        });
    }

    updateOrbitMouseMapping(panWithLeft) {
        if (!this.orbit || !this.orbit.mouseButtons || typeof THREE.MOUSE === 'undefined') return;
        this.orbit.mouseButtons.LEFT = panWithLeft ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
        this.orbit.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
        this.orbit.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    }

    setupFallbackOrbit(domElement) {
        let isDragging = false;
        let mode = 'orbit';
        let prev = { x: 0, y: 0 };
        const spherical = { radius: 155, theta: 0, phi: 1.0 };
        const target = new THREE.Vector3(0, 0, 0);

        const updateCamera = () => {
            this.camera.position.x = target.x + spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta);
            this.camera.position.y = target.y + spherical.radius * Math.cos(spherical.phi);
            this.camera.position.z = target.z + spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta);
            this.camera.lookAt(target);
        };
        updateCamera();

        domElement.addEventListener('contextmenu', e => e.preventDefault());
        domElement.addEventListener('pointerdown', (e) => {
            if (this.transformControl && this.transformControl.axis) return;
            isDragging = true;
            if (e.button === 1 || e.button === 2 || e.shiftKey || this.spaceKeyHeld || this.panModeActive) {
                mode = 'pan';
            } else {
                mode = 'orbit';
            }
            prev = { x: e.clientX, y: e.clientY };
        });
        window.addEventListener('pointermove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - prev.x;
            const dy = e.clientY - prev.y;
            prev = { x: e.clientX, y: e.clientY };
            if (mode === 'orbit') {
                spherical.theta -= dx * 0.006;
                spherical.phi = Math.max(0.1, Math.min(Math.PI * 0.48, spherical.phi - dy * 0.006));
            } else {
                const panScale = spherical.radius * 0.0018;
                const cosT = Math.cos(spherical.theta);
                const sinT = Math.sin(spherical.theta);
                target.x -= (dx * cosT + dy * sinT) * panScale;
                target.z -= (-dx * sinT + dy * cosT) * panScale;
            }
            updateCamera();
        });
        window.addEventListener('pointerup', () => { isDragging = false; });
        domElement.addEventListener('wheel', (e) => {
            spherical.radius = Math.max(10, Math.min(900, spherical.radius + e.deltaY * 0.12));
            updateCamera();
        });
        this.orbit = { target, update: updateCamera, enabled: true };
    }

    // --- Undo / Redo System ---

    pushUndoSnapshot(snapshotStr) {
        if (!snapshotStr) return;
        if (this.undoStack.length > 0 && this.undoStack[this.undoStack.length - 1] === snapshotStr) {
            return;
        }
        this.undoStack.push(snapshotStr);
        if (this.undoStack.length > this.maxUndoSteps) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        this.updateUndoRedoUI();
    }

    recordUndoState() {
        if (!this.worldMap) return;
        this.pushUndoSnapshot(this.serializeWorldMap());
    }

    updateUndoRedoUI() {
        const btnUndo = document.getElementById('btn-undo');
        const btnRedo = document.getElementById('btn-redo');
        if (btnUndo) {
            btnUndo.disabled = this.undoStack.length === 0;
            btnUndo.style.opacity = this.undoStack.length === 0 ? '0.45' : '1';
        }
        if (btnRedo) {
            btnRedo.disabled = this.redoStack.length === 0;
            btnRedo.style.opacity = this.redoStack.length === 0 ? '0.45' : '1';
        }
    }

    async undo() {
        if (this.undoStack.length === 0) {
            this.showToast('Nothing to undo');
            return;
        }
        const currentSnapshot = this.serializeWorldMap();
        const prevSnapshot = this.undoStack.pop();
        this.redoStack.push(currentSnapshot);
        this.updateUndoRedoUI();

        const selectedId = this.selected?.data?.id;
        this.worldMap = JSON.parse(prevSnapshot);
        this.selected = null;
        await this.rebuildSceneFromMap();
        if (selectedId) {
            const match = this.editableObjects.find(e => e.data && e.data.id === selectedId);
            if (match) this.selectEntry(match);
            else this.renderInspector();
        } else {
            this.renderInspector();
        }
        this.showToast(`Undo (${this.undoStack.length} step${this.undoStack.length === 1 ? '' : 's'} remaining)`);
    }

    async redo() {
        if (this.redoStack.length === 0) {
            this.showToast('Nothing to redo');
            return;
        }
        const currentSnapshot = this.serializeWorldMap();
        const nextSnapshot = this.redoStack.pop();
        this.undoStack.push(currentSnapshot);
        this.updateUndoRedoUI();

        const selectedId = this.selected?.data?.id;
        this.worldMap = JSON.parse(nextSnapshot);
        this.selected = null;
        await this.rebuildSceneFromMap();
        if (selectedId) {
            const match = this.editableObjects.find(e => e.data && e.data.id === selectedId);
            if (match) this.selectEntry(match);
            else this.renderInspector();
        } else {
            this.renderInspector();
        }
        this.showToast(`Redo (${this.redoStack.length} step${this.redoStack.length === 1 ? '' : 's'} remaining)`);
    }

    async refreshAvailableModels() {
        try {
            const res = await fetch('/api/models');
            if (res.ok) {
                const data = await res.json();
                this.availableModels = data.models || [];
            }
        } catch {
            this.availableModels = [];
        }
    }

    async loadWorld() {
        const res = await fetch('/data/world_map.json?t=' + Date.now());
        this.worldMap = await res.json();

        delete this.worldMap.staticColliders;

        for (const cat of CATEGORIES) {
            if (cat.key === 'bounds' || cat.key === 'hills') continue;
            if (!Array.isArray(this.worldMap[cat.key])) {
                this.worldMap[cat.key] = [];
            }
        }
        // Normalize legacy array sailboats into full transform objects so y, rotY, scale, and model persist on save
        if (Array.isArray(this.worldMap.sailboats)) {
            this.worldMap.sailboats = this.worldMap.sailboats.map((sb, idx) => {
                if (Array.isArray(sb)) {
                    return {
                        id: `sailboat_${idx}`,
                        name: `Яхта #${idx + 1}`,
                        model: idx % 2 === 0 ? 'models/sailboat_white.glb' : 'models/sailboat_blue.glb',
                        x: sb[0] || 0,
                        y: -1.1,
                        z: sb[1] || 0,
                        rotY: 0,
                        scale: 1
                    };
                }
                return sb;
            });
        }
        if (!this.worldMap.bounds || typeof this.worldMap.bounds !== 'object') {
            this.worldMap.bounds = {
                player: { minX: -46, maxX: 48, minZ: -155, maxZ: 155 },
                vehicle: { minX: -13, maxX: 44, minZ: -150, maxZ: 150 },
                npc: { minX: -12.5, maxX: 12.0, minZ: -130, maxZ: 130 }
            };
        }
        if (!this.worldMap.hills || typeof this.worldMap.hills !== 'object') {
            this.worldMap.hills = { east: [], north: [], south: [] };
        }

        await this.rebuildSceneFromMap();
        this.updateUndoRedoUI();
    }

    getLinkedGroup(entry) {
        if (!entry || !entry.data || Array.isArray(entry.data)) {
            return { pois: [], teleports: [] };
        }
        const parentId = entry.data.id;
        if (!parentId || !['landmarks', 'stalls', 'props'].includes(entry.category)) {
            return { pois: [], teleports: [] };
        }

        const pois = this.editableObjects.filter(
            e => e.category === 'pois' && e.data && (e.data.parentId === parentId || e.data.id === parentId)
        );
        const teleports = [];
        if (this.worldMap && this.worldMap.teleports) {
            const tpKey = TELEPORT_KEY_BY_PARENT_ID[parentId] || parentId;
            if (this.worldMap.teleports[tpKey]) {
                teleports.push(this.worldMap.teleports[tpKey]);
            }
        }
        return { pois, teleports };
    }

    getParentEntryForChild(childEntry) {
        if (!childEntry || !childEntry.data || Array.isArray(childEntry.data)) return null;
        const parentId = childEntry.data.parentId || childEntry.data.id;
        if (!parentId) return null;
        return this.editableObjects.find(
            e => (e.category === 'landmarks' || e.category === 'stalls' || e.category === 'props') &&
                e.data && e.data.id === parentId
        ) || null;
    }

    async rebuildSceneFromMap() {
        const prevSelectedData = this.selected ? this.selected.data : null;

        if (this.transformControl) {
            this.transformControl.detach();
        }
        this.selectionBox.visible = false;

        // Keep persistent editor helpers and lights
        const keep = new Set([
            this.colliderGroup,
            this.poiGroup,
            this.boundsGroup,
            this.spawnGroup,
            this.vehicleGroup,
            this.selectionBox,
            this.transformControl,
            this.gridHelper,
            ...(this.persistentLights || [])
        ]);
        for (let i = this.scene.children.length - 1; i >= 0; i--) {
            const child = this.scene.children[i];
            if (!keep.has(child)) {
                this.scene.remove(child);
            }
        }
        this.colliderGroup.clear();
        this.poiGroup.clear();
        this.boundsGroup.clear();
        this.spawnGroup.clear();
        this.vehicleGroup.clear();
        this.editableObjects = [];

        // Preload models
        await ModelLoader.preloadAll(this.worldMap);
        for (const m of this.availableModels) {
            await ModelLoader.load(m);
        }

        // Build base world via World.buildVladivostokNabka
        World.scene = this.scene;
        if (Array.isArray(this.persistentLights) && this.persistentLights.length >= 3) {
            World.ambientLight = this.persistentLights[0];
            World.hemiLight = this.persistentLights[1];
            World.sunLight = this.persistentLights[2];
        }
        World.buildVladivostokNabka(this.worldMap);

        // If worldMap.terrain was not populated yet, copy the active terrain configs
        if (!Array.isArray(this.worldMap.terrain) || this.worldMap.terrain.length === 0) {
            this.worldMap.terrain = (World.terrainMeshes || []).map(m => m.userData.configRef);
        }

        // Register editable objects from scene and build editor overlays
        this.registerWorldObjects();
        this.buildEditorOverlays();
        this.renderOutliner();

        if (prevSelectedData) {
            const match = this.editableObjects.find(e => e.data === prevSelectedData);
            this.selectEntry(match || null);
        }
    }

    registerWorldObjects() {
        // 0. Base Terrain Slabs
        (World.terrainMeshes || []).forEach((mesh, index) => {
            const slab = this.worldMap.terrain[index] || mesh.userData.configRef;
            if (slab && mesh) {
                this.registerEditable('terrain', index, slab, mesh);
            }
        });

        // 1. Landmarks
        (World.landmarkGroups || []).forEach((obj, index) => {
            const lm = this.worldMap.landmarks[index];
            if (lm && obj) {
                this.registerEditable('landmarks', index, lm, obj);
            }
        });

        // 2. Stalls
        (World.stallGroups || []).forEach((obj, index) => {
            const stall = this.worldMap.stalls[index];
            if (stall && obj) {
                this.registerEditable('stalls', index, stall, obj);
            }
        });

        // 3. Props
        (World.propGroups || []).forEach((obj, index) => {
            const prop = this.worldMap.props[index];
            if (prop && obj) {
                this.registerEditable('props', index, prop, obj);
            }
        });

        // 4. Sopka Hills
        (World.hillGroups || []).forEach((obj, index) => {
            const hill = obj.userData && obj.userData.configRef;
            if (hill && obj) {
                this.registerEditable('hills', index, hill, obj);
            }
        });

        // 5. Sailboats & Tankers from scene children userData
        for (const child of this.scene.children) {
            if (!child.userData) continue;
            if (child.userData.editorCategory === 'sailboats') {
                const idx = child.userData.editorIndex;
                const sb = this.worldMap.sailboats[idx];
                if (sb !== undefined) {
                    this.registerEditable('sailboats', idx, sb, child);
                }
            } else if (child.userData.editorCategory === 'tankers') {
                const tk = child.userData.configRef;
                const idx = (this.worldMap.tankers || []).indexOf(tk);
                if (idx !== -1) {
                    this.registerEditable('tankers', idx, tk, child);
                }
            }
        }

        // 6. Vehicles
        (this.worldMap.vehicles || []).forEach((veh, index) => {
            const modelPath = veh.model || `models/${veh.id}.glb`;
            const mesh = ModelLoader.instantiate(
                modelPath,
                () => ModelBuilders.car(veh.colorHex ?? veh.color ?? 0xf97316, veh.id)
            );
            const localBox = (mesh.userData && mesh.userData.boundingBox) || computeModelBoundingBox(mesh);
            mesh.userData = mesh.userData || {};
            mesh.userData.boundingBox = localBox;
            mesh.position.set(veh.x || 0, veh.y || 0, veh.z || 0);
            mesh.rotation.y = veh.rotY ?? veh.rotation ?? 0;
            if (veh.scale !== undefined && veh.scale !== 1) {
                mesh.scale.setScalar(veh.scale);
            }
            this.vehicleGroup.add(mesh);
            this.registerEditable('vehicles', index, veh, mesh);
        });
    }

    computeEntryCollider(entry) {
        if (!entry || !entry.data || !entry.object3d) return null;
        if (!['landmarks', 'stalls', 'props', 'hills', 'vehicles', 'sailboats', 'tankers'].includes(entry.category)) {
            return null;
        }
        const localBox = (entry.object3d.userData && entry.object3d.userData.boundingBox) || computeModelBoundingBox(entry.object3d);
        if (localBox) {
            entry.object3d.userData = entry.object3d.userData || {};
            entry.object3d.userData.boundingBox = localBox;
        }
        const col = computeWorldColliderFromEntity(entry.data, entry.category, localBox);
        if (col) {
            entry.object3d.userData.computedCollider = col;
        }
        return col;
    }

    updateColliderOverlayForEntry(entry) {
        if (!entry) return;
        const col = this.computeEntryCollider(entry);
        if (!col) {
            if (entry.colliderMesh) {
                entry.colliderMesh.visible = false;
            }
            return;
        }

        if (!entry.colliderMesh) {
            const isCircle = col.type === 'circle';
            const geo = isCircle
                ? new THREE.CylinderGeometry(1, 1, 1, 20, 1, false)
                : new THREE.BoxGeometry(1, 1, 1);
            const mat = new THREE.MeshBasicMaterial({
                color: isCircle ? 0xf97316 : (col.climbable ? 0x34d399 : 0xfbbf24),
                wireframe: true,
                transparent: true,
                opacity: 0.72
            });
            const mesh = new THREE.Mesh(geo, mat);
            this.colliderGroup.add(mesh);
            entry.colliderMesh = mesh;
        }

        const mesh = entry.colliderMesh;
        mesh.visible = true;
        mesh.position.set(col.x || 0, col.y ?? ((col.height || 2) / 2), col.z || 0);
        mesh.rotation.set(0, col.rotY || 0, 0);
        if (col.type === 'circle') {
            const r = Math.max(0.1, col.radius || 1);
            const h = Math.max(0.1, col.boxHeight || col.height || 1);
            mesh.scale.set(r, h, r);
        } else {
            const w = Math.max(0.05, col.width || 1);
            const h = Math.max(0.05, col.boxHeight || col.height || 1);
            const d = Math.max(0.05, col.depth || 1);
            mesh.scale.set(w, h, d);
        }

        if (World && typeof World.attachBoundingBoxCordon === 'function' && entry.object3d) {
            const hasCordon = entry.object3d.getObjectByName('bounding_box_cordon');
            if (hasCordon || entry.data?.id === 'fountain' || entry.data?.id === 'ferris_wheel' || entry.data?.hasPoliceTape || entry.data?.isFerrisWheel || entry.data?.hasFountainParticles) {
                World.attachBoundingBoxCordon(entry.object3d, entry.object3d.userData?.boundingBox, entry.data?.scale || 1);
            }
        }

        if (World && typeof World.attachBoundingBoxFence === 'function' && entry.object3d) {
            const hasFence = entry.object3d.getObjectByName('bounding_box_fence');
            if (hasFence || entry.data?.id === 'oceanarium' || entry.data?.hasFence || entry.data?.hasBoundingBoxFence) {
                World.attachBoundingBoxFence(entry.object3d, entry.object3d.userData?.boundingBox, entry.data?.scale || 1);
            }
        }
    }

    buildEditorOverlays() {
        // Playable Map Bounds (player, vehicle, npc)
        const boundColors = { player: 0x10b981, vehicle: 0xf59e0b, npc: 0xa855f7 };
        const boundKeys = ['player', 'vehicle', 'npc'];
        boundKeys.forEach((key, index) => {
            const b = this.worldMap.bounds && this.worldMap.bounds[key];
            if (!b) return;
            const w = Math.max(2, (b.maxX ?? 48) - (b.minX ?? -46));
            const d = Math.max(2, (b.maxZ ?? 155) - (b.minZ ?? -155));
            const cx = ((b.minX ?? -46) + (b.maxX ?? 48)) / 2;
            const cz = ((b.minZ ?? -155) + (b.maxZ ?? 155)) / 2;
            const h = key === 'player' ? 4 : (key === 'vehicle' ? 3 : 2);
            const geo = new THREE.BoxGeometry(w, h, d);
            const mat = new THREE.MeshBasicMaterial({
                color: boundColors[key] || 0x10b981,
                wireframe: true,
                transparent: true,
                opacity: 0.85
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(cx, h / 2, cz);
            b._boundKey = key;
            this.boundsGroup.add(mesh);
            this.registerEditable('bounds', index, b, mesh);
        });
        this.boundsGroup.visible = this.showBounds;

        // Model-computed Bounding Boxes (non-selectable visual overlays derived from model geometry)
        for (const entry of this.editableObjects) {
            if (['landmarks', 'stalls', 'props', 'hills', 'vehicles', 'sailboats', 'tankers'].includes(entry.category)) {
                this.updateColliderOverlayForEntry(entry);
            }
        }
        this.colliderGroup.visible = this.showColliders;

        // POIs
        (this.worldMap.pois || []).forEach((poi, index) => {
            const r = poi.radius || poi.r || 6;
            const geo = new THREE.CylinderGeometry(r, r, 2.5, 24, 1, false);
            const mat = new THREE.MeshBasicMaterial({
                color: 0x38bdf8,
                wireframe: true,
                transparent: true,
                opacity: 0.7
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(poi.x || 0, 1.25, poi.z || 0);
            this.poiGroup.add(mesh);
            this.registerEditable('pois', index, poi, mesh);
        });
        this.poiGroup.visible = this.showPois;

        // Spawn Points (cone geometry offset by +1.25 in Y so mesh.position.y === sp.y)
        (this.worldMap.spawnPoints || []).forEach((sp, index) => {
            const geo = new THREE.ConeGeometry(1.0, 2.5, 12);
            if (typeof geo.translate === 'function') {
                geo.translate(0, 1.25, 0);
            }
            const mat = new THREE.MeshBasicMaterial({ color: 0x22c55e });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(sp.x || 0, sp.y || 0, sp.z || 0);
            mesh.rotation.y = sp.yaw ?? sp.rotY ?? 0;
            this.spawnGroup.add(mesh);
            this.registerEditable('spawnPoints', index, sp, mesh);
        });
    }

    registerEditable(category, index, data, object3d) {
        const entry = { category, index, data, object3d, colliderMesh: null };
        object3d.userData.editorEntry = entry;
        object3d.traverse((child) => {
            child.userData.editorEntry = entry;
        });
        this.editableObjects.push(entry);
        return entry;
    }

    handleViewportClick(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.pointer, this.camera);
        // Prioritize non-bounds objects over giant bounds wireframes
        const nonBoundRoots = this.editableObjects
            .filter(e => e.category !== 'bounds' && e.object3d.visible && (!e.object3d.parent || e.object3d.parent.visible))
            .map(e => e.object3d);

        let hits = this.raycaster.intersectObjects(nonBoundRoots, true);
        if (hits.length === 0 && this.showBounds) {
            const boundRoots = this.editableObjects
                .filter(e => e.category === 'bounds' && e.object3d.visible)
                .map(e => e.object3d);
            hits = this.raycaster.intersectObjects(boundRoots, true);
        }

        if (hits.length > 0) {
            let obj = hits[0].object;
            while (obj && !obj.userData.editorEntry) {
                obj = obj.parent;
            }
            if (obj && obj.userData.editorEntry) {
                this.selectEntry(obj.userData.editorEntry);
                return;
            }
        }
        this.selectEntry(null);
    }

    selectEntry(entry) {
        this.selected = entry;
        if (this.transformControl) {
            if (entry && entry.object3d && !this.panModeActive) {
                this.transformControl.attach(entry.object3d);
                this.transformControl.setMode(this.transformMode);
            } else {
                this.transformControl.detach();
            }
        }

        if (entry && entry.object3d) {
            this.selectionBox.setFromObject(entry.object3d);
            this.selectionBox.visible = true;
        } else {
            this.selectionBox.visible = false;
        }

        this.renderOutliner();
        this.renderInspector();
    }

    focusSelected() {
        if (!this.selected || !this.selected.object3d) {
            this.resetCameraView();
            return;
        }
        const pos = this.selected.object3d.position;
        if (this.orbit && this.orbit.target) {
            this.orbit.target.set(pos.x, pos.y, pos.z);
            this.camera.position.set(pos.x + 25, pos.y + 22, pos.z + 25);
            this.camera.lookAt(pos);
            if (this.orbit.update) this.orbit.update();
        }
    }

    resetCameraView() {
        if (this.orbit && this.orbit.target) {
            this.orbit.target.set(45, 0, 0);
        }
        this.camera.position.set(110, 160, 180);
        this.camera.lookAt(45, 0, 0);
        if (this.orbit && this.orbit.update) this.orbit.update();
        this.showToast('Camera reset to map overview (no edits lost)');
    }

    getObjectYaw(object3d) {
        if (!object3d) return 0;
        const q = object3d.quaternion;
        if (q && typeof q.w === 'number') {
            const siny = 2 * (q.w * q.y + q.x * q.z);
            const cosy = 1 - 2 * (q.x * q.x + q.y * q.y);
            return Math.atan2(siny, cosy);
        }
        return (object3d.rotation && object3d.rotation.y) || 0;
    }

    finalizeGizmoDrag(entry) {
        if (!entry || !entry.object3d || !entry.data) return;
        const { category, data, object3d } = entry;
        if (category === 'terrain') {
            const w = Math.max(2, data.width || 30);
            const h = Math.max(0.1, data.height || 1.0);
            const d = Math.max(2, data.depth || 340);
            if (data.type === 'ocean' || data.id === 'ocean') {
                const geo = new THREE.PlaneGeometry(w, d, 48, 48);
                geo.rotateX(-Math.PI / 2);
                object3d.geometry = geo;
            } else {
                object3d.geometry = new THREE.BoxGeometry(w, h, d);
            }
            object3d.scale.set(1, 1, 1);
        } else if (category === 'bounds') {
            const key = data._boundKey || 'player';
            const w = Math.max(2, (data.maxX ?? 48) - (data.minX ?? -46));
            const d = Math.max(2, (data.maxZ ?? 155) - (data.minZ ?? -155));
            const h = key === 'player' ? 4 : (key === 'vehicle' ? 3 : 2);
            object3d.geometry = new THREE.BoxGeometry(w, h, d);
            object3d.scale.set(1, 1, 1);
        } else if (category === 'pois') {
            const r = Math.max(1, data.radius || data.r || 6);
            object3d.geometry = new THREE.CylinderGeometry(r, r, 2.5, 24, 1, false);
            object3d.scale.set(1, 1, 1);
        }
        if (this.selectionBox && this.selectionBox.visible) {
            this.selectionBox.setFromObject(object3d);
        }
    }

    captureDragStartState(entry) {
        if (!entry || !entry.data || !entry.object3d) return null;
        const { data } = entry;
        const linked = this.getLinkedGroup(entry);
        return {
            x: Array.isArray(data) ? data[0] : (data.x || 0),
            y: Array.isArray(data) ? -1.1 : (data.y || 0),
            z: Array.isArray(data) ? data[1] : (data.z || 0),
            rotY: data.rotY ?? data.rotation ?? data.yaw ?? 0,
            width: data.width ?? data.w ?? 30,
            depth: data.depth ?? data.d ?? 340,
            height: data.height ?? data.h ?? 1.0,
            radius: data.radius ?? data.r ?? 6,
            scale: data.scale ?? 1,
            scaleX: entry.object3d.scale.x || 1,
            scaleY: entry.object3d.scale.y || 1,
            scaleZ: entry.object3d.scale.z || 1,
            r: data.r ?? data.radius ?? 32,
            h: data.h ?? data.height ?? 48,
            minX: data.minX ?? -46,
            maxX: data.maxX ?? 48,
            minZ: data.minZ ?? -155,
            maxZ: data.maxZ ?? 155,
            label: data.label ? { x: data.label.x, y: data.label.y, z: data.label.z } : null,
            pois: linked.pois.map(p => ({
                entry: p,
                x: p.data.x || 0,
                z: p.data.z || 0,
                radius: p.data.radius ?? p.data.r ?? 6,
                labelX: p.data.label ? p.data.label.x : 0,
                labelZ: p.data.label ? p.data.label.z : 0
            })),
            teleports: linked.teleports.map(tp => ({
                ref: tp,
                x: tp.x || 0,
                z: tp.z || 0
            }))
        };
    }

    moveLinkedChildrenByDelta(entry, dx, dz) {
        if (!this.groupColliders || (dx === 0 && dz === 0)) return;
        const round2 = (v) => Math.round(Number(v) * 100) / 100;
        const { data } = entry;
        if (data && data.label && typeof data.label === 'object') {
            data.label.x = round2((data.label.x || 0) + dx);
            data.label.z = round2((data.label.z || 0) + dz);
        }
        const linked = this.getLinkedGroup(entry);
        for (const poiEntry of linked.pois) {
            poiEntry.data.x = round2((poiEntry.data.x || 0) + dx);
            poiEntry.data.z = round2((poiEntry.data.z || 0) + dz);
            if (poiEntry.data.label && typeof poiEntry.data.label === 'object') {
                poiEntry.data.label.x = round2((poiEntry.data.label.x || 0) + dx);
                poiEntry.data.label.z = round2((poiEntry.data.label.z || 0) + dz);
            }
            poiEntry.object3d.position.x = poiEntry.data.x;
            poiEntry.object3d.position.z = poiEntry.data.z;
        }
        for (const tp of linked.teleports) {
            tp.x = round2((tp.x || 0) + dx);
            tp.z = round2((tp.z || 0) + dz);
        }
    }

    rotateLinkedChildrenByDelta(entry, dRotY) {
        if (!this.groupColliders || dRotY === 0) return;
        const round2 = (v) => Math.round(Number(v) * 100) / 100;
        const { data } = entry;
        const originX = data.x || 0;
        const originZ = data.z || 0;
        const cos = Math.cos(dRotY);
        const sin = Math.sin(dRotY);

        const linked = this.getLinkedGroup(entry);
        for (const poiEntry of linked.pois) {
            const relX = (poiEntry.data.x || 0) - originX;
            const relZ = (poiEntry.data.z || 0) - originZ;
            poiEntry.data.x = round2(originX + relX * cos + relZ * sin);
            poiEntry.data.z = round2(originZ - relX * sin + relZ * cos);
            poiEntry.object3d.position.x = poiEntry.data.x;
            poiEntry.object3d.position.z = poiEntry.data.z;

            if (poiEntry.data.label && typeof poiEntry.data.label === 'object') {
                const lRelX = (poiEntry.data.label.x || 0) - originX;
                const lRelZ = (poiEntry.data.label.z || 0) - originZ;
                poiEntry.data.label.x = round2(originX + lRelX * cos + lRelZ * sin);
                poiEntry.data.label.z = round2(originZ - lRelX * sin + lRelZ * cos);
            }
        }
    }

    syncObject3DToData(entry) {
        const { category, data, object3d } = entry;
        const round2 = (v) => Math.round(Number(v) * 100) / 100;
        const start = this._dragStartState;

        if (category === 'bounds') {
            const baseW = start ? (start.maxX - start.minX) : ((data.maxX ?? 48) - (data.minX ?? -46));
            const baseD = start ? (start.maxZ - start.minZ) : ((data.maxZ ?? 155) - (data.minZ ?? -155));
            const scaleRatioX = (object3d.scale.x || 1) / (start ? (start.scaleX || 1) : 1);
            const scaleRatioZ = (object3d.scale.z || 1) / (start ? (start.scaleZ || 1) : 1);
            const halfW = Math.max(1, (baseW * scaleRatioX) / 2);
            const halfD = Math.max(1, (baseD * scaleRatioZ) / 2);
            data.minX = round2(object3d.position.x - halfW);
            data.maxX = round2(object3d.position.x + halfW);
            data.minZ = round2(object3d.position.z - halfD);
            data.maxZ = round2(object3d.position.z + halfD);
            const updateInput = (name, val) => {
                const el = document.querySelector(`[data-field="${name}"]`);
                if (el && document.activeElement !== el) el.value = val;
            };
            updateInput('minX', data.minX);
            updateInput('maxX', data.maxX);
            updateInput('minZ', data.minZ);
            updateInput('maxZ', data.maxZ);
            return;
        }

        if (Array.isArray(data)) {
            data[0] = round2(object3d.position.x);
            data[1] = round2(object3d.position.z);
            this.updateColliderOverlayForEntry(entry);
            return;
        }

        const prevX = data.x || 0;
        const prevZ = data.z || 0;
        const newX = round2(object3d.position.x);
        const newY = round2(object3d.position.y);
        const newZ = round2(object3d.position.z);

        data.x = newX;
        data.z = newZ;

        // Save Y for all 3D world entities so nothing resets its vertical position on scene rebuild
        if (['landmarks', 'stalls', 'vehicles', 'props', 'terrain', 'hills', 'sailboats', 'tankers', 'spawnPoints'].includes(category)) {
            data.y = newY;
        }

        // Move linked POIs, labels, and teleports together with parent object
        if (this.groupColliders && ['landmarks', 'stalls', 'props'].includes(category)) {
            if (start) {
                const totalDx = newX - start.x;
                const totalDz = newZ - start.z;
                if (start.label && data.label) {
                    data.label.x = round2(start.label.x + totalDx);
                    data.label.z = round2(start.label.z + totalDz);
                }
                for (const p of start.pois) {
                    p.entry.data.x = round2(p.x + totalDx);
                    p.entry.data.z = round2(p.z + totalDz);
                    if (p.entry.data.label) {
                        p.entry.data.label.x = round2(p.labelX + totalDx);
                        p.entry.data.label.z = round2(p.labelZ + totalDz);
                    }
                    p.entry.object3d.position.x = p.entry.data.x;
                    p.entry.object3d.position.z = p.entry.data.z;
                }
                for (const tp of start.teleports) {
                    tp.ref.x = round2(tp.x + totalDx);
                    tp.ref.z = round2(tp.z + totalDz);
                }
            } else {
                this.moveLinkedChildrenByDelta(entry, newX - prevX, newZ - prevZ);
            }
        }

        const prevRotY = data.rotY ?? data.rotation ?? data.yaw ?? 0;
        const newRotY = round2(this.getObjectYaw(object3d));
        if (object3d.rotation && typeof object3d.rotation.set === 'function') {
            object3d.rotation.set(0, newRotY, 0);
        } else if (object3d.rotation) {
            object3d.rotation.x = 0;
            object3d.rotation.y = newRotY;
            object3d.rotation.z = 0;
        }

        if (category === 'spawnPoints') {
            data.yaw = newRotY;
        } else if (category === 'vehicles') {
            data.rotY = newRotY;
            if ('rotation' in data) data.rotation = newRotY;
        } else if ('rotY' in data || ['landmarks', 'stalls', 'props', 'terrain', 'hills', 'sailboats', 'tankers'].includes(category)) {
            data.rotY = newRotY;
            if ('rotation' in data) data.rotation = newRotY;
        } else if ('rotation' in data) {
            data.rotation = newRotY;
        }

        // Rotate linked POIs and labels together with parent object
        if (this.groupColliders && ['landmarks', 'stalls', 'props'].includes(category) && this.transformMode === 'rotate') {
            const startRotY = (start && typeof start.rotY === 'number') ? start.rotY : prevRotY;
            const dRotY = newRotY - startRotY;
            if (Math.abs(dRotY) > 0.0001) {
                if (start && start.pois) {
                    const originX = start.x;
                    const originZ = start.z;
                    const cos = Math.cos(dRotY);
                    const sin = Math.sin(dRotY);
                    for (const p of start.pois) {
                        const relX = p.x - originX;
                        const relZ = p.z - originZ;
                        p.entry.data.x = round2(originX + relX * cos + relZ * sin);
                        p.entry.data.z = round2(originZ - relX * sin + relZ * cos);
                        p.entry.object3d.position.x = p.entry.data.x;
                        p.entry.object3d.position.z = p.entry.data.z;

                        if (p.entry.data.label) {
                            const lRelX = p.labelX - originX;
                            const lRelZ = p.labelZ - originZ;
                            p.entry.data.label.x = round2(originX + lRelX * cos + lRelZ * sin);
                            p.entry.data.label.z = round2(originZ - lRelX * sin + lRelZ * cos);
                        }
                    }
                } else {
                    this.rotateLinkedChildrenByDelta(entry, newRotY - prevRotY);
                }
            }
        }

        if (this.transformMode === 'scale') {
            const startScaleX = start ? (start.scaleX || 1) : 1;
            const startScaleY = start ? (start.scaleY || 1) : 1;
            const startScaleZ = start ? (start.scaleZ || 1) : 1;

            if (category === 'terrain') {
                const origW = start ? start.width : (data.width || 30);
                const origH = start ? start.height : (data.height || 1.0);
                const origD = start ? start.depth : (data.depth || 340);
                data.width = Math.max(2, round2(origW * (object3d.scale.x / startScaleX)));
                data.height = Math.max(0.1, round2(origH * (object3d.scale.y / startScaleY)));
                data.depth = Math.max(2, round2(origD * (object3d.scale.z / startScaleZ)));
            } else if (category === 'hills') {
                const origR = start ? (start.r || 32) : (data.r || 32);
                const origH = start ? (start.h || 48) : (data.h || 48);

                const dX = Math.abs(object3d.scale.x - startScaleX);
                const dZ = Math.abs(object3d.scale.z - startScaleZ);

                const activeHorizScale = dZ > dX ? object3d.scale.z : object3d.scale.x;
                const horizRatio = startScaleX > 0 ? (activeHorizScale / startScaleX) : 1;
                const vertRatio = startScaleY > 0 ? (object3d.scale.y / startScaleY) : 1;

                object3d.scale.x = activeHorizScale;
                object3d.scale.z = activeHorizScale;

                data.r = Math.max(4, round2(origR * horizRatio));
                data.h = Math.max(4, round2(origH * vertRatio));
            } else if (category === 'pois') {
                const origR = start ? start.radius : (data.radius || data.r || 6);
                const dX = Math.abs(object3d.scale.x - startScaleX);
                const dZ = Math.abs(object3d.scale.z - startScaleZ);
                const activeHorizScale = dZ > dX ? object3d.scale.z : object3d.scale.x;
                const ratio = startScaleX > 0 ? (activeHorizScale / startScaleX) : 1;
                object3d.scale.x = activeHorizScale;
                object3d.scale.z = activeHorizScale;
                data.radius = Math.max(1, round2(origR * ratio));
            } else if (['landmarks', 'stalls', 'props', 'vehicles', 'sailboats', 'tankers'].includes(category)) {
                const dX = Math.abs(object3d.scale.x - startScaleX);
                const dY = Math.abs(object3d.scale.y - startScaleY);
                const dZ = Math.abs(object3d.scale.z - startScaleZ);
                let activeAxisScale = object3d.scale.x;
                let baseAxisScale = startScaleX;
                if (dY >= dX && dY >= dZ) {
                    activeAxisScale = object3d.scale.y;
                    baseAxisScale = startScaleY;
                } else if (dZ >= dX && dZ >= dY) {
                    activeAxisScale = object3d.scale.z;
                    baseAxisScale = startScaleZ;
                }
                const origScale = start ? (start.scale || 1) : (data.scale || 1);
                const ratio = baseAxisScale > 0 ? (activeAxisScale / baseAxisScale) : 1;
                const newScale = Math.max(0.05, round2(origScale * ratio));
                data.scale = newScale;
                object3d.scale.setScalar(newScale);
            }
        }

        this.updateColliderOverlayForEntry(entry);

        const updateInput = (name, val) => {
            const el = document.querySelector(`[data-field="${name}"]`);
            if (el && document.activeElement !== el) {
                el.value = val;
            }
        };
        if (data.x !== undefined) updateInput('x', data.x);
        if (data.y !== undefined) updateInput('y', data.y);
        if (data.z !== undefined) updateInput('z', data.z);
        if (data.width !== undefined) updateInput('width', data.width);
        if (data.depth !== undefined) updateInput('depth', data.depth);
        if (data.radius !== undefined) updateInput('radius', data.radius);
        if (data.height !== undefined) updateInput('height', data.height);
        if (data.r !== undefined) updateInput('r', data.r);
        if (data.h !== undefined) updateInput('h', data.h);
        if (data.rotY !== undefined) updateInput('rotY', data.rotY);
        if (data.rotation !== undefined) updateInput('rotation', data.rotation);
        if (data.yaw !== undefined) updateInput('yaw', data.yaw);
        if (data.scale !== undefined) updateInput('scale', data.scale);
    }

    getEntryTitle(category, data, index) {
        if (category === 'bounds') {
            return `Bounds: ${data._boundKey || index} (${Math.round((data.maxX || 0) - (data.minX || 0))}×${Math.round((data.maxZ || 0) - (data.minZ || 0))})`;
        }
        if (category === 'terrain') {
            return `${data.name || data.id} (${Math.round(data.width || 0)}×${Math.round(data.depth || 0)})`;
        }
        if (Array.isArray(data)) {
            return `${category}[${index}] (${data[0]}, ${data[1]})`;
        }
        if (data.label && typeof data.label === 'object' && data.label.text) {
            return data.label.text;
        }
        return data.name || data.title || (typeof data.label === 'string' ? data.label : '') || data.id || `${category}[${index}]`;
    }

    renderOutliner() {
        const listEl = document.getElementById('outliner-list');
        const countEl = document.getElementById('outliner-count');
        listEl.innerHTML = '';

        const filter = this.filterText.trim().toLowerCase();
        let totalCount = 0;

        for (const cat of CATEGORIES) {
            const items = this.editableObjects.filter(e => e.category === cat.key);
            totalCount += items.length;

            const filteredItems = filter
                ? items.filter(e => {
                    const title = this.getEntryTitle(cat.key, e.data, e.index).toLowerCase();
                    const model = (!Array.isArray(e.data) && e.data.model ? e.data.model : '').toLowerCase();
                    return title.includes(filter) || model.includes(filter);
                })
                : items;

            const groupDiv = document.createElement('div');
            groupDiv.className = 'tree-group';

            const header = document.createElement('div');
            header.className = 'tree-group-header';
            header.innerHTML = `
                <span><i class="fa-solid ${cat.icon}" style="margin-right:6px;color:#38bdf8;"></i>${cat.label} (${filteredItems.length})</span>
                ${cat.noAdd ? '' : `<button class="btn" style="padding:2px 6px;font-size:10px;" data-add-category="${cat.key}" title="Add ${cat.label}">+ Add</button>`}
            `;
            const addBtn = header.querySelector('[data-add-category]');
            if (addBtn) {
                addBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.addNewItem(cat.key);
                });
            }
            groupDiv.appendChild(header);

            for (const entry of filteredItems) {
                const row = document.createElement('div');
                const isSelected = this.selected && this.selected.data === entry.data;
                row.className = 'tree-item' + (isSelected ? ' selected' : '');
                const title = this.getEntryTitle(cat.key, entry.data, entry.index);
                const sub = (!Array.isArray(entry.data) && entry.data.model)
                    ? entry.data.model.replace('models/', '')
                    : `(${Math.round(entry.object3d.position.x)}, ${Math.round(entry.object3d.position.z)})`;
                row.innerHTML = `
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${title}</span>
                    <span style="font-size:10px;color:#64748b;margin-left:6px;">${sub}</span>
                `;
                row.addEventListener('click', () => this.selectEntry(entry));
                row.addEventListener('dblclick', () => {
                    this.selectEntry(entry);
                    this.focusSelected();
                });
                groupDiv.appendChild(row);
            }

            listEl.appendChild(groupDiv);
        }

        countEl.textContent = `${totalCount} items`;
    }

    renderInspector() {
        const container = document.getElementById('inspector-content');
        const catBadge = document.getElementById('inspector-category');
        container.innerHTML = '';

        if (!this.selected) {
            catBadge.textContent = 'None';
            container.innerHTML = `
                <div style="color:#64748b;font-size:12px;line-height:1.5;padding:8px;">
                    Click any building, stall, car, prop, hill, or POI in the 3D viewport or Scene Outliner to inspect and edit its transform, properties, or <code>.glb</code> model.
                </div>
            `;
            return;
        }

        const { category, index, data } = this.selected;
        catBadge.textContent = `${category}[${index}]`;

        const form = document.createElement('div');

        // Action Bar (Focus, Ground Y, Duplicate, Delete)
        const actionRow = document.createElement('div');
        actionRow.style.cssText = 'display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;';
        actionRow.innerHTML = `
            <button class="btn" id="insp-focus" style="flex:1;"><i class="fa-solid fa-crosshairs"></i> Focus (F)</button>
            <button class="btn" id="insp-ground" title="Snap vertical Y coordinate to ground level"><i class="fa-solid fa-arrow-down-to-line"></i> Ground Y</button>
            <button class="btn" id="insp-dup"><i class="fa-solid fa-copy"></i> Dup</button>
            <button class="btn btn-danger" id="insp-del"><i class="fa-solid fa-trash"></i></button>
        `;
        form.appendChild(actionRow);

        // Computed Model Bounding Box summary (auto-derived from geometry on model load)
        const computedCol = this.computeEntryCollider(this.selected);
        if (computedCol) {
            const bboxCard = document.createElement('div');
            bboxCard.id = 'insp-computed-bbox';
            bboxCard.style.cssText = 'background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.35);border-radius:8px;padding:9px;margin-bottom:12px;font-size:11px;line-height:1.45;';
            const dimsText = computedCol.type === 'circle'
                ? `Radius: <b>${computedCol.radius}m</b> &times; H: <b>${computedCol.height}m</b>`
                : `Size: <b>${computedCol.width} &times; ${computedCol.boxHeight ?? computedCol.height} &times; ${computedCol.depth}m</b>`;
            bboxCard.innerHTML = `
                <div class="field-label" style="color:#fbbf24;margin-bottom:3px;">
                    <i class="fa-solid fa-vector-square"></i> Computed Model Bounding Box
                </div>
                <div style="color:#fde68a;">${dimsText}</div>
                <div style="color:#94a3b8;font-size:10px;margin-top:2px;">
                    Center: (${computedCol.x}, ${computedCol.z}) &bull; Top Y: ${computedCol.height}m${computedCol.climbable ? ' &bull; Climbable' : ''}
                </div>
            `;
            form.appendChild(bboxCard);
        }

        // Linked POIs section for parent objects (landmarks, stalls)
        const linked = this.getLinkedGroup(this.selected);
        if (linked.pois.length > 0) {
            const groupBox = document.createElement('div');
            groupBox.style.cssText = 'background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.35);border-radius:8px;padding:9px;margin-bottom:12px;';
            const itemsHtml = linked.pois.map((p, idx) => `
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:3px 0;">
                    <span><i class="fa-solid fa-location-dot" style="color:#38bdf8;margin-right:5px;"></i>POI: ${p.data.name || p.data.id}</span>
                    <button class="btn" style="padding:2px 6px;font-size:10px;" data-select-linked-poi="${idx}">Inspect</button>
                </div>
            `).join('');
            groupBox.innerHTML = `
                <div class="field-label" style="color:#34d399;margin-bottom:4px;">
                    <i class="fa-solid fa-link"></i> Linked POIs
                </div>
                ${itemsHtml}
            `;
            groupBox.querySelectorAll('[data-select-linked-poi]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const pEntry = linked.pois[Number(btn.dataset.selectLinkedPoi)];
                    if (pEntry) this.selectEntry(pEntry);
                });
            });
            form.appendChild(groupBox);
        }

        // If a POI is selected, show parent object link info
        if (category === 'pois') {
            const parentEntry = this.getParentEntryForChild(this.selected);
            if (parentEntry) {
                const parentBox = document.createElement('div');
                parentBox.style.cssText = 'background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.35);border-radius:8px;padding:9px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;';
                parentBox.innerHTML = `
                    <span style="font-size:11px;color:#fde68a;"><i class="fa-solid fa-link"></i> Linked to <b>${this.getEntryTitle(parentEntry.category, parentEntry.data, parentEntry.index)}</b></span>
                    <button class="btn" id="insp-select-parent" style="padding:3px 8px;font-size:11px;">Select Parent</button>
                `;
                form.appendChild(parentBox);
            }
        }

        // Model / Blockbench Export section for 3D model-backed entities
        const supportsModel = ['landmarks', 'stalls', 'vehicles', 'props', 'sailboats', 'tankers'].includes(category);
        if (supportsModel && !Array.isArray(data)) {
            const modelBox = document.createElement('div');
            modelBox.style.cssText = 'background:rgba(30,41,59,0.65);border:1px solid rgba(56,189,248,0.25);border-radius:8px;padding:10px;margin-bottom:12px;';
            const currentModel = data.model || '';
            const optionsHtml = [
                `<option value="">(Procedural / Default)</option>`,
                ...this.availableModels.map(m => `<option value="${m}" ${m === currentModel ? 'selected' : ''}>${m}</option>`)
            ].join('');

            modelBox.innerHTML = `
                <div class="field-label" style="color:#38bdf8;margin-bottom:6px;">3D Model (.glb for Blockbench / Blender)</div>
                <div class="field-row" style="margin-bottom:8px;">
                    <select class="field-select" id="insp-model-select">${optionsHtml}</select>
                </div>
                <div class="field-row" style="margin-bottom:8px;">
                    <input class="field-input" id="insp-model-path" value="${currentModel}" placeholder="models/example.glb">
                </div>
                <div style="display:flex;gap:6px;">
                    <button class="btn btn-amber" id="insp-download-glb" style="flex:1;justify-content:center;">
                        <i class="fa-solid fa-cube"></i> Download .glb
                    </button>
                    <button class="btn" id="insp-replace-glb" style="flex:1;justify-content:center;">
                        <i class="fa-solid fa-upload"></i> Replace .glb
                    </button>
                </div>
            `;
            form.appendChild(modelBox);
        }

        if (Array.isArray(data)) {
            ['x (0)', 'z (1)'].forEach((lbl, arrIdx) => {
                const row = document.createElement('div');
                row.className = 'field-row';
                row.innerHTML = `<label class="field-label">${lbl}</label>`;
                const input = document.createElement('input');
                input.className = 'field-input';
                input.type = 'number';
                input.step = '0.5';
                input.value = data[arrIdx] || 0;
                let focusSnapshot = null;
                input.addEventListener('focus', () => {
                    focusSnapshot = this.serializeWorldMap();
                });
                input.addEventListener('input', () => {
                    const num = parseFloat(input.value);
                    if (Number.isFinite(num)) {
                        if (focusSnapshot) {
                            this.pushUndoSnapshot(focusSnapshot);
                            focusSnapshot = null;
                        }
                        data[arrIdx] = num;
                        this.selected.object3d.position.set(data[0], this.selected.object3d.position.y, data[1]);
                        this.selectionBox.update();
                    }
                });
                row.appendChild(input);
                form.appendChild(row);
            });
        } else {
            const keys = Object.keys(data);
            for (const key of keys) {
                if (key.startsWith('_')) continue;
                if (key === 'model' && supportsModel) continue;
                const val = data[key];
                if (val && typeof val === 'object') continue;
                const row = document.createElement('div');
                row.className = 'field-row';

                const label = document.createElement('label');
                label.className = 'field-label';
                label.textContent = key;
                row.appendChild(label);

                const input = document.createElement('input');
                input.className = 'field-input';
                input.dataset.field = key;

                if (typeof val === 'number') {
                    input.type = 'number';
                    input.step = (key === 'rotation' || key === 'rotY' || key === 'yaw' || key === 'scale') ? '0.05' : '0.5';
                    input.value = val;
                } else if (typeof val === 'boolean') {
                    input.type = 'checkbox';
                    input.checked = val;
                    input.style.width = 'auto';
                } else {
                    input.type = 'text';
                    input.value = val ?? '';
                }

                let focusSnapshot = null;
                input.addEventListener('focus', () => {
                    focusSnapshot = this.serializeWorldMap();
                });

                input.addEventListener('input', () => {
                    const prevVal = data[key];
                    if (typeof val === 'number') {
                        const num = parseFloat(input.value);
                        if (Number.isFinite(num)) {
                            if (focusSnapshot) {
                                this.pushUndoSnapshot(focusSnapshot);
                                focusSnapshot = null;
                            }
                            data[key] = num;
                        }
                    } else if (typeof val === 'boolean') {
                        this.pushUndoSnapshot(focusSnapshot || this.serializeWorldMap());
                        focusSnapshot = null;
                        data[key] = input.checked;
                    } else {
                        if (focusSnapshot) {
                            this.pushUndoSnapshot(focusSnapshot);
                            focusSnapshot = null;
                        }
                        data[key] = input.value;
                    }
                    this.applyDataToObject3D(this.selected, key, prevVal);
                });

                row.appendChild(input);
                form.appendChild(row);
            }
        }

        container.appendChild(form);

        document.getElementById('insp-focus').addEventListener('click', () => this.focusSelected());
        document.getElementById('insp-ground').addEventListener('click', () => this.snapSelectedToGround());
        document.getElementById('insp-dup').addEventListener('click', () => this.duplicateSelected());
        document.getElementById('insp-del').addEventListener('click', () => this.deleteSelected());

        const selectParentBtn = document.getElementById('insp-select-parent');
        if (selectParentBtn) {
            selectParentBtn.addEventListener('click', () => {
                const p = this.getParentEntryForChild(this.selected);
                if (p) this.selectEntry(p);
            });
        }

        if (supportsModel && !Array.isArray(data)) {
            const selectEl = document.getElementById('insp-model-select');
            const pathEl = document.getElementById('insp-model-path');
            selectEl.addEventListener('change', async () => {
                this.recordUndoState();
                pathEl.value = selectEl.value;
                data.model = selectEl.value;
                if (data.model) {
                    await ModelLoader.load(data.model);
                }
                await this.rebuildSceneFromMap();
                this.renderInspector();
            });
            pathEl.addEventListener('change', async () => {
                this.recordUndoState();
                data.model = pathEl.value.trim();
                if (data.model) {
                    await ModelLoader.load(data.model);
                }
                await this.rebuildSceneFromMap();
                this.renderInspector();
            });
            document.getElementById('insp-download-glb').addEventListener('click', () => {
                this.downloadSelectedObjectGLB();
            });
            document.getElementById('insp-replace-glb').addEventListener('click', () => {
                document.getElementById('input-upload-glb').click();
            });
        }
    }

    snapSelectedToGround() {
        if (!this.selected || !this.selected.data || Array.isArray(this.selected.data)) return;
        this.recordUndoState();
        const { category, data, object3d } = this.selected;
        const groundY = (category === 'hills' || category === 'terrain') ? -0.5 : (category === 'props' && data.type === 'bench' ? 0.325 : 0);
        data.y = groundY;
        object3d.position.y = groundY;
        this.updateColliderOverlayForEntry(this.selected);
        this.selectionBox.update();
        this.renderInspector();
        this.showToast(`Snapped Y to ${groundY}`);
    }

    async applyDataToObject3D(entry, changedKey, prevVal) {
        const { category, data, object3d } = entry;
        if (changedKey === 'x' || changedKey === 'y' || changedKey === 'z') {
            if (this.groupColliders && ['landmarks', 'stalls', 'props'].includes(category) && typeof prevVal === 'number') {
                const dx = changedKey === 'x' ? (data.x - prevVal) : 0;
                const dz = changedKey === 'z' ? (data.z - prevVal) : 0;
                this.moveLinkedChildrenByDelta(entry, dx, dz);
            }
            object3d.position.set(
                data.x ?? object3d.position.x,
                data.y ?? object3d.position.y,
                data.z ?? object3d.position.z
            );
            this.updateColliderOverlayForEntry(entry);
            this.selectionBox.update();
            this.renderOutliner();
            return;
        }
        if (changedKey === 'rotation' || changedKey === 'rotY' || changedKey === 'yaw') {
            const newRot = data.rotY ?? data.rotation ?? data.yaw ?? 0;
            if (changedKey === 'rotY' && 'rotation' in data) data.rotation = newRot;
            if (changedKey === 'rotation' && 'rotY' in data) data.rotY = newRot;
            if (this.groupColliders && ['landmarks', 'stalls', 'props'].includes(category) && typeof prevVal === 'number') {
                this.rotateLinkedChildrenByDelta(entry, newRot - prevVal);
            }
            object3d.rotation.set(0, newRot, 0);
            this.updateColliderOverlayForEntry(entry);
            this.selectionBox.update();
            return;
        }
        if (category === 'hills' && (changedKey === 'r' || changedKey === 'h')) {
            const r = data.r || 32;
            const h = data.h || 48;
            object3d.scale.set(r / 32, h / 48, r / 32);
            this.updateColliderOverlayForEntry(entry);
            this.selectionBox.update();
            return;
        }
        if (changedKey === 'scale' && Number.isFinite(data.scale) && data.scale > 0) {
            object3d.scale.setScalar(data.scale);
            this.updateColliderOverlayForEntry(entry);
            this.selectionBox.update();
            return;
        }
        if (category === 'terrain' && (changedKey === 'width' || changedKey === 'height' || changedKey === 'depth' || changedKey === 'color' || changedKey === 'type')) {
            if (changedKey === 'type') {
                await this.rebuildSceneFromMap();
                const match = this.editableObjects.find(e => e.data === data);
                if (match) this.selectEntry(match);
                return;
            }
            if (changedKey === 'color' && object3d.material && object3d.material.color) {
                object3d.material.color.setHex(Number(data.color) || 0x334155);
            } else {
                const w = Math.max(0.5, Number(data.width) || 10);
                const h = Math.max(0.05, Number(data.height) || 1);
                const d = Math.max(0.5, Number(data.depth) || 10);
                if (object3d.geometry && object3d.geometry.dispose) object3d.geometry.dispose();
                object3d.geometry = new THREE.BoxGeometry(w, h, d);
                object3d.scale.set(1, 1, 1);
                if (object3d.material && object3d.material.map) {
                    if (data.type === 'road' || data.type === 'road_x') {
                        const isX = data.type === 'road_x' || (w > d && d <= 30);
                        if (isX) object3d.material.map.repeat.set(Math.max(1, Math.round(w / 14)), 1);
                        else object3d.material.map.repeat.set(1, Math.max(1, Math.round(d / 14)));
                    } else if (data.type === 'sidewalk') {
                        object3d.material.map.repeat.set(Math.max(1, Math.round(w / 3)), Math.max(1, Math.round(d / 3)));
                    } else if (data.type === 'grass' || data.type === 'lawn' || data.type === 'park') {
                        object3d.material.map.repeat.set(Math.max(1, Math.round(w / 8)), Math.max(1, Math.round(d / 8)));
                    } else if (data.type === 'plaza') {
                        object3d.material.map.repeat.set(Math.max(1, Math.round(w / 6)), Math.max(1, Math.round(d / 6)));
                    }
                    object3d.material.map.needsUpdate = true;
                }
            }
            this.selectionBox.update();
            return;
        }
        if (category === 'bounds' && ['minX', 'maxX', 'minZ', 'maxZ'].includes(changedKey)) {
            const w = Math.max(2, (Number(data.maxX) || 0) - (Number(data.minX) || 0));
            const d = Math.max(2, (Number(data.maxZ) || 0) - (Number(data.minZ) || 0));
            const cx = ((Number(data.minX) || 0) + (Number(data.maxX) || 0)) / 2;
            const cz = ((Number(data.minZ) || 0) + (Number(data.maxZ) || 0)) / 2;
            object3d.position.set(cx, 12, cz);
            object3d.scale.set(1, 1, 1);
            object3d.children.forEach(c => {
                if (c.geometry && c.geometry.dispose) c.geometry.dispose();
                c.geometry = new THREE.BoxGeometry(w, 24, d);
            });
            this.selectionBox.update();
            return;
        }
        if (category === 'pois' && changedKey === 'radius') {
            const r = Math.max(1, Number(data.radius) || 6);
            object3d.scale.set(1, 1, 1);
            const ring = object3d.children[0];
            if (ring) {
                if (ring.geometry && ring.geometry.dispose) ring.geometry.dispose();
                ring.geometry = new THREE.CylinderGeometry(r, r, 0.3, 24, 1, true);
            }
            this.selectionBox.update();
            return;
        }
        // Metadata fields (name, id, title, sub, prompt, etc.) only need outliner refresh
        this.renderOutliner();
    }

    async addNewItem(category) {
        if (category === 'bounds') {
            this.showToast('Map bounds (player, vehicle, npc) are fixed keys — select one to scale it.');
            return;
        }
        this.recordUndoState();

        const target = this.orbit && this.orbit.target ? this.orbit.target : new THREE.Vector3(0, 0, 0);
        const x = Math.round(target.x);
        const z = Math.round(target.z);
        const idSuffix = Date.now().toString().slice(-4);

        const templates = {
            terrain: {
                id: `terrain_${idSuffix}`,
                name: 'Новый участок (парк/дорога)',
                type: 'grass',
                x, y: -0.49, z,
                width: 30, height: 1.0, depth: 30,
                color: 3046706
            },
            hills: {
                x, y: -0.5, z, r: 45, h: 32, seed: 10
            },
            landmarks: {
                id: `landmark_${idSuffix}`,
                name: `Здание ${idSuffix}`,
                model: 'models/fountain.glb',
                x, y: 0, z, rotY: 0, scale: 1
            },
            stalls: {
                id: `stall_${idSuffix}`,
                title: 'ПЯН-СЕ',
                sub: 'Стритфуд',
                color: 12070156,
                accent: 16698133,
                model: 'models/stall_pyanse.glb',
                x, y: 0, z, rotY: 0, scale: 1
            },
            vehicles: {
                id: `car_${(this.worldMap.vehicles || []).length}`,
                name: 'Toyota Chaser Tourer V',
                x, y: 0, z, rotation: 0, rotY: 0, scale: 1,
                color: 15856113,
                accentColor: 16096779,
                model: 'models/car_0.glb'
            },
            props: {
                id: `prop_${idSuffix}`,
                type: 'bench',
                model: 'models/bench.glb',
                x, y: 0.325, z, rotY: 0, scale: 1
            },
            pois: {
                id: `poi_${idSuffix}`,
                name: 'Новая точка',
                prompt: 'Нажмите [F]',
                x, z, radius: 6
            },
            sailboats: {
                id: `sailboat_${idSuffix}`,
                name: `Парусник ${idSuffix}`,
                x, y: -1.1, z: z + 20, rotY: 0, scale: 1,
                model: 'models/sailboat_white.glb'
            },
            tankers: {
                x: -240, y: -1.35, z, rotY: 0, scale: 1.0, speed: 1.2, dir: 1, hullColor: 0x7f1d1d,
                model: 'models/tanker.glb'
            },
            spawnPoints: { id: `spawn_${idSuffix}`, name: `Точка спавна ${idSuffix}`, x, y: 0, z, yaw: 0 }
        };

        const item = templates[category];
        if (!item) return;

        if (category === 'hills') {
            this.worldMap.hills = this.worldMap.hills || { east: [], north: [], south: [] };
            this.worldMap.hills.east.push(item);
        } else {
            this.worldMap[category] = this.worldMap[category] || [];
            this.worldMap[category].push(item);
        }

        await this.rebuildSceneFromMap();
        const created = this.editableObjects.find(e => e.data === item);
        if (created) this.selectEntry(created);
        this.showToast(`Added new item to ${category}`);
    }

    async duplicateSelected() {
        if (!this.selected) return;
        const { category, data } = this.selected;
        if (category === 'bounds') {
            this.showToast('Map bounds cannot be duplicated');
            return;
        }
        this.recordUndoState();

        const clone = JSON.parse(JSON.stringify(data));
        if (Array.isArray(clone)) {
            clone[0] = Math.round((clone[0] + 4) * 100) / 100;
            clone[1] = Math.round((clone[1] + 4) * 100) / 100;
        } else {
            if ('x' in clone) clone.x = Math.round((clone.x + 4) * 100) / 100;
            if ('z' in clone) clone.z = Math.round((clone.z + 4) * 100) / 100;
            if (clone.id) clone.id = `${clone.id}_copy`;
            if (clone.label && typeof clone.label === 'object') {
                clone.label.x = Math.round(((clone.label.x || 0) + 4) * 100) / 100;
                clone.label.z = Math.round(((clone.label.z || 0) + 4) * 100) / 100;
            }
        }
        if (category === 'hills') {
            this.worldMap.hills.east.push(clone);
        } else {
            this.worldMap[category].push(clone);
        }

        await this.rebuildSceneFromMap();
        const created = this.editableObjects.find(e => e.data === clone);
        if (created) this.selectEntry(created);
        this.showToast(`Duplicated item in ${category}`);
    }

    async deleteSelected() {
        if (!this.selected) return;
        const { category, index, data } = this.selected;
        if (category === 'bounds') {
            this.showToast('Map bounds cannot be deleted — resize them instead');
            return;
        }
        this.recordUndoState();

        if (category === 'hills' && this.worldMap.hills) {
            for (const dir of ['east', 'north', 'south']) {
                const arr = this.worldMap.hills[dir] || [];
                const idx = arr.indexOf(data);
                if (idx !== -1) {
                    arr.splice(idx, 1);
                    break;
                }
            }
        } else if (Array.isArray(this.worldMap[category])) {
            const idx = this.worldMap[category].indexOf(data);
            if (idx !== -1) {
                this.worldMap[category].splice(idx, 1);
            } else {
                this.worldMap[category].splice(index, 1);
            }
        }
        this.selected = null;
        await this.rebuildSceneFromMap();
        this.renderInspector();
        this.showToast(`Deleted item from ${category}`);
    }

    async makeMapSquare() {
        this.recordUndoState();
        const size = 340;
        const halfZ = size / 2; // 170
        if (Array.isArray(this.worldMap.terrain)) {
            for (const slab of this.worldMap.terrain) {
                if (slab.type === 'ocean') {
                    slab.depth = Math.max(1200, size * 3);
                } else if (['beach', 'promenade', 'ground'].includes(slab.type) || slab.id === 'east_ground') {
                    slab.depth = size;
                    if (slab.type === 'east_ground' || slab.id === 'east_ground') {
                        slab.width = 263;
                        slab.x = 162.5;
                    }
                } else if (slab.id === 'road' || slab.id === 'road_morskaya') {
                    slab.depth = size;
                }
            }
        }
        if (this.worldMap.bounds) {
            if (this.worldMap.bounds.player) {
                Object.assign(this.worldMap.bounds.player, {
                    minX: -46, maxX: 294, minZ: -halfZ, maxZ: halfZ
                });
            }
            if (this.worldMap.bounds.vehicle) {
                Object.assign(this.worldMap.bounds.vehicle, {
                    minX: -13, maxX: 290, minZ: -(halfZ - 5), maxZ: halfZ - 5
                });
            }
        }
        // Only shift original perimeter eastern hills that don't have a custom seed
        if (this.worldMap.hills && Array.isArray(this.worldMap.hills.east)) {
            for (const h of this.worldMap.hills.east) {
                if (h.x >= 55 && h.x <= 90 && !h.seed) {
                    h.x += 230;
                }
            }
        }
        await this.rebuildSceneFromMap();
        const eastGroundEntry = this.editableObjects.find(
            e => e.category === 'terrain' && e.data && (e.data.type === 'east_ground' || e.data.id === 'east_ground')
        );
        if (eastGroundEntry) {
            this.selectEntry(eastGroundEntry);
        }
        this.showToast('Scaled base map & bounds to 340×340m square! Click "Save world_map.json" to persist.');
    }

    downloadSelectedObjectGLB() {
        if (!this.selected || !this.selected.object3d) return;
        const { data, object3d } = this.selected;
        const clone = object3d.clone(true);
        for (let i = clone.children.length - 1; i >= 0; i--) {
            const child = clone.children[i];
            if (child.name === 'bounding_box_cordon' || child.userData?.isCordon || child.name === 'fountainParticles') {
                clone.remove(child);
            }
        }
        clone.position.set(0, 0, 0);
        clone.rotation.set(0, 0, 0);
        clone.scale.set(1, 1, 1);

        const glbBytes = exportObjectToGLB(clone);
        const rawName = ((!Array.isArray(data) && data.model) ? data.model.replace('models/', '') : (data.id || 'model'))
            .replace(/\.glb$/i, '') + '.glb';

        const blob = new Blob([glbBytes], { type: 'model/gltf-binary' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = rawName;
        a.click();
        URL.revokeObjectURL(a.href);
        this.showToast(`Downloaded ${rawName} (${(glbBytes.byteLength / 1024).toFixed(1)} KB)`);
    }

    async exportAllModelsToServer(skipSceneRebuild = false) {
        this.showToast('Building & exporting all 35 3D models to .glb...');
        const models = buildAllExportableModels(this.worldMap);
        const entries = models instanceof Map ? Array.from(models.entries()) : Object.entries(models);
        let savedCount = 0;

        for (const [name, obj] of entries) {
            const fileName = name.endsWith('.glb') ? name : `${name}.glb`;
            const glbBytes = exportObjectToGLB(obj);
            const res = await fetch(`/api/models/${fileName}`, {
                method: 'PUT',
                body: glbBytes
            });
            if (res.ok) {
                savedCount++;
            }
        }

        ModelLoader.cache.clear();
        await this.refreshAvailableModels();
        if (!skipSceneRebuild) {
            await this.rebuildSceneFromMap();
        }
        this.showToast(`Exported ${savedCount}/${entries.length} .glb models to static/models/!`);
        return { total: entries.length, saved: savedCount };
    }

    serializeWorldMap() {
        return JSON.stringify(
            this.worldMap,
            (key, value) => (key.startsWith('_') ? undefined : value),
            2
        );
    }

    async saveWorldMapToDisk() {
        try {
            const res = await fetch('/api/world-map', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: this.serializeWorldMap()
            });
            if (res.ok) {
                this.showToast('Saved static/data/world_map.json to disk!');
                return;
            }
        } catch {
            // Fall back to download if dev server API is not reachable
        }
        this.downloadWorldMapJSON();
    }

    downloadWorldMapJSON() {
        const json = this.serializeWorldMap() + '\n';
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'world_map.json';
        a.click();
        URL.revokeObjectURL(a.href);
        this.showToast('Downloaded world_map.json');
    }

    setTransformMode(mode) {
        if (mode === 'pan') {
            this.panModeActive = true;
            if (this.transformControl) {
                this.transformControl.detach();
            }
            this.updateOrbitMouseMapping(true);
        } else {
            this.panModeActive = false;
            this.transformMode = mode;
            this.updateOrbitMouseMapping(this.spaceKeyHeld);
            if (this.transformControl) {
                if (this.selected && this.selected.object3d) {
                    this.transformControl.attach(this.selected.object3d);
                }
                this.transformControl.setMode(mode);
            }
        }
        document.getElementById('btn-mode-translate').classList.toggle('active', !this.panModeActive && this.transformMode === 'translate');
        document.getElementById('btn-mode-rotate').classList.toggle('active', !this.panModeActive && this.transformMode === 'rotate');
        document.getElementById('btn-mode-scale').classList.toggle('active', !this.panModeActive && this.transformMode === 'scale');
        const btnPan = document.getElementById('btn-mode-pan');
        if (btnPan) {
            btnPan.classList.toggle('active', this.panModeActive);
        }
        if (this.renderer && this.renderer.domElement) {
            this.renderer.domElement.style.cursor = this.panModeActive ? 'grab' : '';
        }
    }

    bindUI() {
        document.getElementById('btn-mode-translate').addEventListener('click', () => this.setTransformMode('translate'));
        document.getElementById('btn-mode-rotate').addEventListener('click', () => this.setTransformMode('rotate'));
        document.getElementById('btn-mode-scale').addEventListener('click', () => this.setTransformMode('scale'));
        const btnPan = document.getElementById('btn-mode-pan');
        if (btnPan) {
            btnPan.addEventListener('click', () => this.setTransformMode(this.panModeActive ? 'translate' : 'pan'));
        }
        const btnResetCam = document.getElementById('btn-reset-camera');
        if (btnResetCam) {
            btnResetCam.addEventListener('click', () => this.resetCameraView());
        }

        const btnUndo = document.getElementById('btn-undo');
        if (btnUndo) btnUndo.addEventListener('click', () => this.undo());
        const btnRedo = document.getElementById('btn-redo');
        if (btnRedo) btnRedo.addEventListener('click', () => this.redo());

        const chkBounds = document.getElementById('chk-show-bounds');
        if (chkBounds) {
            chkBounds.addEventListener('change', (e) => {
                this.showBounds = e.target.checked;
                this.boundsGroup.visible = this.showBounds;
            });
        }
        const btnSquare = document.getElementById('btn-make-square');
        if (btnSquare) {
            btnSquare.addEventListener('click', () => this.makeMapSquare());
        }

        document.getElementById('chk-show-colliders').addEventListener('change', (e) => {
            this.showColliders = e.target.checked;
            this.colliderGroup.visible = this.showColliders;
        });
        document.getElementById('chk-show-pois').addEventListener('change', (e) => {
            this.showPois = e.target.checked;
            this.poiGroup.visible = this.showPois;
        });

        document.getElementById('outliner-filter').addEventListener('input', (e) => {
            this.filterText = e.target.value;
            this.renderOutliner();
        });

        document.getElementById('btn-export-all-glb').addEventListener('click', () => this.exportAllModelsToServer());
        document.getElementById('btn-save-disk').addEventListener('click', () => this.saveWorldMapToDisk());
        document.getElementById('btn-download-json').addEventListener('click', () => this.downloadWorldMapJSON());

        const uploadInput = document.getElementById('input-upload-glb');
        document.getElementById('btn-upload-glb').addEventListener('click', () => uploadInput.click());
        uploadInput.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const buf = await file.arrayBuffer();
            try {
                await parseGLB(buf);
            } catch (err) {
                this.showToast(`Invalid .glb file: ${err.message}`);
                return;
            }
            const targetName = file.name.endsWith('.glb') ? file.name : `${file.name}.glb`;

            const res = await fetch(`/api/models/${encodeURIComponent(targetName)}`, {
                method: 'PUT',
                body: buf
            });
            if (res.ok) {
                this.recordUndoState();
                ModelLoader.cache.clear();
                await this.refreshAvailableModels();
                if (this.selected && this.selected.data && !Array.isArray(this.selected.data)) {
                    this.selected.data.model = `models/${targetName}`;
                }
                await ModelLoader.load(`models/${targetName}`);
                await this.rebuildSceneFromMap();
                this.renderInspector();
                this.showToast(`Imported models/${targetName} and updated scene!`);
            }
            uploadInput.value = '';
        });

        window.addEventListener('keydown', (e) => {
            const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
            const key = e.key.toLowerCase();

            // Undo / Redo shortcuts
            if ((e.ctrlKey || e.metaKey) && !inInput) {
                if (key === 'z' && !e.shiftKey) {
                    e.preventDefault();
                    this.undo();
                    return;
                }
                if (key === 'y' || (key === 'z' && e.shiftKey)) {
                    e.preventDefault();
                    this.redo();
                    return;
                }
            }

            if (inInput) return;

            this.keysPressed.add(e.code);

            if (e.code === 'Space') {
                this.spaceKeyHeld = true;
                this.updateOrbitMouseMapping(true);
                return;
            }

            if (!this.rightMouseHeld && !this.panModeActive) {
                if (key === 'w') this.setTransformMode('translate');
                else if (key === 'e') this.setTransformMode('rotate');
                else if (key === 'r') this.setTransformMode('scale');
                else if (key === 'h') this.setTransformMode('pan');
                else if (key === 'f') this.focusSelected();
                else if (key === 'c' || e.code === 'Home') this.resetCameraView();
                else if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelected();
            } else if (key === 'h') {
                this.setTransformMode('translate');
            } else if (key === 'c' || e.code === 'Home') {
                this.resetCameraView();
            }
        });

        window.addEventListener('keyup', (e) => {
            this.keysPressed.delete(e.code);
            if (e.code === 'Space') {
                this.spaceKeyHeld = false;
                this.updateOrbitMouseMapping(this.panModeActive);
            }
        });
    }

    updateKeyboardCameraPan() {
        if (!this.orbit || !this.orbit.target || !this.camera) return;
        const allowWasd = this.rightMouseHeld || this.panModeActive;
        let forwardInput = 0;
        let rightInput = 0;

        if (this.keysPressed.has('ArrowUp') || (allowWasd && this.keysPressed.has('KeyW'))) forwardInput += 1;
        if (this.keysPressed.has('ArrowDown') || (allowWasd && this.keysPressed.has('KeyS'))) forwardInput -= 1;
        if (this.keysPressed.has('ArrowRight') || (allowWasd && this.keysPressed.has('KeyD'))) rightInput += 1;
        if (this.keysPressed.has('ArrowLeft') || (allowWasd && this.keysPressed.has('KeyA'))) rightInput -= 1;

        if (forwardInput === 0 && rightInput === 0) return;

        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        forward.y = 0;
        if (forward.lengthSq() < 1e-5) {
            forward.set(0, 0, -1);
        } else {
            forward.normalize();
        }
        const right = new THREE.Vector3(-forward.z, 0, forward.x);

        const dist = this.camera.position.distanceTo(this.orbit.target);
        const speed = Math.max(0.8, dist * 0.018);

        const move = new THREE.Vector3()
            .addScaledVector(forward, forwardInput * speed)
            .addScaledVector(right, rightInput * speed);

        this.orbit.target.add(move);
        this.camera.position.add(move);
    }

    showToast(msg) {
        const el = document.getElementById('status-toast');
        el.textContent = msg;
        el.style.display = 'block';
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => {
            el.style.display = 'none';
        }, 3200);
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        this.updateKeyboardCameraPan();
        if (this.orbit && this.orbit.update) {
            this.orbit.update();
        }
        this.renderer.render(this.scene, this.camera);
    }
}

const editor = new NabkaWorldEditor();
window.nabkaEditor = editor;
window.World = World;
window.exportAllModelsToServer = () => editor.exportAllModelsToServer();
editor.init();
