import { renderVehiclePose, resetVehiclePose } from './vehicle-motion.js';
import { GAME_STATE, isGameplayInputSuspended } from './state.js';
import { PhysicsEngine, WorldVehiclePhysics, stepWorldVehiclePhysics, getVehicleCollisionCircles } from './physics.js';
import { TextureFactory } from './textures.js';
import { SoundManager } from './audio.js';
import { World } from './world.js';
import { completePOI, triggerPlayerSpeech, showToast, closeNpcDialogue, dismissInteractionPrompt, showLocalLabels, hideLocalLabels, LOCAL_LABEL_EXIT_VEHICLE_DURATION_MS } from './ui.js';
import { ModelLoader, ModelBuilders } from './models.js';

export const Player = {
    group: null,
    head: null,
    leftArm: null,
    rightArm: null,
    leftLeg: null,
    rightLeg: null,
    position: null,
    velocity: null,
    rotationY: Math.PI,
    isGrounded: true,
    walkCycle: 0,
    emoteTimer: 0,

    init(scene, spawnPos = null) {
        const sx = (spawnPos && spawnPos.x !== undefined) ? spawnPos.x : 0;
        const sy = (spawnPos && spawnPos.y !== undefined) ? spawnPos.y : 0;
        const sz = (spawnPos && spawnPos.z !== undefined) ? spawnPos.z : 22;
        this.position = new THREE.Vector3(sx, sy, sz);
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.rotationY = (spawnPos && spawnPos.yaw !== undefined) ? spawnPos.yaw : Math.PI;

        const username = GAME_STATE.username || 'Игрок';
        this.group = ModelLoader.instantiate('models/player.glb', () => ModelBuilders.player(username, '#38bdf8'));
        this.group.position.copy(this.position);
        this.group.rotation.y = this.rotationY;

        const torso = this.group.getObjectByName ? this.group.getObjectByName('torso') : null;
        if (torso && torso.material) {
            const shirtTex = TextureFactory.createPlayerShirtTexture(username, '#38bdf8');
            if (torso.material.map && torso.material.map.flipY === false) {
                shirtTex.flipY = false;
            }
            torso.material = torso.material.clone();
            torso.material.map = shirtTex;
            torso.material.needsUpdate = true;
        }

        this.head = (this.group.getObjectByName && this.group.getObjectByName('head')) || new THREE.Group();
        this.leftArm = (this.group.getObjectByName && this.group.getObjectByName('leftArm')) || new THREE.Group();
        this.rightArm = (this.group.getObjectByName && this.group.getObjectByName('rightArm')) || new THREE.Group();
        this.leftLeg = (this.group.getObjectByName && this.group.getObjectByName('leftLeg')) || new THREE.Group();
        this.rightLeg = (this.group.getObjectByName && this.group.getObjectByName('rightLeg')) || new THREE.Group();

        scene.add(this.group);
    },

    update(dt, remotePlayersMap) {
        if (GAME_STATE.inVehicle) {
            this.position.copy(GAME_STATE.inVehicle.group.position);
            this.group.visible = false;
            return;
        }
        this.group.visible = true;

        let moveForward = 0;
        let moveRight = 0;
        if (!isGameplayInputSuspended()) {
            if (GAME_STATE.keys.w) moveForward += 1;
            if (GAME_STATE.keys.s) moveForward -= 1;
            if (GAME_STATE.keys.d) moveRight += 1;
            if (GAME_STATE.keys.a) moveRight -= 1;

            if (Math.abs(GAME_STATE.joystickVector.x) > 0.05 || Math.abs(GAME_STATE.joystickVector.y) > 0.05) {
                moveRight += GAME_STATE.joystickVector.x;
                moveForward -= GAME_STATE.joystickVector.y;
            }
        }

        const inputLen = Math.hypot(moveForward, moveRight);
        const isMoving = inputLen > 0.05;
        const isSprinting = Boolean(GAME_STATE.keys.shift || GAME_STATE.joystickSprint);
        const speed = isSprinting ? 14.5 : 8.2;

        if (isMoving) {
            this.emoteTimer = 0;
            const camForwardX = -Math.sin(GAME_STATE.cameraYaw);
            const camForwardZ = -Math.cos(GAME_STATE.cameraYaw);
            const camRightX = Math.cos(GAME_STATE.cameraYaw);
            const camRightZ = -Math.sin(GAME_STATE.cameraYaw);

            const dirX = (camForwardX * moveForward + camRightX * moveRight) / Math.max(1, inputLen);
            const dirZ = (camForwardZ * moveForward + camRightZ * moveRight) / Math.max(1, inputLen);

            this.velocity.x = dirX * speed;
            this.velocity.z = dirZ * speed;

            const targetAngle = Math.atan2(dirX, dirZ);
            let diff = targetAngle - this.rotationY;
            diff = Math.atan2(Math.sin(diff), Math.cos(diff));
            this.rotationY += diff * Math.min(1, dt * 12);
        } else {
            this.velocity.x *= 0.8;
            this.velocity.z *= 0.8;
        }

        if (!this.isGrounded) {
            this.velocity.y -= 26 * dt;
        }

        const pBounds = (World.worldMap && World.worldMap.bounds && World.worldMap.bounds.player)
            ? World.worldMap.bounds.player
            : { minX: -46, maxX: 294, minZ: -170, maxZ: 170 };

        const candidatePos = new THREE.Vector3(
            Math.max(pBounds.minX, Math.min(pBounds.maxX, this.position.x + this.velocity.x * dt)),
            this.position.y,
            Math.max(pBounds.minZ, Math.min(pBounds.maxZ, this.position.z + this.velocity.z * dt))
        );

        PhysicsEngine.resolveWorldCollision(candidatePos, 0.52, this.position.y);

        if (this.position.y < 1.25) {
            for (const v of World.vehicles) {
                const dx = candidatePos.x - v.group.position.x;
                const dz = candidatePos.z - v.group.position.z;
                const dist = Math.hypot(dx, dz);
                const minDist = 2.05;
                if (dist < minDist && dist > 0.001) {
                    candidatePos.x = v.group.position.x + (dx / dist) * minDist;
                    candidatePos.z = v.group.position.z + (dz / dist) * minDist;
                }
            }
        }

        if (remotePlayersMap) {
            for (const rp of remotePlayersMap.values()) {
                if (rp.mode === 'pedestrian' && rp.group.visible) {
                    const dx = candidatePos.x - rp.group.position.x;
                    const dz = candidatePos.z - rp.group.position.z;
                    const dist = Math.hypot(dx, dz);
                    const minDist = 0.85;
                    if (dist < minDist && dist > 0.001 && Math.abs(this.position.y - rp.group.position.y) < 1.6) {
                        candidatePos.x = rp.group.position.x + (dx / dist) * minDist;
                        candidatePos.z = rp.group.position.z + (dz / dist) * minDist;
                    }
                }
            }
        }

        for (const npc of World.npcs) {
            const dx = candidatePos.x - npc.group.position.x;
            const dz = candidatePos.z - npc.group.position.z;
            const dist = Math.hypot(dx, dz);
            const minDist = 0.88;
            if (dist < minDist && dist > 0.001 && this.position.y < 1.8) {
                const nx = dx / dist;
                const nz = dz / dist;
                candidatePos.x = npc.group.position.x + nx * minDist;
                candidatePos.z = npc.group.position.z + nz * minDist;
                npc.group.position.x -= nx * 0.08;
                npc.group.position.z -= nz * 0.08;
            }
        }

        this.position.x = candidatePos.x;
        this.position.z = candidatePos.z;

        const supportY = PhysicsEngine.getSupportHeightAt(this.position.x, this.position.z, this.position.y, 0.52, World.vehicles, GAME_STATE.inVehicle);

        this.position.y += this.velocity.y * dt;
        if (this.position.y <= supportY) {
            this.position.y = supportY;
            this.velocity.y = 0;
            this.isGrounded = true;
        } else {
            this.isGrounded = false;
        }

        this.group.position.copy(this.position);
        this.group.rotation.y = this.rotationY;

        if (this.emoteTimer > 0) {
            this.emoteTimer -= dt;
            const t = performance.now() * 0.012;
            this.leftArm.rotation.x = Math.PI * 0.75 + Math.sin(t) * 0.5;
            this.rightArm.rotation.x = Math.PI * 0.75 + Math.cos(t) * 0.5;
            this.leftLeg.rotation.x = Math.sin(t) * 0.35;
            this.rightLeg.rotation.x = -Math.sin(t) * 0.35;
            this.head.rotation.y = Math.sin(t * 0.5) * 0.3;
        } else if (!this.isGrounded) {
            this.leftArm.rotation.x = -0.6;
            this.rightArm.rotation.x = -0.6;
            this.leftLeg.rotation.x = 0.4;
            this.rightLeg.rotation.x = -0.3;
        } else if (isMoving) {
            this.walkCycle += dt * (isSprinting ? 15 : 9.5);
            const swing = Math.sin(this.walkCycle) * (isSprinting ? 0.85 : 0.55);
            this.leftLeg.rotation.x = swing;
            this.rightLeg.rotation.x = -swing;
            this.leftArm.rotation.x = -swing * 0.8;
            this.rightArm.rotation.x = swing * 0.8;
            this.head.rotation.y = 0;
        } else {
            const idle = Math.sin(performance.now() * 0.003) * 0.04;
            this.leftLeg.rotation.x *= 0.85;
            this.rightLeg.rotation.x *= 0.85;
            this.leftArm.rotation.x = idle;
            this.rightArm.rotation.x = -idle;
        }
    },

    jump() {
        if (GAME_STATE.inVehicle || isGameplayInputSuspended()) return;
        if (this.isGrounded) {
            this.velocity.y = 9.8;
            this.isGrounded = false;
            SoundManager.playActionSound('jump');
            if (Dunya.petType !== 'cat') {
                Dunya.hopAndBark('Прыг! 🐾🤍');
            }
        }
    },

    emote() {
        if (GAME_STATE.inVehicle || isGameplayInputSuspended()) return;
        this.emoteTimer = 3.2;
        triggerPlayerSpeech(`Владивосток, салют от @${GAME_STATE.username || 'Игрок'}! 🔥🌊`);
        SoundManager.playActionSound('cash');
        Dunya.hopAndBark(Dunya.petType === 'cat' ? 'Мяу-мяу! Мы на Набке! 🐾' : 'Тяф-тяф! Мы на Набке! 🐾🎀');
    }
};

export const Dunya = {
    group: null,
    scene: null,
    headGroup: null,
    tailPivot: null,
    tailTip: null,
    bodyGroup: null,
    legs: [],
    position: null,
    velocity: null,
    rotationY: Math.PI,
    isGrounded: true,
    walkCycle: 0,
    spinTimer: 0,
    petType: 'dog',
    idleTimer: 0,
    lieDownProgress: 0,

    init(scene, startX = null, startZ = null, startYaw = null, petType = null) {
        this.scene = scene;
        this.petType = petType || (typeof GAME_STATE !== 'undefined' && GAME_STATE.petType) || 'dog';
        this.idleTimer = 0;
        this.lieDownProgress = 0;
        const dx = startX !== null ? startX : 1.6;
        const dz = startZ !== null ? startZ : 22.8;
        this.position = new THREE.Vector3(dx, 0, dz);
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.rotationY = startYaw !== null ? startYaw : Math.PI;

        this._spawnModel();
        this.updateNametagUI();
    },

    setPetType(type) {
        if (type !== 'cat' && type !== 'dog') return;
        if (this.petType === type && this.group) return;
        this.petType = type;
        this.idleTimer = 0;
        this.lieDownProgress = 0;
        if (typeof GAME_STATE !== 'undefined') {
            GAME_STATE.petType = type;
        }
        if (this.scene) {
            this._spawnModel();
            this.updateNametagUI();
            showLocalLabels();
        }
    },

    _spawnModel() {
        if (!this.scene) return;
        if (this.group) {
            this.scene.remove(this.group);
            if (typeof this.group.traverse === 'function') {
                this.group.traverse(obj => {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) {
                        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
                        else obj.material.dispose();
                    }
                });
            }
        }

        const isCat = this.petType === 'cat';
        const modelUrl = isCat ? 'models/berik.glb' : 'models/dunya.glb';
        const fallbackFn = isCat ? () => ModelBuilders.berik() : () => ModelBuilders.dunya();

        if (modelUrl && typeof ModelLoader !== 'undefined' && ModelLoader.cache && !ModelLoader.cache.has(modelUrl) && typeof ModelLoader.load === 'function') {
            ModelLoader.load(modelUrl).then(loaded => {
                if (loaded && this.petType === (isCat ? 'cat' : 'dog') && this.scene) {
                    this._spawnModel();
                }
            });
        }

        this.group = ModelLoader.instantiate(modelUrl, fallbackFn);
        if (this.position) this.group.position.copy(this.position);
        this.group.rotation.y = this.rotationY;

        this.bodyGroup = (this.group.getObjectByName && this.group.getObjectByName('body')) || null;
        this.headGroup = (this.group.getObjectByName && this.group.getObjectByName('headGroup')) || new THREE.Group();
        this.tailPivot = (this.group.getObjectByName && (
            this.group.getObjectByName('tailPivot') ||
            this.group.getObjectByName('tailGroup') ||
            this.group.getObjectByName('tail_base')
        )) || new THREE.Group();
        this.tailTip = (this.group.getObjectByName && (
            this.group.getObjectByName('tail_tip') ||
            this.group.getObjectByName('tail_plume')
        )) || null;
        this.legs = [0, 1, 2, 3].map(idx => (
            (this.group.getObjectByName && (
                this.group.getObjectByName(`leg_${idx}`) ||
                this.group.getObjectByName(['leg_FL', 'leg_FR', 'leg_BL', 'leg_BR'][idx])
            )) || new THREE.Group()
        ));

        this.scene.add(this.group);
    },

    updateNametagUI() {
        if (typeof document === 'undefined') return;
        const nameEl = document.getElementById('pet-nametag-name');
        const iconEl = document.getElementById('pet-nametag-icon');
        const pillEl = document.getElementById('pet-nametag-pill');
        const bubbleEl = document.getElementById('dunya-speech-bubble');

        const isCat = this.petType === 'cat';
        if (nameEl) nameEl.textContent = isCat ? 'Берик' : 'Дуня';
        if (iconEl) iconEl.textContent = isCat ? '🐱' : '🐾';
        if (pillEl) {
            if (isCat) {
                pillEl.className = 'bg-slate-950/80 border border-sky-400/60 px-2 py-0.5 rounded-full shadow-md flex items-center gap-1';
                if (nameEl) nameEl.className = 'font-bold text-[11px] text-sky-200 tracking-tight';
            } else {
                pillEl.className = 'bg-slate-950/80 border border-pink-400/60 px-2 py-0.5 rounded-full shadow-md flex items-center gap-1';
                if (nameEl) nameEl.className = 'font-bold text-[11px] text-pink-200 tracking-tight';
            }
        }
        if (bubbleEl) {
            if (isCat) {
                bubbleEl.className = 'hidden mt-0.5 bg-sky-50 text-slate-900 font-bold text-[11px] px-2 py-0.5 rounded-lg shadow-md whitespace-nowrap';
            } else {
                bubbleEl.className = 'hidden mt-0.5 bg-pink-50 text-slate-900 font-bold text-[11px] px-2 py-0.5 rounded-lg shadow-md whitespace-nowrap';
            }
        }
    },

    hopAndBark(text = null) {
        const isCat = this.petType === 'cat';
        const soundType = isCat ? 'meow' : 'bark';
        const defaultText = isCat ? 'Мяу-мяу! 🐾' : 'Тяф-тяф! 🐾🤍';
        SoundManager.playActionSound(soundType);

        // Dog jumps up eagerly and spins around; cat remains calm and does not jump or spin
        if (!isCat) {
            if (this.velocity && this.isGrounded && !GAME_STATE.inVehicle) {
                this.velocity.y = 6.8;
                this.isGrounded = false;
            }
            this.spinTimer = 1.1;
        } else {
            this.spinTimer = 0;
        }

        if (typeof document !== 'undefined') {
            const bubble = document.getElementById('dunya-speech-bubble');
            if (bubble) {
                bubble.textContent = text || defaultText;
                bubble.classList.remove('hidden');
                clearTimeout(bubble._timer);
                bubble._timer = setTimeout(() => bubble.classList.add('hidden'), 3200);
            }
        }
    },

    update(dt, time) {
        if (!this.group) return;

        const isCat = this.petType === 'cat';

        if (GAME_STATE.inVehicle) {
            const car = GAME_STATE.inVehicle.group;
            const passengerOffset = new THREE.Vector3(0.58, isCat ? 0.95 : 1.05, 0.15).applyAxisAngle(new THREE.Vector3(0, 1, 0), car.rotation.y);
            this.position.copy(car.position).add(passengerOffset);
            this.rotationY = car.rotation.y;
            this.group.position.copy(this.position);
            this.group.rotation.y = this.rotationY;

            if (isCat) {
                this.headGroup.rotation.y = Math.sin(time * 1.5) * 0.18;
                this.headGroup.rotation.x = 0;
                this.legs[0].rotation.x = -1.25;
                this.legs[1].rotation.x = -1.25;
                this.legs[2].rotation.x = 1.25;
                this.legs[3].rotation.x = 1.25;
                this.legs[0].rotation.z = 0.1;
                this.legs[1].rotation.z = -0.1;
                this.legs[2].rotation.z = -0.15;
                this.legs[3].rotation.z = 0.15;
                if (this.tailPivot) {
                    this.tailPivot.rotation.x = -0.2;
                    this.tailPivot.rotation.z = Math.sin(time * 1.5) * 0.20;
                }
            } else {
                this.headGroup.rotation.y = Math.sin(time * 3.5) * 0.25;
                this.legs.forEach(l => { l.rotation.x = 0; l.rotation.z = 0; });
                if (this.tailPivot) {
                    this.tailPivot.rotation.x = 0;
                    this.tailPivot.rotation.z = Math.sin(time * 16) * 0.45;
                }
            }
            return;
        }

        const followAngle = Player.rotationY - 0.65;
        const orbitShift = isCat ? 0 : Math.sin(time * 1.4) * 0.35;
        const targetX = Player.position.x + Math.sin(followAngle + orbitShift) * 1.65;
        const targetZ = Player.position.z + Math.cos(followAngle + orbitShift) * 1.65;

        const dx = targetX - this.position.x;
        const dz = targetZ - this.position.z;
        const distToTarget = Math.hypot(dx, dz);
        const distToPlayer = Math.hypot(Player.position.x - this.position.x, Player.position.z - this.position.z);

        if (distToPlayer > 26) {
            this.position.set(Player.position.x + 1.4, Player.position.y + 0.2, Player.position.z + 1.2);
            this.velocity.set(0, 0, 0);
            this.idleTimer = 0;
            this.lieDownProgress = 0;
        }

        // Cat resting tolerance: when lying down, cat stays resting unless player walks away
        const trotThreshold = isCat
            ? (this.lieDownProgress > 0.5 ? 2.2 : 0.55)
            : 0.35;

        let isTrotting = false;
        if (distToTarget > trotThreshold) {
            isTrotting = true;
            this.idleTimer = 0;
            if (isCat) {
                // Cat rises up from lying down before running
                this.lieDownProgress = Math.max(0, this.lieDownProgress - dt * 3.5);
            } else {
                this.lieDownProgress = 0;
            }

            // Gated acceleration while standing up from loaf
            const getUpFactor = isCat ? (1 - this.lieDownProgress * 0.65) : 1;
            const moveSpeed = (distToTarget > 3.2 ? 15.5 : (distToTarget > 1.4 ? 10.2 : 6.2)) * getUpFactor;
            const dirX = dx / distToTarget;
            const dirZ = dz / distToTarget;

            this.velocity.x = dirX * moveSpeed;
            this.velocity.z = dirZ * moveSpeed;

            const desiredYaw = Math.atan2(dirX, dirZ);
            let yawDiff = desiredYaw - this.rotationY;
            yawDiff = Math.atan2(Math.sin(yawDiff), Math.cos(yawDiff));
            this.rotationY += yawDiff * Math.min(1, dt * 14);
        } else {
            this.velocity.x *= 0.75;
            this.velocity.z *= 0.75;
            this.idleTimer += dt;

            if (isCat) {
                // Cat lies down when idle after a brief pause
                if (this.idleTimer > 0.5) {
                    this.lieDownProgress = Math.min(1, this.lieDownProgress + dt * 2.2);
                }
            } else {
                this.lieDownProgress = 0;
            }

            const toPlayerX = Player.position.x - this.position.x;
            const toPlayerZ = Player.position.z - this.position.z;
            const lookYaw = Math.atan2(toPlayerX, toPlayerZ);
            let diff = lookYaw - this.rotationY;
            diff = Math.atan2(Math.sin(diff), Math.cos(diff));
            const turnRate = (isCat && this.lieDownProgress > 0.5) ? 2.5 : 5;
            this.rotationY += diff * Math.min(1, dt * turnRate);
        }

        // Tail animation: Cat does not wag tail rapidly, but slowly waves it
        if (this.tailPivot) {
            if (isCat) {
                if (this.lieDownProgress > 0.4) {
                    // Resting in loaf pose: tail lays along floor and lazily sways
                    this.tailPivot.rotation.x = -0.22 * this.lieDownProgress;
                    this.tailPivot.rotation.z = Math.sin(time * 1.5) * 0.22;
                } else if (isTrotting) {
                    // Trotting: graceful fluid wave
                    this.tailPivot.rotation.x = 0.12;
                    this.tailPivot.rotation.z = Math.sin(time * 2.2) * 0.30;
                } else {
                    // Standing: relaxed slow wave
                    this.tailPivot.rotation.x = 0;
                    this.tailPivot.rotation.z = Math.sin(time * 1.8) * 0.25;
                }
                if (this.tailTip) {
                    this.tailTip.rotation.z = Math.sin(time * 1.8 - 0.7) * 0.22;
                }
            } else {
                // Dog: rapid energetic tail wag
                this.tailPivot.rotation.x = 0;
                this.tailPivot.rotation.z = Math.sin(time * 16) * 0.45;
                if (this.tailTip) {
                    this.tailTip.rotation.z = 0;
                }
            }
        }

        // Dog jumps excitedly whenever player jumps; cat does NOT jump around eagerly
        if (!isCat && this.isGrounded && Player.position.y > this.position.y + 0.35 && distToPlayer < 5.5) {
            this.velocity.y = 8.4;
            this.isGrounded = false;
        }

        // Cat only hops if navigating up onto an elevated platform/bench to reach player
        if (isCat && this.isGrounded && distToTarget > 0.5 && Player.position.y > this.position.y + 0.55) {
            this.velocity.y = 6.2;
            this.isGrounded = false;
            this.lieDownProgress = 0;
        }

        if (!this.isGrounded) {
            this.velocity.y -= 24 * dt;
        }

        const nextPos = new THREE.Vector3(
            this.position.x + this.velocity.x * dt,
            this.position.y,
            this.position.z + this.velocity.z * dt
        );

        PhysicsEngine.resolveWorldCollision(nextPos, 0.28, this.position.y);
        this.position.x = nextPos.x;
        this.position.z = nextPos.z;

        const supportY = PhysicsEngine.getSupportHeightAt(this.position.x, this.position.z, this.position.y, 0.28, World.vehicles, GAME_STATE.inVehicle);
        this.position.y += this.velocity.y * dt;
        if (this.position.y <= supportY) {
            this.position.y = supportY;
            this.velocity.y = 0;
            this.isGrounded = true;
        } else {
            this.isGrounded = false;
        }

        if (this.spinTimer > 0) {
            this.spinTimer -= dt;
            this.rotationY += dt * 11.5;
        }

        if (isTrotting && this.lieDownProgress < 0.2) {
            const walkSpeed = isCat ? 16 : 22;
            this.walkCycle += dt * walkSpeed;
            const swing = Math.sin(this.walkCycle) * (isCat ? 0.5 : 0.65);
            this.legs[0].rotation.x = swing;
            this.legs[1].rotation.x = -swing;
            this.legs[2].rotation.x = -swing;
            this.legs[3].rotation.x = swing;
            this.legs[0].rotation.z = 0;
            this.legs[1].rotation.z = 0;
            this.legs[2].rotation.z = 0;
            this.legs[3].rotation.z = 0;
            this.headGroup.position.y = 0.58 + Math.abs(Math.sin(this.walkCycle)) * 0.035;
            this.headGroup.rotation.x = 0;
        } else {
            if (isCat && this.lieDownProgress > 0) {
                const p = this.lieDownProgress;
                // Front paws folded forward / tucked in cat loaf pose
                this.legs[0].rotation.x = -1.35 * p;
                this.legs[1].rotation.x = -1.35 * p;
                this.legs[0].rotation.z = 0.12 * p;
                this.legs[1].rotation.z = -0.12 * p;
                // Hind legs tucked forward under flanks
                this.legs[2].rotation.x = 1.35 * p;
                this.legs[3].rotation.x = 1.35 * p;
                this.legs[2].rotation.z = -0.15 * p;
                this.legs[3].rotation.z = 0.15 * p;

                // Gentle relaxed breathing in loaf pose
                const breathe = Math.sin(time * 2.0) * 0.008 * p;
                this.headGroup.position.y = 0.58 - 0.02 * p + breathe;
                this.headGroup.rotation.x = 0.06 * p;
            } else {
                this.legs.forEach(l => {
                    l.rotation.x *= 0.8;
                    l.rotation.z *= 0.8;
                });
                this.headGroup.position.y = 0.58 + Math.sin(time * 4) * 0.012;
                this.headGroup.rotation.x = 0;
            }
        }

        this.group.position.copy(this.position);
        if (isCat && this.lieDownProgress > 0) {
            // Lower body down to floor in cat loaf pose
            this.group.position.y -= 0.15 * this.lieDownProgress;
        }
        this.group.rotation.y = this.rotationY;
    }
};

export function createJDMCar(name, colorHex, x, z, rotY = 0, onToggleDrive = null, customId = null, modelUrl = null, y = 0.02) {
    const carId = customId || ('car_' + World.vehicles.length);
    const resolvedModelUrl = modelUrl || `models/${carId}.glb`;
    const group = ModelLoader.instantiate(resolvedModelUrl, () => ModelBuilders.car(colorHex, carId));
    const initY = (y !== undefined && Number.isFinite(Number(y))) ? Number(y) : 0.02;
    group.position.set(x, initY, z);
    group.rotation.y = rotY;

    const headBeam = new THREE.SpotLight(0xfef08a, 1.8, 36, Math.PI / 5, 0.45, 1.2);
    headBeam.name = 'headBeam';
    headBeam.position.set(0, 0.85, 2.4);
    headBeam.target.position.set(0, 0.2, 16);
    group.add(headBeam);
    group.add(headBeam.target);

    if (World.scene && typeof World.scene.add === 'function') {
        World.scene.add(group);
    }

    let mass = 1450;
    if (name.includes('Mark II')) mass = 1470;
    else if (name.includes('Skyline') || name.includes('R34')) mass = 1560;
    else if (name.includes('Forester')) mass = 1510;
    else if (name.includes('Chaser')) mass = 1480;
    else if (name.includes('RX-7') || name.includes('FD3S')) mass = 1280;

    const carObj = {
        id: carId,
        name,
        group,
        headBeam,
        x,
        y: initY,
        z,
        yaw: rotY,
        vx: 0,
        vz: 0,
        speed: 0,
        yawRate: 0,
        mass,
        yawInertia: mass * (2.3 * 2.3 + 4.8 * 4.8) / 12,
        width: 2.3,
        length: 4.8,
        axleOffset: 1.25,
        collisionRadius: 1.15,
        isAwake: false,
        isDrifting: false,
        isBraking: false,
        steering: 0,
        remoteDriver: null,
        netTarget: null,
        spawnX: x,
        spawnY: initY,
        spawnZ: z,
        spawnRotY: rotY,
        resetToSpawn() {
            this.x = this.spawnX;
            this.y = (this.spawnY !== undefined && Number.isFinite(this.spawnY)) ? this.spawnY : 0.02;
            this.z = this.spawnZ;
            this.yaw = this.spawnRotY || 0;
            this.vx = 0;
            this.vz = 0;
            this.speed = 0;
            this.yawRate = 0;
            this.isAwake = false;
            this.isDrifting = false;
            this.isBraking = false;
            this.steering = 0;
            this.remoteDriver = null;
            this.netTarget = null;
            this.snapshotBuffer = null;
            resetVehiclePose(this);
            if (this.group && this.group.position) {
                this.group.position.set(this.spawnX, this.y, this.spawnZ);
                this.group.rotation.y = this.spawnRotY || 0;
            }
            if (this.headBeam) {
                this.headBeam.intensity = 0;
            }
        }
    };

    World.vehicles.push(carObj);

    World.interactables.push({
        id: carObj.id,
        name: name,
        isCar: true,
        carRef: carObj,
        get prompt() {
            if (carObj.remoteDriver) {
                return `За рулём ${name} сейчас @${carObj.remoteDriver}`;
            }
            return `Сесть за правый руль ${name} (E)`;
        },
        get x() { return carObj.group.position.x; },
        get z() { return carObj.group.position.z; },
        radius: 4.5,
        onInteract: () => {
            if (carObj.remoteDriver && carObj.remoteDriver !== GAME_STATE.username) {
                showToast(`⚠️ За рулём ${carObj.name} уже сидит @${carObj.remoteDriver}!`, 'amber');
                return;
            }
            if (onToggleDrive) onToggleDrive(carObj);
        }
    });

    return carObj;
}

export function toggleVehicleDrive(carObj, onSendSnapshot = null) {
    const speedBox = (typeof document !== 'undefined') ? document.getElementById('speedometer-box') : null;
    const mobilePedals = (typeof document !== 'undefined') ? document.getElementById('mobile-car-pedals') : null;
    const jumpBtn = (typeof document !== 'undefined') ? document.getElementById('btn-action-jump') : null;
    const actionBtnLabel = (typeof document !== 'undefined') ? document.getElementById('action-btn-label') : null;
    SoundManager.playActionSound('car');

    dismissInteractionPrompt();

    if (GAME_STATE.inVehicle) {
        const leavingVehicle = GAME_STATE.inVehicle;
        leavingVehicle._lastExitTime = Date.now();
        leavingVehicle.speed = 0;
        leavingVehicle.vx = 0;
        leavingVehicle.vz = 0;
        leavingVehicle.yawRate = 0;
        leavingVehicle.isAwake = false;
        leavingVehicle.isDrifting = false;
        leavingVehicle.isBraking = false;
        resetVehiclePose(leavingVehicle);

        if (onSendSnapshot) onSendSnapshot(true);

        const exitX = leavingVehicle.group.position.x - 2.6;
        const exitZ = leavingVehicle.group.position.z;
        Player.position.set(exitX, 0, exitZ);
        GAME_STATE.inVehicle = null;
        GAME_STATE.keys.w = GAME_STATE.keys.s = GAME_STATE.keys.space = false;
        SoundManager.updateVehicleAudio(null, false, false, false, false);
        if (speedBox) speedBox.classList.add('hidden');
        if (mobilePedals) mobilePedals.classList.add('hidden');
        if (jumpBtn) jumpBtn.classList.remove('hidden');
        if (actionBtnLabel) actionBtnLabel.textContent = 'Действие (E)';
        showToast(`🚶 @${GAME_STATE.username} вышел на променад Набки`, 'sky');
        showLocalLabels(LOCAL_LABEL_EXIT_VEHICLE_DURATION_MS);
        if (onSendSnapshot) onSendSnapshot(true);
    } else {
        if (carObj.remoteDriver && carObj.remoteDriver !== GAME_STATE.username) {
            showToast(`⚠️ Машина занята игроком @${carObj.remoteDriver}`, 'amber');
            return;
        }
        if (GAME_STATE.activeNpcChat) closeNpcDialogue();
        GAME_STATE.inVehicle = carObj;
        hideLocalLabels();
        carObj.snapshotBuffer = null;
        carObj.remoteDriver = null;
        resetVehiclePose(carObj);
        if (speedBox) speedBox.classList.remove('hidden');
        if (mobilePedals) mobilePedals.classList.remove('hidden');
        if (jumpBtn) jumpBtn.classList.add('hidden');
        if (actionBtnLabel) actionBtnLabel.textContent = 'Выйти (E)';
        completePOI('jdm_drive', `🏎️ @${GAME_STATE.username} за рулём праворульного ${carObj.name}!`, 1200);
        triggerPlayerSpeech('Турер Ви на Набке! 🏎️💨');
        if (onSendSnapshot) onSendSnapshot(true);
    }
}

export function updateWorldVehicles(dt, worldMap = null) {
    if (!Array.isArray(World.vehicles) || World.vehicles.length === 0) return;

    let input = null;
    let isBoostActive = false;
    let throttle = 0;
    let turn = 0;
    let isHandbrakeActive = false;

    if (GAME_STATE.inVehicle) {
        if (!isGameplayInputSuspended()) {
            if (GAME_STATE.keys.w || GAME_STATE.joystickVector.y < -0.2) throttle += 1;
            if (GAME_STATE.keys.s || GAME_STATE.joystickVector.y > 0.2) throttle -= 1;

            if (GAME_STATE.keys.a || GAME_STATE.joystickVector.x < -0.2) turn += 1;
            if (GAME_STATE.keys.d || GAME_STATE.joystickVector.x > 0.2) turn -= 1;

            isBoostActive = Boolean(GAME_STATE.keys.shift || GAME_STATE.joystickSprint);
            isHandbrakeActive = Boolean(GAME_STATE.keys.space);
        }

        input = {
            throttle,
            steer: turn,
            handbrake: isHandbrakeActive,
            boost: isBoostActive
        };
    }

    const bounds = (worldMap && worldMap.bounds && worldMap.bounds.vehicle) ? worldMap.bounds.vehicle : { minX: -13, maxX: 44, minZ: -150, maxZ: 150 };

    // Sample network-controlled bodies before collision queries, never deriving
    // their velocities from smoothed mesh positions.
    for (const car of World.vehicles) {
        if (!car.remoteDriver || !car.snapshotBuffer) continue;
        const pose = car.snapshotBuffer.sample(performance.now());
        if (pose) Object.assign(car, { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw,
            vx: pose.vx, vz: pose.vz, yawRate: pose.yawRate, speed: pose.speed });
    }

    // Advance fixed-step world physics for all vehicles, resolving car-to-car and obstacle collisions iteratively
    const events = stepWorldVehiclePhysics(World.vehicles, dt, PhysicsEngine, bounds, GAME_STATE.inVehicle, input);

    // Trigger crash audio & particle effects for high-energy collisions
    for (const ev of events) {
        const intensity = Math.min(35, Math.abs(ev.impulse) / 750);
        if (intensity > 2.0) {
            SoundManager.playCrashSound(intensity);
            World.spawnDriftSmoke(ev.contactX, ev.contactZ);
        }
    }

    // Sync visuals and auxiliary behaviors
    for (const car of World.vehicles) {
        if (GAME_STATE.inVehicle === car) {
            if (car.isDrifting || car.isBraking) {
                const rearX = car.x - Math.sin(car.yaw) * 2.1;
                const rearZ = car.z - Math.cos(car.yaw) * 2.1;
                World.spawnDriftSmoke(rearX, rearZ);
            }
            SoundManager.updateVehicleAudio(car, throttle !== 0, car.isBraking, car.isDrifting, isBoostActive);

            // Push NPCs away from car collision hull
            const circles = getVehicleCollisionCircles(car);
            if (Array.isArray(World.npcs)) {
                for (const npc of World.npcs) {
                    const npcX = npc.group ? npc.group.position.x : (npc.position ? npc.position.x : 0);
                    const npcZ = npc.group ? npc.group.position.z : (npc.position ? npc.position.z : 0);
                    for (const c of circles) {
                        const dx = npcX - c.x;
                        const dz = npcZ - c.z;
                        const dist = Math.hypot(dx, dz);
                        const minDist = c.radius + 0.55;
                        if (dist < minDist && dist > 0.0001) {
                            const push = minDist - dist;
                            const nx = dx / dist;
                            const nz = dz / dist;
                            if (npc.group && npc.group.position) {
                                npc.group.position.x += nx * push;
                                npc.group.position.z += nz * push;
                            }
                            if (npc.position) {
                                npc.position.x += nx * push;
                                npc.position.z += nz * push;
                            }
                        }
                    }
                }
            }

            if (car.group && car.group.position) {
                const pose = renderVehiclePose(car, WorldVehiclePhysics.alpha);
                car.group.position.x = pose.x;
                car.group.position.z = pose.z;
                car.group.rotation.y = pose.yaw;
            }
        } else if (car.remoteDriver && car.netTarget) {
            car.group.position.set(car.x, car.y, car.z);
            car.group.rotation.y = car.yaw;

            if (car.headBeam) {
                car.headBeam.intensity = car.netTarget.lights ? 1.8 : 0;
            }
            if (car.netTarget.drift && Math.abs(car.speed) > 3) {
                const rearX = car.group.position.x - Math.sin(car.group.rotation.y) * 2.1;
                const rearZ = car.group.position.z - Math.cos(car.group.rotation.y) * 2.1;
                World.spawnDriftSmoke(rearX, rearZ);
            }
        } else {
            // Unoccupied car: sync visuals
            if (car.group && car.group.position) {
                const pose = renderVehiclePose(car, WorldVehiclePhysics.alpha);
                car.group.position.x = pose.x;
                car.group.position.z = pose.z;
                car.group.rotation.y = pose.yaw;
            }
        }
    }
}

export const NPC_CONFIG = {
    minX: -12.5,   // Avoid seaside balustrade & beach steps
    maxX: 12.0,    // Avoid eastern roadway (curb at 14.5, road starts at 15.0)
    minZ: -130.0,  // Promenade north boundary
    maxZ: 130.0,   // Promenade south boundary
    minDistanceBetweenNPCs: 1.35, // Distance to keep between NPCs
    collisionRadius: 0.55,
    minDistanceToPlayer: 1.05,
    minDistanceToVehicle: 2.4
};

export function initPromenadeNPCs(dialoguePool = [], npcConfig = {}) {
    const colors = npcConfig.colors || [0xe11d48, 0x2563eb, 0x059669, 0xd97706, 0x7c3aed, 0x0891b2, 0x0d9488];
    const count = npcConfig.count || 14;
    const npcLabelsContainer = typeof document !== 'undefined' ? document.getElementById('npc-labels-container') : null;

    for (let i = 0; i < count; i++) {
        const persona = dialoguePool[i % dialoguePool.length];
        if (!persona) continue;
        const npcColor = colors[i % colors.length];
        const g = (typeof THREE !== 'undefined')
            ? ModelLoader.instantiate('models/npc.glb', () => ModelBuilders.npc(npcColor))
            : { position: { x: 0, y: 0, z: 0 }, rotation: { y: 0 }, add() {} };
        const startZ = -110 + i * 16;
        const laneX = -7.5 + (i % 3) * 4.5;
        g.position.x = laneX;
        g.position.y = 0;
        g.position.z = startZ;

        const initialHeading = i % 2 === 0 ? 0 : Math.PI;
        g.rotation.y = initialHeading;

        if (typeof THREE !== 'undefined') {
            const bodyNode = g.getObjectByName ? g.getObjectByName('body') : null;
            if (bodyNode && bodyNode.material) {
                bodyNode.material = bodyNode.material.clone();
                bodyNode.material.color.setHex(npcColor);
            }
            if (World && World.scene) World.scene.add(g);
        }

        let labelEl = null;
        if (typeof document !== 'undefined') {
            labelEl = document.createElement('div');
            labelEl.className = 'absolute top-0 left-0 -translate-x-1/2 -translate-y-full bg-slate-950/85 border border-sky-400/50 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow flex items-center gap-1 whitespace-nowrap transition-opacity duration-150';

            const emojiSpan = document.createElement('span');
            emojiSpan.textContent = persona.emoji;
            const nameSpan = document.createElement('span');
            nameSpan.textContent = persona.name;
            const keySpan = document.createElement('span');
            keySpan.className = 'text-amber-300 font-mono-code';
            keySpan.textContent = '[E]';
            labelEl.append(emojiSpan, nameSpan, keySpan);

            if (npcLabelsContainer) npcLabelsContainer.appendChild(labelEl);
        }

        const npcObj = {
            id: 'npc_' + i,
            group: g,
            heading: initialHeading,
            dir: i % 2 === 0 ? 1 : -1,
            speed: 1.4 + (i % 3) * 0.35,
            state: (i % 4 === 0) ? 'idle' : 'walking',
            stateTimer: 2.0 + (i % 5) * 1.2,
            stuckTimer: 0,
            lastX: laneX,
            lastZ: startZ,
            collisionRadius: NPC_CONFIG.collisionRadius,
            walkCycle: (i * 1.3),
            persona,
            labelEl,
            chatStage: 'opening',
            chatHistory: [
                { role: 'model', text: persona.opening }
            ]
        };

        if (World && Array.isArray(World.npcs)) {
            World.npcs.push(npcObj);
        }
    }
}

/**
 * Resolves mutual collision and personal space keeping between NPCs.
 * Prevents NPCs from walking through each other and pushes overlapping NPCs apart.
 */
export function resolveNpcToNpcCollisions(npcs = [], activeChatNpc = null, minDist = NPC_CONFIG.minDistanceBetweenNPCs) {
    if (!Array.isArray(npcs) || npcs.length < 2) return;
    const minDistSq = minDist * minDist;

    for (let i = 0; i < npcs.length; i++) {
        const npcA = npcs[i];
        const posA = npcA.group ? npcA.group.position : (npcA.position || null);
        if (!posA) continue;

        for (let j = i + 1; j < npcs.length; j++) {
            const npcB = npcs[j];
            const posB = npcB.group ? npcB.group.position : (npcB.position || null);
            if (!posB) continue;

            const dx = posB.x - posA.x;
            const dz = posB.z - posA.z;
            const distSq = dx * dx + dz * dz;

            if (distSq < minDistSq) {
                const dist = Math.sqrt(distSq);
                const overlap = minDist - dist;
                const nx = dist > 0.0001 ? dx / dist : (i % 2 === 0 ? 1 : -1);
                const nz = dist > 0.0001 ? dz / dist : 0;

                const isChatA = activeChatNpc === npcA;
                const isChatB = activeChatNpc === npcB;

                if (isChatA && !isChatB) {
                    posB.x += nx * overlap;
                    posB.z += nz * overlap;
                } else if (!isChatA && isChatB) {
                    posA.x -= nx * overlap;
                    posA.z -= nz * overlap;
                } else {
                    posA.x -= nx * overlap * 0.5;
                    posA.z -= nz * overlap * 0.5;
                    posB.x += nx * overlap * 0.5;
                    posB.z += nz * overlap * 0.5;
                }

                // If both are walking, deflect headings away to steer around each other
                if (npcA.state === 'walking' && npcB.state === 'walking') {
                    const vAx = Math.sin(npcA.heading || 0);
                    const vAz = Math.cos(npcA.heading || 0);
                    const vBx = Math.sin(npcB.heading || 0);
                    const vBz = Math.cos(npcB.heading || 0);

                    const relVx = vBx - vAx;
                    const relVz = vBz - vAz;
                    const closingSpeed = -(relVx * nx + relVz * nz);

                    if (closingSpeed > 0) {
                        const cross = vAx * nz - vAz * nx;
                        const steerSign = cross >= 0 ? 1 : -1;
                        npcA.heading = ((npcA.heading || 0) + steerSign * 0.4 + Math.PI * 2) % (Math.PI * 2);
                        npcB.heading = ((npcB.heading || 0) - steerSign * 0.4 + Math.PI * 2) % (Math.PI * 2);
                    }
                }
            }
        }
    }
}

/**
 * Chooses a new heading for an NPC biased along the promenade corridor.
 */
export function pickNpcHeading(npc, randomFn = Math.random) {
    const pos = npc.group ? npc.group.position : (npc.position || { x: 0, z: 0 });
    const z = pos.z !== undefined ? pos.z : 0;
    const x = pos.x !== undefined ? pos.x : 0;

    // Default flow: 0 is south (+Z), PI is north (-Z)
    let baseDir = randomFn() < 0.5 ? 0 : Math.PI;
    if (z > 95) baseDir = Math.PI; // near south edge, go north
    else if (z < -95) baseDir = 0; // near north edge, go south

    // Add wander angle (-55° to +55°)
    let heading = baseDir + (randomFn() - 0.5) * 1.9;

    // Steer away from edges
    if (x > 8) {
        heading -= randomFn() * 0.8;
    } else if (x < -8) {
        heading += randomFn() * 0.8;
    }

    return (heading + Math.PI * 2) % (Math.PI * 2);
}

/**
 * Updates all promenade NPCs:
 * - Distance keeping and collision detection between NPCs
 * - Random walking, stopping (idle state), direction changes
 * - Wall/obstacle avoidance so NPCs do not get stuck
 * - Enforcing bounds to stay on the paved promenade (avoid road and sea)
 */
export function updatePromenadeNPCs({
    npcs = [],
    dt = 0.016,
    playerPos = null,
    inVehicle = false,
    vehicles = [],
    activeChatNpc = null,
    bounds = NPC_CONFIG,
    randomFn = Math.random
} = {}) {
    if (!Array.isArray(npcs) || npcs.length === 0) return;

    for (let i = 0; i < npcs.length; i++) {
        const npc = npcs[i];
        const pos = npc.group ? npc.group.position : (npc.position || null);
        if (!pos) continue;

        // If player is currently talking to this NPC: halt, face player, skip autonomous walk
        if (activeChatNpc === npc && playerPos) {
            const dx = playerPos.x - pos.x;
            const dz = playerPos.z - pos.z;
            const faceYaw = Math.atan2(dx, dz);
            if (npc.group && npc.group.rotation) {
                npc.group.rotation.y = faceYaw;
            } else if (npc.rotationY !== undefined) {
                npc.rotationY = faceYaw;
            }
            npc.heading = faceYaw;
            npc.state = 'idle';
            npc.stateTimer = 5.0;
            if (npc.group && npc.group.position) npc.group.position.y = 0;
            continue;
        }

        // Initialize state fields if not set
        if (!npc.state) npc.state = (i % 4 === 0) ? 'idle' : 'walking';
        if (npc.heading === undefined) npc.heading = (i % 2 === 0 ? 0 : Math.PI);
        if (npc.stateTimer === undefined) npc.stateTimer = 2.0 + randomFn() * 4.0;
        if (npc.speed === undefined) npc.speed = 1.4 + (i % 3) * 0.35;
        if (npc.collisionRadius === undefined) npc.collisionRadius = bounds.collisionRadius || 0.55;
        if (npc.lastX === undefined) { npc.lastX = pos.x; npc.lastZ = pos.z; }

        // State machine timer
        npc.stateTimer -= dt;
        if (npc.stateTimer <= 0) {
            if (npc.state === 'walking') {
                // 40% chance to pause/idle for 2.0 - 5.0s, or pick a new heading and keep walking
                if (randomFn() < 0.4) {
                    npc.state = 'idle';
                    npc.stateTimer = 2.0 + randomFn() * 3.5;
                } else {
                    npc.heading = pickNpcHeading(npc, randomFn);
                    npc.stateTimer = 4.0 + randomFn() * 6.0;
                }
            } else {
                // In idle: resume walking
                npc.state = 'walking';
                npc.heading = pickNpcHeading(npc, randomFn);
                npc.stateTimer = 4.0 + randomFn() * 7.0;
            }
        }

        // Movement step if walking
        const prevX = pos.x;
        const prevZ = pos.z;

        if (npc.state === 'walking') {
            const vx = Math.sin(npc.heading) * npc.speed;
            const vz = Math.cos(npc.heading) * npc.speed;
            pos.x += vx * dt;
            pos.z += vz * dt;

            npc.walkCycle = (npc.walkCycle || 0) + dt * 6.5;
            if (npc.group && npc.group.position) {
                npc.group.position.y = Math.abs(Math.sin(npc.walkCycle)) * 0.05;
            }
        } else {
            if (npc.group && npc.group.position) npc.group.position.y = 0;
        }

        // 1. Static world collider collision (buildings, stalls, statues, fountain rim)
        const hitWall = PhysicsEngine.resolveWorldCollision(pos, npc.collisionRadius, 0);
        if (hitWall) {
            // Hit an obstacle: immediately change direction away from the wall
            npc.heading = ((npc.heading || 0) + Math.PI * 0.65 + randomFn() * Math.PI * 0.7) % (Math.PI * 2);
            npc.state = 'walking';
            npc.stateTimer = 2.5 + randomFn() * 3.5;
            npc.stuckTimer = 0;
        }

        // Detect if stuck (attempting to walk but not moving)
        const movedDist = Math.hypot(pos.x - prevX, pos.z - prevZ);
        if (npc.state === 'walking' && movedDist < npc.speed * dt * 0.2) {
            npc.stuckTimer = (npc.stuckTimer || 0) + dt;
            if (npc.stuckTimer > 0.4) {
                npc.heading = pickNpcHeading(npc, randomFn);
                npc.stuckTimer = 0;
                npc.stateTimer = 3.0 + randomFn() * 3.0;
            }
        } else {
            npc.stuckTimer = 0;
        }
        npc.lastX = pos.x;
        npc.lastZ = pos.z;

        // 2. Keep on Paved Area (Avoid road on East and sea/beach on West)
        if (pos.x < bounds.minX) {
            pos.x = bounds.minX;
            // Heading towards East (+X)
            npc.heading = (Math.PI * 0.5 + (randomFn() - 0.5) * 1.0 + Math.PI * 2) % (Math.PI * 2);
            npc.stateTimer = 3.0 + randomFn() * 3.0;
        } else if (pos.x > bounds.maxX) {
            pos.x = bounds.maxX;
            // Heading towards West (-X)
            npc.heading = (-Math.PI * 0.5 + (randomFn() - 0.5) * 1.0 + Math.PI * 2) % (Math.PI * 2);
            npc.stateTimer = 3.0 + randomFn() * 3.0;
        }

        if (pos.z < bounds.minZ) {
            pos.z = bounds.minZ;
            // Heading towards South (+Z)
            npc.heading = (0 + (randomFn() - 0.5) * 1.0 + Math.PI * 2) % (Math.PI * 2);
            npc.stateTimer = 3.0 + randomFn() * 3.0;
        } else if (pos.z > bounds.maxZ) {
            pos.z = bounds.maxZ;
            // Heading towards North (-Z)
            npc.heading = (Math.PI + (randomFn() - 0.5) * 1.0 + Math.PI * 2) % (Math.PI * 2);
            npc.stateTimer = 3.0 + randomFn() * 3.0;
        }

        // 3. Central Fountain ring avoidance (radius ~9.8m, center at 0, 0)
        const distFountain = Math.hypot(pos.x, pos.z);
        if (distFountain < 10.8) {
            const pushDir = pos.x >= 0 ? 1 : -1;
            pos.x += pushDir * npc.speed * dt * 1.2;
            if (distFountain < 10.2) {
                npc.heading = ((npc.heading || 0) + Math.PI * 0.5) % (Math.PI * 2);
            }
        }

        // 4. Avoid Player
        if (playerPos && !inVehicle) {
            const dxP = pos.x - playerPos.x;
            const dzP = pos.z - playerPos.z;
            const distP = Math.hypot(dxP, dzP);
            if (distP < bounds.minDistanceToPlayer && distP > 0.0001) {
                pos.x = playerPos.x + (dxP / distP) * bounds.minDistanceToPlayer;
                pos.z = playerPos.z + (dzP / distP) * bounds.minDistanceToPlayer;
            }
        }

        // 5. Avoid Vehicles
        if (Array.isArray(vehicles)) {
            for (const v of vehicles) {
                const vPos = v.group ? v.group.position : (v.position || v);
                if (!vPos) continue;
                const dxV = pos.x - vPos.x;
                const dzV = pos.z - vPos.z;
                const distV = Math.hypot(dxV, dzV);
                if (distV < bounds.minDistanceToVehicle && distV > 0.0001) {
                    pos.x = vPos.x + (dxV / distV) * bounds.minDistanceToVehicle;
                    pos.z = vPos.z + (dzV / distV) * bounds.minDistanceToVehicle;
                    if (npc.state === 'walking') {
                        npc.heading = ((npc.heading || 0) + Math.PI * 0.6) % (Math.PI * 2);
                    }
                }
            }
        }

        // Visual rotation alignment
        if (npc.group && npc.group.rotation) {
            if (npc.state === 'walking') {
                let rotDiff = npc.heading - npc.group.rotation.y;
                rotDiff = Math.atan2(Math.sin(rotDiff), Math.cos(rotDiff));
                npc.group.rotation.y += rotDiff * Math.min(1, dt * 8);
            }
        } else if (npc.rotationY !== undefined && npc.state === 'walking') {
            let rotDiff = npc.heading - npc.rotationY;
            rotDiff = Math.atan2(Math.sin(rotDiff), Math.cos(rotDiff));
            npc.rotationY += rotDiff * Math.min(1, dt * 8);
        }
    }

    // 6. Mutual NPC-to-NPC collision detection and personal distance keeping
    resolveNpcToNpcCollisions(npcs, activeChatNpc, bounds.minDistanceBetweenNPCs);

    // Final boundary clamp after NPC-to-NPC separation
    for (let i = 0; i < npcs.length; i++) {
        const pos = npcs[i].group ? npcs[i].group.position : (npcs[i].position || null);
        if (pos) {
            pos.x = Math.max(bounds.minX, Math.min(bounds.maxX, pos.x));
            pos.z = Math.max(bounds.minZ, Math.min(bounds.maxZ, pos.z));
        }
    }
}


export function selectValidSpawnPoint({
    spawnPoints = [],
    remotePlayers = null,
    npcs = [],
    vehicles = [],
    randomFn = Math.random
} = {}) {
    if (!Array.isArray(spawnPoints) || spawnPoints.length === 0) {
        return { x: 0, y: 0, z: 22, yaw: Math.PI };
    }

    const isPointOccupied = (x, z, minDistance = 2.5) => {
        if (remotePlayers) {
            const players = remotePlayers.values ? Array.from(remotePlayers.values()) : (Array.isArray(remotePlayers) ? remotePlayers : []);
            for (const rp of players) {
                const rpPos = (rp.group && rp.group.position) || rp.target || null;
                if (rpPos && Math.hypot(x - rpPos.x, z - rpPos.z) < minDistance) {
                    return true;
                }
            }
        }
        if (Array.isArray(npcs)) {
            for (const npc of npcs) {
                const nPos = npc.group ? npc.group.position : npc.position;
                if (nPos && Math.hypot(x - nPos.x, z - nPos.z) < minDistance) {
                    return true;
                }
            }
        }
        if (Array.isArray(vehicles)) {
            for (const v of vehicles) {
                const vPos = v.group ? v.group.position : v;
                if (vPos && Math.hypot(x - vPos.x, z - vPos.z) < minDistance) {
                    return true;
                }
            }
        }
        return false;
    };

    // Pick a random starting index
    const startIndex = Math.floor(randomFn() * spawnPoints.length);
    const order = [];
    for (let i = 0; i < spawnPoints.length; i++) {
        order.push(spawnPoints[(startIndex + i) % spawnPoints.length]);
    }

    // Check primary spawn candidates
    for (const sp of order) {
        if (!isPointOccupied(sp.x, sp.z, 2.5)) {
            return { x: sp.x, y: sp.y || 0, z: sp.z, yaw: sp.yaw !== undefined ? sp.yaw : Math.PI };
        }
    }

    // If all exact points are occupied, search nearby around the first preferred point
    const base = order[0];
    const testOffsets = [
        [2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5],
        [2.2, 2.2], [-2.2, 2.2], [2.2, -2.2], [-2.2, -2.2],
        [4.0, 0], [-4.0, 0], [0, 4.0], [0, -4.0]
    ];

    for (const [ox, oz] of testOffsets) {
        const candX = base.x + ox;
        const candZ = base.z + oz;
        if (!isPointOccupied(candX, candZ, 2.2)) {
            return { x: candX, y: base.y || 0, z: candZ, yaw: base.yaw !== undefined ? base.yaw : Math.PI };
        }
    }

    return { x: base.x, y: base.y || 0, z: base.z, yaw: base.yaw !== undefined ? base.yaw : Math.PI };
}

export function revalidatePlayerSpawn(worldMap = {}, remotePlayers = null, randomFn = Math.random) {
    if (GAME_STATE.inVehicle || !Player.position) return false;
    const spawnPoints = Array.isArray(worldMap.spawnPoints) ? worldMap.spawnPoints : (worldMap.playerSpawn ? [worldMap.playerSpawn] : []);
    if (!spawnPoints.length) return false;

    const x = Player.position.x;
    const z = Player.position.z;
    let isOccupied = false;

    if (remotePlayers) {
        const players = remotePlayers.values ? Array.from(remotePlayers.values()) : (Array.isArray(remotePlayers) ? remotePlayers : []);
        for (const rp of players) {
            const rpPos = (rp.group && rp.group.position) || rp.target || null;
            if (rpPos && Math.hypot(x - rpPos.x, z - rpPos.z) < 2.5) {
                isOccupied = true;
                break;
            }
        }
    }
    if (!isOccupied && Array.isArray(World.vehicles)) {
        for (const v of World.vehicles) {
            const vPos = v.group ? v.group.position : v;
            if (vPos && Math.hypot(x - vPos.x, z - vPos.z) < 2.5) {
                isOccupied = true;
                break;
            }
        }
    }
    if (!isOccupied && Array.isArray(World.npcs)) {
        for (const npc of World.npcs) {
            const nPos = npc.group ? npc.group.position : npc.position;
            if (nPos && Math.hypot(x - nPos.x, z - nPos.z) < 2.5) {
                isOccupied = true;
                break;
            }
        }
    }

    if (!isOccupied) return false;

    const chosen = selectValidSpawnPoint({
        spawnPoints,
        remotePlayers,
        npcs: World.npcs,
        vehicles: World.vehicles,
        randomFn
    });

    Player.position.set(chosen.x, chosen.y || 0, chosen.z);
    Player.rotationY = chosen.yaw !== undefined ? chosen.yaw : Math.PI;
    if (Player.group) {
        Player.group.position.copy(Player.position);
        Player.group.rotation.y = Player.rotationY;
    }
    if (Dunya && Dunya.position) {
        const dunyaOffsetX = 1.3 * Math.cos(Player.rotationY + Math.PI / 2);
        const dunyaOffsetZ = 1.3 * Math.sin(Player.rotationY + Math.PI / 2);
        Dunya.position.set(Player.position.x + dunyaOffsetX, 0, Player.position.z + dunyaOffsetZ);
        Dunya.rotationY = Player.rotationY;
        if (Dunya.group) {
            Dunya.group.position.copy(Dunya.position);
            Dunya.group.rotation.y = Dunya.rotationY;
        }
    }
    return true;
}

