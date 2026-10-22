import { ModelBuilders } from '../static/js/models.js';

function padTo4Bytes(uint8) {
    const rem = uint8.byteLength % 4;
    if (rem === 0) return uint8;
    const padded = new Uint8Array(uint8.byteLength + (4 - rem));
    padded.set(uint8);
    return padded;
}

function dataUrlToUint8Array(dataUrl) {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return null;
    const base64 = dataUrl.slice(commaIdx + 1);
    if (typeof atob === 'function') {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
    if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(base64, 'base64'));
    }
    return null;
}

function extractTexturePngBytes(texture) {
    if (!texture) return null;
    if (texture.userData && texture.userData.pngBytes instanceof Uint8Array) {
        return texture.userData.pngBytes;
    }
    const img = texture.image;
    if (!img) return null;
    if (typeof img.toDataURL === 'function') {
        try {
            const url = img.toDataURL('image/png');
            if (url && url.startsWith('data:image/png')) {
                return dataUrlToUint8Array(url);
            }
        } catch (e) {}
    }
    if (typeof document !== 'undefined' && img.width && img.height) {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.drawImage(img, 0, 0);
                const url = canvas.toDataURL('image/png');
                if (url && url.startsWith('data:image/png')) {
                    return dataUrlToUint8Array(url);
                }
            }
        } catch (e) {}
    }
    return null;
}

function computeMinMax(floatArray, itemSize) {
    const count = floatArray.length / itemSize;
    if (count === 0) return { min: new Array(itemSize).fill(0), max: new Array(itemSize).fill(0) };
    const min = new Array(itemSize).fill(Infinity);
    const max = new Array(itemSize).fill(-Infinity);
    for (let i = 0; i < count; i++) {
        for (let c = 0; c < itemSize; c++) {
            const val = floatArray[i * itemSize + c];
            if (val < min[c]) min[c] = val;
            if (val > max[c]) max[c] = val;
        }
    }
    return { min, max };
}

/**
 * Exports a THREE.Object3D / THREE.Group hierarchy to a binary glTF 2.0 (.glb) Uint8Array.
 * Preserves node names, transforms, indexed triangle meshes, UVs (flipped to glTF top-left origin),
 * PBR & unlit materials, and embedded PNG textures for Blockbench and Blender compatibility.
 */
export function exportObjectToGLB(rootObject) {
    const gltf = {
        asset: {
            version: '2.0',
            generator: 'Nabka World & Model Exporter'
        },
        extensionsUsed: ['KHR_materials_unlit'],
        scene: 0,
        scenes: [{ nodes: [] }],
        nodes: [],
        meshes: [],
        materials: [],
        accessors: [],
        bufferViews: [],
        buffers: []
    };

    const images = [];
    const textures = [];
    const samplers = [];
    const binChunks = [];
    let binByteLength = 0;

    function appendBufferView(uint8Data, target = undefined) {
        const padded = padTo4Bytes(uint8Data);
        const byteOffset = binByteLength;
        binChunks.push(padded);
        binByteLength += padded.byteLength;

        const bv = {
            buffer: 0,
            byteOffset,
            byteLength: uint8Data.byteLength
        };
        if (target !== undefined) bv.target = target;
        const idx = gltf.bufferViews.length;
        gltf.bufferViews.push(bv);
        return idx;
    }

    const materialCache = new Map();
    const textureCache = new Map();

    function registerTexture(threeTex) {
        if (!threeTex) return undefined;
        if (textureCache.has(threeTex)) return textureCache.get(threeTex);

        const pngBytes = extractTexturePngBytes(threeTex);
        if (!pngBytes) return undefined;

        const bvIdx = appendBufferView(pngBytes);
        const imgIdx = images.length;
        images.push({
            bufferView: bvIdx,
            mimeType: 'image/png'
        });

        const wrapS = (typeof THREE !== 'undefined' && threeTex.wrapS === THREE.ClampToEdgeWrapping) ? 33071 : 10497;
        const wrapT = (typeof THREE !== 'undefined' && threeTex.wrapT === THREE.ClampToEdgeWrapping) ? 33071 : 10497;
        const samplerIdx = samplers.length;
        samplers.push({
            magFilter: 9729,
            minFilter: 9987,
            wrapS,
            wrapT
        });

        const texIdx = textures.length;
        textures.push({
            sampler: samplerIdx,
            source: imgIdx
        });
        textureCache.set(threeTex, texIdx);
        return texIdx;
    }

    function registerMaterial(mat) {
        if (!mat) return undefined;
        if (materialCache.has(mat)) return materialCache.get(mat);

        const color = mat.color || { r: 1, g: 1, b: 1 };
        const opacity = mat.transparent && mat.opacity !== undefined ? mat.opacity : 1.0;
        const isBasic = Boolean(mat.isMeshBasicMaterial);

        const pbr = {
            baseColorFactor: [
                Number(color.r.toFixed(6)),
                Number(color.g.toFixed(6)),
                Number(color.b.toFixed(6)),
                Number(opacity.toFixed(6))
            ],
            metallicFactor: isBasic ? 0.0 : (mat.metalness !== undefined ? Number(mat.metalness.toFixed(4)) : 0.0),
            roughnessFactor: isBasic ? 0.9 : (mat.roughness !== undefined ? Number(mat.roughness.toFixed(4)) : 0.7)
        };

        if (mat.map) {
            const texIdx = registerTexture(mat.map);
            if (texIdx !== undefined) {
                pbr.baseColorTexture = { index: texIdx };
            }
        }

        const matDef = {
            name: mat.name || `mat_${gltf.materials.length}`,
            pbrMetallicRoughness: pbr
        };

        if (isBasic) {
            matDef.extensions = { KHR_materials_unlit: {} };
        } else if (mat.emissive && (mat.emissive.r > 0 || mat.emissive.g > 0 || mat.emissive.b > 0)) {
            matDef.emissiveFactor = [
                Number(mat.emissive.r.toFixed(6)),
                Number(mat.emissive.g.toFixed(6)),
                Number(mat.emissive.b.toFixed(6))
            ];
        }

        if (typeof THREE !== 'undefined' && mat.side === THREE.DoubleSide) {
            matDef.doubleSided = true;
        }
        if (opacity < 1.0) {
            matDef.alphaMode = 'BLEND';
        }

        const extras = {};
        if (mat.flatShading) extras.flatShading = true;
        if (mat.fog === false) extras.fog = false;
        if (mat.emissiveIntensity !== undefined && mat.emissiveIntensity !== 1.0) {
            extras.emissiveIntensity = mat.emissiveIntensity;
        }
        if (Object.keys(extras).length > 0) {
            matDef.extras = extras;
        }

        const idx = gltf.materials.length;
        gltf.materials.push(matDef);
        materialCache.set(mat, idx);
        return idx;
    }

    function exportMesh(mesh) {
        let geo = mesh.geometry;
        if (!geo || !geo.attributes || !geo.attributes.position) return undefined;

        if (!geo.attributes.normal && typeof geo.computeVertexNormals === 'function') {
            geo = geo.clone();
            geo.computeVertexNormals();
        }

        const posAttr = geo.attributes.position;
        const posCount = posAttr.count;
        const posArray = new Float32Array(posCount * 3);
        for (let i = 0; i < posCount; i++) {
            posArray[i * 3] = posAttr.getX(i);
            posArray[i * 3 + 1] = posAttr.getY(i);
            posArray[i * 3 + 2] = posAttr.getZ(i);
        }
        const posMinMax = computeMinMax(posArray, 3);
        const posBv = appendBufferView(new Uint8Array(posArray.buffer), 34962);
        const posAcc = gltf.accessors.length;
        gltf.accessors.push({
            bufferView: posBv,
            componentType: 5126,
            count: posCount,
            type: 'VEC3',
            min: posMinMax.min,
            max: posMinMax.max
        });

        const attributes = { POSITION: posAcc };

        if (geo.attributes.normal) {
            const normAttr = geo.attributes.normal;
            const normArray = new Float32Array(posCount * 3);
            for (let i = 0; i < posCount; i++) {
                const nx = normAttr.getX(i);
                const ny = normAttr.getY(i);
                const nz = normAttr.getZ(i);
                const len = Math.hypot(nx, ny, nz) || 1;
                normArray[i * 3] = nx / len;
                normArray[i * 3 + 1] = ny / len;
                normArray[i * 3 + 2] = nz / len;
            }
            const normBv = appendBufferView(new Uint8Array(normArray.buffer), 34962);
            const normAcc = gltf.accessors.length;
            gltf.accessors.push({
                bufferView: normBv,
                componentType: 5126,
                count: posCount,
                type: 'VEC3'
            });
            attributes.NORMAL = normAcc;
        }

        if (geo.attributes.uv) {
            const uvAttr = geo.attributes.uv;
            const uvArray = new Float32Array(posCount * 2);
            const tex = mesh.material && mesh.material.map;
            const repX = (tex && tex.repeat && tex.repeat.x) ? tex.repeat.x : 1;
            const repY = (tex && tex.repeat && tex.repeat.y) ? tex.repeat.y : 1;
            const flipY = tex ? (tex.flipY !== false) : true;

            for (let i = 0; i < posCount; i++) {
                const u = uvAttr.getX(i) * repX;
                const rawV = uvAttr.getY(i) * repY;
                const v = flipY ? (1.0 - rawV) : rawV;
                uvArray[i * 2] = u;
                uvArray[i * 2 + 1] = v;
            }
            const uvBv = appendBufferView(new Uint8Array(uvArray.buffer), 34962);
            const uvAcc = gltf.accessors.length;
            gltf.accessors.push({
                bufferView: uvBv,
                componentType: 5126,
                count: posCount,
                type: 'VEC2'
            });
            attributes.TEXCOORD_0 = uvAcc;
        }

        let indexTypedArray;
        let indexComponentType;
        if (geo.index) {
            const idxAttr = geo.index;
            const idxCount = idxAttr.count;
            const use32 = posCount > 65535;
            indexTypedArray = use32 ? new Uint32Array(idxCount) : new Uint16Array(idxCount);
            indexComponentType = use32 ? 5125 : 5123;
            for (let i = 0; i < idxCount; i++) {
                indexTypedArray[i] = idxAttr.getX(i);
            }
        } else {
            const use32 = posCount > 65535;
            indexTypedArray = use32 ? new Uint32Array(posCount) : new Uint16Array(posCount);
            indexComponentType = use32 ? 5125 : 5123;
            for (let i = 0; i < posCount; i++) {
                indexTypedArray[i] = i;
            }
        }

        const idxBv = appendBufferView(new Uint8Array(indexTypedArray.buffer), 34963);
        const idxAcc = gltf.accessors.length;
        gltf.accessors.push({
            bufferView: idxBv,
            componentType: indexComponentType,
            count: indexTypedArray.length,
            type: 'SCALAR'
        });

        const matIdx = registerMaterial(Array.isArray(mesh.material) ? mesh.material[0] : mesh.material);
        const primitive = {
            attributes,
            indices: idxAcc,
            mode: 4
        };
        if (matIdx !== undefined) {
            primitive.material = matIdx;
        }

        const meshIdx = gltf.meshes.length;
        gltf.meshes.push({
            name: mesh.name || `mesh_${meshIdx}`,
            primitives: [primitive]
        });
        return meshIdx;
    }

    function shouldSkipObject(obj) {
        if (!obj) return true;
        if (obj.isPoints || obj.isLight || obj.isCamera) return true;
        if (obj.name === 'fountainParticles' || obj.name === 'headBeam' || obj.name === 'bounding_box_cordon' || obj.name === 'bounding_box_fence') return true;
        if (obj.userData && (obj.userData.isCordon || obj.userData.isFence)) return true;
        return false;
    }

    function visitNode(obj, isRoot = false) {
        const nodeDef = {
            name: obj.name || (isRoot ? 'root' : `node_${gltf.nodes.length}`)
        };

        if (!isRoot) {
            if (obj.position && (obj.position.x !== 0 || obj.position.y !== 0 || obj.position.z !== 0)) {
                nodeDef.translation = [
                    Number(obj.position.x.toFixed(6)),
                    Number(obj.position.y.toFixed(6)),
                    Number(obj.position.z.toFixed(6))
                ];
            }
            if (obj.quaternion && (obj.quaternion.x !== 0 || obj.quaternion.y !== 0 || obj.quaternion.z !== 0 || obj.quaternion.w !== 1)) {
                nodeDef.rotation = [
                    Number(obj.quaternion.x.toFixed(6)),
                    Number(obj.quaternion.y.toFixed(6)),
                    Number(obj.quaternion.z.toFixed(6)),
                    Number(obj.quaternion.w.toFixed(6))
                ];
            }
            if (obj.scale && (obj.scale.x !== 1 || obj.scale.y !== 1 || obj.scale.z !== 1)) {
                nodeDef.scale = [
                    Number(obj.scale.x.toFixed(6)),
                    Number(obj.scale.y.toFixed(6)),
                    Number(obj.scale.z.toFixed(6))
                ];
            }
        }

        if (obj.isMesh) {
            const meshIdx = exportMesh(obj);
            if (meshIdx !== undefined) {
                nodeDef.mesh = meshIdx;
            }
            nodeDef.extras = {
                castShadow: Boolean(obj.castShadow),
                receiveShadow: Boolean(obj.receiveShadow)
            };
        }

        if (obj.userData && obj.userData.noCollide) {
            nodeDef.extras = {
                ...(nodeDef.extras || {}),
                noCollide: true
            };
        }

        const nodeIdx = gltf.nodes.length;
        gltf.nodes.push(nodeDef);

        if (Array.isArray(obj.children) && obj.children.length > 0) {
            const childIndices = [];
            for (const child of obj.children) {
                if (shouldSkipObject(child)) continue;
                childIndices.push(visitNode(child, false));
            }
            if (childIndices.length > 0) {
                nodeDef.children = childIndices;
            }
        }

        return nodeIdx;
    }

    const rootNodeIdx = visitNode(rootObject, true);
    gltf.scenes[0].nodes.push(rootNodeIdx);

    if (images.length > 0) gltf.images = images;
    if (textures.length > 0) gltf.textures = textures;
    if (samplers.length > 0) gltf.samplers = samplers;

    gltf.buffers.push({ byteLength: binByteLength });

    const jsonText = JSON.stringify(gltf);
    const jsonRaw = new TextEncoder().encode(jsonText);
    const jsonRem = jsonRaw.byteLength % 4;
    const jsonPad = jsonRem === 0 ? 0 : (4 - jsonRem);
    const jsonChunkBytes = new Uint8Array(jsonRaw.byteLength + jsonPad);
    jsonChunkBytes.set(jsonRaw);
    for (let i = jsonRaw.byteLength; i < jsonChunkBytes.byteLength; i++) {
        jsonChunkBytes[i] = 0x20; // space padding per glTF 2.0 spec
    }

    const totalLength = 12 + 8 + jsonChunkBytes.byteLength + (binByteLength > 0 ? (8 + binByteLength) : 0);
    const glbBytes = new Uint8Array(totalLength);
    const view = new DataView(glbBytes.buffer);

    // GLB Header
    view.setUint32(0, 0x46546C67, true); // 'glTF'
    view.setUint32(4, 2, true);          // version 2
    view.setUint32(8, totalLength, true);

    // JSON Chunk
    view.setUint32(12, jsonChunkBytes.byteLength, true);
    view.setUint32(16, 0x4E4F534A, true); // 'JSON'
    glbBytes.set(jsonChunkBytes, 20);

    // BIN Chunk
    if (binByteLength > 0) {
        const binHeaderOffset = 20 + jsonChunkBytes.byteLength;
        view.setUint32(binHeaderOffset, binByteLength, true);
        view.setUint32(binHeaderOffset + 4, 0x004E4942, true); // 'BIN\0'
        let cursor = binHeaderOffset + 8;
        for (const chunk of binChunks) {
            glbBytes.set(chunk, cursor);
            cursor += chunk.byteLength;
        }
    }

    return glbBytes;
}

/**
 * Builds all 35 Nabka 3D models and returns a map of { filename: THREE.Group }.
 */
export function buildAllExportableModels(worldMap = {}) {
    const models = new Map();

    // 1. Landmarks
    models.set('fountain.glb', ModelBuilders.fountain());
    models.set('tiger_statue.glb', ModelBuilders.tiger_statue());
    models.set('pier.glb', ModelBuilders.pier());
    models.set('ferris_wheel.glb', ModelBuilders.ferris_wheel());
    models.set('oceanarium.glb', ModelBuilders.oceanarium());
    models.set('arbat_paving.glb', ModelBuilders.arbat_paving());
    models.set('supra_restaurant.glb', ModelBuilders.supra_restaurant());
    models.set('fortress_museum.glb', ModelBuilders.fortress_museum());
    models.set('olympiets_complex.glb', ModelBuilders.olympiets_complex());
    models.set('azimut_hotel.glb', ModelBuilders.azimut_hotel());
    models.set('yacht_club_pier.glb', ModelBuilders.yacht_club_pier());
    models.set('yacht_club_boathouse.glb', ModelBuilders.yacht_club_boathouse());
    models.set('lighthouse.glb', ModelBuilders.lighthouse());
    models.set('bridge_pylon.glb', ModelBuilders.bridge_pylon());
    models.set('bridge_deck.glb', ModelBuilders.bridge_deck());

    // 2. Stalls
    const defaultStalls = [
        { id: 'pyanse', title: 'ПЯН-СЕ', sub: 'ЛЕГЕНДА ВЛАДИВОСТОКА', bg: '#7c2d12', accent: '#fbbf24', bodyColor: 10105874 },
        { id: 'chifanka', title: 'ЧИФАНЬКА', sub: 'ЛАПША • ДАМПЛИНГИ • ВОК', bg: '#7f1d1d', accent: '#f87171', bodyColor: 4524554 },
        { id: 'coffee', title: 'МОРСКОЙ КОФЕ', sub: 'РАФ С МОРСКОЙ СОЛЬЮ', bg: '#0c4a6e', accent: '#38bdf8', bodyColor: 988970 }
    ];
    const stalls = (worldMap && Array.isArray(worldMap.stalls) && worldMap.stalls.length > 0) ? worldMap.stalls : defaultStalls;
    for (const s of stalls) {
        models.set(`stall_${s.id}.glb`, ModelBuilders.stall(s));
    }

    // 3. Vehicles
    const defaultCars = [
        { id: 'car_0', colorHex: 16317180 },
        { id: 'car_1', colorHex: 9741240 },
        { id: 'car_2', colorHex: 14427686 },
        { id: 'car_3', colorHex: 16096779 },
        { id: 'car_4', colorHex: 1920728 }
    ];
    const vehicles = (worldMap && Array.isArray(worldMap.vehicles) && worldMap.vehicles.length > 0) ? worldMap.vehicles : defaultCars;
    for (const v of vehicles) {
        models.set(`${v.id}.glb`, ModelBuilders.car(v.colorHex, v.id));
    }

    // 4. Props & Entities
    models.set('street_lamp.glb', ModelBuilders.street_lamp());
    models.set('road_lamp.glb', ModelBuilders.road_lamp());
    models.set('bench.glb', ModelBuilders.bench());
    models.set('sopka.glb', ModelBuilders.sopka(32, 48));
    models.set('sailboat_white.glb', ModelBuilders.sailboat(0xffffff));
    models.set('sailboat_blue.glb', ModelBuilders.sailboat(0x38bdf8));
    models.set('tanker.glb', ModelBuilders.tanker(8330525));
    models.set('seagull.glb', ModelBuilders.seagull());
    models.set('player.glb', ModelBuilders.player('Игрок', '#38bdf8'));
    models.set('dunya.glb', ModelBuilders.dunya());
    models.set('npc.glb', ModelBuilders.npc(0xe11d48));

    return models;
}
