import { smoothingAlpha } from './vehicle-motion.js';
import { GAME_STATE, DEFAULT_WALK_PITCH, loadGameData } from './state.js';
import { World } from './world.js';
import { Player, Dunya, createJDMCar, toggleVehicleDrive, initPromenadeNPCs, selectValidSpawnPoint, updateWorldVehicles } from './entities.js';
import { MultiplayerClient } from './network.js';
import { bindInputControls } from './input.js';
import { checkProximityInteractions, updateScreenProjections, drawGTARadar } from './ui.js';
import { ModelLoader } from './models.js';

let activeWorldMap = {};

export function updateThirdPersonCamera(dt = 0.016) {
    const camera = World.camera;
    if (!camera || !Player.position) return;

    const mode = GAME_STATE.cameraModes[GAME_STATE.cameraMode] || { heightOffset: 2.6 };
    const targetBase = GAME_STATE.inVehicle ? GAME_STATE.inVehicle.group.position : Player.position;

    if (GAME_STATE.inVehicle) {
        const car = GAME_STATE.inVehicle.group;
        const targetCarCamYaw = car.rotation.y + Math.PI;
        const yawDiff = Math.atan2(Math.sin(targetCarCamYaw - GAME_STATE.cameraYaw), Math.cos(targetCarCamYaw - GAME_STATE.cameraYaw));
        GAME_STATE.cameraYaw += yawDiff * smoothingAlpha(14, dt);
        GAME_STATE.cameraPitch += (0.28 - GAME_STATE.cameraPitch) * smoothingAlpha(10, dt);
    } else {
        const timeSinceMouse = performance.now() - GAME_STATE.lastMouseMoveTime;
        if (timeSinceMouse > 1000) {
            const targetWalkYaw = Player.rotationY + Math.PI;
            const yawDiff = Math.atan2(Math.sin(targetWalkYaw - GAME_STATE.cameraYaw), Math.cos(targetWalkYaw - GAME_STATE.cameraYaw));
            GAME_STATE.cameraYaw += yawDiff * smoothingAlpha(3.2, dt);
            GAME_STATE.cameraPitch += (DEFAULT_WALK_PITCH - GAME_STATE.cameraPitch) * smoothingAlpha(3.5, dt);
        }
    }

    if (GAME_STATE.cameraMode === 3) {
        if (Player.group) Player.group.visible = false;
        if (GAME_STATE.inVehicle) {
            const car = GAME_STATE.inVehicle.group;
            const seatOffset = new THREE.Vector3(-0.45, 1.38, 0.15).applyAxisAngle(new THREE.Vector3(0, 1, 0), car.rotation.y);
            const camPos = car.position.clone().add(seatOffset);
            camera.position.copy(camPos);
            const forwardDir = new THREE.Vector3(Math.sin(car.rotation.y), -0.04, Math.cos(car.rotation.y));
            camera.lookAt(camPos.clone().add(forwardDir.multiplyScalar(25)));
        } else {
            const eyePos = new THREE.Vector3(targetBase.x, targetBase.y + 2.35, targetBase.z);
            camera.position.copy(eyePos);
            const lookDir = new THREE.Vector3(
                -Math.sin(GAME_STATE.cameraYaw) * Math.cos(GAME_STATE.cameraPitch),
                -Math.sin(GAME_STATE.cameraPitch - 0.25),
                -Math.cos(GAME_STATE.cameraYaw) * Math.cos(GAME_STATE.cameraPitch)
            );
            camera.lookAt(eyePos.clone().add(lookDir.multiplyScalar(20)));
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

    camera.position.lerp(new THREE.Vector3(camX, camY, camZ), smoothingAlpha(GAME_STATE.inVehicle ? 25.85 : 14.91, dt));
    camera.lookAt(lookTarget);
}

function gameLoop() {
    requestAnimationFrame(gameLoop);

    const dt = Math.min(World.clock.getDelta(), 0.05);
    const elapsed = World.clock.getElapsedTime();

    if (GAME_STATE.isConnected) {
        Player.update(dt, MultiplayerClient.remotePlayers);
        updateWorldVehicles(dt, activeWorldMap);
        Dunya.update(dt, elapsed, Player.position);
        MultiplayerClient.update(dt);
    }

    const staminaBar = document.getElementById('stamina-bar');
    if (staminaBar) staminaBar.style.width = `${GAME_STATE.stamina}%`;
    if (GAME_STATE.inVehicle) {
        const kmh = Math.round(Math.abs(GAME_STATE.inVehicle.speed) * 3.8);
        const speedVal = document.getElementById('speed-value');
        if (speedVal) speedVal.textContent = String(kmh);
    }

    World.animateEnvironment(elapsed, dt, Player.position);
    updateThirdPersonCamera(dt);
    checkProximityInteractions({
        playerPos: Player.position,
        npcs: World.npcs,
        interactables: World.interactables,
        dunya: Dunya,
        worldMap: activeWorldMap
    });
    updateScreenProjections({
        camera: World.camera,
        playerPos: Player.position,
        dunya: Dunya,
        worldLabels: World.worldLabels,
        npcs: World.npcs,
        remotePlayers: MultiplayerClient.remotePlayers
    });
    drawGTARadar({
        playerPos: Player.position,
        interactables: World.interactables,
        npcs: World.npcs,
        dunya: Dunya,
        remotePlayers: MultiplayerClient.remotePlayers
    });

    World.renderer.render(World.scene, World.camera);
}

export async function startApp() {
    const { worldMap, npcDialogues } = await loadGameData();
    activeWorldMap = worldMap;

    if (Array.isArray(worldMap.weatherPresets) && worldMap.weatherPresets.length > 0) {
        GAME_STATE.weatherPresets = worldMap.weatherPresets;
    }
    if (Array.isArray(worldMap.cameraModes) && worldMap.cameraModes.length > 0) {
        GAME_STATE.cameraModes = worldMap.cameraModes;
    }

    await ModelLoader.preloadAll(worldMap);

    World.initThreeScene();
    World.buildVladivostokNabka(worldMap);
    World.updateVladivostokClockAndTimeOfDay();
    if (typeof window !== 'undefined') {
        window.GAME_STATE = GAME_STATE;
        window.World = World;
        window.Player = Player;
        window.Dunya = Dunya;
        window.MultiplayerClient = MultiplayerClient;
    }

    const handleToggleDrive = (carObj) => {
        toggleVehicleDrive(carObj, (force) => MultiplayerClient.sendMoveSnapshot(force));
    };

    const vehiclesList = Array.isArray(worldMap.vehicles) ? worldMap.vehicles : [];
    for (const v of vehiclesList) {
        const rawColor = v.colorHex !== undefined ? v.colorHex : v.color;
        const colorInt = typeof rawColor === 'string' ? parseInt(rawColor, 16) : rawColor;
        const rotY = v.rotY ?? v.rotation ?? v.rotationY ?? 0;
        const carObj = createJDMCar(v.name, colorInt, v.x, v.z, rotY, handleToggleDrive, v.id, v.model || null);
        if (carObj && carObj.group) {
            if (v.y !== undefined) {
                carObj.group.position.y = v.y;
            }
            if (v.scale !== undefined && v.scale !== 1) {
                carObj.group.scale.setScalar(v.scale);
            }
            carObj.group.userData = {
                ...carObj.group.userData,
                editorCategory: 'vehicles',
                editorId: v.id,
                configRef: v
            };
        }
    }

    initPromenadeNPCs(npcDialogues, worldMap.npcs || {});

    const spawnPoints = Array.isArray(worldMap.spawnPoints) ? worldMap.spawnPoints : [worldMap.playerSpawn];
    const chosenSpawn = selectValidSpawnPoint({
        spawnPoints,
        remotePlayers: MultiplayerClient.remotePlayers,
        npcs: World.npcs,
        vehicles: World.vehicles
    });
    Player.init(World.scene, chosenSpawn);

    const dunyaOffsetX = 1.3 * Math.cos(chosenSpawn.yaw + Math.PI / 2);
    const dunyaOffsetZ = 1.3 * Math.sin(chosenSpawn.yaw + Math.PI / 2);
    Dunya.init(World.scene, chosenSpawn.x + dunyaOffsetX, chosenSpawn.z + dunyaOffsetZ, chosenSpawn.yaw);

    MultiplayerClient.initUI(worldMap);
    bindInputControls(worldMap);

    gameLoop();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', startApp);
    } else {
        startApp();
    }
}
