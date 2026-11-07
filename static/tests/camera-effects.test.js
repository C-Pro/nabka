import { describe, test, expect, beforeEach } from 'bun:test';
import {
    triggerCameraShake,
    getCameraShakeIntensity,
    resetCameraShake,
    removeCameraShake,
    applyCameraShake
} from '../js/camera-effects.js';

describe('Camera Shake Effects - Zero Trajectory Contamination', () => {
    let mockCamera;

    beforeEach(() => {
        resetCameraShake();
        mockCamera = {
            position: { x: 10, y: 5, z: -20 }
        };
    });

    test('triggerCameraShake sets intensity and applyCameraShake displaces camera temporarily', () => {
        triggerCameraShake(1.5);
        expect(getCameraShakeIntensity()).toBe(1.5);

        const initialPos = { ...mockCamera.position };
        applyCameraShake(mockCamera, 0.016);

        // Position was displaced for rendering
        expect(mockCamera.position.x !== initialPos.x || mockCamera.position.y !== initialPos.y || mockCamera.position.z !== initialPos.z).toBe(true);
        expect(getCameraShakeIntensity()).toBeLessThan(1.5);
    });

    test('removeCameraShake removes displacement before lerping, preventing trajectory contamination', () => {
        triggerCameraShake(1.0);

        // Frame 1: calculate base, lerp, apply shake
        mockCamera.position.x = 50;
        applyCameraShake(mockCamera, 0.016);
        expect(mockCamera.position.x).not.toBe(50); // Shaken for rendering

        // Frame 2: removeCameraShake restores pure base before lerping
        removeCameraShake(mockCamera);
        expect(mockCamera.position.x).toBe(50); // Restored!

        // Lerp to new target
        mockCamera.position.x = 55;
        applyCameraShake(mockCamera, 0.016);

        // Decay shake completely
        for (let i = 0; i < 40; i++) {
            removeCameraShake(mockCamera);
            applyCameraShake(mockCamera, 0.05);
        }

        removeCameraShake(mockCamera);
        expect(getCameraShakeIntensity()).toBe(0);
        expect(mockCamera.position.x).toBe(55);
    });

    test('resetCameraShake removes active offset immediately and resets intensity', () => {
        triggerCameraShake(2.0);
        applyCameraShake(mockCamera, 0.016);

        resetCameraShake(mockCamera);
        expect(getCameraShakeIntensity()).toBe(0);
        expect(mockCamera.position.x).toBe(10);
        expect(mockCamera.position.y).toBe(5);
        expect(mockCamera.position.z).toBe(-20);
    });
});
