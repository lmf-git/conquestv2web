<template>
  <div class="game-wrapper">
    <div ref="container" class="game-container">
      <div class="crosshair"></div>
      <div v-if="!isPointerLocked" class="click-prompt">Click to play</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import * as THREE from 'three';
import { 
  PLANET_RADIUS, BOX, STATIC_BOXES, MOVING_BOXES,
  calculateSurfacePosition, calculateNormal, crossProduct, lerpVectors
} from 'conquest-shared';

// Game state (formerly in store)
const players = ref(new Map());
const myId = ref(null);
const planetRadius = ref(PLANET_RADIUS);
const ws = ref(null);
const lastServerState = ref(null);
const previousServerState = ref(null);
const keys = ref({ w: false, a: false, s: false, d: false, ' ': false });
const isConnected = ref(false);
const isInitialized = ref(false);
const isPointerLocked = ref(false);
const container = ref(null);

// Three.js variables
let scene, camera, renderer, animationFrameId;
let cameraRotation = { x: 0, y: 0 };
const playerMeshes = new Map();
const staticBoxMeshes = new Map();
const movingBoxMeshes = new Map();
let localPlayerObject, localPlayerMesh;
let lastNormalVector = new THREE.Vector3(0, 1, 0);

// Server connection functions
function connectToServer() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = process.env.NODE_ENV === 'development' ? 'localhost:3001' : window.location.host;
  
  ws.value = new WebSocket(`${protocol}//${host}`);
  
  ws.value.onopen = () => {
    console.log('Connected to server');
    isConnected.value = true;
  };
  
  ws.value.onmessage = (event) => {
    const message = JSON.parse(event.data);
    
    if (message.type === 'init') {
      myId.value = message.data.id;
      planetRadius.value = message.data.planetRadius;
    } 
    else if (message.type === 'state') {
      previousServerState.value = lastServerState.value;
      lastServerState.value = message.data;
    }
  };
  
  ws.value.onclose = () => {
    isConnected.value = false;
    setTimeout(() => connectToServer(), 3000);
  };
}

function sendInput(cameraRotation, normalVector) { 
  if (!ws.value || ws.value.readyState !== WebSocket.OPEN) return;
  
  ws.value.send(JSON.stringify({
    type: 'input',
    keys: { ...keys.value },
    rotation: { ...cameraRotation },
    normal: normalVector
  }));
}

function getMyPlayerData() {
  return lastServerState.value?.players.find(p => p.id === myId.value) || null;
}

function getStaticBoxes() {
  return lastServerState.value?.staticBoxes || [];
}

function getMovingBoxes() {
  return lastServerState.value?.movingBoxes || [];
}

// Event handlers
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
  if (keys.value.hasOwnProperty(e.key.toLowerCase())) {
    keys.value[e.key.toLowerCase()] = true;
  }
}

function handleKeyUp(e) {
  if (keys.value.hasOwnProperty(e.key.toLowerCase())) {
    keys.value[e.key.toLowerCase()] = false;
  }
}

function handleMouseMove(event) {
  if (!isPointerLocked.value) return;
  
  cameraRotation.x -= event.movementY * 0.002;
  cameraRotation.y -= event.movementX * 0.002;
  cameraRotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, cameraRotation.x));
}

// Three.js rendering and updates
function updateCameraOrientation() {
  const playerData = getMyPlayerData();
  if (!playerData) return;
  
  // Set position
  localPlayerObject.position.copy(new THREE.Vector3(
    playerData.pos.x, playerData.pos.y, playerData.pos.z
  ));
  
  // Get current orientation data - prioritize contact normal when available
  const currentNormal = new THREE.Vector3(
    playerData.contactNormal?.x || playerData.normal.x,
    playerData.contactNormal?.y || playerData.normal.y, 
    playerData.contactNormal?.z || playerData.normal.z
  ).normalize();
  
  lastNormalVector.copy(currentNormal);
  
  const cameraHolder = camera.parent;
  
  // Apply orientations based on player state
  if (!playerData.falling) {
    // On ground - first align player with the surface
    // This base quaternion aligns the player's "up" with the surface normal
    const baseQuat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), currentNormal
    );
    
    // Apply the rotation to align feet with surface
    localPlayerObject.quaternion.copy(baseQuat);
    
    // Now we need to rotate the entire player + camera system around the normal
    // Create a rotation around the normal axis for the yaw component
    const normalYawQuat = new THREE.Quaternion().setFromAxisAngle(
      currentNormal, cameraRotation.y
    );
    
    // Apply this yaw rotation to the player object (this rotates everything)
    localPlayerObject.quaternion.premultiply(normalYawQuat);
    
    // Reset camera holder orientation since we've rotated the base object
    cameraHolder.quaternion.identity();
    
    // Now handle pitch, which should only affect the camera, not the player's body
    // To do this, we need a right vector in the rotated space
    const rightVector = new THREE.Vector3(1, 0, 0)
      .applyQuaternion(baseQuat)      // First align with surface
      .applyQuaternion(normalYawQuat) // Then apply the yaw rotation
      .normalize();
    
    // Apply pitch around the right vector - this only affects the camera
    const pitchQuat = new THREE.Quaternion().setFromAxisAngle(
      rightVector, cameraRotation.x
    );
    cameraHolder.quaternion.copy(pitchQuat);
    
    // The player's mesh should already be correctly oriented by the localPlayerObject
    // rotation, so we don't need separate rotation for the mesh
    localPlayerMesh.quaternion.identity();
  } else {
    // In air - use world up for orientation
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
  if (!lastServerState.value) return;
  
  // Update static boxes
  for (const boxData of getStaticBoxes()) {
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
  for (const boxData of getMovingBoxes()) {
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
  if (!lastServerState.value) return;
  
  const seenIds = new Set();
  
  for (const playerData of lastServerState.value.players) {
    if (playerData.id === myId.value) continue;
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
  
  if (isPointerLocked.value && getMyPlayerData()) {
    const playerData = getMyPlayerData();
    const normalVector = playerData && !playerData.falling ? 
      // Use contact normal when available
      new THREE.Vector3(
        playerData.contactNormal?.x || playerData.normal.x,
        playerData.contactNormal?.y || playerData.normal.y, 
        playerData.contactNormal?.z || playerData.normal.z
      ) : 
      lastNormalVector;
    
    sendInput(cameraRotation, {
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

// Lifecycle hooks
onMounted(() => {
  connectToServer();
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
    new THREE.SphereGeometry(planetRadius.value, 32, 32),
    new THREE.MeshStandardMaterial({ color: 0x5555ff, roughness: 0.8, metalness: 0.2 })
  ));
  
  // Create main platform using shared BOX definition
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(BOX.width, BOX.height, BOX.depth),
    new THREE.MeshStandardMaterial({ 
      color: 0xFF8C00, roughness: 0.7, metalness: 0.2,
      emissive: 0x331400, emissiveIntensity: 0.2
    })
  );
  box.position.set(BOX.position.x, BOX.position.y, BOX.position.z);
  box.rotation.set(BOX.rotation.x, BOX.rotation.y, BOX.rotation.z);
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
  localPlayerObject.position.set(0, planetRadius.value + 50, 0);
  
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
  ws.value?.close();
  renderer?.dispose();
});
</script>

<style>
html, body {
  margin: 0;
  padding: 0;
  overflow: hidden;
}

.game-wrapper {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

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