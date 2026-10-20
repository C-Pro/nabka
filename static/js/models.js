import { TextureFactory } from './textures.js';
import { registerModelBoundingBox, getModelBoundingBox } from './physics.js';

const COMPONENT_TYPES = {
    5120: Int8Array,
    5121: Uint8Array,
    5122: Int16Array,
    5123: Uint16Array,
    5125: Uint32Array,
    5126: Float32Array
};

const COMPONENT_BYTE_SIZES = {
    5120: 1,
    5121: 1,
    5122: 2,
    5123: 2,
    5125: 4,
    5126: 4
};

const TYPE_COUNTS = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16
};

const WEBGL_WRAPPING = {
    33071: () => THREE.ClampToEdgeWrapping,
    33648: () => THREE.MirroredRepeatWrapping,
    10497: () => THREE.RepeatWrapping
};

function readAccessorData(gltf, binChunk, accessorIndex) {
    const accessor = gltf.accessors[accessorIndex];
    if (!accessor) return null;
    const bufferView = gltf.bufferViews[accessor.bufferView];
    if (!bufferView || !binChunk) return null;

    const TypedArrayCtor = COMPONENT_TYPES[accessor.componentType];
    const compBytes = COMPONENT_BYTE_SIZES[accessor.componentType];
    const numComponents = TYPE_COUNTS[accessor.type] || 1;
    const count = accessor.count || 0;
    const totalElements = count * numComponents;

    const baseOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
    const stride = bufferView.byteStride || (numComponents * compBytes);
    const result = new TypedArrayCtor(totalElements);

    const dataView = new DataView(binChunk.buffer, binChunk.byteOffset, binChunk.byteLength);
    const isLittleEndian = true;

    for (let i = 0; i < count; i++) {
        const elemOffset = baseOffset + i * stride;
        for (let c = 0; c < numComponents; c++) {
            const bytePos = elemOffset + c * compBytes;
            const outIdx = i * numComponents + c;
            switch (accessor.componentType) {
                case 5120: result[outIdx] = dataView.getInt8(bytePos); break;
                case 5121: result[outIdx] = dataView.getUint8(bytePos); break;
                case 5122: result[outIdx] = dataView.getInt16(bytePos, isLittleEndian); break;
                case 5123: result[outIdx] = dataView.getUint16(bytePos, isLittleEndian); break;
                case 5125: result[outIdx] = dataView.getUint32(bytePos, isLittleEndian); break;
                case 5126: result[outIdx] = dataView.getFloat32(bytePos, isLittleEndian); break;
            }
        }
    }

    return result;
}

async function decodeGLTFImage(imgDef, gltf, binChunk) {
    if (typeof THREE === 'undefined' || typeof Image === 'undefined') return null;

    let srcUrl = null;
    let revokeAfterLoad = false;

    if (imgDef.bufferView !== undefined && binChunk) {
        const bv = gltf.bufferViews[imgDef.bufferView];
        if (!bv) return null;
        const slice = binChunk.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
        const blob = new Blob([slice], { type: imgDef.mimeType || 'image/png' });
        srcUrl = URL.createObjectURL(blob);
        revokeAfterLoad = true;
    } else if (imgDef.uri) {
        srcUrl = imgDef.uri;
    }

    if (!srcUrl) return null;

    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            if (revokeAfterLoad) URL.revokeObjectURL(srcUrl);
            if (typeof document !== 'undefined') {
                const canvas = document.createElement('canvas');
                canvas.width = img.width || 256;
                canvas.height = img.height || 256;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    ctx.drawImage(img, 0, 0);
                    resolve(canvas);
                    return;
                }
            }
            resolve(img);
        };
        img.onerror = () => {
            if (revokeAfterLoad) URL.revokeObjectURL(srcUrl);
            resolve(null);
        };
        img.src = srcUrl;
    });
}

/**
 * Parses a binary glTF 2.0 (.glb) ArrayBuffer into a THREE.Group hierarchy.
 */
export async function parseGLB(arrayBuffer) {
    if (typeof THREE === 'undefined') return null;
    const buffer = arrayBuffer instanceof Uint8Array
        ? arrayBuffer.buffer.slice(arrayBuffer.byteOffset, arrayBuffer.byteOffset + arrayBuffer.byteLength)
        : arrayBuffer;

    if (!buffer || buffer.byteLength < 20) {
        throw new Error('Invalid GLB buffer: too short');
    }

    const headerView = new DataView(buffer);
    const magic = headerView.getUint32(0, true);
    if (magic !== 0x46546C67) {
        throw new Error('Invalid GLB magic header');
    }
    const version = headerView.getUint32(4, true);
    if (version !== 2) {
        throw new Error(`Unsupported GLB version: ${version}`);
    }

    let gltf = null;
    let binChunk = null;
    let offset = 12;

    while (offset + 8 <= buffer.byteLength) {
        const chunkLength = headerView.getUint32(offset, true);
        const chunkType = headerView.getUint32(offset + 4, true);
        const chunkStart = offset + 8;
        if (chunkStart + chunkLength > buffer.byteLength) break;

        if (chunkType === 0x4E4F534A) {
            const jsonBytes = new Uint8Array(buffer, chunkStart, chunkLength);
            const jsonText = new TextDecoder('utf-8').decode(jsonBytes);
            gltf = JSON.parse(jsonText);
        } else if (chunkType === 0x004E4942) {
            binChunk = new Uint8Array(buffer, chunkStart, chunkLength);
        }
        offset = chunkStart + chunkLength;
    }

    if (!gltf) {
        throw new Error('GLB missing JSON chunk');
    }

    // 1. Decode embedded images & build textures
    const decodedImages = [];
    if (Array.isArray(gltf.images)) {
        for (const imgDef of gltf.images) {
            decodedImages.push(await decodeGLTFImage(imgDef, gltf, binChunk));
        }
    }

    const textures = [];
    if (Array.isArray(gltf.textures)) {
        for (const texDef of gltf.textures) {
            const img = decodedImages[texDef.source];
            if (img) {
                const tex = new THREE.Texture(img);
                tex.flipY = false;
                const sampler = (gltf.samplers && texDef.sampler !== undefined) ? gltf.samplers[texDef.sampler] : null;
                if (sampler) {
                    if (sampler.wrapS && WEBGL_WRAPPING[sampler.wrapS]) tex.wrapS = WEBGL_WRAPPING[sampler.wrapS]();
                    if (sampler.wrapT && WEBGL_WRAPPING[sampler.wrapT]) tex.wrapT = WEBGL_WRAPPING[sampler.wrapT]();
                } else {
                    tex.wrapS = THREE.RepeatWrapping;
                    tex.wrapT = THREE.RepeatWrapping;
                }
                tex.needsUpdate = true;
                textures.push(tex);
            } else {
                textures.push(null);
            }
        }
    }

    // 2. Build materials
    const materials = [];
    if (Array.isArray(gltf.materials)) {
        for (const matDef of gltf.materials) {
            const isUnlit = Boolean(matDef.extensions && matDef.extensions.KHR_materials_unlit);
            const pbr = matDef.pbrMetallicRoughness || {};
            const baseColor = pbr.baseColorFactor || [1, 1, 1, 1];
            const colorObj = new THREE.Color(baseColor[0], baseColor[1], baseColor[2]);
            const extras = matDef.extras || {};

            let mat;
            if (isUnlit) {
                mat = new THREE.MeshBasicMaterial({
                    color: colorObj
                });
            } else {
                mat = new THREE.MeshStandardMaterial({
                    color: colorObj,
                    metalness: pbr.metallicFactor !== undefined ? Math.min(pbr.metallicFactor, 0.58) : 0.0,
                    roughness: pbr.roughnessFactor !== undefined ? Math.max(pbr.roughnessFactor, 0.32) : 0.7,
                    flatShading: Boolean(extras.flatShading)
                });
                if (Array.isArray(matDef.emissiveFactor)) {
                    const [er, eg, eb] = matDef.emissiveFactor;
                    if (er > 0 || eg > 0 || eb > 0) {
                        mat.emissive = new THREE.Color(er, eg, eb);
                        mat.emissiveIntensity = extras.emissiveIntensity !== undefined ? extras.emissiveIntensity : 1.0;
                    }
                }
            }

            if (pbr.baseColorTexture && textures[pbr.baseColorTexture.index]) {
                mat.map = textures[pbr.baseColorTexture.index];
            }
            if (baseColor[3] < 1.0 || matDef.alphaMode === 'BLEND') {
                mat.transparent = true;
                mat.opacity = baseColor[3];
            }
            if (matDef.doubleSided) {
                mat.side = THREE.DoubleSide;
            }
            if (extras.fog === false) {
                mat.fog = false;
            }
            if (matDef.name) {
                mat.name = matDef.name;
            }
            materials.push(mat);
        }
    }
    const defaultMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });

    // 3. Build primitive mesh factory
    function buildMeshFromDef(meshDef) {
        const primitives = meshDef.primitives || [];
        const builtMeshes = [];

        for (const prim of primitives) {
            const geo = new THREE.BufferGeometry();
            const attrs = prim.attributes || {};

            if (attrs.POSITION !== undefined) {
                const posData = readAccessorData(gltf, binChunk, attrs.POSITION);
                if (posData) geo.setAttribute('position', new THREE.BufferAttribute(posData, 3));
            }
            if (attrs.NORMAL !== undefined) {
                const normData = readAccessorData(gltf, binChunk, attrs.NORMAL);
                if (normData) geo.setAttribute('normal', new THREE.BufferAttribute(normData, 3));
            }
            if (attrs.TEXCOORD_0 !== undefined) {
                const uvData = readAccessorData(gltf, binChunk, attrs.TEXCOORD_0);
                if (uvData) geo.setAttribute('uv', new THREE.BufferAttribute(uvData, 2));
            }
            if (attrs.COLOR_0 !== undefined) {
                const colData = readAccessorData(gltf, binChunk, attrs.COLOR_0);
                const acc = gltf.accessors[attrs.COLOR_0];
                const itemSize = (acc && acc.type === 'VEC4') ? 4 : 3;
                if (colData) geo.setAttribute('color', new THREE.BufferAttribute(colData, itemSize));
            }
            if (prim.indices !== undefined) {
                const idxData = readAccessorData(gltf, binChunk, prim.indices);
                if (idxData) geo.setIndex(new THREE.BufferAttribute(idxData, 1));
            }
            if (!geo.attributes.normal && geo.attributes.position) {
                geo.computeVertexNormals();
            }

            const mat = (prim.material !== undefined && materials[prim.material])
                ? materials[prim.material]
                : defaultMaterial;

            const mesh = new THREE.Mesh(geo, mat);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            builtMeshes.push(mesh);
        }

        if (builtMeshes.length === 1) {
            return builtMeshes[0];
        }
        const multiGroup = new THREE.Group();
        builtMeshes.forEach(m => multiGroup.add(m));
        return multiGroup;
    }

    // 4. Build scene nodes recursively
    function buildNode(nodeIdx) {
        const nodeDef = gltf.nodes[nodeIdx];
        if (!nodeDef) return new THREE.Group();

        let obj;
        if (nodeDef.mesh !== undefined && gltf.meshes && gltf.meshes[nodeDef.mesh]) {
            obj = buildMeshFromDef(gltf.meshes[nodeDef.mesh]);
        } else {
            obj = new THREE.Group();
        }

        if (nodeDef.name) {
            obj.name = nodeDef.name;
        }
        if (nodeDef.extras) {
            if (nodeDef.extras.castShadow !== undefined && obj.isMesh) {
                obj.castShadow = Boolean(nodeDef.extras.castShadow);
            }
            if (nodeDef.extras.receiveShadow !== undefined && obj.isMesh) {
                obj.receiveShadow = Boolean(nodeDef.extras.receiveShadow);
            }
            if (nodeDef.extras.noCollide) {
                obj.userData = obj.userData || {};
                obj.userData.noCollide = true;
            }
        }

        if (Array.isArray(nodeDef.matrix) && nodeDef.matrix.length === 16) {
            const m = new THREE.Matrix4().fromArray(nodeDef.matrix);
            m.decompose(obj.position, obj.quaternion, obj.scale);
        } else {
            if (Array.isArray(nodeDef.translation)) {
                obj.position.set(nodeDef.translation[0], nodeDef.translation[1], nodeDef.translation[2]);
            }
            if (Array.isArray(nodeDef.rotation)) {
                obj.quaternion.set(nodeDef.rotation[0], nodeDef.rotation[1], nodeDef.rotation[2], nodeDef.rotation[3]);
            }
            if (Array.isArray(nodeDef.scale)) {
                obj.scale.set(nodeDef.scale[0], nodeDef.scale[1], nodeDef.scale[2]);
            }
        }

        if (Array.isArray(nodeDef.children)) {
            for (const childIdx of nodeDef.children) {
                obj.add(buildNode(childIdx));
            }
        }

        return obj;
    }

    const rootGroup = new THREE.Group();
    const sceneIdx = gltf.scene !== undefined ? gltf.scene : 0;
    const sceneDef = (gltf.scenes && gltf.scenes[sceneIdx]) || { nodes: [] };

    let resultRoot = rootGroup;
    if (Array.isArray(sceneDef.nodes)) {
        if (sceneDef.nodes.length === 1) {
            const singleRoot = buildNode(sceneDef.nodes[0]);
            if (singleRoot.isGroup && !singleRoot.isMesh &&
                singleRoot.position.lengthSq() === 0 &&
                singleRoot.rotation.x === 0 && singleRoot.rotation.y === 0 && singleRoot.rotation.z === 0 &&
                singleRoot.scale.x === 1 && singleRoot.scale.y === 1 && singleRoot.scale.z === 1) {
                resultRoot = singleRoot;
            } else {
                rootGroup.add(singleRoot);
                resultRoot = rootGroup;
            }
        } else {
            for (const nIdx of sceneDef.nodes) {
                rootGroup.add(buildNode(nIdx));
            }
            resultRoot = rootGroup;
        }
    }

    const bbox = computeModelBoundingBox(resultRoot);
    if (bbox) {
        resultRoot.userData = resultRoot.userData || {};
        resultRoot.userData.boundingBox = bbox;
    }

    return resultRoot;
}

function composeLocalMatrix(px, py, pz, qx, qy, qz, qw, sx, sy, sz) {
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2;
    const yy = qy * y2, yz = qy * z2, zz = qz * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;

    return [
        (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
        (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
        (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
        px, py, pz, 1
    ];
}

function multiplyMatrices4(a, b) {
    const out = new Array(16);
    for (let col = 0; col < 4; col++) {
        const b0 = b[col * 4], b1 = b[col * 4 + 1], b2 = b[col * 4 + 2], b3 = b[col * 4 + 3];
        out[col * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
        out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
        out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return out;
}

function getNodeQuaternion(node) {
    if (node.quaternion && typeof node.quaternion.w === 'number') {
        return [node.quaternion.x || 0, node.quaternion.y || 0, node.quaternion.z || 0, node.quaternion.w];
    }
    const rx = (node.rotation && node.rotation.x) || 0;
    const ry = (node.rotation && node.rotation.y) || 0;
    const rz = (node.rotation && node.rotation.z) || 0;
    const c1 = Math.cos(rx / 2), c2 = Math.cos(ry / 2), c3 = Math.cos(rz / 2);
    const s1 = Math.sin(rx / 2), s2 = Math.sin(ry / 2), s3 = Math.sin(rz / 2);
    return [
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3
    ];
}

/**
 * Computes the local-space 3D axis-aligned bounding box of a model hierarchy from its mesh geometry.
 */
export function computeModelBoundingBox(rootObject) {
    if (!rootObject) return null;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let hasVertices = false;

    const addTransformedPoint = (m, vx, vy, vz) => {
        const wx = m[0] * vx + m[4] * vy + m[8] * vz + m[12];
        const wy = m[1] * vx + m[5] * vy + m[9] * vz + m[13];
        const wz = m[2] * vx + m[6] * vy + m[10] * vz + m[14];
        if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) return;
        hasVertices = true;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
        if (wz < minZ) minZ = wz;
        if (wz > maxZ) maxZ = wz;
    };

    const addLocalBoundsBox = (m, bx0, bx1, by0, by1, bz0, bz1) => {
        const xs = [bx0, bx1];
        const ys = [by0, by1];
        const zs = [bz0, bz1];
        for (const x of xs) {
            for (const y of ys) {
                for (const z of zs) {
                    addTransformedPoint(m, x, y, z);
                }
            }
        }
    };

    const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    const visit = (node, parentMat, isRoot) => {
        if (!node) return;
        if (node.isPoints || node.isLight || node.isSprite) return;
        if (node.name === 'fountainParticles' || node.name === 'headBeam' || node.name === 'bounding_box_cordon' || node.name === 'bounding_box_fence') return;
        if (node.userData && (node.userData.noCollide || node.userData.isCordon || node.userData.isFence)) return;

        let mat = IDENTITY;
        if (!isRoot) {
            const px = (node.position && node.position.x) || 0;
            const py = (node.position && node.position.y) || 0;
            const pz = (node.position && node.position.z) || 0;
            const [qx, qy, qz, qw] = getNodeQuaternion(node);
            const sx = (node.scale && node.scale.x !== undefined) ? node.scale.x : 1;
            const sy = (node.scale && node.scale.y !== undefined) ? node.scale.y : 1;
            const sz = (node.scale && node.scale.z !== undefined) ? node.scale.z : 1;
            const localMat = composeLocalMatrix(px, py, pz, qx, qy, qz, qw, sx, sy, sz);
            mat = multiplyMatrices4(parentMat, localMat);
        }

        const geo = node.geometry;
        if ((node.isMesh || geo) && geo) {
            const posAttr = geo.attributes && geo.attributes.position;
            if (posAttr && posAttr.array && posAttr.array.length >= 3) {
                const arr = posAttr.array;
                const stride = posAttr.itemSize || 3;
                for (let i = 0; i <= arr.length - 3; i += stride) {
                    addTransformedPoint(mat, arr[i], arr[i + 1], arr[i + 2]);
                }
            } else if (geo.boundingBox && geo.boundingBox.min && geo.boundingBox.max) {
                const bmin = geo.boundingBox.min;
                const bmax = geo.boundingBox.max;
                addLocalBoundsBox(mat, bmin.x, bmax.x, bmin.y, bmax.y, bmin.z, bmax.z);
            } else if (geo.parameters) {
                const p = geo.parameters;
                const r = Math.max(
                    p.radius || 0,
                    p.radiusTop || 0,
                    p.radiusBottom || 0,
                    p.outerRadius || 0
                ) + (p.tube || 0);
                const hw = p.width !== undefined ? p.width / 2 : r;
                const hh = p.height !== undefined ? p.height / 2 : r;
                const hd = p.depth !== undefined ? p.depth / 2 : (p.width !== undefined && p.depth === undefined && !r ? 0.01 : r);
                if (hw > 0 || hh > 0 || hd > 0) {
                    addLocalBoundsBox(mat, -hw, hw, -hh, hh, -hd, hd);
                }
            }
        }

        if (Array.isArray(node.children)) {
            for (const child of node.children) {
                visit(child, mat, false);
            }
        }
    };

    visit(rootObject, IDENTITY, true);

    if (!hasVertices) return null;

    const round3 = (v) => Math.round(v * 1000) / 1000;
    return {
        minX: round3(minX),
        maxX: round3(maxX),
        minY: round3(minY),
        maxY: round3(maxY),
        minZ: round3(minZ),
        maxZ: round3(maxZ),
        width: round3(maxX - minX),
        height: round3(maxY - minY),
        depth: round3(maxZ - minZ),
        centerX: round3((minX + maxX) / 2),
        centerY: round3((minY + maxY) / 2),
        centerZ: round3((minZ + maxZ) / 2)
    };
}

export function cloneModelHierarchy(source) {
    if (!source || typeof source.clone !== 'function') return null;
    const cloned = source.clone(true);
    if (source.userData && source.userData.boundingBox) {
        cloned.userData = cloned.userData || {};
        cloned.userData.boundingBox = { ...source.userData.boundingBox };
    }
    cloned.traverse((node) => {
        if (node.isMesh && node.material) {
            if (Array.isArray(node.material)) {
                node.material = node.material.map(m => m.clone());
            } else {
                node.material = node.material.clone();
            }
        }
    });
    return cloned;
}

export const DEFAULT_LANDMARKS = [
    { id: 'fountain', name: 'Центральный Фонтан', model: 'models/fountain.glb', x: 0, y: 0, z: 0, rotY: 0, scale: 1, hasFountainParticles: true },
    { id: 'tiger_statue', name: 'Бронзовый Амурский Тигр', model: 'models/tiger_statue.glb', x: -10, y: 0, z: -32, rotY: 0, scale: 1 },
    { id: 'pier', name: 'Пирс пляжа «Юбилейный»', model: 'models/pier.glb', x: -32, y: 0.1, z: 48, rotY: 0, scale: 1 },
    { id: 'ferris_wheel', name: 'Колесо обозрения', model: 'models/ferris_wheel.glb', x: -4, y: 0, z: -88, rotY: 0, scale: 1, isFerrisWheel: true },
    { id: 'dynamo_stadium', name: 'Стадион «Динамо»', model: 'models/dynamo_stadium.glb', x: 38, y: 0, z: -45, rotY: 0, scale: 1, label: { text: '🏟️ Стадион «Динамо» (Фокина, 1 • ★ 4.1)', x: 30, y: 14.5, z: -45 } },
    { id: 'ocean_cinema', name: 'Кинотеатр «Океан IMAX»', model: 'models/ocean_cinema.glb', x: 38, y: 0, z: 92, rotY: 0, scale: 1, label: { text: '🎬 К/Т «Океан IMAX» (Набережная, 3 • ★ 4.7)', x: 28, y: 18.5, z: 92 } },
    { id: 'oceanarium', name: 'Океанариум', model: 'models/oceanarium.glb', x: 6, y: 0, z: -118, rotY: 0, scale: 1 },
    { id: 'supra_restaurant', name: 'Грузинский дом «Супра»', model: 'models/supra_restaurant.glb', x: 36, y: 0, z: 16, rotY: 0, scale: 1 },
    { id: 'fortress_museum', name: 'Музей «Владивостокская крепость»', model: 'models/fortress_museum.glb', x: 35, y: 0, z: -92, rotY: 0, scale: 1 },
    { id: 'olympiets_complex', name: 'СК «Олимпиец»', model: 'models/olympiets_complex.glb', x: 38, y: 0, z: -134, rotY: 0, scale: 1 },
    { id: 'azimut_hotel', name: 'AZIMUT Сити Отель', model: 'models/azimut_hotel.glb', x: 42, y: 0, z: 130, rotY: 0, scale: 1 },
    { id: 'yacht_club_pier', name: 'Пирс яхт-клуба «Семь Футов»', model: 'models/yacht_club_pier.glb', x: -28, y: 0.15, z: 118, rotY: 0, scale: 1 },
    { id: 'yacht_club_boathouse', name: 'Эллинг яхт-клуба «Семь Футов»', model: 'models/yacht_club_boathouse.glb', x: -10, y: 2.25, z: 118, rotY: 0, scale: 1 },
    { id: 'lighthouse', name: 'Токаревский Маяк', model: 'models/lighthouse.glb', x: -105, y: -1.2, z: 125, rotY: 0, scale: 1, label: { text: '🚨 Токаревский Маяк', x: -105, y: 20, z: 125 } },
    { id: 'bridge_pylon_west', name: 'Западный пилон моста', model: 'models/bridge_pylon.glb', x: -35, y: 0, z: 235, rotY: 0, scale: 1 },
    { id: 'bridge_pylon_east', name: 'Восточный пилон моста', model: 'models/bridge_pylon.glb', x: 35, y: 0, z: 235, rotY: 0, scale: 1 },
    { id: 'bridge_deck', name: 'Пролёт моста', model: 'models/bridge_deck.glb', x: 0, y: 24, z: 235, rotY: 0, scale: 1 }
];

export function generateDefaultPromenadeProps() {
    const props = [];
    for (let z = -120; z <= 120; z += 24) {
        props.push({
            id: `lamp_${z}`,
            name: `Фонарь (Z=${z})`,
            type: 'lamp',
            model: 'models/street_lamp.glb',
            x: -12,
            y: 0,
            z,
            rotY: 0,
            scale: 1
        });
        if (Math.abs(z) > 14) {
            props.push({
                id: `bench_${z + 6}`,
                name: `Лавочка (Z=${z + 6})`,
                type: 'bench',
                model: 'models/bench.glb',
                x: -11.2,
                y: 0.325,
                z: z + 6,
                rotY: 0,
                scale: 1,
                hasCollider: true
            });
        }
    }
    return props;
}

/**
 * Procedural builders for all Nabka models.
 * Used as synchronous fallbacks when GLB files are not preloaded (e.g. in unit tests)
 * and by the standalone GLB exporter to generate initial .glb files.
 */
export const ModelBuilders = {
    fountain() {
        const group = new THREE.Group();
        group.name = 'fountain';

        const outerRim = new THREE.Mesh(
            new THREE.CylinderGeometry(9.5, 10.2, 1.1, 32),
            new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.4 })
        );
        outerRim.name = 'outerRim';
        outerRim.position.y = 0.55;
        outerRim.castShadow = true;
        outerRim.receiveShadow = true;
        group.add(outerRim);

        const poolWater = new THREE.Mesh(
            new THREE.CylinderGeometry(8.8, 8.8, 0.95, 32),
            new THREE.MeshStandardMaterial({ color: 0x0ea5e9, emissive: 0x0284c7, emissiveIntensity: 0.45, roughness: 0.15 })
        );
        poolWater.name = 'poolWater';
        poolWater.position.y = 0.62;
        group.add(poolWater);

        const centerTier = new THREE.Mesh(
            new THREE.CylinderGeometry(2.5, 3.2, 1.8, 20),
            new THREE.MeshStandardMaterial({ color: 0xcbd5e1, metalness: 0.5, roughness: 0.3 })
        );
        centerTier.name = 'centerTier';
        centerTier.position.y = 1.1;
        group.add(centerTier);

        return group;
    },

    tiger_statue() {
        const group = new THREE.Group();
        group.name = 'tiger_statue';

        const ped = new THREE.Mesh(
            new THREE.BoxGeometry(3.6, 1.1, 2.4),
            new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.7 })
        );
        ped.name = 'pedestal';
        ped.position.y = 0.55;
        ped.castShadow = true;
        group.add(ped);

        const bronzeMat = new THREE.MeshStandardMaterial({
            color: 0xb45309,
            metalness: 0.85,
            roughness: 0.28
        });

        const body = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.85, 0.85), bronzeMat);
        body.name = 'body';
        body.position.set(0, 1.65, 0);
        body.castShadow = true;
        group.add(body);

        const head = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.7, 0.75), bronzeMat);
        head.name = 'head';
        head.position.set(-1.15, 2.0, 0);
        group.add(head);

        [[-0.75, 0.3], [-0.75, -0.3], [0.75, 0.3], [0.75, -0.3]].forEach(([lx, lz], idx) => {
            const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.8, 0.3), bronzeMat);
            leg.name = `leg_${idx}`;
            leg.position.set(lx, 1.25, lz);
            group.add(leg);
        });

        const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 1.3), bronzeMat);
        tail.name = 'tail';
        tail.rotation.z = -0.8;
        tail.position.set(1.35, 1.55, 0);
        group.add(tail);

        return group;
    },

    stall(s = {}) {
        const group = new THREE.Group();
        group.name = `stall_${s.id || 'generic'}`;

        const booth = new THREE.Mesh(
            new THREE.BoxGeometry(4.4, 3.4, 6.2),
            new THREE.MeshStandardMaterial({ color: s.bodyColor !== undefined ? s.bodyColor : 0x7c2d12, roughness: 0.5 })
        );
        booth.name = 'booth';
        booth.position.y = 1.7;
        booth.castShadow = true;
        booth.receiveShadow = true;
        group.add(booth);

        const win = new THREE.Mesh(
            new THREE.PlaneGeometry(4.2, 1.5),
            new THREE.MeshBasicMaterial({ color: 0xfef3c7 })
        );
        win.name = 'window';
        win.rotation.y = -Math.PI / 2;
        win.position.set(-2.22, 1.85, 0);
        group.add(win);

        const signTex = TextureFactory.createSignTexture(
            s.title || 'СТРИТФУД',
            s.sub || 'НАБКА',
            s.bg || '#7c2d12',
            s.accent || '#fbbf24'
        );
        const signBoard = new THREE.Mesh(
            new THREE.BoxGeometry(0.4, 1.5, 5.8),
            new THREE.MeshBasicMaterial({ map: signTex })
        );
        signBoard.name = 'signBoard';
        signBoard.position.set(-2.1, 4.15, 0);
        group.add(signBoard);

        return group;
    },

    pier() {
        const group = new THREE.Group();
        group.name = 'pier';
        const pierGeo = new THREE.BoxGeometry(36, 0.6, 7);
        const pierMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.8 });
        const pier = new THREE.Mesh(pierGeo, pierMat);
        pier.name = 'pierDeck';
        pier.receiveShadow = true;
        group.add(pier);
        return group;
    },

    sailboat(sailColor = 0xffffff) {
        const boat = new THREE.Group();
        boat.name = sailColor === 0xffffff ? 'sailboat_white' : 'sailboat_blue';

        const hull = new THREE.Mesh(
            new THREE.BoxGeometry(7.5, 1.4, 2.8),
            new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.3 })
        );
        hull.name = 'hull';
        boat.add(hull);

        const mast = new THREE.Mesh(
            new THREE.CylinderGeometry(0.1, 0.12, 11),
            new THREE.MeshStandardMaterial({ color: 0xe2e8f0 })
        );
        mast.name = 'mast';
        mast.position.y = 5.5;
        boat.add(mast);

        const sail = new THREE.Mesh(
            new THREE.PlaneGeometry(4.5, 8.5),
            new THREE.MeshStandardMaterial({ color: sailColor, side: THREE.DoubleSide })
        );
        sail.name = 'sail';
        sail.position.set(1.2, 5.5, 0);
        boat.add(sail);

        return boat;
    },

    ferris_wheel() {
        const supportGroup = new THREE.Group();
        supportGroup.name = 'ferris_wheel';

        const legMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.6, roughness: 0.3 });
        [-2.2, 2.2].forEach((lz, idx) => {
            const legA = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 22), legMat);
            legA.name = `legA_${idx}`;
            legA.position.set(-4, 10, lz);
            legA.rotation.z = -0.22;
            supportGroup.add(legA);

            const legB = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 22), legMat);
            legB.name = `legB_${idx}`;
            legB.position.set(4, 10, lz);
            legB.rotation.z = 0.22;
            supportGroup.add(legB);
        });

        const wheelGroup = new THREE.Group();
        wheelGroup.name = 'ferrisWheelGroup';
        wheelGroup.position.set(0, 19.5, 0);

        const rim = new THREE.Mesh(
            new THREE.TorusGeometry(13.5, 0.35, 12, 36),
            new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0284c7, emissiveIntensity: 0.6 })
        );
        rim.name = 'rim';
        wheelGroup.add(rim);

        const cabinColors = [0xf43f5e, 0xf59e0b, 0x10b981, 0x3b82f6, 0xa855f7];
        for (let i = 0; i < 12; i++) {
            const angle = (i / 12) * Math.PI * 2;
            const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 27), legMat);
            spoke.name = `spoke_${i}`;
            spoke.rotation.z = angle;
            wheelGroup.add(spoke);

            const cabin = new THREE.Mesh(
                new THREE.BoxGeometry(1.8, 1.8, 1.8),
                new THREE.MeshStandardMaterial({ color: cabinColors[i % cabinColors.length], roughness: 0.3 })
            );
            cabin.name = `cabin_${i}`;
            cabin.position.set(Math.cos(angle) * 13.5, Math.sin(angle) * 13.5, 0);
            wheelGroup.add(cabin);
        }

        supportGroup.add(wheelGroup);
        return supportGroup;
    },

    dynamo_stadium() {
        const group = new THREE.Group();
        group.name = 'dynamo_stadium';

        const tex = TextureFactory.createBuildingFacadeTexture('#1e3a8a', '#93c5fd', 8, 4);
        const mainStand = new THREE.Mesh(
            new THREE.BoxGeometry(16, 13, 56),
            new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 })
        );
        mainStand.name = 'mainStand';
        mainStand.position.y = 6.5;
        mainStand.castShadow = true;
        group.add(mainStand);

        const signTex = TextureFactory.createSignTexture('ДИНАМО', 'СТАДИОН • ВЛАДИВОСТОК', '#172554', '#60a5fa');
        const sign = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 3.2, 16),
            new THREE.MeshBasicMaterial({ map: signTex })
        );
        sign.name = 'sign';
        sign.position.set(-8.2, 11.5, 0);
        group.add(sign);

        return group;
    },

    ocean_cinema() {
        const group = new THREE.Group();
        group.name = 'ocean_cinema';

        const base = new THREE.Mesh(
            new THREE.BoxGeometry(20, 6, 28),
            new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.6 })
        );
        base.name = 'base';
        base.position.y = 3;
        group.add(base);

        const rotundaTex = TextureFactory.createBuildingFacadeTexture('#0f172a', '#38bdf8', 12, 5);
        const rotunda = new THREE.Mesh(
            new THREE.CylinderGeometry(11, 11, 12, 28),
            new THREE.MeshStandardMaterial({ map: rotundaTex, roughness: 0.35, metalness: 0.4 })
        );
        rotunda.name = 'rotunda';
        rotunda.position.y = 11;
        group.add(rotunda);

        const signTex = TextureFactory.createSignTexture('ОКЕАН', 'КИНОТЕАТР IMAX • НАБКА', '#0284c7', '#ffffff');
        const sign = new THREE.Mesh(
            new THREE.BoxGeometry(0.6, 3.0, 14),
            new THREE.MeshBasicMaterial({ map: signTex })
        );
        sign.name = 'sign';
        sign.position.set(-11.2, 15.8, 0);
        group.add(sign);

        return group;
    },

    oceanarium() {
        const group = new THREE.Group();
        group.name = 'oceanarium';

        const baseCyl = new THREE.Mesh(
            new THREE.CylinderGeometry(11.5, 12, 5.5, 28),
            new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 })
        );
        baseCyl.name = 'baseCyl';
        baseCyl.position.y = 2.75;
        baseCyl.castShadow = true;
        group.add(baseCyl);

        const dome = new THREE.Mesh(
            new THREE.SphereGeometry(11.4, 28, 16, 0, Math.PI * 2, 0, Math.PI / 2),
            new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.25, metalness: 0.35 })
        );
        dome.name = 'dome';
        dome.position.y = 5.4;
        group.add(dome);

        const signTex = TextureFactory.createSignTexture('ОКЕАНАРИУМ', 'УЛ. БАТАРЕЙНАЯ • НАБКА', '#0c4a6e', '#38bdf8');
        const sign = new THREE.Mesh(
            new THREE.BoxGeometry(12, 2.6, 0.5),
            new THREE.MeshBasicMaterial({ map: signTex })
        );
        sign.name = 'sign';
        sign.position.set(0, 6.5, 11.8);
        group.add(sign);

        return group;
    },

    arbat_paving() {
        const group = new THREE.Group();
        group.name = 'arbat_paving';
        const arbatPaving = new THREE.Mesh(
            new THREE.BoxGeometry(28, 0.12, 14),
            new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.6 })
        );
        arbatPaving.name = 'paving';
        group.add(arbatPaving);
        return group;
    },

    supra_restaurant() {
        const supraGroup = new THREE.Group();
        supraGroup.name = 'supra_restaurant';

        const supraTex = TextureFactory.createBuildingFacadeTexture('#7c2d12', '#fde68a', 5, 3);
        const supraBuilding = new THREE.Mesh(
            new THREE.BoxGeometry(11, 7.5, 13),
            new THREE.MeshStandardMaterial({ map: supraTex, roughness: 0.55 })
        );
        supraBuilding.name = 'supraBuilding';
        supraBuilding.position.y = 3.75;
        supraBuilding.castShadow = true;
        supraGroup.add(supraBuilding);

        const supraSignTex = TextureFactory.createSignTexture('СУПРА', 'ФОКИНА, 1Б • ГРУЗИНСКИЙ ДОМ', '#451a03', '#fbbf24');
        const supraSign = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 2.4, 10.5),
            new THREE.MeshBasicMaterial({ map: supraSignTex })
        );
        supraSign.name = 'supraSign';
        supraSign.position.set(-5.6, 6.2, 0);
        supraGroup.add(supraSign);

        const terrace = new THREE.Mesh(
            new THREE.BoxGeometry(3.2, 0.75, 11),
            new THREE.MeshStandardMaterial({ color: 0x78350f })
        );
        terrace.name = 'terrace';
        terrace.position.set(-7.1, 0.375, 0);
        supraGroup.add(terrace);

        return supraGroup;
    },

    fortress_museum() {
        const fortGroup = new THREE.Group();
        fortGroup.name = 'fortress_museum';

        const parapet = new THREE.Mesh(
            new THREE.BoxGeometry(9, 1.25, 22),
            new THREE.MeshStandardMaterial({ color: 0x7f1d1d, roughness: 0.85 })
        );
        parapet.name = 'parapet';
        parapet.position.y = 0.625;
        parapet.castShadow = true;
        fortGroup.add(parapet);

        const bunker = new THREE.Mesh(
            new THREE.BoxGeometry(10, 5.5, 16),
            new THREE.MeshStandardMaterial({ color: 0x991b1b, roughness: 0.8 })
        );
        bunker.name = 'bunker';
        bunker.position.set(6, 2.75, 0);
        fortGroup.add(bunker);

        const cannonMat = new THREE.MeshStandardMaterial({ color: 0x14532d, metalness: 0.6, roughness: 0.4 });
        [-5, 5].forEach((cz, idx) => {
            const mount = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.9, 1.8), cannonMat);
            mount.name = `cannonMount_${idx}`;
            mount.position.set(-1.5, 1.7, cz);
            fortGroup.add(mount);

            const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.26, 4.6), cannonMat);
            barrel.name = `cannonBarrel_${idx}`;
            barrel.rotation.z = Math.PI / 2.2;
            barrel.position.set(-3.2, 2.2, cz);
            fortGroup.add(barrel);
        });

        const fortSignTex = TextureFactory.createSignTexture('КРЕПОСТЬ', 'МУЗЕЙ • БАТАРЕЙНАЯ, 4А', '#450a0a', '#fca5a5');
        const fortSign = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 2.2, 11),
            new THREE.MeshBasicMaterial({ map: fortSignTex })
        );
        fortSign.name = 'fortSign';
        fortSign.position.set(0.8, 6.2, 0);
        fortGroup.add(fortSign);

        return fortGroup;
    },

    olympiets_complex() {
        const olympGroup = new THREE.Group();
        olympGroup.name = 'olympiets_complex';

        const olympTex = TextureFactory.createBuildingFacadeTexture('#0f172a', '#38bdf8', 8, 4);
        const olympHall = new THREE.Mesh(
            new THREE.BoxGeometry(18, 11, 28),
            new THREE.MeshStandardMaterial({ map: olympTex, roughness: 0.5 })
        );
        olympHall.name = 'olympHall';
        olympHall.position.y = 5.5;
        olympHall.castShadow = true;
        olympGroup.add(olympHall);

        const olympSignTex = TextureFactory.createSignTexture('СК ОЛИМПИЕЦ', 'БАТАРЕЙНАЯ, 2 • СПОРТКОМПЛЕКС', '#0369a1', '#fde047');
        const olympSign = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 2.8, 15),
            new THREE.MeshBasicMaterial({ map: olympSignTex })
        );
        olympSign.name = 'olympSign';
        olympSign.position.set(-9.2, 9.8, 0);
        olympGroup.add(olympSign);

        return olympGroup;
    },

    azimut_hotel() {
        const azimutGroup = new THREE.Group();
        azimutGroup.name = 'azimut_hotel';

        const azimutTex = TextureFactory.createBuildingFacadeTexture('#cbd5e1', '#fef08a', 10, 10);
        const azimutTower = new THREE.Mesh(
            new THREE.BoxGeometry(14, 28, 30),
            new THREE.MeshStandardMaterial({ map: azimutTex, roughness: 0.45 })
        );
        azimutTower.name = 'azimutTower';
        azimutTower.position.y = 14;
        azimutTower.castShadow = true;
        azimutGroup.add(azimutTower);

        const azimutSignTex = TextureFactory.createSignTexture('AZIMUT ОТЕЛЬ', 'УЛ. НАБЕРЕЖНАЯ, 10 • ВЛАДИВОСТОК', '#991b1b', '#ffffff');
        const azimutSign = new THREE.Mesh(
            new THREE.BoxGeometry(0.6, 3.2, 16),
            new THREE.MeshBasicMaterial({ map: azimutSignTex })
        );
        azimutSign.name = 'azimutSign';
        azimutSign.position.set(-7.2, 26.2, 0);
        azimutGroup.add(azimutSign);

        return azimutGroup;
    },

    yacht_club_pier() {
        const group = new THREE.Group();
        group.name = 'yacht_club_pier';
        const marinaPier = new THREE.Mesh(
            new THREE.BoxGeometry(30, 0.7, 8),
            new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.7 })
        );
        marinaPier.name = 'marinaPier';
        group.add(marinaPier);
        return group;
    },

    yacht_club_boathouse() {
        const group = new THREE.Group();
        group.name = 'yacht_club_boathouse';
        const clubBoathouse = new THREE.Mesh(
            new THREE.BoxGeometry(7, 4.5, 9),
            new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.4 })
        );
        clubBoathouse.name = 'clubBoathouse';
        group.add(clubBoathouse);
        return group;
    },

    lighthouse() {
        const lighthouseGroup = new THREE.Group();
        lighthouseGroup.name = 'lighthouse';

        const spit = new THREE.Mesh(
            new THREE.BoxGeometry(55, 1.2, 6),
            new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.9 })
        );
        spit.name = 'spit';
        spit.position.set(22, 0.2, 0);
        lighthouseGroup.add(spit);

        const tower = new THREE.Mesh(
            new THREE.CylinderGeometry(1.4, 2.2, 14, 16),
            new THREE.MeshStandardMaterial({ color: 0xf8fafc })
        );
        tower.name = 'tower';
        tower.position.y = 7;
        lighthouseGroup.add(tower);

        const redTop = new THREE.Mesh(
            new THREE.CylinderGeometry(1.6, 1.6, 2.8, 16),
            new THREE.MeshStandardMaterial({ color: 0xdc2626 })
        );
        redTop.name = 'redTop';
        redTop.position.y = 14.8;
        lighthouseGroup.add(redTop);

        const beacon = new THREE.Mesh(
            new THREE.SphereGeometry(1.2, 12, 12),
            new THREE.MeshBasicMaterial({ color: 0xfef08a })
        );
        beacon.name = 'beacon';
        beacon.position.y = 16.8;
        lighthouseGroup.add(beacon);

        return lighthouseGroup;
    },

    bridge_pylon() {
        const pylon = new THREE.Group();
        pylon.name = 'bridge_pylon';
        const pylonMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.4, metalness: 0.5 });

        const legL = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.6, 68), pylonMat);
        legL.name = 'legL';
        legL.position.set(-6, 32, 0);
        legL.rotation.z = -0.14;
        pylon.add(legL);

        const legR = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.6, 68), pylonMat);
        legR.name = 'legR';
        legR.position.set(6, 32, 0);
        legR.rotation.z = 0.14;
        pylon.add(legR);

        const crossBar = new THREE.Mesh(new THREE.BoxGeometry(18, 2.2, 2.5), pylonMat);
        crossBar.name = 'crossBar';
        crossBar.position.set(0, 26, 0);
        pylon.add(crossBar);

        return pylon;
    },

    bridge_deck() {
        const group = new THREE.Group();
        group.name = 'bridge_deck';
        const bridgeDeck = new THREE.Mesh(
            new THREE.BoxGeometry(160, 1.8, 6),
            new THREE.MeshStandardMaterial({ color: 0x334155 })
        );
        bridgeDeck.name = 'bridgeDeck';
        group.add(bridgeDeck);
        return group;
    },

    street_lamp() {
        const lamp = new THREE.Group();
        lamp.name = 'street_lamp';
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.7 });
        const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfde68a });

        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 5.2), poleMat);
        pole.name = 'pole';
        pole.position.y = 2.6;
        lamp.add(pole);

        const globe = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 10), bulbMat);
        globe.name = 'globe';
        globe.position.y = 5.3;
        lamp.add(globe);

        return lamp;
    },

    road_lamp() {
        const lamp = new THREE.Group();
        lamp.name = 'road_lamp';

        const steelMat = new THREE.MeshStandardMaterial({
            color: 0x334155,
            roughness: 0.45,
            metalness: 0.75
        });
        const darkSteelMat = new THREE.MeshStandardMaterial({
            color: 0x1e293b,
            roughness: 0.6,
            metalness: 0.8
        });
        const luminaireMat = new THREE.MeshStandardMaterial({
            color: 0x475569,
            roughness: 0.5,
            metalness: 0.7
        });
        const ledMat = new THREE.MeshBasicMaterial({
            color: 0xffffff
        });

        // 1. Heavy base mounting plate & collar (pole-only collider base)
        const baseFlange = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.25, 12), darkSteelMat);
        baseFlange.name = 'baseFlange';
        baseFlange.position.y = 0.125;
        lamp.add(baseFlange);

        const baseCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.24, 0.8, 12), darkSteelMat);
        baseCollar.name = 'baseCollar';
        baseCollar.position.y = 0.55;
        lamp.add(baseCollar);

        // 2. Main vertical mast (pole)
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.18, 6.7, 12), steelMat);
        mast.name = 'mast';
        mast.position.y = 4.3;
        lamp.add(mast);

        // 3. Cantilever outreach arm (marked noCollide so vehicles/players walk/drive underneath)
        const armGroup = new THREE.Group();
        armGroup.name = 'armGroup';
        armGroup.userData = { noCollide: true };

        const bracket1 = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.10, 1.8, 8), steelMat);
        bracket1.name = 'bracket1';
        bracket1.position.set(0.65, 8.0, 0);
        bracket1.rotation.z = -Math.PI / 4;
        bracket1.userData = { noCollide: true };
        armGroup.add(bracket1);

        const bracket2 = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.4, 8), steelMat);
        bracket2.name = 'bracket2';
        bracket2.position.set(1.8, 8.55, 0);
        bracket2.rotation.z = -Math.PI / 2;
        bracket2.userData = { noCollide: true };
        armGroup.add(bracket2);

        const fixture = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.22, 0.42), luminaireMat);
        fixture.name = 'luminaireFixture';
        fixture.position.set(2.4, 8.45, 0);
        fixture.rotation.z = 0.08;
        fixture.userData = { noCollide: true };
        armGroup.add(fixture);

        const ledPanel = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.32), ledMat);
        ledPanel.name = 'ledPanel';
        ledPanel.position.set(2.4, 8.33, 0);
        ledPanel.rotation.x = Math.PI / 2;
        ledPanel.userData = { noCollide: true };
        armGroup.add(ledPanel);

        lamp.add(armGroup);

        lamp.userData = {
            boundingBox: {
                minX: -0.28,
                maxX: 0.28,
                minY: 0,
                maxY: 7.65,
                minZ: -0.28,
                maxZ: 0.28
            }
        };

        return lamp;
    },

    bench() {
        const group = new THREE.Group();
        group.name = 'bench';
        const bench = new THREE.Mesh(
            new THREE.BoxGeometry(0.9, 0.65, 2.6),
            new THREE.MeshStandardMaterial({ color: 0x92400e })
        );
        bench.name = 'benchMesh';
        group.add(bench);
        return group;
    },

    sopka(radius = 32, height = 48) {
        const hillGroup = new THREE.Group();
        hillGroup.name = 'sopka';

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

        const cone = new THREE.Mesh(
            new THREE.ConeGeometry(radius, height, 14, 3),
            sopkaGreenMat
        );
        cone.name = 'cone';
        cone.position.y = height / 2;
        cone.castShadow = true;
        cone.receiveShadow = true;
        hillGroup.add(cone);

        const shoulder = new THREE.Mesh(
            new THREE.DodecahedronGeometry(radius * 0.68, 1),
            sopkaDarkForestMat
        );
        shoulder.name = 'shoulder';
        shoulder.scale.set(1.15, (height * 0.55) / (radius * 0.68), 1.1);
        shoulder.position.set(-radius * 0.22, height * 0.28, radius * 0.15);
        hillGroup.add(shoulder);

        const cliff = new THREE.Mesh(
            new THREE.CylinderGeometry(radius * 0.82, radius * 0.98, Math.min(7, height * 0.22), 12),
            cliffRockMat
        );
        cliff.name = 'cliff';
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
            foliage.name = `tree_${t}`;
            foliage.position.set(tx, ty, tz);
            hillGroup.add(foliage);
        }

        return hillGroup;
    },

    tanker(hullColor = 0x7f1d1d) {
        const ship = new THREE.Group();
        ship.name = 'tanker';

        const hull = new THREE.Mesh(
            new THREE.BoxGeometry(6.8, 2.6, 34),
            new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.6 })
        );
        hull.name = 'hull';
        hull.position.y = 1.1;
        ship.add(hull);

        const waterline = new THREE.Mesh(
            new THREE.BoxGeometry(7.0, 0.8, 34.2),
            new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.7 })
        );
        waterline.name = 'waterline';
        waterline.position.y = 0.25;
        ship.add(waterline);

        const deckPipe = new THREE.Mesh(
            new THREE.CylinderGeometry(0.35, 0.35, 22),
            new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.5 })
        );
        deckPipe.name = 'deckPipe';
        deckPipe.rotation.x = Math.PI / 2;
        deckPipe.position.set(0, 2.65, 2);
        ship.add(deckPipe);

        const bridge = new THREE.Mesh(
            new THREE.BoxGeometry(5.6, 5.2, 6.2),
            new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 })
        );
        bridge.name = 'bridge';
        bridge.position.set(0, 4.8, -11.5);
        ship.add(bridge);

        const funnel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.85, 1.05, 3.2, 12),
            new THREE.MeshStandardMaterial({ color: 0xea580c })
        );
        funnel.name = 'funnel';
        funnel.position.set(0, 8.2, -12.5);
        ship.add(funnel);

        const navLight = new THREE.Mesh(
            new THREE.SphereGeometry(0.45, 8, 8),
            new THREE.MeshBasicMaterial({ color: 0xfef08a, fog: false })
        );
        navLight.name = 'navLight';
        navLight.position.set(0, 9.8, -11.0);
        ship.add(navLight);

        const bowLight = new THREE.Mesh(
            new THREE.SphereGeometry(0.38, 8, 8),
            new THREE.MeshBasicMaterial({ color: 0x38bdf8, fog: false })
        );
        bowLight.name = 'bowLight';
        bowLight.position.set(0, 4.2, 15.5);
        ship.add(bowLight);

        return ship;
    },

    seagull() {
        const bird = new THREE.Group();
        bird.name = 'seagull';

        const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
        const wingMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, side: THREE.DoubleSide, roughness: 0.45 });
        const wingTipMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, side: THREE.DoubleSide });
        const beakMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b });

        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.2, 0.68), bodyMat);
        torso.name = 'torso';
        bird.add(torso);

        const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), bodyMat);
        head.name = 'head';
        head.position.set(0, 0.08, 0.36);
        bird.add(head);

        const beak = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.2, 6), beakMat);
        beak.name = 'beak';
        beak.rotation.x = Math.PI / 2;
        beak.position.set(0, 0.06, 0.50);
        bird.add(beak);

        const tail = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 0.26), wingTipMat);
        tail.name = 'tail';
        tail.position.set(0, 0.02, -0.42);
        bird.add(tail);

        const leftWingPivot = new THREE.Group();
        leftWingPivot.name = 'leftWing';
        leftWingPivot.position.set(0.11, 0.05, 0.02);
        const leftInner = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.04, 0.28), wingMat);
        leftInner.name = 'leftInner';
        leftInner.position.x = 0.34;
        const leftTip = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.035, 0.22), wingTipMat);
        leftTip.name = 'leftTip';
        leftTip.position.x = 0.80;
        leftWingPivot.add(leftInner, leftTip);

        const rightWingPivot = new THREE.Group();
        rightWingPivot.name = 'rightWing';
        rightWingPivot.position.set(-0.11, 0.05, 0.02);
        const rightInner = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.04, 0.28), wingMat);
        rightInner.name = 'rightInner';
        rightInner.position.x = -0.34;
        const rightTip = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.035, 0.22), wingTipMat);
        rightTip.name = 'rightTip';
        rightTip.position.x = -0.80;
        rightWingPivot.add(rightInner, rightTip);

        bird.add(leftWingPivot, rightWingPivot);
        return bird;
    },

    player(username = 'Игрок', accentHex = '#38bdf8') {
        const group = new THREE.Group();
        group.name = 'player';

        const accentColorInt = parseInt(String(accentHex).replace('#', ''), 16) || 0x38bdf8;
        const shirtTex = TextureFactory.createPlayerShirtTexture(username, accentHex);
        const torsoMat = new THREE.MeshStandardMaterial({ map: shirtTex, roughness: 0.5 });
        const skinMat = new THREE.MeshStandardMaterial({ color: 0xf1c27d, roughness: 0.6 });
        const jeansMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 });
        const shoeMat = new THREE.MeshStandardMaterial({ color: accentColorInt, roughness: 0.4 });

        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.92, 1.15, 0.52), torsoMat);
        torso.name = 'torso';
        torso.position.y = 1.48;
        torso.castShadow = true;
        group.add(torso);

        const head = new THREE.Group();
        head.name = 'head';
        head.position.set(0, 2.32, 0);

        const headMesh = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.56, 0.56), skinMat);
        headMesh.name = 'headMesh';
        headMesh.castShadow = true;
        head.add(headMesh);

        const capMat = new THREE.MeshStandardMaterial({ color: accentColorInt, roughness: 0.4 });
        const capCrown = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.22, 0.6), capMat);
        capCrown.name = 'capCrown';
        capCrown.position.y = 0.24;
        head.add(capCrown);

        const capVisor = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.08, 0.35), capMat);
        capVisor.name = 'capVisor';
        capVisor.position.set(0, 0.16, 0.38);
        head.add(capVisor);

        const glasses = new THREE.Mesh(
            new THREE.BoxGeometry(0.58, 0.14, 0.12),
            new THREE.MeshStandardMaterial({ color: 0x090d16, metalness: 0.9, roughness: 0.1 })
        );
        glasses.name = 'glasses';
        glasses.position.set(0, 0.04, 0.26);
        head.add(glasses);

        group.add(head);

        const makeLimb = (limbName, w, h, d, mat, shoe = null) => {
            const pivot = new THREE.Group();
            pivot.name = limbName;
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
            mesh.name = `${limbName}_mesh`;
            mesh.position.y = -h / 2;
            mesh.castShadow = true;
            pivot.add(mesh);

            if (shoe) {
                const sneaker = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.22, d + 0.16), shoe);
                sneaker.name = `${limbName}_shoe`;
                sneaker.position.set(0, -h + 0.11, 0.06);
                sneaker.castShadow = true;
                pivot.add(sneaker);
            }
            return pivot;
        };

        const leftArm = makeLimb('leftArm', 0.28, 0.95, 0.28, new THREE.MeshStandardMaterial({ color: 0x0f172a }));
        leftArm.position.set(0.6, 1.95, 0);
        group.add(leftArm);

        const rightArm = makeLimb('rightArm', 0.28, 0.95, 0.28, new THREE.MeshStandardMaterial({ color: 0x0f172a }));
        rightArm.position.set(-0.6, 1.95, 0);
        group.add(rightArm);

        const leftLeg = makeLimb('leftLeg', 0.34, 0.9, 0.34, jeansMat, shoeMat);
        leftLeg.position.set(0.23, 0.9, 0);
        group.add(leftLeg);

        const rightLeg = makeLimb('rightLeg', 0.34, 0.9, 0.34, jeansMat, shoeMat);
        rightLeg.position.set(-0.23, 0.9, 0);
        group.add(rightLeg);

        return group;
    },

    dunya() {
        const group = new THREE.Group();
        group.name = 'dunya';

        const whiteFurMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
        const snowFluffMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.9 });
        const darkEyeMat = new THREE.MeshStandardMaterial({ color: 0x090d16, roughness: 0.15 });
        const pinkBowMat = new THREE.MeshStandardMaterial({ color: 0xf43f5e, roughness: 0.4 });
        const pinkTongueMat = new THREE.MeshStandardMaterial({ color: 0xfb7185, roughness: 0.5 });
        const goldMat = new THREE.MeshStandardMaterial({ color: 0xfbbf24, metalness: 0.85, roughness: 0.2 });

        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.32, 0.64), whiteFurMat);
        torso.name = 'torso';
        torso.position.set(0, 0.34, 0);
        torso.castShadow = true;
        group.add(torso);

        const chestFluff = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 10), snowFluffMat);
        chestFluff.name = 'chestFluff';
        chestFluff.scale.set(1.0, 0.95, 0.9);
        chestFluff.position.set(0, 0.36, 0.25);
        group.add(chestFluff);

        const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.18, 0.06, 12), pinkBowMat);
        collar.name = 'collar';
        collar.rotation.x = 0.35;
        collar.position.set(0, 0.45, 0.24);
        group.add(collar);

        const medal = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), goldMat);
        medal.name = 'medal';
        medal.position.set(0, 0.39, 0.38);
        group.add(medal);

        const headGroup = new THREE.Group();
        headGroup.name = 'headGroup';
        headGroup.position.set(0, 0.58, 0.30);

        const skull = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 12), whiteFurMat);
        skull.name = 'skull';
        skull.scale.set(1.05, 0.98, 1.0);
        skull.castShadow = true;
        headGroup.add(skull);

        const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.14, 0.16), snowFluffMat);
        muzzle.name = 'muzzle';
        muzzle.position.set(0, -0.03, 0.17);
        headGroup.add(muzzle);

        const nose = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), darkEyeMat);
        nose.name = 'nose';
        nose.position.set(0, 0.01, 0.25);
        headGroup.add(nose);

        const tongue = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.03), pinkTongueMat);
        tongue.name = 'tongue';
        tongue.rotation.x = 0.35;
        tongue.position.set(0, -0.08, 0.23);
        headGroup.add(tongue);

        [-0.085, 0.085].forEach((ex, idx) => {
            const eye = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 8), darkEyeMat);
            eye.name = `eye_${idx}`;
            eye.position.set(ex, 0.05, 0.18);
            headGroup.add(eye);
        });

        [-0.19, 0.19].forEach((earX, idx) => {
            const ear = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, 0.14), snowFluffMat);
            ear.name = `ear_${idx}`;
            ear.position.set(earX, -0.02, 0.02);
            ear.rotation.z = earX > 0 ? -0.22 : 0.22;
            headGroup.add(ear);
        });

        const topknot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), whiteFurMat);
        topknot.name = 'topknot';
        topknot.position.set(0, 0.22, 0.02);
        headGroup.add(topknot);

        const bowLeft = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.055, 0.04), pinkBowMat);
        bowLeft.name = 'bowLeft';
        bowLeft.position.set(-0.045, 0.18, 0.08);
        bowLeft.rotation.z = 0.25;
        const bowRight = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.055, 0.04), pinkBowMat);
        bowRight.name = 'bowRight';
        bowRight.position.set(0.045, 0.18, 0.08);
        bowRight.rotation.z = -0.25;
        headGroup.add(bowLeft, bowRight);

        group.add(headGroup);

        const tailPivot = new THREE.Group();
        tailPivot.name = 'tailPivot';
        tailPivot.position.set(0, 0.44, -0.30);
        const tailPlume = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 8), whiteFurMat);
        tailPlume.name = 'tailPlume';
        tailPlume.scale.set(0.85, 1.35, 1.1);
        tailPlume.position.set(0, 0.10, -0.04);
        tailPivot.add(tailPlume);
        group.add(tailPivot);

        const legPositions = [
            [-0.12, 0.22, 0.20],
            [0.12, 0.22, 0.20],
            [-0.12, 0.22, -0.20],
            [0.12, 0.22, -0.20]
        ];
        legPositions.forEach(([lx, ly, lz], idx) => {
            const pivot = new THREE.Group();
            pivot.name = `leg_${idx}`;
            pivot.position.set(lx, ly, lz);
            const legMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.22, 8), whiteFurMat);
            legMesh.name = `legMesh_${idx}`;
            legMesh.position.y = -0.11;
            legMesh.castShadow = true;
            pivot.add(legMesh);
            group.add(pivot);
        });

        return group;
    },

    berik() {
        const group = new THREE.Group();
        group.name = 'berik';

        const greyFurMat = new THREE.MeshStandardMaterial({ color: 0x5b6574, roughness: 0.85 });
        const whiteFurMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
        const eyeGreenMat = new THREE.MeshStandardMaterial({ color: 0xa8e62c, roughness: 0.2 });
        const darkPupilMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.15 });
        const pinkNoseMat = new THREE.MeshStandardMaterial({ color: 0xf472b6, roughness: 0.4 });
        const innerEarMat = new THREE.MeshStandardMaterial({ color: 0xfda4af, roughness: 0.6 });
        const darkSlateMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5 });

        // Body & Coat
        const bodyGroup = new THREE.Group();
        bodyGroup.name = 'body';
        bodyGroup.position.set(0, 0.34, 0);

        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.325, 0.65), greyFurMat);
        torso.name = 'torso';
        torso.castShadow = true;
        bodyGroup.add(torso);

        const flankL = new THREE.Mesh(new THREE.BoxGeometry(0.088, 0.21, 0.425), greyFurMat);
        flankL.name = 'flank_L';
        flankL.position.set(-0.21, -0.01, -0.01);
        bodyGroup.add(flankL);

        const flankR = new THREE.Mesh(new THREE.BoxGeometry(0.088, 0.21, 0.425), greyFurMat);
        flankR.name = 'flank_R';
        flankR.position.set(0.21, -0.01, -0.01);
        bodyGroup.add(flankR);

        const chestFluff = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 10), whiteFurMat);
        chestFluff.name = 'chestFluff';
        chestFluff.scale.set(0.95, 0.98, 0.95);
        chestFluff.position.set(0, 0.02, 0.25);
        bodyGroup.add(chestFluff);

        group.add(bodyGroup);

        // Head Group
        const headGroup = new THREE.Group();
        headGroup.name = 'headGroup';
        headGroup.position.set(0, 0.58, 0.30);

        const skull = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 12), greyFurMat);
        skull.name = 'skull';
        skull.scale.set(1.06, 0.96, 1.0);
        skull.castShadow = true;
        headGroup.add(skull);

        // Triangular white blaze
        const blaze = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.16, 4), whiteFurMat);
        blaze.name = 'blaze';
        blaze.rotation.x = -0.28;
        blaze.position.set(0, 0.05, 0.21);
        headGroup.add(blaze);

        // White Muzzle
        [-0.053, 0.053].forEach((mx, idx) => {
            const pad = new THREE.Mesh(new THREE.SphereGeometry(0.053, 8, 8), whiteFurMat);
            pad.name = `muzzlePad_${idx}`;
            pad.position.set(mx, -0.05, 0.19);
            headGroup.add(pad);
        });

        const nose = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.035, 3), pinkNoseMat);
        nose.name = 'nose';
        nose.rotation.z = Math.PI;
        nose.position.set(0, -0.005, 0.245);
        headGroup.add(nose);

        // Grumpy Mouth
        const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.015, 0.01), darkSlateMat);
        mouth.name = 'mouth';
        mouth.position.set(0, -0.07, 0.24);
        headGroup.add(mouth);

        // Yellow-Green Eyes & Slit Pupils
        [-0.088, 0.088].forEach((ex, idx) => {
            const eye = new THREE.Mesh(new THREE.SphereGeometry(0.036, 8, 8), eyeGreenMat);
            eye.name = `eye_${idx}`;
            eye.position.set(ex, 0.055, 0.18);

            const pupil = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.03, 0.005), darkPupilMat);
            pupil.name = `pupil_${idx}`;
            pupil.position.set(ex, 0.055, 0.215);

            // Grumpy furrowed brow
            const brow = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.015, 0.03), greyFurMat);
            brow.name = `brow_${idx}`;
            brow.position.set(ex, 0.085, 0.19);
            brow.rotation.z = ex > 0 ? 0.42 : -0.42;

            headGroup.add(eye, pupil, brow);
        });

        // Upright Cat Ears
        [-0.145, 0.145].forEach((earX, idx) => {
            const ear = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.11, 4), greyFurMat);
            ear.name = `ear_${idx}`;
            ear.position.set(earX, 0.195, -0.035);
            ear.rotation.z = earX > 0 ? -0.32 : 0.32;
            ear.rotation.x = 0.2;

            const earInner = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.08, 4), innerEarMat);
            earInner.name = `earInner_${idx}`;
            earInner.position.set(earX, 0.19, -0.02);
            earInner.rotation.z = earX > 0 ? -0.32 : 0.32;
            earInner.rotation.x = 0.2;

            headGroup.add(ear, earInner);
        });

        group.add(headGroup);

        // Legs with White Paws
        const legOffsets = [
            [-0.12, 0.20],
            [0.12, 0.20],
            [-0.12, -0.20],
            [0.12, -0.20]
        ];
        legOffsets.forEach(([lx, lz], idx) => {
            const pivot = new THREE.Group();
            pivot.name = `leg_${idx}`;
            pivot.position.set(lx, 0.22, lz);

            const upperLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.07, 0.14, 8), greyFurMat);
            upperLeg.name = `upperLeg_${idx}`;
            upperLeg.position.y = -0.07;
            upperLeg.castShadow = true;

            const paw = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.075, 0.075, 8), whiteFurMat);
            paw.name = `paw_${idx}`;
            paw.position.y = -0.18;

            pivot.add(upperLeg, paw);
            group.add(pivot);
        });

        // Bushy Longhair Tail
        const tailGroup = new THREE.Group();
        tailGroup.name = 'tailGroup';
        tailGroup.position.set(0, 0.36, -0.32);

        const tailBase = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.18, 8), greyFurMat);
        tailBase.name = 'tail_base';
        tailBase.rotation.x = -0.6;
        tailBase.position.set(0, 0.08, -0.06);

        const tailMid = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.09, 0.22, 8), greyFurMat);
        tailMid.name = 'tail_mid';
        tailMid.rotation.x = -1.1;
        tailMid.position.set(0, 0.21, -0.12);

        const tailPlume = new THREE.Mesh(new THREE.SphereGeometry(0.115, 10, 10), greyFurMat);
        tailPlume.name = 'tail_plume';
        tailPlume.scale.set(1.0, 1.25, 1.0);
        tailPlume.position.set(0, 0.44, -0.10);

        tailGroup.add(tailBase, tailMid, tailPlume);
        group.add(tailGroup);

        return group;
    },

    npc(colorHex = 0xe11d48) {
        const g = new THREE.Group();
        g.name = 'npc';

        const body = new THREE.Mesh(
            new THREE.BoxGeometry(0.65, 1.35, 0.4),
            new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.45 })
        );
        body.name = 'body';
        body.position.y = 0.85;
        body.castShadow = true;
        g.add(body);

        const head = new THREE.Mesh(
            new THREE.BoxGeometry(0.44, 0.44, 0.44),
            new THREE.MeshStandardMaterial({ color: 0xf1c27d })
        );
        head.name = 'head';
        head.position.y = 1.78;
        g.add(head);

        const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.55, 0.68, 20),
            new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.55 })
        );
        ring.name = 'ring';
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.04;
        g.add(ring);

        return g;
    },

    car(colorHex = 0xf8fafc, id = 'car_0') {
        const group = new THREE.Group();
        group.name = id;

        let finalColor = colorHex;
        if (id === 'car_1' || id === 'roadster') finalColor = 0x94a3b8;
        else if (id === 'car_2' || id === 'forrester') finalColor = 0xdc2626;
        else if (id === 'car_4' || id === 'impreza_wrx') finalColor = 0x1d4ed8;

        const bodyMat = new THREE.MeshStandardMaterial({
            color: finalColor,
            metalness: 0.45,
            roughness: 0.35
        });
        const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.75, 4.9), bodyMat);
        chassis.name = 'chassis';
        chassis.position.y = 0.65;
        chassis.castShadow = true;
        group.add(chassis);

        const cabin = new THREE.Mesh(
            new THREE.BoxGeometry(1.95, 0.65, 2.4),
            new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.6, roughness: 0.25 })
        );
        cabin.name = 'cabin';
        cabin.position.set(0, 1.3, -0.2);
        group.add(cabin);

        const spoiler = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.12, 0.45), bodyMat);
        spoiler.name = 'spoiler';
        spoiler.position.set(0, 1.18, -2.25);
        group.add(spoiler);

        const headMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
        const tailMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
        [-0.75, 0.75].forEach((lx, idx) => {
            const hl = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.2, 0.1), headMat);
            hl.name = `headlight_${idx}`;
            hl.position.set(lx, 0.7, 2.46);
            group.add(hl);

            const tl = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.2, 0.1), tailMat);
            tl.name = `taillight_${idx}`;
            tl.position.set(lx, 0.75, -2.46);
            group.add(tl);
        });

        const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.32, 16);
        wheelGeo.rotateZ(Math.PI / 2);
        const isWRX = (id === 'car_4' || id === 'impreza_wrx');
        const wheelMat = isWRX
            ? new THREE.MeshStandardMaterial({ color: 0xd97706, metalness: 0.6, roughness: 0.3 })
            : new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.7 });
        [[-1.15, 1.5], [1.15, 1.5], [-1.15, -1.5], [1.15, -1.5]].forEach(([wx, wz], idx) => {
            const w = new THREE.Mesh(wheelGeo, wheelMat);
            w.name = `wheel_${idx}`;
            w.position.set(wx, 0.42, wz);
            group.add(w);
        });

        return group;
    }
};

export const ModelLoader = {
    cache: new Map(),

    async load(url) {
        if (!url || typeof fetch === 'undefined' || typeof THREE === 'undefined') return null;
        if (this.cache.has(url)) {
            const cached = this.cache.get(url);
            if (cached && cached.userData && cached.userData.boundingBox) {
                registerModelBoundingBox(url, cached.userData.boundingBox);
            }
            return cached;
        }
        try {
            const resp = await fetch(url);
            if (!resp.ok) return null;
            const buf = await resp.arrayBuffer();
            const parsed = await parseGLB(buf);
            if (parsed) {
                const bbox = (parsed.userData && parsed.userData.boundingBox) || computeModelBoundingBox(parsed);
                if (bbox) {
                    parsed.userData = parsed.userData || {};
                    parsed.userData.boundingBox = bbox;
                    registerModelBoundingBox(url, bbox);
                }
                this.cache.set(url, parsed);
            }
            return parsed;
        } catch (err) {
            return null;
        }
    },

    async preloadAll(worldMap = {}) {
        if (typeof fetch === 'undefined' || typeof THREE === 'undefined') return;
        const urls = new Set([
            'models/player.glb',
            'models/dunya.glb',
            'models/npc.glb',
            'models/seagull.glb',
            'models/sailboat_white.glb',
            'models/sailboat_blue.glb',
            'models/tanker.glb',
            'models/sopka.glb',
            'models/street_lamp.glb',
            'models/road_lamp.glb',
            'models/bench.glb'
        ]);

        const landmarks = Array.isArray(worldMap.landmarks) ? worldMap.landmarks : DEFAULT_LANDMARKS;
        for (const lm of landmarks) {
            if (lm && lm.model) urls.add(lm.model);
        }

        const stalls = Array.isArray(worldMap.stalls) ? worldMap.stalls : [];
        for (const s of stalls) {
            if (s && s.model) urls.add(s.model);
            else if (s && s.id) urls.add(`models/stall_${s.id}.glb`);
        }

        const vehicles = Array.isArray(worldMap.vehicles) ? worldMap.vehicles : [];
        for (const v of vehicles) {
            if (v && v.model) urls.add(v.model);
            else if (v && v.id) urls.add(`models/${v.id}.glb`);
        }

        const props = Array.isArray(worldMap.props) ? worldMap.props : [];
        for (const p of props) {
            if (p && p.model) urls.add(p.model);
        }

        await Promise.all(Array.from(urls).map(u => this.load(u)));
    },

    getBoundingBox(url, fallbackObject = null) {
        if (url && this.cache.has(url)) {
            const template = this.cache.get(url);
            if (template) {
                if (!template.userData || !template.userData.boundingBox) {
                    template.userData = template.userData || {};
                    template.userData.boundingBox = computeModelBoundingBox(template);
                }
                if (template.userData.boundingBox) {
                    registerModelBoundingBox(url, template.userData.boundingBox);
                    return template.userData.boundingBox;
                }
            }
        }
        if (fallbackObject) {
            const computed = (fallbackObject.userData && fallbackObject.userData.boundingBox) || computeModelBoundingBox(fallbackObject);
            if (computed) {
                fallbackObject.userData = fallbackObject.userData || {};
                fallbackObject.userData.boundingBox = computed;
                if (url) registerModelBoundingBox(url, computed);
                return computed;
            }
        }
        return url ? getModelBoundingBox(url) : null;
    },

    instantiate(url, fallbackFn = null) {
        let instance = null;
        if (url && this.cache.has(url)) {
            const template = this.cache.get(url);
            if (template) {
                if (!template.userData || !template.userData.boundingBox) {
                    const bbox = computeModelBoundingBox(template);
                    if (bbox) {
                        template.userData = template.userData || {};
                        template.userData.boundingBox = bbox;
                        registerModelBoundingBox(url, bbox);
                    }
                } else {
                    registerModelBoundingBox(url, template.userData.boundingBox);
                }
                instance = cloneModelHierarchy(template);
            }
        }
        if (!instance && typeof fallbackFn === 'function') {
            instance = fallbackFn();
        }
        if (instance) {
            instance.userData = instance.userData || {};
            if (!instance.userData.boundingBox) {
                const bbox = computeModelBoundingBox(instance) || (url ? getModelBoundingBox(url) : null);
                if (bbox) {
                    instance.userData.boundingBox = bbox;
                    if (url) registerModelBoundingBox(url, bbox);
                }
            }
        }
        return instance;
    }
};

