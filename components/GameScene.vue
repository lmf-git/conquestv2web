<template>
  <div ref="container" class="game-container">
    <div class="crosshair"></div>
    <div v-if="!isPointerLocked" class="click-prompt">Click to play</div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import * as THREE from 'three';
import { useGameStore } from '~/stores/game';

const container = ref(null);
const gameStore = useGameStore();
const isPointerLocked = ref(false);

let scene, camera, renderer, animationFrameId;
let cameraRotation = { x: 0, y: 0 };
const playerMeshes = new Map();
const staticBoxMeshes = new Map();
const movingBoxMeshes = new Map();
let localPlayerObject, localPlayerMesh;
let lastNormalVector = new THREE.Vector3(0, 1, 0);

onMounted(() => {
  gameStore.connectToServer();
  if (!container.value) return;
  
  // Scene setup
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000020);
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.value.appendChild(renderer.domElement);
  
  // Add lights
  scene.add(new THREE.AmbientLight(0x404040));
  scene.add(new THREE.DirectionalLight(0xffffff, 1).translateY(1));
  
  // Create planet
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(gameStore.planetRadius, 32, 32),
    new THREE.MeshStandardMaterial({ color: 0x5555ff, roughness: 0.8, metalness: 0.2 })
  ));
  
  // Create main platform
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(30, 3, 30),
    new THREE.MeshStandardMaterial({ 
      color: 0xFF8C00, roughness: 0.7, metalness: 0.2,
      emissive: 0x331400, emissiveIntensity: 0.2
    })
  );
  box.position.set(0, gameStore.planetRadius + 30, 0);
  scene.add(box);
  
  // Create player
  localPlayerObject = new THREE.Group();
  scene.add(localPlayerObject);
  
  localPlayerMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.5, 1, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0x00ff00 })
  );
  localPlayerObject.add(localPlayerMesh);
  
  // Camera setup
  const cameraHolder = new THREE.Object3D();
  cameraHolder.position.y = 0.7;
  localPlayerObject.add(cameraHolder);
  cameraHolder.add(camera);
  
  // Init position
  localPlayerObject.position.set(0, gameStore.planetRadius + 50, 0);
  
  // Events
  container.value.addEventListener('click', requestPointerLock);
  setupEventListeners();
  
  animate();
});

onUnmounted(() => {
  cancelAnimationFrame(animationFrameId);
  document.removeEventListener('pointerlockchange', handlePointerLockChange);
  document.removeEventListener('mousemove', handleMouseMove);
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('keyup', handleKeyUp);
  
  document.exitPointerLock?.();
  gameStore.ws?.close();
  renderer?.dispose();
});

function setupEventListeners() {
  document.addEventListener('pointerlockchange', handlePointerLockChange);
  document.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('resize', handleResize);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
}

function requestPointerLock() {
  container.value.requestPointerLock = 
    container.value.requestPointerLock || 
    container.value.mozRequestPointerLock;
  container.value.requestPointerLock();
}

function handlePointerLockChange() {
  isPointerLocked.value = document.pointerLockElement === container.value;
}

function handleResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function handleKeyDown(e) {
  if (gameStore.keys.hasOwnProperty(e.key.toLowerCase())) {
    gameStore.keys[e.key.toLowerCase()] = true;
  }
}

function handleKeyUp(e) {
  if (gameStore.keys.hasOwnProperty(e.key.toLowerCase())) {
    gameStore.keys[e.key.toLowerCase()] = false;
  }
}

function handleMouseMove(event) {
  if (!isPointerLocked.value) return;
  
  cameraRotation.x -= event.movementY * 0.002;
  cameraRotation.y -= event.movementX * 0.002;
  cameraRotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, cameraRotation.x));
}

function updateCameraOrientation() {
  const playerData = gameStore.getMyPlayerData();
  if (!playerData) return;
  
  // Set position
  localPlayerObject.position.copy(new THREE.Vector3(
    playerData.pos.x, playerData.pos.y, playerData.pos.z
  ));
  
  // Get current orientation data
  const currentNormal = new THREE.Vector3(
    playerData.normal.x, playerData.normal.y, playerData.normal.z
  ).normalize();
  lastNormalVector.copy(currentNormal);
  
  const cameraHolder = camera.parent;
  
  // Apply orientations based on player state
  if (!playerData.falling) {
    // On ground
    if (playerData.onBox && !playerData.onStaticBox && !playerData.onMovingBox) {
      localPlayerObject.quaternion.identity();
    } else {
      localPlayerObject.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0), currentNormal
      );
    }
    
    // Reset and apply camera rotations
    cameraHolder.quaternion.identity();
    const yawQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), cameraRotation.y
    );
    const pitchQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), cameraRotation.x
    );
    
    cameraHolder.quaternion.multiply(yawQuat).multiply(pitchQuat);
    localPlayerMesh.quaternion.copy(yawQuat);
  } else {
    // In air
    localPlayerObject.quaternion.identity();
    
    const yawQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), cameraRotation.y
    );
    localPlayerObject.quaternion.multiply(yawQuat);
    
    cameraHolder.quaternion.setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), cameraRotation.x
    );
    
    localPlayerMesh.quaternion.identity();
  }
}

function updateBoxes() {
  if (!gameStore.lastServerState) return;
  
  // Update static boxes
  for (const boxData of gameStore.getStaticBoxes()) {
    if (!staticBoxMeshes.has(boxData.id)) {
      // Create new box
      const boxMesh = new THREE.Mesh(
        new THREE.BoxGeometry(boxData.width, boxData.height, boxData.depth),
        new THREE.MeshStandardMaterial({ 
          color: 0x2ecc71, roughness: 0.6, metalness: 0.2
        })
      );
      scene.add(boxMesh);
      staticBoxMeshes.set(boxData.id, { mesh: boxMesh, data: { ...boxData } });
    }
    
    // Update position and orientation
    const box = staticBoxMeshes.get(boxData.id);
    box.data = { ...boxData };
    box.mesh.position.set(
      boxData.position.x, boxData.position.y, boxData.position.z
    );
    
    const normal = new THREE.Vector3(
      boxData.position.x, boxData.position.y, boxData.position.z
    ).normalize();
    
    box.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  }
  
  // Update moving boxes
  for (const boxData of gameStore.getMovingBoxes()) {
    if (!movingBoxMeshes.has(boxData.id)) {
      // Create new box
      const boxMesh = new THREE.Mesh(
        new THREE.BoxGeometry(boxData.width, boxData.height, boxData.depth),
        new THREE.MeshStandardMaterial({ 
          color: 0xe74c3c, roughness: 0.6, metalness: 0.2,
          emissive: 0x300000, emissiveIntensity: 0.2
        })
      );
      scene.add(boxMesh);
      movingBoxMeshes.set(boxData.id, { mesh: boxMesh, data: { ...boxData } });
    }
    
    // Update position and orientation
    const box = movingBoxMeshes.get(boxData.id);
    box.data = { ...boxData };
    box.mesh.position.set(
      boxData.position.x, boxData.position.y, boxData.position.z
    );
    
    const normal = new THREE.Vector3(
      boxData.position.x, boxData.position.y, boxData.position.z
    ).normalize();
    
    box.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  }
}

function updateOtherPlayers() {
  if (!gameStore.lastServerState) return;
  
  const seenIds = new Set();
  
  for (const playerData of gameStore.lastServerState.players) {
    if (playerData.id === gameStore.myId) continue;
    seenIds.add(playerData.id);
    
    if (!playerMeshes.has(playerData.id)) {
      // Create new player
      const playerMesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.5, 1, 4, 8),
        new THREE.MeshStandardMaterial({ color: 0xff0000 })
      );
      scene.add(playerMesh);
      playerMeshes.set(playerData.id, {
        mesh: playerMesh,
        pos: { ...playerData.pos },
        rot: { ...playerData.rot },
        normal: { ...playerData.normal },
        falling: playerData.falling
      });
    }
    
    // Update player
    const player = playerMeshes.get(playerData.id);
    
    // Update position and state
    player.pos = { ...playerData.pos };
    player.normal = { ...playerData.normal };
    player.falling = playerData.falling;
    player.mesh.position.set(player.pos.x, player.pos.y, player.pos.z);
    
    // Apply orientation
    if (player.falling) {
      player.mesh.quaternion.setFromEuler(
        new THREE.Euler(playerData.rot.x, playerData.rot.y, 0, 'YXZ')
      );
    } else {
      const normalVector = new THREE.Vector3(
        player.normal.x, player.normal.y, player.normal.z
      ).normalize();
      
      const lookVector = new THREE.Vector3(
        Math.sin(playerData.rot.y) * Math.cos(playerData.rot.x),
        Math.sin(playerData.rot.x),
        Math.cos(playerData.rot.y) * Math.cos(playerData.rot.x)
      );
      
      player.mesh.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().lookAt(
          new THREE.Vector3(), lookVector, normalVector
        )
      );
    }
  }
  
  // Remove disconnected players
  for (const [id, player] of playerMeshes.entries()) {
    if (!seenIds.has(id)) {
      scene.remove(player.mesh);
      playerMeshes.delete(id);
    }
  }
}

function animate() {
  animationFrameId = requestAnimationFrame(animate);
  
  if (isPointerLocked.value && gameStore.getMyPlayerData()) {
    const playerData = gameStore.getMyPlayerData();
    const normalVector = playerData && !playerData.falling ? 
      new THREE.Vector3(playerData.normal.x, playerData.normal.y, playerData.normal.z) : 
      lastNormalVector;
    
    gameStore.sendInput(cameraRotation, {
      x: normalVector.x,
      y: normalVector.y,
      z: normalVector.z
    });
  }
  
  updateCameraOrientation();
  updateOtherPlayers();
  updateBoxes();
  
  renderer.render(scene, camera);
}
</script>

<style scoped>
.game-container {
  width: 100vw;
  height: 100vh;
  position: relative;
  background-color: #000;
}

.crosshair {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid white;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.click-prompt {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: white;
  font-size: 24px;
  cursor: pointer;
  user-select: none;
}
</style>