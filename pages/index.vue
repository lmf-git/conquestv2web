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

// Game state with concise definitions
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

// Three.js variables with simplified initialization
let scene, camera, renderer, animationFrameId;
let cameraRotation = { x: 0, y: 0 };
const playerMeshes = new Map();
const staticBoxMeshes = new Map();
const movingBoxMeshes = new Map();
let localPlayerObject, localPlayerMesh;
let lastNormalVector = new THREE.Vector3(0, 1, 0);

// Server connection with arrow functions
const connectToServer = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = process.env.NODE_ENV === 'development' ? 'localhost:3001' : window.location.host;
  
  ws.value = new WebSocket(`${protocol}//${host}`);
  
  ws.value.onopen = () => {
    console.log('Connected to server');
    isConnected.value = true;
  };
  
  ws.value.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    
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
    setTimeout(connectToServer, 3000);
  };
};

// Simplified input sender
const sendInput = (cameraRotation, normalVector) => 
  ws.value?.readyState === WebSocket.OPEN && 
    ws.value.send(JSON.stringify({
      type: 'input',
      keys: { ...keys.value },
      rotation: { ...cameraRotation },
      normal: normalVector
    }));

// Getter functions using optional chaining and arrow syntax
const getMyPlayerData = () => lastServerState.value?.players.find(p => p.id === myId.value) || null;
const getStaticBoxes = () => lastServerState.value?.staticBoxes || [];
const getMovingBoxes = () => lastServerState.value?.movingBoxes || [];

// Event handlers with concise syntax
const setupEventListeners = () => {
  document.addEventListener('pointerlockchange', handlePointerLockChange);
  document.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('resize', handleResize);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
};

const requestPointerLock = () => 
  (container.value.requestPointerLock = container.value.requestPointerLock || 
    container.value.mozRequestPointerLock) && container.value.requestPointerLock();

const handlePointerLockChange = () => 
  isPointerLocked.value = document.pointerLockElement === container.value;

const handleResize = () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
};

const handleKeyDown = e => keys.value.hasOwnProperty(e.key.toLowerCase()) && (keys.value[e.key.toLowerCase()] = true);
const handleKeyUp = e => keys.value.hasOwnProperty(e.key.toLowerCase()) && (keys.value[e.key.toLowerCase()] = false);

const handleMouseMove = ({ movementX, movementY }) => {
  if (!isPointerLocked.value) return;
  
  cameraRotation.x -= movementY * 0.002;
  cameraRotation.y -= movementX * 0.002;
  cameraRotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, cameraRotation.x));
};

// Updated Three.js rendering functions
function updateCameraOrientation() {
  const playerData = getMyPlayerData();
  if (!playerData) return;
  
  // Set position
  localPlayerObject.position.set(playerData.pos.x, playerData.pos.y, playerData.pos.z);
  
  // Get current normal once
  const currentNormal = new THREE.Vector3(
    playerData.contactNormal?.x || playerData.normal.x,
    playerData.contactNormal?.y || playerData.normal.y, 
    playerData.contactNormal?.z || playerData.normal.z
  ).normalize();
  
  lastNormalVector.copy(currentNormal);
  const cameraHolder = camera.parent;
  
  if (!playerData.falling) {
    // Combined orientation logic for grounded player
    const baseQuat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), currentNormal
    );
    
    localPlayerObject.quaternion.copy(baseQuat);
    
    localPlayerObject.quaternion.premultiply(
      new THREE.Quaternion().setFromAxisAngle(currentNormal, cameraRotation.y)
    );
    
    cameraHolder.quaternion.identity();
    
    // Calculate and apply pitch
    cameraHolder.quaternion.setFromAxisAngle(
      new THREE.Vector3(1, 0, 0)
        .applyQuaternion(baseQuat)
        .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(currentNormal, cameraRotation.y))
        .normalize(), 
      cameraRotation.x
    );
    
    localPlayerMesh.quaternion.identity();
  } else {
    // Simplified in-air orientation
    localPlayerObject.quaternion.identity()
      .multiply(new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), cameraRotation.y
      ));
    
    cameraHolder.quaternion.setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), cameraRotation.x
    );
    
    localPlayerMesh.quaternion.identity();
  }
}

// Simplified box update with more concise code
function updateBoxes() {
  if (!lastServerState.value) return;
  
  // Generic box updater
  const updateBox = (boxData, meshMap, color, emissive = null) => {
    if (!meshMap.has(boxData.id)) {
      const material = new THREE.MeshStandardMaterial({ 
        color, roughness: 0.6, metalness: 0.2
      });
      
      if (emissive) {
        material.emissive = emissive;
        material.emissiveIntensity = 0.2;
      }
      
      const boxMesh = new THREE.Mesh(
        new THREE.BoxGeometry(boxData.width, boxData.height, boxData.depth),
        material
      );
      scene.add(boxMesh);
      meshMap.set(boxData.id, { mesh: boxMesh, data: { ...boxData } });
    }
    
    const box = meshMap.get(boxData.id);
    box.data = { ...boxData };
    box.mesh.position.set(boxData.position.x, boxData.position.y, boxData.position.z);
    
    box.mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), 
      new THREE.Vector3(boxData.position.x, boxData.position.y, boxData.position.z).normalize()
    );
  };
  
  // Apply to box collections
  getStaticBoxes().forEach(box => updateBox(box, staticBoxMeshes, 0x2ecc71));
  getMovingBoxes().forEach(box => updateBox(box, movingBoxMeshes, 0xe74c3c, 0x300000));
}

// Optimize other player updates
function updateOtherPlayers() {
  if (!lastServerState.value) return;
  
  const seenIds = new Set();
  
  for (const playerData of lastServerState.value.players) {
    if (playerData.id === myId.value) continue;
    seenIds.add(playerData.id);
    
    if (!playerMeshes.has(playerData.id)) {
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
    
    // Update player with concise property assignments
    const player = playerMeshes.get(playerData.id);
    Object.assign(player, {
      pos: { ...playerData.pos }, 
      normal: { ...playerData.normal },
      falling: playerData.falling
    });
    player.mesh.position.set(player.pos.x, player.pos.y, player.pos.z);
    
    // Apply orientation based on state
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
        new THREE.Matrix4().lookAt(new THREE.Vector3(), lookVector, normalVector)
      );
    }
  }
  
  // Clean up disconnected players
  for (const [id, player] of playerMeshes.entries()) {
    if (!seenIds.has(id)) {
      scene.remove(player.mesh);
      playerMeshes.delete(id);
    }
  }
}

// Optimized animation loop
function animate() {
  animationFrameId = requestAnimationFrame(animate);
  
  if (isPointerLocked.value && getMyPlayerData()) {
    const playerData = getMyPlayerData();
    const normalVector = playerData && !playerData.falling 
      ? new THREE.Vector3(
          playerData.contactNormal?.x || playerData.normal.x,
          playerData.contactNormal?.y || playerData.normal.y, 
          playerData.contactNormal?.z || playerData.normal.z
        ) 
      : lastNormalVector;
    
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

// Lifecycle hooks with cleanup
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
  
  // Add scene elements with chaining
  scene.add(new THREE.AmbientLight(0x404040))
       .add(new THREE.DirectionalLight(0xffffff, 1).translateY(1))
       .add(new THREE.Mesh(
         new THREE.SphereGeometry(planetRadius.value, 32, 32),
         new THREE.MeshStandardMaterial({ color: 0x5555ff, roughness: 0.8, metalness: 0.2 })
       ));
  
  // Create main platform
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
  
  // Player and camera setup with cleaner structure
  localPlayerObject = new THREE.Group();
  localPlayerMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.5, 1, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0x00ff00 })
  );
  
  const cameraHolder = new THREE.Object3D();
  cameraHolder.position.y = 0.7;
  cameraHolder.add(camera);
  
  localPlayerObject.add(localPlayerMesh).add(cameraHolder);
  localPlayerObject.position.set(0, planetRadius.value + 50, 0);
  scene.add(localPlayerObject);
  
  // Events and animation
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