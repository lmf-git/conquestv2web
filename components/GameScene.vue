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

// Three.js variables
let scene, camera, renderer, animationFrameId;
let cameraRotation = { x: 0, y: 0 };

// Game objects
const playerMeshes = new Map();
let localPlayerObject, localPlayerMesh;

onMounted(() => {
  // Connect to server
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
  
  // Lighting
  scene.add(new THREE.AmbientLight(0x404040));
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(0, 1, 0);
  scene.add(directionalLight);
  
  // Create planet
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(gameStore.planetRadius, 32, 32),
    new THREE.MeshStandardMaterial({ color: 0x5555ff, roughness: 0.8, metalness: 0.2 })
  );
  scene.add(planet);
  
  // Create local player object and mesh
  localPlayerObject = new THREE.Group();
  scene.add(localPlayerObject);
  
  localPlayerMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.5, 1, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0x00ff00 })
  );
  localPlayerObject.add(localPlayerMesh);
  
  // Camera setup
  const cameraHolder = new THREE.Object3D();
  cameraHolder.position.set(0, 0.7, 0);
  localPlayerObject.add(cameraHolder);
  cameraHolder.add(camera);
  
  // Event setup
  container.value.addEventListener('click', requestPointerLock);
  setupEventListeners();
  
  // Initial position
  localPlayerObject.position.set(0, gameStore.planetRadius + 10, 0);
  
  animate();
});

onUnmounted(() => {
  cancelAnimationFrame(animationFrameId);
  
  // Remove event listeners
  document.removeEventListener('pointerlockchange', handlePointerLockChange);
  document.removeEventListener('pointerlockerror', handlePointerLockError);
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
  document.addEventListener('pointerlockerror', handlePointerLockError);
  document.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('resize', handleResize);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
}

function requestPointerLock() {
  container.value.requestPointerLock = 
    container.value.requestPointerLock || 
    container.value.mozRequestPointerLock || 
    container.value.webkitRequestPointerLock;
    
  container.value.requestPointerLock();
}

function handlePointerLockChange() {
  isPointerLocked.value = document.pointerLockElement === container.value;
}

function handlePointerLockError() {
  console.error('Pointer lock error');
}

function handleResize() {
  if (!camera || !renderer) return;
  
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
  
  // Update camera rotation with sensitivity
  cameraRotation.x -= event.movementY * 0.002;
  cameraRotation.y -= event.movementX * 0.002;
  
  // Limit vertical rotation
  cameraRotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, cameraRotation.x));
}

function updateCameraOrientation() {
  const playerData = gameStore.getMyPlayerData();
  if (!playerData || !localPlayerMesh) return;
  
  // Update position (combine vector creation and copying)
  localPlayerObject.position.set(playerData.pos.x, playerData.pos.y, playerData.pos.z);
  
  // Create and normalize normal vector in one step
  const normalVector = new THREE.Vector3(playerData.normal.x, playerData.normal.y, playerData.normal.z).normalize();
  const cameraHolder = camera.parent;
  
  if (!playerData.falling) {
    // Set quaternion directly from normal vector
    localPlayerObject.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normalVector);
    
    // Reset and apply rotations in one chain
    cameraHolder.quaternion.identity()
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), cameraRotation.y))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), cameraRotation.x));
    
    // Orient to normal but facing camera
    const cameraDirection = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraHolder.quaternion).projectOnPlane(normalVector);
    
    if (cameraDirection.length() > 0.001) {
      cameraDirection.normalize();
      localPlayerMesh.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().lookAt(
          localPlayerMesh.position,
          new THREE.Vector3().addVectors(localPlayerMesh.position, cameraDirection),
          normalVector
        )
      );
    }
  } else {
    // When falling, simplify by doing everything in one step
    const euler = new THREE.Euler(cameraRotation.x, cameraRotation.y, 0, 'YXZ');
    localPlayerObject.quaternion.identity();
    cameraHolder.quaternion.setFromEuler(euler);
    localPlayerMesh.quaternion.copy(cameraHolder.quaternion);
  }
}

function updateOtherPlayers() {
  if (!gameStore.lastServerState) return;
  
  const seenIds = new Set();
  
  for (const playerData of gameStore.lastServerState.players) {
    if (playerData.id === gameStore.myId) continue; // Skip early
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
        normal: { ...(playerData.normal || { x: 0, y: 1, z: 0 }) },
        falling: playerData.falling || false,
        targetPos: { ...playerData.pos },
        targetRot: { ...playerData.rot },
        targetNormal: { ...(playerData.normal || { x: 0, y: 1, z: 0 }) }
      });
    }
    
    // Update player data
    const player = playerMeshes.get(playerData.id);
    player.targetPos = { ...playerData.pos };
    player.targetRot = { ...playerData.rot };
    player.targetNormal = { ...(playerData.normal || { x: 0, y: 1, z: 0 }) };
    player.falling = playerData.falling;
    
    // Interpolate and position
    const t = 0.2;
    player.pos = gameStore.lerpVectors(player.pos, player.targetPos, t);
    player.normal = gameStore.lerpVectors(player.normal, player.targetNormal, t);
    player.mesh.position.set(player.pos.x, player.pos.y, player.pos.z);
    
    if (player.falling) {
      player.mesh.quaternion.setFromEuler(new THREE.Euler(playerData.rot.x, playerData.rot.y, 0, 'YXZ'));
    } else {
      // Orient to surface
      const normalVector = new THREE.Vector3(
        player.normal.x, player.normal.y, player.normal.z
      ).normalize();
      
      const lookVector = new THREE.Vector3(
        Math.sin(player.targetRot.y) * Math.cos(player.targetRot.x),
        Math.sin(player.targetRot.x),
        Math.cos(player.targetRot.y) * Math.cos(player.targetRot.x)
      );
      
      const matrix = new THREE.Matrix4().lookAt(
        new THREE.Vector3(0, 0, 0),
        lookVector,
        normalVector
      );
      
      const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
      player.mesh.quaternion.slerp(quaternion, 0.2);
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
    gameStore.sendInput(cameraRotation);
  }
  
  updateCameraOrientation();
  updateOtherPlayers();
  
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