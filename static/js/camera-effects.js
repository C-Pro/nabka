/**
 * Camera effects module for Nabka.
 * Provides temporary camera shake (e.g. for cannon shots) that decays smoothly
 * without contaminating camera position lerping or corrupting yaw/pitch.
 */

let shakeIntensity = 0;
let lastShakeOffset = { x: 0, y: 0, z: 0 };

export function triggerCameraShake(intensity = 1.0) {
    shakeIntensity = Math.max(shakeIntensity, intensity);
}

export function getCameraShakeIntensity() {
    return shakeIntensity;
}

export function resetCameraShake(camera = null) {
    if (camera) {
        camera.position.x -= lastShakeOffset.x;
        camera.position.y -= lastShakeOffset.y;
        camera.position.z -= lastShakeOffset.z;
    }
    shakeIntensity = 0;
    lastShakeOffset = { x: 0, y: 0, z: 0 };
}

/**
 * Removes active shake displacement from camera.position BEFORE lerping or calculation.
 * Ensures camera smoothing starts from the true unshaken base.
 */
export function removeCameraShake(camera) {
    if (!camera) return;
    if (lastShakeOffset.x !== 0 || lastShakeOffset.y !== 0 || lastShakeOffset.z !== 0) {
        camera.position.x -= lastShakeOffset.x;
        camera.position.y -= lastShakeOffset.y;
        camera.position.z -= lastShakeOffset.z;
        lastShakeOffset = { x: 0, y: 0, z: 0 };
    }
}

/**
 * Calculates decay and applies temporary displacement to camera.position AFTER lerping.
 */
export function applyCameraShake(camera, dt = 0.016) {
    if (!camera) return;
    if (shakeIntensity <= 0.001) {
        shakeIntensity = 0;
        return;
    }

    const shakeX = (Math.random() - 0.5) * 0.5 * shakeIntensity;
    const shakeY = (Math.random() - 0.5) * 0.5 * shakeIntensity;
    const shakeZ = (Math.random() - 0.5) * 0.5 * shakeIntensity;

    camera.position.x += shakeX;
    camera.position.y += shakeY;
    camera.position.z += shakeZ;

    lastShakeOffset = { x: shakeX, y: shakeY, z: shakeZ };
    shakeIntensity = Math.max(0, shakeIntensity - dt * 2.8);
}
