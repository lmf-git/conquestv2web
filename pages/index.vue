<template>
  <div class="game-wrapper">
    <div ref="container" class="game-container" @click="handleClick">
      <div class="crosshair" v-if="isPointerLocked"></div>
      <div v-if="!isPointerLocked" class="click-prompt">Click to play</div>
      <div v-if="debug" class="debug-info">{{ debugInfo }}</div>
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
const debug = ref(process.env.NODE_ENV === 'development');
const debugInfo = ref('');

// Three.js variables with simplified initialization
let scene, camera, renderer, animationFrameId;
let cameraRotation = { x: 0, y: 0 };
const playerMeshes = new Map();
const staticBoxMeshes = new Map();
const movingBoxMeshes = new Map();
let localPlayerObject, localPlayerMesh;
let lastNormalVector = new THREE.Vector3(0, 1, 0);

// Simple click handler that directly locks pointer
const handleClick = () => {
  if (!isPointerLocked.value && container.value) {
    // Simple direct call to request pointer lock
    container.value.requestPointerLock();
    debugInfo.value = "Requested pointer lock";
  }
};

// Server connection with arrow functions
const connectToServer = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = process.env.NODE_ENV === 'development' ? 'localhost:3001' : window.location.host;
  
  ws.value = new WebSocket(`${protocol}//${host}`);
  
  ws.value.onopen = () => {
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
const sendInput = (cameraRotation, normalVector) => {
  if (ws.value?.readyState === WebSocket.OPEN) {
    ws.value.send(JSON.stringify({
      type: 'input',
      keys: { ...keys.value },
      rotation: { ...cameraRotation },
      normal: normalVector
    }));
  }
}; 

// Getter functions using optional chaining and arrow syntax
const getMyPlayerData = () => lastServerState.value?.players.find(p => p.id === myId.value) || null;
const getStaticBoxes = () => lastServerState.value?.staticBoxes || [];
const getMovingBoxes = () => lastServerState.value?.movingBoxes || [];

// Event handlers with concise syntax
const setupEventListeners = () => {
  // Simplified to just what we need
  document.addEventListener('pointerlockchange', handlePointerLockChange);
  document.addEventListener('mozpointerlockchange', handlePointerLockChange);
  document.addEventListener('webkitpointerlockchange', handlePointerLockChange);
  document.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('resize', handleResize);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
};

// Simplified pointer lock change handler
const handlePointerLockChange = () => {
  const lockElement = document.pointerLockElement || 
                      document.mozPointerLockElement || 
                      document.webkitPointerLockElement;
                      
  isPointerLocked.value = lockElement === container.value;
  debugInfo.value = isPointerLocked.value ? "Pointer locked" : "Pointer unlocked";
};

// Mouse movement handler
const handleMouseMove = (event) => {
  if (!isPointerLocked.value) return;
  
  // Apply mouse movement to camera rotation
  const { movementX, movementY } = event;
  cameraRotation.x -= movementY * 0.002; // Look up/down
  cameraRotation.y -= movementX * 0.002; // Look left/right
  
  // Clamp vertical rotation to prevent flipping
  cameraRotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, cameraRotation.x));
  
  if (debug.value) {
    debugInfo.value = `Camera rotation: ${cameraRotation.x.toFixed(2)}, ${cameraRotation.y.toFixed(2)}`;
  }
};

// Window resize handler
const handleResize = () => {
  if (!camera || !renderer) return;
  
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
};

// Keyboard event handlers
const handleKeyDown = (event) => {
  const key = event.key.toLowerCase();
  if (keys.value.hasOwnProperty(key)) {
    keys.value[key] = true;
  }
};

const handleKeyUp = (event) => {
  const key = event.key.toLowerCase();
  if (keys.value.hasOwnProperty(key)) {
    keys.value[key] = false;
  }
};

// Camera orientation function - was missing
function updateCameraOrientation() {
  const playerData = getMyPlayerData();
  if (!playerData) return;
  
  // Smooth position updates from physics
  const lerpFactor = 0.3; // Adjust for balance between smoothness and responsiveness
  
  // Get current position from mesh
  const currentPosition = localPlayerObject.position;
  
  // Calculate lerped position for smoother movement
  const targetPosition = new THREE.Vector3(
    playerData.pos.x, 
    playerData.pos.y, 
    playerData.pos.z
  );
  
  // Apply smoothing only when not too far (prevents slow catch-up after teleports)
  const distance = currentPosition.distanceTo(targetPosition);
  const actualLerpFactor = distance > 5 ? 1.0 : lerpFactor;
  
  currentPosition.lerp(targetPosition, actualLerpFactor);
  
  // Get current normal
  const currentNormal = new THREE.Vector3(
    playerData.contactNormal?.x || playerData.normal.x,
    playerData.contactNormal?.y || playerData.normal.y, 
    playerData.contactNormal?.z || playerData.normal.z
  ).normalize();
  
  lastNormalVector.copy(currentNormal);
  const cameraHolder = camera.parent;
  
  // Apply orientation based on player state
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

// Box update function - was missing
function updateBoxes() {
  if (!lastServerState.value) return;
  
  // Generic box updater with physics-based orientation
  const updateBox = (boxData, meshMap, color, emissive = null) => {
    if (!meshMap.has(boxData.id)) {
      const material = new THREE.MeshStandardMaterial({ 
        color, roughness: 0.6, metalness: 0.2
      });
      
      if (emissive) {
        material.emissive = new THREE.Color(emissive);
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
    const previousPos = box.data.position || boxData.position;
    box.data = { ...boxData };
    
    // Simple interpolation for smoother movement
    const lerpFactor = 0.3; // Adjust for smoother or more responsive movement
    const lerpedPosition = {
      x: previousPos.x + (boxData.position.x - previousPos.x) * lerpFactor,
      y: previousPos.y + (boxData.position.y - previousPos.y) * lerpFactor,
      z: previousPos.z + (boxData.position.z - previousPos.z) * lerpFactor
    };
    
    box.mesh.position.set(lerpedPosition.x, lerpedPosition.y, lerpedPosition.z);
    
    // Apply orientation based on surface normal for boxes on planet
    const normal = calculateNormal(boxData.position);
    
    // Create proper orientation matrix
    const up = new THREE.Vector3(0, 1, 0);
    const boxNormal = new THREE.Vector3(normal.x, normal.y, normal.z);
    
    // Use lookAt for simple alignment to normal
    const alignMatrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const targetPos = new THREE.Vector3().addVectors(
      pos, 
      new THREE.Vector3(normal.x, normal.y, normal.z)
    );
    alignMatrix.lookAt(pos, targetPos, up);
    
    // Apply any custom rotation if provided (for the main rotating box)
    if (boxData.rotation) {
      box.mesh.rotation.set(boxData.rotation.x, boxData.rotation.y, boxData.rotation.z);
    } else {
      box.mesh.quaternion.setFromRotationMatrix(alignMatrix);
    }
  };
  
  // Apply to box collections
  getStaticBoxes().forEach(box => updateBox(box, staticBoxMeshes, 0x2ecc71));
  getMovingBoxes().forEach(box => updateBox(box, movingBoxMeshes, 0xe74c3c, 0x300000));
}

// Update other players - was missing
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

// Updated animate function with better physics debugging and null checks
function animate() {
  animationFrameId = requestAnimationFrame(animate);
  
  const playerData = getMyPlayerData();
  if (debug.value && playerData) {
    // Enhanced debugging information with null checks for velocity
    const vel = playerData.vel || { x: 0, y: 0, z: 0 };
    
    debugInfo.value = `Player: ${JSON.stringify({
      pos: [playerData.pos.x.toFixed(1), playerData.pos.y.toFixed(1), playerData.pos.z.toFixed(1)],
      vel: [vel.x.toFixed(2), vel.y.toFixed(2), vel.z.toFixed(2)],
      falling: playerData.falling,
      height: Math.sqrt(
        playerData.pos.x**2 + playerData.pos.y**2 + playerData.pos.z**2
      ).toFixed(1),
      ground: !playerData.falling ? "grounded" : "falling"
    })}`;
  }
  
  if (isPointerLocked.value && playerData) {
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
  
  // Add scene elements
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
  
  // Register event listeners - directly call setupEventListeners
  setupEventListeners();
  animate();
  
  // Check pointer lock API support
  if (!('pointerLockElement' in document) && 
      !('mozPointerLockElement' in document) && 
      !('webkitPointerLockElement' in document)) {
    debugInfo.value = "Pointer lock API not supported";
  }
});

onUnmounted(() => {
  cancelAnimationFrame(animationFrameId);
  document.removeEventListener('pointerlockchange', handlePointerLockChange);
  document.removeEventListener('mozpointerlockchange', handlePointerLockChange);
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

.debug-info {
  position: absolute;
  top: 10px;
  left: 10px;
  color: white;
  background: rgba(0, 0, 0, 0.5);
  padding: 10px;
  font-family: monospace;
  font-size: 12px;
  pointer-events: none;
  max-width: 500px;
  white-space: pre-wrap;
  z-index: 100;
}
</style>