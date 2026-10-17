/**
 * 3D height-aware collision and support height engine.
 * Pure math module independent of Three.js / WebGL so it can be shared or mirrored on the server.
 */

export function createColliderStore(initialColliders = []) {
    const colliders = [];

    const engine = {
        colliders,

        clear() {
            colliders.length = 0;
        },

        addCircleCollider(x, z, radius, height = 10, climbable = false, name = '') {
            colliders.push({ type: 'circle', x, z, radius, height, climbable, name });
        },

        addBoxCollider(x, z, width, depth, height = 12, climbable = false, name = '') {
            colliders.push({ type: 'box', x, z, halfW: width / 2, halfD: depth / 2, height, climbable, name });
        },

        loadFromConfig(config = []) {
            const colliderDefs = Array.isArray(config)
                ? config
                : (config && Array.isArray(config.staticColliders) ? config.staticColliders : []);
            for (const def of colliderDefs) {
                if (def.type === 'circle') {
                    this.addCircleCollider(def.x, def.z, def.radius, def.height, def.climbable, def.name);
                } else if (def.type === 'box') {
                    this.addBoxCollider(def.x, def.z, def.width, def.depth, def.height, def.climbable, def.name);
                }
            }
        },

        /**
         * Returns base terrain height + checks if entity is standing on top of any climbable 3D collider
         * or parked vehicle.
         */
        getSupportHeightAt(x, z, currentY, entityRadius = 0.45, vehiclesList = [], activeVehicle = null) {
            let baseGround = 0;
            // Seaside amphitheater steps down to Yubileyny Beach (except wooden pier corridor at Z: 44..52 and 114..122)
            const onPier = (z > 44 && z < 52) || (z > 114 && z < 122);
            if (x < -15 && !onPier) {
                baseGround = Math.max(-1.2, (x + 15) * 0.16);
            }

            let maxSupport = baseGround;
            for (const col of colliders) {
                // Only consider surfaces the entity has jumped high enough to land on
                if (currentY >= col.height - 0.42) {
                    if (col.type === 'circle') {
                        const dist = Math.hypot(x - col.x, z - col.z);
                        if (dist <= col.radius + entityRadius * 0.4) {
                            if (col.height > maxSupport) maxSupport = col.height;
                        }
                    } else if (col.type === 'box') {
                        if (
                            Math.abs(x - col.x) <= col.halfW + entityRadius * 0.4 &&
                            Math.abs(z - col.z) <= col.halfD + entityRadius * 0.4
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
                // If entity is above the top of this structure (e.g. jumped on the Fountain), do not block horizontally
                if (currentY >= col.height - 0.35) continue;

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
                    const dx = pos.x - col.x;
                    const dz = pos.z - col.z;
                    const clampedX = Math.max(-col.halfW, Math.min(col.halfW, dx));
                    const clampedZ = Math.max(-col.halfD, Math.min(col.halfD, dz));
                    const diffX = dx - clampedX;
                    const diffZ = dz - clampedZ;
                    const distSq = diffX * diffX + diffZ * diffZ;

                    if (distSq < radius * radius) {
                        hitAny = true;
                        const dist = Math.sqrt(distSq);
                        if (dist > 0.0001) {
                            const overlap = radius - dist;
                            pos.x += (diffX / dist) * overlap;
                            pos.z += (diffZ / dist) * overlap;
                        } else {
                            // Inside box center fallback: push out along nearest axis
                            const penX = col.halfW + radius - Math.abs(dx);
                            const penZ = col.halfD + radius - Math.abs(dz);
                            if (penX < penZ) {
                                pos.x += dx >= 0 ? penX : -penX;
                            } else {
                                pos.z += dz >= 0 ? penZ : -penZ;
                            }
                        }
                    }
                }
            }
            return hitAny;
        }
    };

    if (initialColliders.length > 0) {
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
    length: 4.8,
    width: 2.3,
    wheelbase: 2.7,
    axleOffset: 1.25,
    collisionRadius: 1.15,
    restitution: 0.25,
    maxSpeedForward: 25.0,
    maxSpeedBoost: 34.0,
    maxSpeedReverse: -10.0,
    accelForward: 18.0,
    accelBoost: 26.0,
    accelBrake: 12.0,
    accelReverse: 8.0,
    accelHandbrake: 9.0,
    dragRoll: 1.4,
    dragAero: 0.003,
    muGrip: 1.15,
    muDrift: 0.55,
    lateralDampingGrip: 12.0,
    lateralDampingDrift: 2.6,
    steerGain: 0.52
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
                const accel = (boost ? CAR_SPECS.accelBoost : CAR_SPECS.accelForward) * throttle;
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
            if (vLong > 0) {
                vLong = Math.max(0, vLong - CAR_SPECS.accelHandbrake * dt);
            } else if (vLong < 0) {
                vLong = Math.min(0, vLong + CAR_SPECS.accelHandbrake * dt);
            }
            if (Math.abs(vLong) > 1.5) {
                car.isBraking = true;
            }
        }

        // Speed scaling: stopped cars cannot drift or steer
        const totalSpeed = Math.hypot(vLong, vLat);
        const speedMag = Math.abs(vLong);
        const steerSpeedFactor = Math.min(1, Math.max(0, (totalSpeed - 0.3) / 2.0));
        const steerSign = vLong >= 0 ? 1 : -1;

        const speedGain = 1.0 / (1.0 + Math.pow(speedMag / 15.0, 2));
        const targetYawRate = steer * (vLong / CAR_SPECS.wheelbase) * CAR_SPECS.steerGain * speedGain;
        const demandedLatAcc = Math.abs(vLong * targetYawRate);
        const maxGripAcc = CAR_SPECS.muGrip * 9.81;

        const isSharpTurn = Math.abs(steer) > 0.35 && totalSpeed > 5.0;
        const canDriftAtSpeed = totalSpeed > 2.0;
        const enterDrift = canDriftAtSpeed && (
            (handbrake && (Math.abs(steer) > 0.1 || Math.abs(vLat) > 0.4)) ||
            (car.isBraking && isSharpTurn) ||
            (demandedLatAcc > maxGripAcc)
        );

        const keepDrift = car.isDrifting && canDriftAtSpeed && (
            handbrake || Math.abs(vLat) > 0.6 || demandedLatAcc > maxGripAcc * 0.65
        );
        car.isDrifting = enterDrift || keepDrift;

        // Lateral tire friction bounded by traction budget
        const mu = car.isDrifting ? CAR_SPECS.muDrift : CAR_SPECS.muGrip;
        const maxLatDeltaV = mu * 9.81 * dt;
        const dampingRate = car.isDrifting ? CAR_SPECS.lateralDampingDrift : CAR_SPECS.lateralDampingGrip;
        let deltaVLat = -vLat * (1 - Math.exp(-dampingRate * dt));
        if (Math.abs(deltaVLat) > maxLatDeltaV) {
            deltaVLat = Math.sign(deltaVLat) * maxLatDeltaV;
        }
        vLat += deltaVLat;

        // Yaw rate integration
        if (!car.isDrifting) {
            // Steering rate integration that allows collision-induced spin to persist naturally
            car.yawRate = car.yawRate + (targetYawRate - car.yawRate) * Math.min(1, 8.5 * dt);
        } else {
            // Oversteer response to counter-steering scaled by speed
            car.yawRate = car.yawRate + (steer * steerSign * 8.5 * steerSpeedFactor) * dt;
            car.yawRate *= Math.exp(-2.8 * dt);
        }

        // PRE-TURN yaw reconstruction preserves momentum and creates realistic outward centrifugal skidding
        car.vx = vLong * sinY + vLat * cosY;
        car.vz = vLong * cosY - vLat * sinY;

        car.yaw = normalizeAngle(currentYaw + car.yawRate * dt);
        car.x = car.x + car.vx * dt;
        car.z = car.z + car.vz * dt;
        car.speed = car.vx * Math.sin(car.yaw) + car.vz * Math.cos(car.yaw);
        car.isAwake = true;
    } else {
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
        const invMassA = (Number.isFinite(rawMassA) && rawMassA > 10.0) ? (1 / rawMassA) : (1 / CAR_SPECS.mass);
        const rawIA = Number(carA.inertia);
        const invIA = (Number.isFinite(rawIA) && rawIA > 50.0) ? (1 / rawIA) : (1 / getVehicleInertia(carA));

        for (let j = i + 1; j < cars.length; j++) {
            const carB = cars[j];
            const rawMassB = Number(carB.mass);
            const invMassB = (Number.isFinite(rawMassB) && rawMassB > 10.0) ? (1 / rawMassB) : (1 / CAR_SPECS.mass);
            const rawIB = Number(carB.inertia);
            const invIB = (Number.isFinite(rawIB) && rawIB > 50.0) ? (1 / rawIB) : (1 / getVehicleInertia(carB));

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
                carA.isAwake = true;
                carB.isAwake = true;

                const { overlap, nx, nz, contactX, contactZ } = bestContact;
                const sumInvM = invMassA + invMassB;

                // Mass-weighted position correction
                carA.x = (Number(carA.x) || 0) - nx * overlap * (invMassA / sumInvM);
                carA.z = (Number(carA.z) || 0) - nz * overlap * (invMassA / sumInvM);
                carB.x = (Number(carB.x) || 0) + nx * overlap * (invMassB / sumInvM);
                carB.z = (Number(carB.z) || 0) + nz * overlap * (invMassB / sumInvM);

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

                    carA.vx = (Number(carA.vx) || 0) - J * nx * invMassA;
                    carA.vz = (Number(carA.vz) || 0) - J * nz * invMassA;
                    carB.vx = (Number(carB.vx) || 0) + J * nx * invMassB;
                    carB.vz = (Number(carB.vz) || 0) + J * nz * invMassB;

                    carA.yawRate = (Number(carA.yawRate) || 0) - J * ca * invIA;
                    carB.yawRate = (Number(carB.yawRate) || 0) + J * cb * invIB;

                    carA.speed = carA.vx * Math.sin(carA.yaw || 0) + carA.vz * Math.cos(carA.yaw || 0);
                    carB.speed = carB.vx * Math.sin(carB.yaw || 0) + carB.vz * Math.cos(carB.yaw || 0);

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
            for (const col of colliderList) {
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
                    const dx = circleX - col.x;
                    const dz = circleZ - col.z;
                    const clampedX = Math.max(-col.halfW, Math.min(col.halfW, dx));
                    const clampedD = Math.max(-col.halfD, Math.min(col.halfD, dz));
                    const diffX = dx - clampedX;
                    const diffZ = dz - clampedD;
                    const distSq = diffX * diffX + diffZ * diffZ;

                    if (distSq < circleRadius * circleRadius) {
                        const dist = Math.sqrt(distSq);
                        if (dist > 0.0001) {
                            nx = diffX / dist;
                            nz = diffZ / dist;
                            overlap = circleRadius - dist;
                        } else {
                            const penX = col.halfW + circleRadius - Math.abs(dx);
                            const penZ = col.halfD + circleRadius - Math.abs(dz);
                            if (penX < penZ) {
                                nx = (Number(car.x) || 0) >= col.x ? 1 : -1;
                                nz = 0;
                                overlap = penX;
                            } else {
                                nx = 0;
                                nz = (Number(car.z) || 0) >= col.z ? 1 : -1;
                                overlap = penZ;
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
        reset() { accumulator = 0; },
        step(vehicles, dt, colliders, bounds = null, activeVehicle = null, activeInput = null) {
            if (!Array.isArray(vehicles) || vehicles.length === 0 || !Number.isFinite(dt) || dt <= 0) return [];
            accumulator += Math.min(0.1, dt);
            const allEvents = [];

            while (accumulator >= fixedDt) {
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
