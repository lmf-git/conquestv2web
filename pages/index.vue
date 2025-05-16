<template>
  <div class="game-wrapper">
    <div ref="container" class="game-container" @click="handleClick">
      <div class="crosshair" v-if="isPointerLocked"></div>
      <div v-if="!isPointerLocked" class="click-prompt">Click to play</div>
      <div v-if="debug" class="debug-info">{{ debugInfo }}</div>
      
      <!-- Simple HUD showing current mode - no transition bar -->
      <div v-if="isPointerLocked" class="mode-indicator">
        <div class="mode-text">{{ currentModeText }}</div>
        <div class="controls-hint">
          <template v-if="inSpaceMode">
            W/A/S/D: Thrust | Space: Up | CTRL: Down
          </template>
          <template v-else>
            W/A/S/D: Move | Space: Jump
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import * as THREE from 'three';
import { 
  PLANET_RADIUS, BOX, STATIC_BOXES, MOVING_BOXES, MODE_TRANSITION_HEIGHT,
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

// Mode tracking variables - removed transition progress
const inSpaceMode = ref(false);

// Computed properties for HUD
const currentModeText = computed(() => 
  inSpaceMode.value ? "SPACE MODE" : "GROUND MODE"
);

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

// Simplified input sender with crouch support
const sendInput = (cameraRotation, normalVector) => {
  if (ws.value?.readyState === WebSocket.OPEN) {
    ws.value.send(JSON.stringify({
      type: 'input',
      keys: { 
        ...keys.value,
        // Add crouch key for downward thrust in space mode
        crouch: keys.value.Control || keys.value.c || false
      },
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
  
  // In space mode, allow full 360° rotation
  if (inSpaceMode.value) {
    // Clamp pitch to avoid gimbal lock, but allow more freedom
    cameraRotation.x = Math.max(-Math.PI * 0.9, Math.min(Math.PI * 0.9, cameraRotation.x));
  } else {
    // For ground mode, use standard FPS limits
    cameraRotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, cameraRotation.x));
  }
  
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
  keys.value[key] = true;
  
  // Also capture Control key for downward thrust in space mode
  if (event.key === 'Control') {
    keys.value.Control = true;
  }
};

const handleKeyUp = (event) => {
  const key = event.key.toLowerCase();
  if (keys.value.hasOwnProperty(key)) {
    keys.value[key] = false;
  }
  
  // Release Control key
  if (event.key === 'Control') {
    keys.value.Control = false;
  }
};

// Enhanced camera orientation based on mode (space or ground)
function updateCameraOrientation() {
  const playerData = getMyPlayerData();
  if (!playerData) return;
  
  // Update mode state from server data - instant transition
  inSpaceMode.value = playerData.inSpaceMode || false;
  
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
  
  if (inSpaceMode.value) {
    // Space mode: orientation follows camera directly with 6DOF
    updateSpaceModeCamera(playerData);
  } else {
    // Ground mode: orientation follows surface normal
    updateGroundModeCamera(playerData);
  }
}

// Update camera for space mode - 6DOF movement
function updateSpaceModeCamera(playerData) {
  // In space, the player's orientation is based purely on the camera
  // with no gravity constraints
  const orientation = playerData.spaceOrientation || {
    forward: {
      x: Math.sin(cameraRotation.y) * Math.cos(cameraRotation.x),
      y: Math.sin(cameraRotation.x),
      z: Math.cos(cameraRotation.y) * Math.cos(cameraRotation.x)
    },
    up: { x: 0, y: 1, z: 0 }
  };
  
  // Create forward and up vectors
  const forward = new THREE.Vector3(
    orientation.forward.x,
    orientation.forward.y,
    orientation.forward.z
  ).normalize();
  
  const up = new THREE.Vector3(
    orientation.up.x,
    orientation.up.y,
    orientation.up.z
  ).normalize();
  
  // Create a basis matrix for orientation
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();
  const correctedUp = new THREE.Vector3().crossVectors(right, forward).normalize();
  
  // Apply to player model
  const rotMatrix = new THREE.Matrix4().makeBasis(
    right,
    correctedUp,
    forward.clone().negate()
  );
  
  // Apply rotation to player object
  localPlayerObject.quaternion.setFromRotationMatrix(rotMatrix);
  
  // Camera pitch is handled directly
  const cameraHolder = camera.parent;
  
  // In space mode, camera follows player orientation exactly
  cameraHolder.quaternion.identity();
}

// Update camera for ground mode - surface-following
function updateGroundModeCamera(playerData) {
  // Determine up vector - use contact normal if available, otherwise use position normal
  const upVector = new THREE.Vector3(
    playerData.contactNormal?.x || playerData.normal.x,
    playerData.contactNormal?.y || playerData.normal.y, 
    playerData.contactNormal?.z || playerData.normal.z
  ).normalize();
  
  // Cache for interpolation
  lastNormalVector.lerp(upVector, 0.2);
  
  // Align player object with the surface normal
  alignWithSurface(localPlayerObject, upVector, cameraRotation);
  
  // Get camera holder for pitch rotation
  const cameraHolder = camera.parent;
  
  // Apply pitch rotation (x-axis)
  cameraHolder.quaternion.setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    cameraRotation.x
  );
}

// Helper function to align object with surface normal
function alignWithSurface(object, upVector, rotation) {
  // Calculate forward direction from camera rotation (yaw only)
  const forwardDir = new THREE.Vector3(
    Math.sin(rotation.y),
    0,
    Math.cos(rotation.y)
  ).normalize();
  
  // Calculate right vector (cross product of world up and forward)
  const worldUp = new THREE.Vector3(0, 1, 0);
  const rightVector = new THREE.Vector3().crossVectors(forwardDir, worldUp).normalize();
  
  // Recalculate real forward vector (cross product of up and right)
  const realForward = new THREE.Vector3().crossVectors(rightVector, upVector).normalize();
  
  // Create rotation matrix
  const rotMatrix = new THREE.Matrix4().makeBasis(
    rightVector,
    upVector,
    realForward.negate()
  );
  
  // Apply rotation to object
  object.quaternion.setFromRotationMatrix(rotMatrix);
}

// Update other players with mode-specific orientation
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
        falling: playerData.falling,
        inSpaceMode: playerData.inSpaceMode || false
      });
    }
    
    // Update player with concise property assignments
    const player = playerMeshes.get(playerData.id);
    Object.assign(player, {
      pos: { ...playerData.pos }, 
      normal: { ...playerData.normal },
      falling: playerData.falling,
      inSpaceMode: playerData.inSpaceMode || false
    });
    player.mesh.position.set(player.pos.x, player.pos.y, player.pos.z);
    
    // Apply orientation based on mode
    if (player.inSpaceMode) {
      // Space mode orientation
      const spaceUp = new THREE.Vector3(0, 1, 0);
      const spaceForward = new THREE.Vector3(
        Math.sin(playerData.rot.y) * Math.cos(playerData.rot.x),
        Math.sin(playerData.rot.x),
        Math.cos(playerData.rot.y) * Math.cos(playerData.rot.x)
      ).normalize();
      
      const spaceRight = new THREE.Vector3().crossVectors(spaceForward, spaceUp).normalize();
      const correctedUp = new THREE.Vector3().crossVectors(spaceRight, spaceForward).normalize();
      
      const rotMatrix = new THREE.Matrix4().makeBasis(
        spaceRight,
        correctedUp,
        spaceForward.clone().negate()
      );
      
      player.mesh.quaternion.setFromRotationMatrix(rotMatrix);
    } else {
      // Ground mode orientation
      const upVector = new THREE.Vector3(
        playerData.contactNormal?.x || playerData.normal.x,
        playerData.contactNormal?.y || playerData.normal.y, 
        playerData.contactNormal?.z || playerData.normal.z
      ).normalize();
      
      // Use helper function to align with surface
      alignWithSurface(player.mesh, upVector, playerData.rot);
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

// Box update function
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

// Updated animate function with better physics debugging
function animate() {
  animationFrameId = requestAnimationFrame(animate);
  
  const playerData = getMyPlayerData();
  if (debug.value && playerData) {
    // Enhanced debugging with more physics details and mode info
    const vel = playerData.vel || { x: 0, y: 0, z: 0 };
    const speed = Math.sqrt(vel.x**2 + vel.y**2 + vel.z**2);
    const height = Math.sqrt(
      playerData.pos.x**2 + playerData.pos.y**2 + playerData.pos.z**2
    );
    const heightAboveSurface = height - PLANET_RADIUS;
    
    debugInfo.value = `Player: ${JSON.stringify({
      pos: [playerData.pos.x.toFixed(1), playerData.pos.y.toFixed(1), playerData.pos.z.toFixed(1)],
      vel: [vel.x.toFixed(2), vel.y.toFixed(2), vel.z.toFixed(2)],
      speed: speed.toFixed(2),
      height: height.toFixed(1),
      altitude: heightAboveSurface.toFixed(1),
      mode: playerData.inSpaceMode ? "SPACE" : "GROUND",
      normal: [
        playerData.normal.x.toFixed(2),
        playerData.normal.y.toFixed(2),
        playerData.normal.z.toFixed(2)
      ]
    })}`;
  }
  
  if (isPointerLocked.value && playerData) {
    // Send input including camera rotation and crouch (for down thrust)
    const normalVector = new THREE.Vector3(
      playerData.normal.x,
      playerData.normal.y,
      playerData.normal.z
    ).normalize();
    
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

.mode-indicator {
  position: absolute;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  background-color: rgba(0, 0, 0, 0.5);
  color: white;
  padding: 10px 20px;
  border-radius: 5px;
  text-align: center;
  font-family: Arial, sans-serif;
  user-select: none;
  pointer-events: none;
}

.mode-text {
  font-size: 18px;
  font-weight: bold;
  margin-bottom: 5px;
}

.controls-hint {
  font-size: 12px;
  opacity: 0.8;
  margin-top: 5px;
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