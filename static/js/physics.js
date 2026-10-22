import { resetVehiclePose } from './vehicle-motion.js';
/**
 * 3D height-aware collision and support height engine.
 * Pure math module independent of Three.js / WebGL so it can be shared or mirrored on the server.
 */

const round3 = (v) => Math.round(Number(v) * 1000) / 1000;

function normalizeModelKey(modelUrl = '') {
    return String(modelUrl || '')
        .trim()
        .replace(/^\/+/, '')
        .replace(/^\.\/+/, '');
}

/**
 * Fallback local bounding boxes used before a model has been loaded (and on headless
 * consumers such as unit tests). At runtime ModelLoader overwrites these with bounds
 * computed from the actual .glb geometry via registerModelBoundingBox().
 * Kept in sync with static/models/*.glb by static/tests/models.test.js.
 */
export const DEFAULT_MODEL_BOUNDS = {
'models/arbat_paving.glb': { minX: -14, maxX: 14, minY: -0.06, maxY: 0.06, minZ: -7, maxZ: 7 },
    'models/azimut_hotel.glb': { minX: -7.5, maxX: 7, minY: 0, maxY: 28, minZ: -15, maxZ: 15 },
    'models/bench.glb': { minX: -0.45, maxX: 0.45, minY: -0.325, maxY: 0.325, minZ: -1.3, maxZ: 1.3 },
    'models/berik.glb': { minX: -0.303, maxX: 0.303, minY: 0, maxY: 0.925, minZ: -0.578, maxZ: 0.559 },
    'models/bridge_deck.glb': { minX: -80, maxX: 80, minY: -0.9, maxY: 0.9, minZ: -3, maxZ: 3 },
    'models/bridge_pylon.glb': { minX: -12.329, maxX: 12.329, minY: -1.891, maxY: 65.821, minZ: -1.6, maxZ: 1.6 },
    'models/car_0.glb': { minX: -1.31, maxX: 1.31, minY: 0, maxY: 1.625, minZ: -2.51, maxZ: 2.51 },
    'models/car_1.glb': { minX: -1.31, maxX: 1.31, minY: 0, maxY: 1.625, minZ: -2.51, maxZ: 2.51 },
    'models/car_2.glb': { minX: -1.31, maxX: 1.31, minY: 0, maxY: 1.625, minZ: -2.51, maxZ: 2.51 },
    'models/car_3.glb': { minX: -1.31, maxX: 1.31, minY: 0, maxY: 1.625, minZ: -2.51, maxZ: 2.51 },
    'models/car_4.glb': { minX: -1.31, maxX: 1.31, minY: 0, maxY: 1.625, minZ: -2.51, maxZ: 2.51 },
    'models/dunya.glb': { minX: -0.253, maxX: 0.253, minY: 0, maxY: 0.89, minZ: -0.461, maxZ: 0.585 },
    'models/dynamo_stadium.glb': { minX: -18.625, maxX: 18, minY: 0, maxY: 19, minZ: -28, maxZ: 28 },
    'models/ferris_wheel.glb': { minX: -14.4, maxX: 14.4, minY: -0.844, maxY: 33.9, minZ: -2.7, maxZ: 2.7 },
    'models/forrester.glb': { minX: -1.31, maxX: 1.31, minY: 0, maxY: 1.867, minZ: -2.51, maxZ: 2.51 },
    'models/fortress_museum.glb': { minX: -5.502, maxX: 11, minY: 0, maxY: 7.3, minZ: -11, maxZ: 11 },
    'models/fountain.glb': { minX: -10.2, maxX: 10.2, minY: 0, maxY: 2, minZ: -10.2, maxZ: 10.2 },
    'models/impreza_wrx.glb': { minX: -1.316, maxX: 1.316, minY: 0, maxY: 1.563, minZ: -2.456, maxZ: 2.47 },
    'models/jimny.glb': { minX: -1.322, maxX: 1.31, minY: -0.187, maxY: 2.375, minZ: -2.347, maxZ: 2.25 },
    'models/lighthouse.glb': { minX: -5.5, maxX: 49.5, minY: -0.4, maxY: 18, minZ: -3, maxZ: 3 },
    'models/npc.glb': { minX: -0.68, maxX: 0.68, minY: 0.04, maxY: 2, minZ: -0.68, maxZ: 0.68 },
    'models/ocean_cinema.glb': { minX: -12.5, maxX: 11, minY: 0, maxY: 16.5, minZ: -14, maxZ: 14 },
    'models/oceanarium.glb': { minX: -12, maxX: 12, minY: 0, maxY: 16.8, minZ: -12, maxZ: 12.05 },
    'models/olympiets_complex.glb': { minX: -9.45, maxX: 9, minY: 0, maxY: 11.2, minZ: -14, maxZ: 14 },
    'models/pier.glb': { minX: -18, maxX: 18, minY: -0.3, maxY: 0.3, minZ: -3.5, maxZ: 3.5 },
    'models/player.glb': { minX: -0.74, maxX: 0.74, minY: 0, maxY: 2.67, minZ: -0.3, maxZ: 0.555 },
    'models/road_lamp.glb': { minX: -0.28, maxX: 0.28, minY: 0, maxY: 7.65, minZ: -0.28, maxZ: 0.28 },
    'models/roadster.glb': { minX: -1.231, maxX: 1.231, minY: 0, maxY: 1.262, minZ: -2.206, maxZ: 2.242 },
    'models/sailboat_blue.glb': { minX: -3.75, maxX: 3.75, minY: -0.7, maxY: 11, minZ: -1.4, maxZ: 1.4 },
    'models/sailboat_white.glb': { minX: -3.75, maxX: 3.75, minY: -0.7, maxY: 11, minZ: -1.4, maxZ: 1.4 },
    'models/seagull.glb': { minX: -1.07, maxX: 1.07, minY: -0.1, maxY: 0.21, minZ: -0.55, maxZ: 0.6 },
    'models/sopka.glb': { minX: -32.064, maxX: 31.36, minY: -12.96, maxY: 48, minZ: -32, maxZ: 32 },
    'models/stall_chifanka.glb': { minX: -2.3, maxX: 2.2, minY: 0, maxY: 4.9, minZ: -3.1, maxZ: 3.1 },
    'models/stall_coffee.glb': { minX: -2.3, maxX: 2.2, minY: 0, maxY: 4.9, minZ: -3.1, maxZ: 3.1 },
    'models/stall_pyanse.glb': { minX: -2.3, maxX: 2.2, minY: 0, maxY: 4.9, minZ: -3.1, maxZ: 3.1 },
    'models/street_lamp.glb': { minX: -0.42, maxX: 0.42, minY: 0, maxY: 5.72, minZ: -0.399, maxZ: 0.399 },
    'models/supra_restaurant.glb': { minX: -8.7, maxX: 5.5, minY: 0, maxY: 7.5, minZ: -6.5, maxZ: 6.5 },
    'models/tanker.glb': { minX: -3.5, maxX: 3.5, minY: -0.2, maxY: 10.25, minZ: -17.1, maxZ: 17.1 },
    'models/tiger_statue.glb': { minX: -1.8, maxX: 1.886, minY: 0, maxY: 2.35, minZ: -1.2, maxZ: 1.2 },
    'models/yacht_club_boathouse.glb': { minX: -3.5, maxX: 3.5, minY: -2.25, maxY: 2.25, minZ: -4.5, maxZ: 4.5 },
    'models/yacht_club_pier.glb': { minX: -15, maxX: 15, minY: -0.35, maxY: 0.35, minZ: -4, maxZ: 4 }
};

/**
 * Compound multi-box collider presets for models with complex boundaries (e.g. stadiums with gates).
 */
export const DEFAULT_COMPOUND_COLLIDERS = {
    'models/dynamo_stadium.glb': [
        { name: 'Стены и Южная трибуна', minX: -18.625, maxX: -9.5, minY: 0, maxY: 9.5, minZ: -27.75, maxZ: 27.75 },
        { name: 'Стены и Северная трибуна / Манеж', minX: 9.5, maxX: 18, minY: 0, maxY: 9.5, minZ: -27.75, maxZ: 27.75 },
        { name: 'Западная стена (южное крыло)', minX: -18.625, maxX: -6.5, minY: 0, maxY: 5.5, minZ: -27.75, maxZ: -26.5 },
        { name: 'Западная стена (северное крыло)', minX: 6.5, maxX: 18, minY: 0, maxY: 5.5, minZ: -27.75, maxZ: -26.5 },
        { name: 'Восточная стена (южное крыло)', minX: -18.625, maxX: -3.5, minY: 0, maxY: 8.75, minZ: 26, maxZ: 27.75 },
        { name: 'Восточная стена (северное крыло)', minX: 3.5, maxX: 18, minY: 0, maxY: 8.75, minZ: 26, maxZ: 27.75 }
    ]
};

function enrichBounds(raw) {
    if (!raw) return null;
    const minX = round3(raw.minX ?? 0);
    const maxX = round3(raw.maxX ?? 0);
    const minY = round3(raw.minY ?? 0);
    const maxY = round3(raw.maxY ?? 0);
    const minZ = round3(raw.minZ ?? 0);
    const maxZ = round3(raw.maxZ ?? 0);
    return {
        minX,
        maxX,
        minY,
        maxY,
        minZ,
        maxZ,
        width: round3(maxX - minX),
        height: round3(maxY - minY),
        depth: round3(maxZ - minZ),
        centerX: round3((minX + maxX) / 2),
        centerY: round3((minY + maxY) / 2),
        centerZ: round3((minZ + maxZ) / 2)
    };
}

export const MODEL_BOUNDING_BOXES = new Map();
for (const [k, v] of Object.entries(DEFAULT_MODEL_BOUNDS)) {
    MODEL_BOUNDING_BOXES.set(k, enrichBounds(v));
}

export function registerModelBoundingBox(modelUrl, bbox) {
    const key = normalizeModelKey(modelUrl);
    if (!key || !bbox) return null;
    const enriched = enrichBounds(bbox);
    MODEL_BOUNDING_BOXES.set(key, enriched);
    if (!key.startsWith('models/')) {
        MODEL_BOUNDING_BOXES.set(`models/${key}`, enriched);
    }
    return enriched;
}

export function getModelBoundingBox(modelUrl) {
    const key = normalizeModelKey(modelUrl);
    if (!key) return null;
    return MODEL_BOUNDING_BOXES.get(key) || MODEL_BOUNDING_BOXES.get(`models/${key}`) || null;
}

export function resolveEntityModelUrl(item, category = 'landmarks') {
    if (!item || typeof item !== 'object') return '';
    if (item.model) return normalizeModelKey(item.model);
    if (category === 'stalls' && item.id) return `models/stall_${item.id}.glb`;
    if (category === 'props') {
        if (item.type === 'bench' || item.model?.includes('bench')) return 'models/bench.glb';
        if (item.type === 'road_lamp' || item.model?.includes('road_lamp')) return 'models/road_lamp.glb';
        return 'models/street_lamp.glb';
    }
    if (category === 'hills') return 'models/sopka.glb';
    if (item.id) return `models/${item.id}.glb`;
    return '';
}

/**
 * Computes a world-space collider from an entity placement and its 3D model geometry bounding box.
 */
export function computeWorldColliderFromEntity(item, category = 'landmarks', localBox = null) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (item.hasCollider === false) return null;

    if (category === 'hills' || (typeof category === 'string' && category.startsWith('hills'))) {
        const x = round3(item.x || 0);
        const y = round3(item.y !== undefined ? item.y : -0.5);
        const z = round3(item.z || 0);
        const r = Number(item.r || 32);
        const rx = Number(item.rx !== undefined ? item.rx : r);
        const rz = Number(item.rz !== undefined ? item.rz : r);
        const h = Number(item.h || 48);
        const minY = y;
        const maxY = round3(y + h);

        if (Math.abs(rx - rz) < 0.001) {
            const radius = round3(rx * 0.78);
            return {
                type: 'circle',
                id: item.id || '',
                category: 'hills',
                model: 'models/sopka.glb',
                x,
                y: round3(y + h / 2),
                z,
                radius,
                minY,
                height: maxY,
                boxHeight: round3(h),
                climbable: false,
                name: item.label || item.name || 'Сопка Владивостока'
            };
        }

        const rotY = Number(item.rotY ?? item.rotation ?? 0) || 0;
        const width = round3(rx * 2 * 0.78);
        const depth = round3(rz * 2 * 0.78);
        return {
            type: 'box',
            id: item.id || '',
            category: 'hills',
            model: 'models/sopka.glb',
            x,
            y: round3(y + h / 2),
            z,
            width,
            depth,
            halfW: width / 2,
            halfD: depth / 2,
            minY,
            height: maxY,
            boxHeight: round3(h),
            rotY,
            climbable: false,
            name: item.label || item.name || 'Сопка Владивостока'
        };
    }

    const modelUrl = resolveEntityModelUrl(item, category);
    const compoundBoxes = (Array.isArray(item.colliderBoxes) && item.colliderBoxes.length > 0)
        ? item.colliderBoxes
        : (DEFAULT_COMPOUND_COLLIDERS[modelUrl] || DEFAULT_COMPOUND_COLLIDERS[`models/${modelUrl}`] || null);

    const isBench = category === 'props' && (item.type === 'bench' || modelUrl.includes('bench'));
    const px = Number(item.x) || 0;
    const py = item.y !== undefined ? Number(item.y) : (isBench ? 0.325 : 0);
    const pz = Number(item.z) || 0;
    const rotY = Number(item.rotY ?? item.rotation ?? 0) || 0;
    const rawScale = Number(item.scale);
    const scale = (Number.isFinite(rawScale) && rawScale > 0) ? rawScale : 1;
    const name = item.name || item.title || (item.label && item.label.text) || item.id || modelUrl;

    if (Array.isArray(compoundBoxes) && compoundBoxes.length > 0) {
        const cos = Math.cos(rotY);
        const sin = Math.sin(rotY);
        return compoundBoxes.map((rawBox, idx) => {
            const b = enrichBounds(rawBox);
            const ox = b.centerX * scale;
            const oy = b.centerY * scale;
            const oz = b.centerZ * scale;

            const cx = round3(px + ox * cos + oz * sin);
            const cy = round3(py + oy);
            const cz = round3(pz - ox * sin + oz * cos);
            const minY = round3(py + b.minY * scale);
            const maxY = round3(py + b.maxY * scale);
            const width = round3(b.width * scale);
            const depth = round3(b.depth * scale);
            const boxHeight = round3(b.height * scale);
            const climbable = rawBox.climbable !== undefined ? Boolean(rawBox.climbable) : (maxY <= 2.5);
            const boxName = rawBox.name ? `${name} - ${rawBox.name}` : `${name} [box ${idx + 1}]`;

            return {
                type: 'box',
                id: item.id ? `${item.id}_${idx}` : '',
                parentId: item.id || '',
                category,
                model: modelUrl,
                x: cx,
                y: cy,
                z: cz,
                width,
                depth,
                halfW: width / 2,
                halfD: depth / 2,
                minY,
                height: maxY,
                boxHeight,
                rotY,
                climbable,
                name: boxName
            };
        });
    }

    const box = localBox ? enrichBounds(localBox) : getModelBoundingBox(modelUrl);
    if (!box || box.width <= 0 || box.depth <= 0) return null;

    const width = round3(box.width * scale);
    const boxHeight = round3(box.height * scale);
    const depth = round3(box.depth * scale);

    const ox = box.centerX * scale;
    const oy = box.centerY * scale;
    const oz = box.centerZ * scale;
    const cos = Math.cos(rotY);
    const sin = Math.sin(rotY);

    const cx = round3(px + ox * cos + oz * sin);
    const cy = round3(py + oy);
    const cz = round3(pz - ox * sin + oz * cos);
    const minY = round3(py + box.minY * scale);
    const maxY = round3(py + box.maxY * scale);
    const climbable = item.climbable !== undefined ? Boolean(item.climbable) : (maxY <= 2.5);

    return {
        type: 'box',
        id: item.id || '',
        category,
        model: modelUrl,
        x: cx,
        y: cy,
        z: cz,
        width,
        depth,
        halfW: width / 2,
        halfD: depth / 2,
        minY,
        height: maxY,
        boxHeight,
        rotY,
        climbable,
        name
    };
}

export function createColliderStore(initialColliders = []) {
    const colliders = [];

    const engine = {
        colliders,

        clear() {
            colliders.length = 0;
        },

        addCircleCollider(x, z, radius, height = 10, climbable = false, name = '', minY = 0, id = '', category = '') {
            const boxHeight = height - minY;
            colliders.push({
                type: 'circle',
                id,
                category,
                x,
                y: minY + boxHeight / 2,
                z,
                radius,
                minY,
                height,
                boxHeight,
                climbable,
                name
            });
        },

        addBoxCollider(x, z, width, depth, height = 12, climbable = false, name = '', rotY = 0, minY = 0, id = '', category = '') {
            const boxHeight = height - minY;
            colliders.push({
                type: 'box',
                id,
                category,
                x,
                y: minY + boxHeight / 2,
                z,
                width,
                depth,
                halfW: width / 2,
                halfD: depth / 2,
                minY,
                height,
                boxHeight,
                climbable,
                name,
                rotY
            });
        },

        addCollider(col) {
            if (!col) return null;
            if (Array.isArray(col)) {
                return col.map(c => this.addCollider(c));
            }
            if (col.type === 'circle') {
                const minY = col.minY ?? 0;
                const height = col.height ?? 10;
                const boxHeight = col.boxHeight ?? (height - minY);
                const entry = {
                    ...col,
                    type: 'circle',
                    minY,
                    height,
                    boxHeight,
                    y: col.y ?? (minY + boxHeight / 2)
                };
                colliders.push(entry);
                return entry;
            }
            const width = col.width ?? ((col.halfW || 2) * 2);
            const depth = col.depth ?? ((col.halfD || 2) * 2);
            const minY = col.minY ?? 0;
            const height = col.height ?? 12;
            const boxHeight = col.boxHeight ?? (height - minY);
            const entry = {
                ...col,
                type: 'box',
                width,
                depth,
                halfW: width / 2,
                halfD: depth / 2,
                minY,
                height,
                boxHeight,
                y: col.y ?? (minY + boxHeight / 2),
                rotY: col.rotY ?? col.rotation ?? 0
            };
            colliders.push(entry);
            return entry;
        },

        addModelCollider(item, category = 'landmarks', localBox = null) {
            const col = computeWorldColliderFromEntity(item, category, localBox);
            if (!col) return null;
            if (Array.isArray(col)) {
                return col.map(c => this.addCollider(c));
            }
            return this.addCollider(col);
        },

        loadFromConfig(config = []) {
            if (Array.isArray(config)) {
                for (const def of config) {
                    if (!def) continue;
                    if (def.type === 'circle') {
                        this.addCircleCollider(def.x, def.z, def.radius, def.height, def.climbable, def.name, def.minY ?? 0, def.id || '', def.category || '');
                    } else if (def.type === 'box') {
                        this.addBoxCollider(def.x, def.z, def.width, def.depth, def.height, def.climbable, def.name, def.rotY ?? def.rotation ?? 0, def.minY ?? 0, def.id || '', def.category || '');
                    }
                }
                return;
            }

            if (!config || typeof config !== 'object') return;

            const hasModelEntities =
                Array.isArray(config.landmarks) ||
                Array.isArray(config.stalls) ||
                Array.isArray(config.props) ||
                Boolean(config.hills && typeof config.hills === 'object');

            if (hasModelEntities) {
                for (const lm of (config.landmarks || [])) {
                    this.addModelCollider(lm, 'landmarks');
                }
                for (const s of (config.stalls || [])) {
                    this.addModelCollider(s, 'stalls');
                }
                for (const p of (config.props || [])) {
                    if (p && p.hasCollider !== false) {
                        this.addModelCollider(p, 'props');
                    }
                }
                const hills = config.hills || {};
                for (const dir of ['east', 'north', 'south']) {
                    for (const h of (hills[dir] || [])) {
                        this.addModelCollider(h, 'hills');
                    }
                }
                return;
            }

            if (Array.isArray(config.staticColliders)) {
                this.loadFromConfig(config.staticColliders);
            }
        },

        /**
         * Returns base terrain height + checks if entity is standing on top of any climbable 3D collider
         * or parked vehicle.
         */
        getSupportHeightAt(x, z, currentY, entityRadius = 0.45, vehiclesList = [], activeVehicle = null) {
            let baseGround = 0;
            // Seaside amphitheater steps down to Yubileyny Beach (except pier corridors)
            const onPier = (z >= 42 && z <= 54) || (z >= 112 && z <= 124) || (z >= 142 && z <= 154);
            if (x < -15 && !onPier) {
                baseGround = Math.max(-1.2, (x + 15) * 0.16);
            }

            let maxSupport = baseGround;
            for (const col of colliders) {
                if (col.minY !== undefined && currentY + 1.8 < col.minY) continue;
                // Only consider surfaces the entity is high enough to step/land on
                if (currentY >= col.height - 0.52) {
                    if (col.type === 'circle') {
                        const dist = Math.hypot(x - col.x, z - col.z);
                        if (dist <= col.radius + entityRadius * 0.4) {
                            if (col.height > maxSupport) maxSupport = col.height;
                        }
                    } else if (col.type === 'box') {
                        let dx = x - col.x;
                        let dz = z - col.z;
                        if (col.rotY) {
                            const cos = Math.cos(col.rotY);
                            const sin = Math.sin(col.rotY);
                            const rx = dx * cos - dz * sin;
                            const rz = dx * sin + dz * cos;
                            dx = rx;
                            dz = rz;
                        }
                        if (
                            Math.abs(dx) <= col.halfW + entityRadius * 0.4 &&
                            Math.abs(dz) <= col.halfD + entityRadius * 0.4
                        ) {
                            if (col.height > maxSupport) maxSupport = col.height;
                        }
                    }
                }
            }

            // Also allow jumping on top of parked JDM cars
            if (currentY >= 1.25 && Array.isArray(vehiclesList)) {
                for (const v of vehiclesList) {
                    if (activeVehicle === v) continue;
                    const vx = v.position ? v.position.x : (v.group ? v.group.position.x : v.x);
                    const vz = v.position ? v.position.z : (v.group ? v.group.position.z : v.z);
                    if (vx !== undefined && vz !== undefined) {
                        const dist = Math.hypot(x - vx, z - vz);
                        if (dist < 2.1) {
                            maxSupport = Math.max(maxSupport, 1.55);
                        }
                    }
                }
            }

            return maxSupport;
        },

        /**
         * Resolves horizontal (X, Z) collisions against all world colliders taller than currentY.
         * Mutates `pos.x` and `pos.z` in place and returns true if any collision occurred.
         */
        resolveWorldCollision(pos, radius, currentY = 0) {
            let hitAny = false;
            for (const col of colliders) {
                // Skip overhead structures high above the entity (e.g. Golden Bridge deck at y=24)
                if (col.minY !== undefined && currentY + 1.8 < col.minY) continue;
                // If entity is above the top of this structure (or it is a low walkable surface <= 0.52m), do not block horizontally
                if (currentY >= col.height - 0.52) continue;

                if (col.type === 'circle') {
                    const dx = pos.x - col.x;
                    const dz = pos.z - col.z;
                    const dist = Math.hypot(dx, dz);
                    const minDist = col.radius + radius;
                    if (dist < minDist) {
                        hitAny = true;
                        const nx = dist > 0.0001 ? dx / dist : 1;
                        const nz = dist > 0.0001 ? dz / dist : 0;
                        pos.x = col.x + nx * minDist;
                        pos.z = col.z + nz * minDist;
                    }
                } else if (col.type === 'box') {
                    let dx = pos.x - col.x;
                    let dz = pos.z - col.z;
                    const hasRot = Boolean(col.rotY);
                    if (hasRot) {
                        const cos = Math.cos(col.rotY);
                        const sin = Math.sin(col.rotY);
                        const rx = dx * cos - dz * sin;
                        const rz = dx * sin + dz * cos;
                        dx = rx;
                        dz = rz;
                    }
                    const clampedX = Math.max(-col.halfW, Math.min(col.halfW, dx));
                    const clampedZ = Math.max(-col.halfD, Math.min(col.halfD, dz));
                    const diffX = dx - clampedX;
                    const diffZ = dz - clampedZ;
                    const distSq = diffX * diffX + diffZ * diffZ;

                    if (distSq < radius * radius) {
                        hitAny = true;
                        const dist = Math.sqrt(distSq);
                        let pushX = 0;
                        let pushZ = 0;
                        if (dist > 0.0001) {
                            const overlap = radius - dist;
                            pushX = (diffX / dist) * overlap;
                            pushZ = (diffZ / dist) * overlap;
                        } else {
                            // Inside box center fallback: push out along nearest axis
                            const penX = col.halfW + radius - Math.abs(dx);
                            const penZ = col.halfD + radius - Math.abs(dz);
                            if (penX < penZ) {
                                pushX = dx >= 0 ? penX : -penX;
                            } else {
                                pushZ = dz >= 0 ? penZ : -penZ;
                            }
                        }
                        if (hasRot) {
                            const cosR = Math.cos(col.rotY);
                            const sinR = Math.sin(col.rotY);
                            pos.x += pushX * cosR + pushZ * sinR;
                            pos.z += -pushX * sinR + pushZ * cosR;
                        } else {
                            pos.x += pushX;
                            pos.z += pushZ;
                        }
                    }
                }
            }
            return hitAny;
        }
    };

    if (Array.isArray(initialColliders) && initialColliders.length > 0) {
        engine.loadFromConfig(initialColliders);
    }

    return engine;
}

export const PhysicsEngine = createColliderStore();

// ============================================================================
// REALISTIC VEHICLE DYNAMICS & RIGID-BODY COLLISION IMPULSE ENGINE
// ============================================================================

export const CAR_SPECS = {
    defaultMass: 1450,
    mass: 1450,
    length: 4.8,
    width: 2.3,
    wheelbase: 2.7,
    axleOffset: 1.25,
    collisionRadius: 1.15,
    restitution: 0.25,
    maxSpeedForward: 44.44,
    maxSpeedBoost: 55.56,
    maxSpeedReverse: -10.0,
    accelForward: 24.0,
    accelBoost: 32.0,
    accelBrake: 12.0,
    accelReverse: 8.0,
    accelHandbrake: 18.0,
    dragRoll: 1.4,
    dragAero: 0.002,
    muGrip: 1.15,
    muDrift: 0.55,
    lateralDampingGrip: 12.0,
    lateralDampingDrift: 2.6,
    steerGain: 0.52,
    driftDriveEfficiency: 0.50,
    driftScrubDrag: 0.012,
    slipAngleStart: 0.14,
    slipAngleFull: 0.55,
    lossSpeedStart: 1.0,
    lossSpeedFull: 5.0,
    handbrakeSlipFloor: 0.35,
    tractionLossRate: 12.0,
    tractionRecoveryRate: 8.0
};

export function rotationalVelocity(r, omega) {
    return { x: omega * r.z, z: -omega * r.x };
}

export function crossYaw(r, q) {
    return r.z * q.x - r.x * q.z;
}

export function normalizeAngle(angle) {
    let a = angle % (Math.PI * 2);
    if (a > Math.PI) a -= Math.PI * 2;
    if (a < -Math.PI) a += Math.PI * 2;
    return a;
}

export function smoothstep(edge0, edge1, x) {
    if (edge0 >= edge1) return x >= edge1 ? 1 : 0;
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

export function getVehicleCollisionCircles(car, axleOffset = CAR_SPECS.axleOffset, radius = CAR_SPECS.collisionRadius) {
    const yaw = Number(car.yaw) || 0;
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    const cx = Number(car.x) || 0;
    const cz = Number(car.z) || 0;
    return [
        {
            name: 'front',
            x: cx + axleOffset * sinY,
            z: cz + axleOffset * cosY,
            radius
        },
        {
            name: 'center',
            x: cx,
            z: cz,
            radius
        },
        {
            name: 'rear',
            x: cx - axleOffset * sinY,
            z: cz - axleOffset * cosY,
            radius
        }
    ];
}

export function getVehicleInertia(car) {
    const rawMass = Number(car.mass);
    const mass = isFinite(rawMass) && rawMass > 0 ? rawMass : CAR_SPECS.defaultMass;
    const rawW = Number(car.width);
    const width = isFinite(rawW) && rawW > 0 ? rawW : CAR_SPECS.width;
    const rawL = Number(car.length);
    const length = isFinite(rawL) && rawL > 0 ? rawL : CAR_SPECS.length;
    const rawI = Number(car.yawInertia);
    return isFinite(rawI) && rawI > 0 ? rawI : (mass * (width * width + length * length) / 12);
}

export function stepSingleVehicleDynamics(car, input, dt) {
    if (!isFinite(dt) || dt <= 0) return;
    const rawX = Number(car.x);
    car.x = isFinite(rawX) ? rawX : 0;
    const rawZ = Number(car.z);
    car.z = isFinite(rawZ) ? rawZ : 0;
    const rawVx = Number(car.vx);
    car.vx = isFinite(rawVx) ? rawVx : 0;
    const rawVz = Number(car.vz);
    car.vz = isFinite(rawVz) ? rawVz : 0;
    const rawYaw = Number(car.yaw);
    car.yaw = isFinite(rawYaw) ? rawYaw : 0;
    const rawYawRate = Number(car.yawRate);
    car.yawRate = isFinite(rawYawRate) ? rawYawRate : 0;
    const rawTractionLoss = Number(car.tractionLoss);
    car.tractionLoss = isFinite(rawTractionLoss) ? Math.max(0, Math.min(1, rawTractionLoss)) : 0;

    if (input && typeof input === 'object') {
        const rawThrottle = Number(input.throttle);
        const throttle = Math.max(-1, Math.min(1, isFinite(rawThrottle) ? rawThrottle : 0));
        const rawSteer = Number(input.steer);
        const steer = Math.max(-1, Math.min(1, isFinite(rawSteer) ? rawSteer : 0));
        const handbrake = Boolean(input.handbrake);
        const boost = Boolean(input.boost);

        const currentYaw = car.yaw;
        const sinY = Math.sin(currentYaw);
        const cosY = Math.cos(currentYaw);

        let vLong = car.vx * sinY + car.vz * cosY;
        let vLat = car.vx * cosY - car.vz * sinY;

        // Dynamic tire traction loss & scrub drag:
        // Drifting is inherently less efficient (power wasted spinning/smoking tires and overcoming slide friction).
        // Car speed is penalized during drift; when the car straightens out and regains traction,
        // it surges forward as full propulsion efficiency restores and tire scrub drag disappears.
        const speedBefore = Math.hypot(vLong, vLat);
        const slipAngle = Math.atan2(Math.abs(vLat), Math.max(Math.abs(vLong), 0.5));
        const slipFactor = smoothstep(CAR_SPECS.slipAngleStart, CAR_SPECS.slipAngleFull, slipAngle);
        const speedFactor = smoothstep(CAR_SPECS.lossSpeedStart, CAR_SPECS.lossSpeedFull, speedBefore);

        const handbrakeFloor = (handbrake && throttle > 0) ? CAR_SPECS.handbrakeSlipFloor : 0;
        const targetLoss = speedFactor * Math.max(slipFactor, handbrakeFloor);

        const currentLoss = car.tractionLoss;
        const lossRate = targetLoss > currentLoss ? CAR_SPECS.tractionLossRate : CAR_SPECS.tractionRecoveryRate;
        car.tractionLoss = currentLoss + (targetLoss - currentLoss) * (1 - Math.exp(-lossRate * dt));

        // Dissipative tire scrub drag during slide/drift (proportional to tractionLoss and v^2)
        const scrubDecel = CAR_SPECS.driftScrubDrag * car.tractionLoss * speedBefore * speedBefore;
        if (speedBefore > 0.001 && scrubDecel > 0) {
            const scrubScale = Math.max(0, 1 - (scrubDecel * dt) / speedBefore);
            vLong *= scrubScale;
            vLat *= scrubScale;
        }

        car.isBraking = false;
        const maxFwd = boost ? CAR_SPECS.maxSpeedBoost : CAR_SPECS.maxSpeedForward;

        // Continuous natural drag & rolling resistance opposing motion at all times
        const drag = CAR_SPECS.dragRoll + CAR_SPECS.dragAero * vLong * vLong;
        if (vLong > 0) {
            vLong = Math.max(0, vLong - drag * dt);
        } else if (vLong < 0) {
            vLong = Math.min(0, vLong + drag * dt);
        }

        if (throttle > 0) {
            if (vLong < -0.2) {
                // Foot braking against reverse motion
                vLong = Math.min(0, vLong + CAR_SPECS.accelBrake * throttle * dt);
                car.isBraking = true;
            } else {
                const efficiency = 1 - (1 - CAR_SPECS.driftDriveEfficiency) * car.tractionLoss;
                const accel = (boost ? CAR_SPECS.accelBoost : CAR_SPECS.accelForward) * throttle * efficiency;
                // Add propulsion only up to maxFwd without truncating existing momentum
                if (vLong < maxFwd) {
                    vLong += Math.min(accel * dt, maxFwd - vLong);
                }
            }
        } else if (throttle < 0) {
            if (vLong > 0.2) {
                // Foot braking against forward motion
                vLong = Math.max(0, vLong - CAR_SPECS.accelBrake * Math.abs(throttle) * dt);
                car.isBraking = true;
            } else {
                const revAccel = CAR_SPECS.accelReverse * Math.abs(throttle);
                if (vLong > CAR_SPECS.maxSpeedReverse) {
                    vLong -= Math.min(revAccel * dt, vLong - CAR_SPECS.maxSpeedReverse);
                }
            }
        }

        if (handbrake) {
            if (throttle <= 0) {
                // When off-throttle (coasting) or reversing, handbrake strongly decelerates the vehicle to a complete stop
                const hBrakeDecel = CAR_SPECS.accelHandbrake;
                if (vLong > 0) {
                    vLong = Math.max(0, vLong - hBrakeDecel * dt);
                } else if (vLong < 0) {
                    vLong = Math.min(0, vLong + hBrakeDecel * dt);
                }
                if (!boost && Math.abs(vLong) < 0.2) {
                    vLong = 0;
                }
                if (Math.abs(vLong) > 0.5) {
                    car.isBraking = true;
                }
            } else {
                // Throttle > 0: Engine beats handbrake!
                // Drive wheels overpower rear handbrake resistance so the car maintains forward
                // propulsion. Handbrake breaks rear traction to initiate/sustain drifts without
                // dragging vehicle speed down to a halt.
            }
        }

        // Speed scaling: stopped cars cannot drift or steer
        const totalSpeed = Math.hypot(vLong, vLat);
        const speedMag = Math.abs(vLong);
        const steerSpeedFactor = Math.min(1, Math.max(0, (totalSpeed - 0.3) / 2.0));
        const steerSign = vLong >= 0 ? 1 : -1;

        const speedGain = 1.0 / (1.0 + Math.pow(speedMag / 26.0, 2));
        const targetYawRate = steer * (vLong / CAR_SPECS.wheelbase) * CAR_SPECS.steerGain * speedGain;
        const demandedLatAcc = Math.abs(vLong * targetYawRate);
        const maxGripAcc = CAR_SPECS.muGrip * 9.81;

        const isSharpTurn = Math.abs(steer) > 0.35 && totalSpeed > 4.0;
        const canDriftAtSpeed = (handbrake && throttle > 0) ? totalSpeed > 0.8 : totalSpeed > 2.0;
        const enterDrift = canDriftAtSpeed && (
            (car.isBraking && isSharpTurn) ||
            (handbrake && (Math.abs(steer) > 0.1 || Math.abs(vLat) > 0.4)) ||
            (demandedLatAcc > maxGripAcc) ||
            (Math.abs(vLat) > 0.6)
        );

        const keepDrift = car.isDrifting && canDriftAtSpeed && (
            Math.abs(vLat) > 0.4 || (car.isBraking && isSharpTurn) || handbrake || demandedLatAcc > maxGripAcc * 0.65
        );
        car.isDrifting = enterDrift || keepDrift;

        // Unified lateral tire friction bounded by traction budget (no artificial sideways friction drop)
        const maxLatDeltaV = CAR_SPECS.muGrip * 9.81 * dt;
        let deltaVLat = -vLat * (1 - Math.exp(-CAR_SPECS.lateralDampingGrip * dt));
        if (Math.abs(deltaVLat) > maxLatDeltaV) {
            deltaVLat = Math.sign(deltaVLat) * maxLatDeltaV;
        }
        vLat += deltaVLat;

        // Steering rate integration that allows collision-induced spin to persist naturally
        car.yawRate = car.yawRate + (targetYawRate - car.yawRate) * Math.min(1, 8.5 * dt);

        // PRE-TURN yaw reconstruction preserves momentum and creates realistic outward centrifugal skidding
        car.vx = vLong * sinY + vLat * cosY;
        car.vz = vLong * cosY - vLat * sinY;

        car.yaw = normalizeAngle(currentYaw + car.yawRate * dt);
        car.x = car.x + car.vx * dt;
        car.z = car.z + car.vz * dt;
        car.speed = car.vx * Math.sin(car.yaw) + car.vz * Math.cos(car.yaw);
        car.isAwake = true;
    } else {
        car.tractionLoss = 0;
        // Unoccupied / parked vehicle (participates when awake after collision)
        if (!car.isAwake) return;

        const currentSpeed = Math.hypot(car.vx, car.vz);
        if (currentSpeed < 0.04 && Math.abs(car.yawRate) < 0.03) {
            car.vx = 0;
            car.vz = 0;
            car.speed = 0;
            car.yawRate = 0;
            car.isAwake = false;
            return;
        }

        const groundDamping = Math.exp(-4.2 * dt);
        car.vx *= groundDamping;
        car.vz *= groundDamping;
        car.yawRate *= Math.exp(-4.8 * dt);

        car.yaw = normalizeAngle(car.yaw + car.yawRate * dt);
        car.x += car.vx * dt;
        car.z += car.vz * dt;
        car.speed = car.vx * Math.sin(car.yaw) + car.vz * Math.cos(car.yaw);
    }
}

export function stepVehicleDynamics(car, input, dt) {
    if (!dt || dt <= 0 || !isFinite(dt)) return;
    const boundedDt = Math.min(0.1, dt);
    const maxSubDt = 0.016;
    let remaining = boundedDt;
    while (remaining > 0.0001) {
        const stepDt = Math.min(maxSubDt, remaining);
        stepSingleVehicleDynamics(car, input, stepDt);
        remaining -= stepDt;
    }
}

export function resolveVehicleToVehicleCollisions(cars, dt) {
    if (!Array.isArray(cars) || cars.length < 2) return [];
    const events = [];

    for (let i = 0; i < cars.length; i++) {
        const carA = cars[i];
        const rawMassA = Number(carA.mass);
        const invMassA = carA.remoteDriver ? 0 : ((Number.isFinite(rawMassA) && rawMassA > 10.0) ? (1 / rawMassA) : (1 / CAR_SPECS.mass));
        const rawIA = Number(carA.inertia);
        const invIA = carA.remoteDriver ? 0 : ((Number.isFinite(rawIA) && rawIA > 50.0) ? (1 / rawIA) : (1 / getVehicleInertia(carA)));

        for (let j = i + 1; j < cars.length; j++) {
            const carB = cars[j];
            const rawMassB = Number(carB.mass);
            const invMassB = carB.remoteDriver ? 0 : ((Number.isFinite(rawMassB) && rawMassB > 10.0) ? (1 / rawMassB) : (1 / CAR_SPECS.mass));
            const rawIB = Number(carB.inertia);
            const invIB = carB.remoteDriver ? 0 : ((Number.isFinite(rawIB) && rawIB > 50.0) ? (1 / rawIB) : (1 / getVehicleInertia(carB)));

            if (invMassA + invMassB === 0) continue;

            // Re-evaluate circles on demand so prior pair displacement is not stale
            const circlesA = getVehicleCollisionCircles(carA, carA.axleOffset, carA.collisionRadius);
            const circlesB = getVehicleCollisionCircles(carB, carB.axleOffset, carB.collisionRadius);

            const cdx = (Number(carB.x) || 0) - (Number(carA.x) || 0);
            const cdz = (Number(carB.z) || 0) - (Number(carA.z) || 0);
            const cdist = Math.hypot(cdx, cdz);
            const fallbackNx = cdist > 0.0001 ? cdx / cdist : 1;
            const fallbackNz = cdist > 0.0001 ? cdz / cdist : 0;

            let bestOverlap = 0;
            let bestContact = null;

            for (const cA of circlesA) {
                for (const cB of circlesB) {
                    const dx = cB.x - cA.x;
                    const dz = cB.z - cA.z;
                    const dist = Math.hypot(dx, dz);
                    const minDist = cA.radius + cB.radius;

                    if (dist < minDist) {
                        const dotCar = dx * fallbackNx + dz * fallbackNz;
                        let nx, nz, overlap;
                        if (dist > 0.0001 && dotCar > 0) {
                            nx = dx / dist;
                            nz = dz / dist;
                            overlap = minDist - dist;
                        } else {
                            // Deep crossover normal follows vehicle separation
                            nx = fallbackNx;
                            nz = fallbackNz;
                            const projDist = dx * nx + dz * nz;
                            overlap = minDist - projDist;
                        }

                        if (overlap > bestOverlap) {
                            bestOverlap = overlap;
                            const contactX = (cA.x + cB.x) / 2;
                            const contactZ = (cA.z + cB.z) / 2;
                            bestContact = {
                                overlap,
                                nx,
                                nz,
                                contactX,
                                contactZ
                            };
                        }
                    }
                }
            }

            if (bestContact && bestOverlap > 0.0001) {
                if (!carA.remoteDriver) carA.isAwake = true;
                if (!carB.remoteDriver) carB.isAwake = true;

                const { overlap, nx, nz, contactX, contactZ } = bestContact;
                const sumInvM = invMassA + invMassB;

                // Mass-weighted position correction
                if (!carA.remoteDriver) carA.x = (Number(carA.x) || 0) - nx * overlap * (invMassA / sumInvM);
                if (!carA.remoteDriver) carA.z = (Number(carA.z) || 0) - nz * overlap * (invMassA / sumInvM);
                if (!carB.remoteDriver) carB.x = (Number(carB.x) || 0) + nx * overlap * (invMassB / sumInvM);
                if (!carB.remoteDriver) carB.z = (Number(carB.z) || 0) + nz * overlap * (invMassB / sumInvM);

                // Lever arms from updated vehicle centers
                const rA = { x: contactX - carA.x, z: contactZ - carA.z };
                const rB = { x: contactX - carB.x, z: contactZ - carB.z };

                // Contact velocities (including yaw rotation)
                const rotA = rotationalVelocity(rA, Number(carA.yawRate) || 0);
                const rotB = rotationalVelocity(rB, Number(carB.yawRate) || 0);

                const vAx = (Number(carA.vx) || 0) + rotA.x;
                const vAz = (Number(carA.vz) || 0) + rotA.z;
                const vBx = (Number(carB.vx) || 0) + rotB.x;
                const vBz = (Number(carB.vz) || 0) + rotB.z;

                const uX = vBx - vAx;
                const uZ = vBz - vAz;
                const vn = uX * nx + uZ * nz;

                if (vn < -0.01) {
                    const ca = crossYaw(rA, { x: nx, z: nz });
                    const cb = crossYaw(rB, { x: nx, z: nz });
                    const denom = invMassA + invMassB + ca * ca * invIA + cb * cb * invIB;

                    const restitution = Math.abs(vn) > 0.8 ? CAR_SPECS.restitution : 0.0;
                    const J = -(1 + restitution) * vn / denom;

                    if (!carA.remoteDriver) carA.vx = (Number(carA.vx) || 0) - J * nx * invMassA;
                    if (!carA.remoteDriver) carA.vz = (Number(carA.vz) || 0) - J * nz * invMassA;
                    if (!carB.remoteDriver) carB.vx = (Number(carB.vx) || 0) + J * nx * invMassB;
                    if (!carB.remoteDriver) carB.vz = (Number(carB.vz) || 0) + J * nz * invMassB;

                    if (!carA.remoteDriver) carA.yawRate = (Number(carA.yawRate) || 0) - J * ca * invIA;
                    if (!carB.remoteDriver) carB.yawRate = (Number(carB.yawRate) || 0) + J * cb * invIB;

                    if (!carA.remoteDriver) carA.speed = carA.vx * Math.sin(carA.yaw || 0) + carA.vz * Math.cos(carA.yaw || 0);
                    if (!carB.remoteDriver) carB.speed = carB.vx * Math.sin(carB.yaw || 0) + carB.vz * Math.cos(carB.yaw || 0);

                    events.push({
                        carA,
                        carB,
                        impulse: J,
                        contactX,
                        contactZ
                    });
                }
            }
        }
    }
    return events;
}

function applyStaticContactImpulse(car, contactX, contactZ, nx, nz, invMass, invInertia) {
    const r = { x: contactX - car.x, z: contactZ - car.z };
    const rot = rotationalVelocity(r, Number(car.yawRate) || 0);
    const contactVx = (Number(car.vx) || 0) + rot.x;
    const contactVz = (Number(car.vz) || 0) + rot.z;
    const vn = contactVx * nx + contactVz * nz;

    if (vn < -0.01) {
        const ca = crossYaw(r, { x: nx, z: nz });
        const denomN = invMass + ca * ca * invInertia;
        const restitution = Math.abs(vn) > 0.8 ? CAR_SPECS.restitution : 0.0;
        const Jn = -(1 + restitution) * vn / denomN;

        // 1. Normal impulse
        car.vx = (Number(car.vx) || 0) + Jn * nx * invMass;
        car.vz = (Number(car.vz) || 0) + Jn * nz * invMass;
        car.yawRate = (Number(car.yawRate) || 0) + Jn * ca * invInertia;

        // 2. Recompute contact velocity after normal impulse
        const rotPost = rotationalVelocity(r, Number(car.yawRate) || 0);
        const postVx = (Number(car.vx) || 0) + rotPost.x;
        const postVz = (Number(car.vz) || 0) + rotPost.z;

        // 3. Tangential Coulomb friction impulse with true contact lever arm
        const tx = -nz;
        const tz = nx;
        const vt = postVx * tx + postVz * tz;
        const ct = crossYaw(r, { x: tx, z: tz });
        const denomT = invMass + ct * ct * invInertia;
        let Jt = -vt / denomT;
        const maxJt = 0.45 * Math.abs(Jn);
        if (Math.abs(Jt) > maxJt) {
            Jt = Math.sign(Jt) * maxJt;
        }

        car.vx = (Number(car.vx) || 0) + Jt * tx * invMass;
        car.vz = (Number(car.vz) || 0) + Jt * tz * invMass;
        car.yawRate = (Number(car.yawRate) || 0) + Jt * ct * invInertia;
    }
}

export function resolveVehicleWorldCollision(car, colliders, bounds = null) {
    if (car.remoteDriver) return false;
    let hitAny = false;
    const rawMass = Number(car.mass);
    const invMass = (Number.isFinite(rawMass) && rawMass > 10.0) ? (1 / rawMass) : (1 / CAR_SPECS.mass);
    const rawInertia = Number(car.inertia);
    const invInertia = (Number.isFinite(rawInertia) && rawInertia > 50.0) ? (1 / rawInertia) : (1 / getVehicleInertia(car));
    const colliderList = Array.isArray(colliders) ? colliders : (colliders && colliders.colliders ? colliders.colliders : []);
    const circleNames = ['front', 'center', 'rear'];

    // 2-pass iterative solver with fresh circle geometry evaluated after every displacement
    for (let pass = 0; pass < 2; pass++) {
        for (const circleName of circleNames) {
            const offset = circleName === 'front' ? (car.axleOffset || CAR_SPECS.axleOffset) : (circleName === 'rear' ? -(car.axleOffset || CAR_SPECS.axleOffset) : 0);
            const circleRadius = car.collisionRadius || CAR_SPECS.collisionRadius;

            // Static world colliders (recompute circleX/Z dynamically inside collider loop)
            const carY = Number(car.y) || 0;
            for (const col of colliderList) {
                if (col.minY !== undefined && carY + 2.0 < col.minY) continue;
                if (col.height !== undefined && carY >= col.height - 0.52) continue;

                const yaw = Number(car.yaw) || 0;
                const circleX = (Number(car.x) || 0) + offset * Math.sin(yaw);
                const circleZ = (Number(car.z) || 0) + offset * Math.cos(yaw);
                let nx = 0, nz = 0, overlap = 0;

                if (col.type === 'circle') {
                    const dx = circleX - col.x;
                    const dz = circleZ - col.z;
                    const dist = Math.hypot(dx, dz);
                    const minDist = col.radius + circleRadius;
                    if (dist < minDist) {
                        overlap = minDist - dist;
                        nx = dist > 0.0001 ? dx / dist : 1;
                        nz = dist > 0.0001 ? dz / dist : 0;
                    }
                } else if (col.type === 'box') {
                    let dx = circleX - col.x;
                    let dz = circleZ - col.z;
                    const hasRot = Boolean(col.rotY);
                    if (hasRot) {
                        const cos = Math.cos(col.rotY);
                        const sin = Math.sin(col.rotY);
                        const rx = dx * cos - dz * sin;
                        const rz = dx * sin + dz * cos;
                        dx = rx;
                        dz = rz;
                    }
                    const clampedX = Math.max(-col.halfW, Math.min(col.halfW, dx));
                    const clampedD = Math.max(-col.halfD, Math.min(col.halfD, dz));
                    const diffX = dx - clampedX;
                    const diffZ = dz - clampedD;
                    const distSq = diffX * diffX + diffZ * diffZ;

                    if (distSq < circleRadius * circleRadius) {
                        const dist = Math.sqrt(distSq);
                        if (dist > 0.0001) {
                            const localNx = diffX / dist;
                            const localNz = diffZ / dist;
                            overlap = circleRadius - dist;
                            if (hasRot) {
                                const cosR = Math.cos(col.rotY);
                                const sinR = Math.sin(col.rotY);
                                nx = localNx * cosR + localNz * sinR;
                                nz = -localNx * sinR + localNz * cosR;
                            } else {
                                nx = localNx;
                                nz = localNz;
                            }
                        } else {
                            const penX = col.halfW + circleRadius - Math.abs(dx);
                            const penZ = col.halfD + circleRadius - Math.abs(dz);
                            const carDx = (Number(car.x) || 0) - col.x;
                            const carDz = (Number(car.z) || 0) - col.z;
                            const carLocalX = hasRot
                                ? carDx * Math.cos(col.rotY) - carDz * Math.sin(col.rotY)
                                : carDx;
                            const carLocalZ = hasRot
                                ? carDx * Math.sin(col.rotY) + carDz * Math.cos(col.rotY)
                                : carDz;

                            let localNx = 0;
                            let localNz = 0;
                            if (penX < penZ) {
                                localNx = carLocalX >= 0 ? 1 : -1;
                                localNz = 0;
                                overlap = penX;
                            } else {
                                localNx = 0;
                                localNz = carLocalZ >= 0 ? 1 : -1;
                                overlap = penZ;
                            }
                            if (hasRot) {
                                const cosR = Math.cos(col.rotY);
                                const sinR = Math.sin(col.rotY);
                                nx = localNx * cosR + localNz * sinR;
                                nz = -localNx * sinR + localNz * cosR;
                            } else {
                                nx = localNx;
                                nz = localNz;
                            }
                        }
                    }
                }

                if (overlap > 0.001) {
                    hitAny = true;
                    // Apply exact separation
                    car.x += nx * overlap;
                    car.z += nz * overlap;

                    // Physical contact point on obstacle surface
                    const contactX = circleX - nx * circleRadius;
                    const contactZ = circleZ - nz * circleRadius;
                    applyStaticContactImpulse(car, contactX, contactZ, nx, nz, invMass, invInertia);
                }
            }

            // Boundary checks for this circle
            if (bounds) {
                const yaw = Number(car.yaw) || 0;
                const freshCircleX = (Number(car.x) || 0) + offset * Math.sin(yaw);
                const freshCircleZ = (Number(car.z) || 0) + offset * Math.cos(yaw);
                const minX = bounds.minX !== undefined ? bounds.minX + circleRadius : -13;
                const maxX = bounds.maxX !== undefined ? bounds.maxX - circleRadius : 44;
                const minZ = bounds.minZ !== undefined ? bounds.minZ + circleRadius : -150;
                const maxZ = bounds.maxZ !== undefined ? bounds.maxZ - circleRadius : 150;

                if (freshCircleX < minX) {
                    hitAny = true;
                    const pen = minX - freshCircleX;
                    car.x += pen;
                    const contactX = minX - circleRadius;
                    const contactZ = freshCircleZ;
                    applyStaticContactImpulse(car, contactX, contactZ, 1, 0, invMass, invInertia);
                } else if (freshCircleX > maxX) {
                    hitAny = true;
                    const pen = freshCircleX - maxX;
                    car.x -= pen;
                    const contactX = maxX + circleRadius;
                    const contactZ = freshCircleZ;
                    applyStaticContactImpulse(car, contactX, contactZ, -1, 0, invMass, invInertia);
                }

                if (freshCircleZ < minZ) {
                    hitAny = true;
                    const pen = minZ - freshCircleZ;
                    car.z += pen;
                    const contactX = freshCircleX;
                    const contactZ = minZ - circleRadius;
                    applyStaticContactImpulse(car, contactX, contactZ, 0, 1, invMass, invInertia);
                } else if (freshCircleZ > maxZ) {
                    hitAny = true;
                    const pen = freshCircleZ - maxZ;
                    car.z -= pen;
                    const contactX = freshCircleX;
                    const contactZ = maxZ + circleRadius;
                    applyStaticContactImpulse(car, contactX, contactZ, 0, -1, invMass, invInertia);
                }
            }
        }
    }

    car.speed = (Number(car.vx) || 0) * Math.sin(car.yaw || 0) + (Number(car.vz) || 0) * Math.cos(car.yaw || 0);
    return hitAny;
}

export function createVehiclePhysicsWorld(options = {}) {
    let accumulator = 0;
    const fixedDt = (Number.isFinite(options.fixedDt) && options.fixedDt > 0.001) ? options.fixedDt : (1 / 60);

    return {
        get accumulator() { return accumulator; },
        get alpha() { return accumulator / fixedDt; },
        reset() { accumulator = 0; },
        step(vehicles, dt, colliders, bounds = null, activeVehicle = null, activeInput = null) {
            if (!Array.isArray(vehicles) || vehicles.length === 0 || !Number.isFinite(dt) || dt <= 0) return [];
            accumulator += Math.min(0.1, dt);
            const allEvents = [];

            while (accumulator >= fixedDt) {
                for (const v of vehicles) { if (!v.remoteDriver) resetVehiclePose(v); }
                // 1. Advance individual vehicle dynamics for local non-remote vehicles
                for (const v of vehicles) {
                    if (v.remoteDriver) continue;
                    const input = (v === activeVehicle) ? activeInput : null;
                    stepSingleVehicleDynamics(v, input, fixedDt);
                }

                // 2. Multi-pass constraint solver across vehicle pairs and obstacles
                for (let iter = 0; iter < 3; iter++) {
                    const events = resolveVehicleToVehicleCollisions(vehicles, fixedDt);
                    if (events.length > 0 && iter === 0) {
                        allEvents.push(...events);
                    }
                    for (const v of vehicles) {
                        resolveVehicleWorldCollision(v, colliders, bounds);
                    }
                }

                accumulator -= fixedDt;
            }

            return allEvents;
        }
    };
}

export const WorldVehiclePhysics = createVehiclePhysicsWorld();

export function stepWorldVehiclePhysics(vehicles, dt, colliders, bounds = null, activeVehicle = null, activeInput = null) {
    return WorldVehiclePhysics.step(vehicles, dt, colliders, bounds, activeVehicle, activeInput);
}
