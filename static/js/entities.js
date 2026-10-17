import { GAME_STATE, isGameplayInputSuspended } from './state.js';
import { PhysicsEngine, stepVehicleDynamics, stepWorldVehiclePhysics, resolveVehicleToVehicleCollisions, resolveVehicleWorldCollision, getVehicleCollisionCircles, CAR_SPECS } from './physics.js';
import { TextureFactory } from './textures.js';
import { SoundManager } from './audio.js';
import { World } from './world.js';
import { completePOI, triggerPlayerSpeech, showToast, closeNpcDialogue } from './ui.js';

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
        this.group = new THREE.Group();
        this.group.position.copy(this.position);
        this.group.rotation.y = this.rotationY;

        const shirtTex = TextureFactory.createCpro29aShirtTexture();
        const torsoMat = new THREE.MeshStandardMaterial({ map: shirtTex, roughness: 0.5 });
        const skinMat = new THREE.MeshStandardMaterial({ color: 0xf1c27d, roughness: 0.6 });
        const jeansMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 });
        const shoeMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.4 });

        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.92, 1.15, 0.52), torsoMat);
        torso.position.y = 1.48;
        torso.castShadow = true;
        this.group.add(torso);

        this.head = new THREE.Group();
        this.head.position.set(0, 2.32, 0);

        const headMesh = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.56, 0.56), skinMat);
        headMesh.castShadow = true;
        this.head.add(headMesh);

        const capMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.4 });
        const capCrown = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.22, 0.6), capMat);
        capCrown.position.y = 0.24;
        this.head.add(capCrown);

        const capVisor = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.08, 0.35), capMat);
        capVisor.position.set(0, 0.16, 0.38);
        this.head.add(capVisor);

        const glasses = new THREE.Mesh(
            new THREE.BoxGeometry(0.58, 0.14, 0.12),
            new THREE.MeshStandardMaterial({ color: 0x090d16, metalness: 0.9, roughness: 0.1 })
        );
        glasses.position.set(0, 0.04, 0.26);
        this.head.add(glasses);

        this.group.add(this.head);

        const makeLimb = (w, h, d, mat, shoe = null) => {
            const pivot = new THREE.Group();
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
            mesh.position.y = -h / 2;
            mesh.castShadow = true;
            pivot.add(mesh);

            if (shoe) {
                const sneaker = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.22, d + 0.16), shoe);
                sneaker.position.set(0, -h + 0.11, 0.06);
                sneaker.castShadow = true;
                pivot.add(sneaker);
            }
            return pivot;
        };

        this.leftArm = makeLimb(0.28, 0.95, 0.28, new THREE.MeshStandardMaterial({ color: 0x0f172a }));
        this.leftArm.position.set(0.6, 1.95, 0);
        this.group.add(this.leftArm);

        this.rightArm = makeLimb(0.28, 0.95, 0.28, new THREE.MeshStandardMaterial({ color: 0x0f172a }));
        this.rightArm.position.set(-0.6, 1.95, 0);
        this.group.add(this.rightArm);

        this.leftLeg = makeLimb(0.34, 0.9, 0.34, jeansMat, shoeMat);
        this.leftLeg.position.set(0.23, 0.9, 0);
        this.group.add(this.leftLeg);

        this.rightLeg = makeLimb(0.34, 0.9, 0.34, jeansMat, shoeMat);
        this.rightLeg.position.set(-0.23, 0.9, 0);
        this.group.add(this.rightLeg);

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
        const isSprinting = (GAME_STATE.keys.shift || GAME_STATE.joystickSprint) && GAME_STATE.stamina > 5;

        if (isMoving && isSprinting) {
            GAME_STATE.stamina = Math.max(0, GAME_STATE.stamina - dt * 18);
        } else {
            GAME_STATE.stamina = Math.min(100, GAME_STATE.stamina + dt * 14);
        }

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

        const candidatePos = new THREE.Vector3(
            Math.max(-46, Math.min(48, this.position.x + this.velocity.x * dt)),
            this.position.y,
            Math.max(-155, Math.min(155, this.position.z + this.velocity.z * dt))
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
            Dunya.hopAndBark('Прыг! 🐾🤍');
        }
    },

    emote() {
        if (GAME_STATE.inVehicle || isGameplayInputSuspended()) return;
        this.emoteTimer = 3.2;
        triggerPlayerSpeech('Владивосток, салют от @cpro29a! 🔥🌊');
        SoundManager.playActionSound('cash');
        Dunya.hopAndBark('Тяф-тяф! Мы на Набке! 🐾🎀');
    }
};

export const Dunya = {
    group: null,
    headGroup: null,
    tailPivot: null,
    legs: [],
    position: null,
    velocity: null,
    rotationY: Math.PI,
    isGrounded: true,
    walkCycle: 0,
    spinTimer: 0,

    init(scene, startX = null, startZ = null, startYaw = null) {
        const dx = startX !== null ? startX : 1.6;
        const dz = startZ !== null ? startZ : 22.8;
        this.position = new THREE.Vector3(dx, 0, dz);
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.rotationY = startYaw !== null ? startYaw : Math.PI;
        this.group = new THREE.Group();
        this.group.position.copy(this.position);
        this.group.rotation.y = this.rotationY;

        const whiteFurMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
        const snowFluffMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.9 });
        const darkEyeMat = new THREE.MeshStandardMaterial({ color: 0x090d16, roughness: 0.15 });
        const pinkBowMat = new THREE.MeshStandardMaterial({ color: 0xf43f5e, roughness: 0.4 });
        const pinkTongueMat = new THREE.MeshStandardMaterial({ color: 0xfb7185, roughness: 0.5 });
        const goldMat = new THREE.MeshStandardMaterial({ color: 0xfbbf24, metalness: 0.85, roughness: 0.2 });

        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.32, 0.64), whiteFurMat);
        torso.position.set(0, 0.34, 0);
        torso.castShadow = true;
        this.group.add(torso);

        const chestFluff = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 10), snowFluffMat);
        chestFluff.scale.set(1.0, 0.95, 0.9);
        chestFluff.position.set(0, 0.36, 0.25);
        this.group.add(chestFluff);

        const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.18, 0.06, 12), pinkBowMat);
        collar.rotation.x = 0.35;
        collar.position.set(0, 0.45, 0.24);
        this.group.add(collar);

        const medal = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), goldMat);
        medal.position.set(0, 0.39, 0.38);
        this.group.add(medal);

        this.headGroup = new THREE.Group();
        this.headGroup.position.set(0, 0.58, 0.30);

        const skull = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 12), whiteFurMat);
        skull.scale.set(1.05, 0.98, 1.0);
        skull.castShadow = true;
        this.headGroup.add(skull);

        const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.14, 0.16), snowFluffMat);
        muzzle.position.set(0, -0.03, 0.17);
        this.headGroup.add(muzzle);

        const nose = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), darkEyeMat);
        nose.position.set(0, 0.01, 0.25);
        this.headGroup.add(nose);

        const tongue = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.03), pinkTongueMat);
        tongue.rotation.x = 0.35;
        tongue.position.set(0, -0.08, 0.23);
        this.headGroup.add(tongue);

        [-0.085, 0.085].forEach(ex => {
            const eye = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 8), darkEyeMat);
            eye.position.set(ex, 0.05, 0.18);
            this.headGroup.add(eye);
        });

        [-0.19, 0.19].forEach(earX => {
            const ear = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, 0.14), snowFluffMat);
            ear.position.set(earX, -0.02, 0.02);
            ear.rotation.z = earX > 0 ? -0.22 : 0.22;
            this.headGroup.add(ear);
        });

        const topknot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), whiteFurMat);
        topknot.position.set(0, 0.22, 0.02);
        this.headGroup.add(topknot);

        const bowLeft = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.055, 0.04), pinkBowMat);
        bowLeft.position.set(-0.045, 0.18, 0.08);
        bowLeft.rotation.z = 0.25;
        const bowRight = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.055, 0.04), pinkBowMat);
        bowRight.position.set(0.045, 0.18, 0.08);
        bowRight.rotation.z = -0.25;
        this.headGroup.add(bowLeft, bowRight);

        this.group.add(this.headGroup);

        this.tailPivot = new THREE.Group();
        this.tailPivot.position.set(0, 0.44, -0.30);
        const tailPlume = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 8), whiteFurMat);
        tailPlume.scale.set(0.85, 1.35, 1.1);
        tailPlume.position.set(0, 0.10, -0.04);
        this.tailPivot.add(tailPlume);
        this.group.add(this.tailPivot);

        const legPositions = [
            [-0.12, 0.22, 0.20],
            [0.12, 0.22, 0.20],
            [-0.12, 0.22, -0.20],
            [0.12, 0.22, -0.20]
        ];
        this.legs = legPositions.map(([lx, ly, lz]) => {
            const pivot = new THREE.Group();
            pivot.position.set(lx, ly, lz);
            const legMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.22, 8), whiteFurMat);
            legMesh.position.y = -0.11;
            legMesh.castShadow = true;
            pivot.add(legMesh);
            this.group.add(pivot);
            return pivot;
        });

        scene.add(this.group);
    },

    hopAndBark(text = 'Тяф-тяф! 🐾🤍') {
        SoundManager.playActionSound('bark');
        if (this.velocity && this.isGrounded && !GAME_STATE.inVehicle) {
            this.velocity.y = 6.8;
            this.isGrounded = false;
        }
        this.spinTimer = 1.1;

        if (typeof document !== 'undefined') {
            const bubble = document.getElementById('dunya-speech-bubble');
            if (bubble) {
                bubble.textContent = text;
                bubble.classList.remove('hidden');
                clearTimeout(bubble._timer);
                bubble._timer = setTimeout(() => bubble.classList.add('hidden'), 3200);
            }
        }
    },

    update(dt, time) {
        if (!this.group) return;

        if (this.tailPivot) {
            this.tailPivot.rotation.z = Math.sin(time * 16) * 0.45;
        }

        if (GAME_STATE.inVehicle) {
            const car = GAME_STATE.inVehicle.group;
            const passengerOffset = new THREE.Vector3(0.58, 1.05, 0.15).applyAxisAngle(new THREE.Vector3(0, 1, 0), car.rotation.y);
            this.position.copy(car.position).add(passengerOffset);
            this.rotationY = car.rotation.y;
            this.group.position.copy(this.position);
            this.group.rotation.y = this.rotationY;
            this.headGroup.rotation.y = Math.sin(time * 3.5) * 0.25;
            this.legs.forEach(l => { l.rotation.x = 0; });
            return;
        }

        const followAngle = Player.rotationY - 0.65;
        const orbitShift = Math.sin(time * 1.4) * 0.35;
        const targetX = Player.position.x + Math.sin(followAngle + orbitShift) * 1.65;
        const targetZ = Player.position.z + Math.cos(followAngle + orbitShift) * 1.65;

        const dx = targetX - this.position.x;
        const dz = targetZ - this.position.z;
        const distToTarget = Math.hypot(dx, dz);
        const distToPlayer = Math.hypot(Player.position.x - this.position.x, Player.position.z - this.position.z);

        if (distToPlayer > 26) {
            this.position.set(Player.position.x + 1.4, Player.position.y + 0.2, Player.position.z + 1.2);
            this.velocity.set(0, 0, 0);
        }

        let isTrotting = false;
        if (distToTarget > 0.32) {
            isTrotting = true;
            const moveSpeed = distToTarget > 3.2 ? 15.5 : (distToTarget > 1.4 ? 10.2 : 6.2);
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
            const toPlayerX = Player.position.x - this.position.x;
            const toPlayerZ = Player.position.z - this.position.z;
            const lookYaw = Math.atan2(toPlayerX, toPlayerZ);
            let diff = lookYaw - this.rotationY;
            diff = Math.atan2(Math.sin(diff), Math.cos(diff));
            this.rotationY += diff * Math.min(1, dt * 5);
        }

        if (this.isGrounded && Player.position.y > this.position.y + 0.35 && distToPlayer < 5.5) {
            this.velocity.y = 8.4;
            this.isGrounded = false;
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

        if (isTrotting) {
            this.walkCycle += dt * 22;
            const swing = Math.sin(this.walkCycle) * 0.65;
            this.legs[0].rotation.x = swing;
            this.legs[1].rotation.x = -swing;
            this.legs[2].rotation.x = -swing;
            this.legs[3].rotation.x = swing;
            this.headGroup.position.y = 0.58 + Math.abs(Math.sin(this.walkCycle)) * 0.035;
        } else {
            this.legs.forEach(l => { l.rotation.x *= 0.8; });
            this.headGroup.position.y = 0.58 + Math.sin(time * 4) * 0.012;
        }

        this.group.position.copy(this.position);
        this.group.rotation.y = this.rotationY;
    }
};

export function createJDMCar(name, colorHex, x, z, rotY = 0, onToggleDrive = null, customId = null) {
    const group = new THREE.Group();
    group.position.set(x, 0.02, z);
    group.rotation.y = rotY;

    const bodyMat = new THREE.MeshStandardMaterial({ color: colorHex, metalness: 0.7, roughness: 0.25 });
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.75, 4.9), bodyMat);
    chassis.position.y = 0.65;
    chassis.castShadow = true;
    group.add(chassis);

    const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(1.95, 0.65, 2.4),
        new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.8, roughness: 0.15 })
    );
    cabin.position.set(0, 1.3, -0.2);
    group.add(cabin);

    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.12, 0.45), bodyMat);
    spoiler.position.set(0, 1.18, -2.25);
    group.add(spoiler);

    const headMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
    const tailMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
    [-0.75, 0.75].forEach(lx => {
        const hl = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.2, 0.1), headMat);
        hl.position.set(lx, 0.7, 2.46);
        group.add(hl);

        const tl = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.2, 0.1), tailMat);
        tl.position.set(lx, 0.75, -2.46);
        group.add(tl);
    });

    const headBeam = new THREE.SpotLight(0xfef08a, 1.8, 36, Math.PI / 5, 0.45, 1.2);
    headBeam.position.set(0, 0.85, 2.4);
    headBeam.target.position.set(0, 0.2, 16);
    group.add(headBeam);
    group.add(headBeam.target);

    const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.32, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.7 });
    [[-1.15, 1.5], [1.15, 1.5], [-1.15, -1.5], [1.15, -1.5]].forEach(([wx, wz]) => {
        const w = new THREE.Mesh(wheelGeo, wheelMat);
        w.position.set(wx, 0.42, wz);
        group.add(w);
    });

    World.scene.add(group);

    let mass = 1450;
    if (name.includes('Mark II')) mass = 1470;
    else if (name.includes('Skyline') || name.includes('R34')) mass = 1560;
    else if (name.includes('Forester')) mass = 1510;
    else if (name.includes('Chaser')) mass = 1480;
    else if (name.includes('RX-7') || name.includes('FD3S')) mass = 1280;

    const carObj = {
        id: customId || ('car_' + World.vehicles.length),
        name,
        group,
        headBeam,
        x,
        y: 0.02,
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
        spawnY: 0.02,
        spawnZ: z,
        spawnRotY: rotY,
        resetToSpawn() {
            this.x = this.spawnX;
            this.y = this.spawnY || 0.02;
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
            if (this.group && this.group.position) {
                this.group.position.set(this.spawnX, this.spawnY || 0.02, this.spawnZ);
                this.group.rotation.y = this.spawnRotY || 0;
            }
            if (this.headBeam) {
                this.headBeam.intensity = 0;
            }
        },
        update(dt) {
            if (GAME_STATE.inVehicle === this) {
                this.remoteDriver = null;

                let throttle = 0;
                let turn = 0;
                let isSpace = false;
                let isBoostActive = false;

                if (!isGameplayInputSuspended()) {
                    if (GAME_STATE.keys.w || GAME_STATE.joystickVector.y < -0.2) throttle += 1;
                    if (GAME_STATE.keys.s || GAME_STATE.joystickVector.y > 0.2) throttle -= 1;

                    if (GAME_STATE.keys.a || GAME_STATE.joystickVector.x < -0.2) turn += 1;
                    if (GAME_STATE.keys.d || GAME_STATE.joystickVector.x > 0.2) turn -= 1;

                    isBoostActive = GAME_STATE.keys.shift || GAME_STATE.joystickSprint;
                    isSpace = GAME_STATE.keys.space;
                }

                const input = {
                    throttle,
                    steer: turn,
                    handbrake: isSpace,
                    boost: isBoostActive
                };

                // Advance realistic vehicle dynamics
                stepVehicleDynamics(this, input, dt);

                // Spawn drift & braking smoke at rear tires
                if (this.isDrifting || this.isBraking) {
                    const rearX = this.x - Math.sin(this.yaw) * 2.1;
                    const rearZ = this.z - Math.cos(this.yaw) * 2.1;
                    World.spawnDriftSmoke(rearX, rearZ);
                }

                SoundManager.updateVehicleAudio(this, throttle !== 0, this.isBraking, this.isDrifting, isBoostActive);

                // Multi-vehicle impulse collisions (with linear and angular impulse transfer)
                const collEvents = resolveVehicleToVehicleCollisions(World.vehicles, dt);
                for (const ev of collEvents) {
                    if (ev.carA === this || ev.carB === this) {
                        const intensity = Math.min(35, Math.abs(ev.impulse) / 750);
                        if (intensity > 2.0) {
                            SoundManager.playCrashSound(intensity);
                            World.spawnDriftSmoke(ev.contactX, ev.contactZ);
                        }
                    }
                }

                // World collisions & boundaries
                const bounds = { minX: -13, maxX: 44, minZ: -150, maxZ: 150 };
                const hitWorld = resolveVehicleWorldCollision(this, PhysicsEngine, bounds);
                if (hitWorld && Math.abs(this.speed) > 2.5) {
                    SoundManager.playCrashSound(Math.abs(this.speed));
                    const frontX = this.x + Math.sin(this.yaw) * 2.0;
                    const frontZ = this.z + Math.cos(this.yaw) * 2.0;
                    World.spawnDriftSmoke(frontX, frontZ);
                }

                // Push NPCs away from car circles
                const circles = getVehicleCollisionCircles(this);
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

                // Synchronize 3D visuals
                if (this.group && this.group.position) {
                    this.group.position.x = this.x;
                    this.group.position.z = this.z;
                    this.group.rotation.y = this.yaw;
                }
            } else if (this.remoteDriver && this.netTarget) {
                const ageSec = Math.min(0.25, (performance.now() - this.netTarget.timestamp) / 1000);
                const predictedX = this.netTarget.x + Math.sin(this.netTarget.yaw) * this.netTarget.speed * ageSec * 0.35;
                const predictedZ = this.netTarget.z + Math.cos(this.netTarget.yaw) * this.netTarget.speed * ageSec * 0.35;

                this.group.position.x += (predictedX - this.group.position.x) * Math.min(1, dt * 14);
                this.group.position.y += (this.netTarget.y - this.group.position.y) * Math.min(1, dt * 14);
                this.group.position.z += (predictedZ - this.group.position.z) * Math.min(1, dt * 14);

                let yawDiff = this.netTarget.yaw - this.group.rotation.y;
                yawDiff = Math.atan2(Math.sin(yawDiff), Math.cos(yawDiff));
                this.group.rotation.y += yawDiff * Math.min(1, dt * 14);

                this.x = this.group.position.x;
                this.z = this.group.position.z;
                this.yaw = this.group.rotation.y;
                this.speed = this.netTarget.speed;

                if (this.headBeam) {
                    this.headBeam.intensity = this.netTarget.lights ? 1.8 : 0;
                }
                if (this.netTarget.drift && Math.abs(this.speed) > 3) {
                    const rearX = this.group.position.x - Math.sin(this.group.rotation.y) * 2.1;
                    const rearZ = this.group.position.z - Math.cos(this.group.rotation.y) * 2.1;
                    World.spawnDriftSmoke(rearX, rearZ);
                }
            } else {
                // Unoccupied car: if awake (e.g. struck by another vehicle), it rolls and rotates
                if (this.isAwake) {
                    stepVehicleDynamics(this, null, dt);
                    const bounds = { minX: -13, maxX: 44, minZ: -150, maxZ: 150 };
                    resolveVehicleWorldCollision(this, PhysicsEngine, bounds);
                    if (this.group && this.group.position) {
                        this.group.position.x = this.x;
                        this.group.position.z = this.z;
                        this.group.rotation.y = this.yaw;
                    }
                } else {
                    this.speed = 0;
                }
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
    const badge = document.getElementById('player-state-badge');
    const speedBox = document.getElementById('speedometer-box');
    const mobilePedals = document.getElementById('mobile-car-pedals');
    const jumpBtnLabel = document.getElementById('jump-btn-label');
    const jumpBtnIcon = document.getElementById('jump-btn-icon');
    const actionBtnLabel = document.getElementById('action-btn-label');
    SoundManager.playActionSound('car');

    if (GAME_STATE.inVehicle) {
        const leavingVehicle = GAME_STATE.inVehicle;
        leavingVehicle.speed = 0;
        leavingVehicle.vx = 0;
        leavingVehicle.vz = 0;
        leavingVehicle.yawRate = 0;
        leavingVehicle.isAwake = false;
        leavingVehicle.isDrifting = false;
        leavingVehicle.isBraking = false;
        if (leavingVehicle.group && leavingVehicle.group.position) {
            leavingVehicle.x = leavingVehicle.group.position.x;
            leavingVehicle.z = leavingVehicle.group.position.z;
            leavingVehicle.yaw = leavingVehicle.group.rotation.y;
        }
        if (onSendSnapshot) onSendSnapshot(true);

        const exitX = leavingVehicle.group.position.x - 2.6;
        const exitZ = leavingVehicle.group.position.z;
        Player.position.set(exitX, 0, exitZ);
        GAME_STATE.inVehicle = null;
        GAME_STATE.keys.w = GAME_STATE.keys.s = GAME_STATE.keys.space = false;
        SoundManager.updateVehicleAudio(null, false, false, false, false);
        if (badge) {
            badge.textContent = 'ПЕШКОМ';
            badge.className = 'bg-sky-500/20 text-sky-300 border border-sky-400/30 px-1 sm:px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-bold truncate max-w-[85px] sm:max-w-none';
        }
        if (speedBox) speedBox.classList.add('hidden');
        if (mobilePedals) mobilePedals.classList.add('hidden');
        if (jumpBtnLabel) jumpBtnLabel.textContent = 'Прыжок';
        if (jumpBtnIcon) jumpBtnIcon.className = 'fa-solid fa-arrow-up text-sky-400';
        if (actionBtnLabel) actionBtnLabel.textContent = 'Действие (E)';
        showToast(`🚶 @${GAME_STATE.username} вышел на променад Набки`, 'sky');
        if (onSendSnapshot) onSendSnapshot(true);
    } else {
        if (carObj.remoteDriver && carObj.remoteDriver !== GAME_STATE.username) {
            showToast(`⚠️ Машина занята игроком @${carObj.remoteDriver}`, 'amber');
            return;
        }
        if (GAME_STATE.activeNpcChat) closeNpcDialogue();
        GAME_STATE.inVehicle = carObj;
        if (badge) {
            badge.textContent = 'ПРАВЫЙ РУЛЬ';
            badge.className = 'bg-amber-500/20 text-amber-300 border border-amber-400/30 px-1 sm:px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-bold truncate max-w-[85px] sm:max-w-none';
        }
        if (speedBox) speedBox.classList.remove('hidden');
        if (mobilePedals) mobilePedals.classList.remove('hidden');
        if (jumpBtnLabel) jumpBtnLabel.textContent = 'Дрифт';
        if (jumpBtnIcon) jumpBtnIcon.className = 'fa-solid fa-compact-disc fa-spin text-amber-400';
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
    let isSpace = false;
    let throttle = 0;
    let turn = 0;

    if (GAME_STATE.inVehicle) {
        if (!isGameplayInputSuspended()) {
            if (GAME_STATE.keys.w || GAME_STATE.joystickVector.y < -0.2) throttle += 1;
            if (GAME_STATE.keys.s || GAME_STATE.joystickVector.y > 0.2) throttle -= 1;

            if (GAME_STATE.keys.a || GAME_STATE.joystickVector.x < -0.2) turn += 1;
            if (GAME_STATE.keys.d || GAME_STATE.joystickVector.x > 0.2) turn -= 1;

            isBoostActive = Boolean(GAME_STATE.keys.shift || GAME_STATE.joystickSprint);
            isSpace = Boolean(GAME_STATE.keys.space);
        }

        input = {
            throttle,
            steer: turn,
            handbrake: isSpace,
            boost: isBoostActive
        };
    }

    const bounds = (worldMap && worldMap.bounds && worldMap.bounds.vehicle) ? worldMap.bounds.vehicle : { minX: -13, maxX: 44, minZ: -150, maxZ: 150 };

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
                car.group.position.x = car.x;
                car.group.position.z = car.z;
                car.group.rotation.y = car.yaw;
            }
        } else if (car.remoteDriver && car.netTarget) {
            const ageSec = Math.min(0.25, (performance.now() - car.netTarget.timestamp) / 1000);
            const predictedX = car.netTarget.x + Math.sin(car.netTarget.yaw) * car.netTarget.speed * ageSec * 0.35;
            const predictedZ = car.netTarget.z + Math.cos(car.netTarget.yaw) * car.netTarget.speed * ageSec * 0.35;

            const prevX = (car.x !== undefined) ? car.x : car.group.position.x;
            const prevZ = (car.z !== undefined) ? car.z : car.group.position.z;
            const prevYaw = (car.yaw !== undefined) ? car.yaw : car.group.rotation.y;

            car.group.position.x += (predictedX - car.group.position.x) * Math.min(1, dt * 14);
            car.group.position.y += (car.netTarget.y - car.group.position.y) * Math.min(1, dt * 14);
            car.group.position.z += (predictedZ - car.group.position.z) * Math.min(1, dt * 14);

            let yawDiff = car.netTarget.yaw - car.group.rotation.y;
            yawDiff = Math.atan2(Math.sin(yawDiff), Math.cos(yawDiff));
            car.group.rotation.y += yawDiff * Math.min(1, dt * 14);

            car.x = car.group.position.x;
            car.z = car.group.position.z;
            car.yaw = car.group.rotation.y;
            car.speed = car.netTarget.speed;

            const safeDt = Math.max(0.001, dt);
            car.vx = (car.x - prevX) / safeDt;
            car.vz = (car.z - prevZ) / safeDt;
            let actualYawDiff = car.yaw - prevYaw;
            actualYawDiff = Math.atan2(Math.sin(actualYawDiff), Math.cos(actualYawDiff));
            car.yawRate = actualYawDiff / safeDt;

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
                car.group.position.x = car.x;
                car.group.position.z = car.z;
                car.group.rotation.y = car.yaw;
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
        const g = (typeof THREE !== 'undefined') ? new THREE.Group() : { position: { x: 0, y: 0, z: 0 }, rotation: { y: 0 }, add() {} };
        const startZ = -110 + i * 16;
        const laneX = -7.5 + (i % 3) * 4.5;
        g.position.x = laneX;
        g.position.y = 0;
        g.position.z = startZ;

        const initialHeading = i % 2 === 0 ? 0 : Math.PI;
        g.rotation.y = initialHeading;

        if (typeof THREE !== 'undefined') {
            const body = new THREE.Mesh(
                new THREE.BoxGeometry(0.65, 1.35, 0.4),
                new THREE.MeshStandardMaterial({ color: colors[i % colors.length], roughness: 0.45 })
            );
            body.position.y = 0.85;
            body.castShadow = true;
            g.add(body);

            const head = new THREE.Mesh(
                new THREE.BoxGeometry(0.44, 0.44, 0.44),
                new THREE.MeshStandardMaterial({ color: 0xf1c27d })
            );
            head.position.y = 1.78;
            g.add(head);

            const ring = new THREE.Mesh(
                new THREE.RingGeometry(0.55, 0.68, 20),
                new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.55 })
            );
            ring.rotation.x = -Math.PI / 2;
            ring.position.y = 0.04;
            g.add(ring);

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

