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
const staticBoxMeshes = new Map();
const movingBoxMeshes = new Map();
let localPlayerObject, localPlayerMesh;

// Add these new variables near the top of the script, with other state variables
let lastNormalVector = new THREE.Vector3(0, 1, 0);  // Default up

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
  
  // Create a static box platform - make it larger and positioned higher
  const boxSize = { width: 30, height: 3, depth: 30 }; // Larger box
  const boxPosition = { x: 0, y: gameStore.planetRadius + 30, z: 0 }; // Higher position
  const boxGeometry = new THREE.BoxGeometry(boxSize.width, boxSize.height, boxSize.depth);
  const boxMaterial = new THREE.MeshStandardMaterial({ 
    color: 0xFF8C00, // Brighter orange color for visibility
    roughness: 0.7, 
    metalness: 0.2,
    emissive: 0x331400, // Add slight glow
    emissiveIntensity: 0.2
  });
  const box = new THREE.Mesh(boxGeometry, boxMaterial);
  box.position.set(boxPosition.x, boxPosition.y, boxPosition.z);
  scene.add(box);
  
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
  
  // Initial position - updated to match server's higher spawn point
  localPlayerObject.position.set(0, gameStore.planetRadius + 50, 0);
  
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
  
  // Set exact position values - no interpolation
  localPlayerObject.position.set(
    playerData.pos.x,
    playerData.pos.y,
    playerData.pos.z
  );
  
  // Create a normalized normal vector
  const normalVector = new THREE.Vector3(
    playerData.normal.x,
    playerData.normal.y,
    playerData.normal.z
  ).normalize();
  
  // Directly update the lastNormalVector for reference
  if (!playerData.falling) {
    lastNormalVector.copy(normalVector);
  }
  
  const cameraHolder = camera.parent;
  
  // Non-falling state (on ground or object)
  if (!playerData.falling) {
    // Create a smooth orientation that faces the normal direction
    if (playerData.onBox) {
      // For boxes, use a fixed up orientation
      localPlayerObject.quaternion.identity();
    } else {
      // For the planet surface, orient to face outward
      localPlayerObject.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        normalVector
      );
    }
    
    // Set camera rotation around the local axes of the player object
    // This prevents camera "flipping" when moving across curved surfaces
    cameraHolder.quaternion.identity();
    
    // Apply pitch first, then yaw - preserve the proper rotation order
    const pitchQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      cameraRotation.x
    );
    
    const yawQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      cameraRotation.y
    );
    
    // Combine the rotations in the correct order
    cameraHolder.quaternion.multiplyQuaternions(yawQuat, pitchQuat);
    
    // Only apply yaw to the player mesh (for visual direction)
    localPlayerMesh.quaternion.copy(yawQuat);
  } else {
    // When falling, maintain a stable orientation based on camera direction
    const fallingEuler = new THREE.Euler(0, cameraRotation.y, 0, 'YXZ');
    localPlayerObject.quaternion.setFromEuler(fallingEuler);
    
    // Apply pitch rotation only to the camera
    cameraHolder.quaternion.setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      cameraRotation.x
    );
    
    // Make player mesh face forward
    localPlayerMesh.quaternion.identity();
  }
}

function updateBoxes() {
  if (!gameStore.lastServerState) return;
  
  // Update static boxes
  if (gameStore.lastServerState.staticBoxes) {
    const boxes = gameStore.lastServerState.staticBoxes;
    
    // Create or update static boxes
    for (const boxData of boxes) {
      if (!staticBoxMeshes.has(boxData.id)) {
        // Create new box mesh
        const boxGeometry = new THREE.BoxGeometry(boxData.width, boxData.height, boxData.depth);
        const boxMaterial = new THREE.MeshStandardMaterial({ 
          color: 0x2ecc71, // Green color for static boxes
          roughness: 0.6,
          metalness: 0.2
        });
        
        const boxMesh = new THREE.Mesh(boxGeometry, boxMaterial);
        scene.add(boxMesh);
        
        staticBoxMeshes.set(boxData.id, {
          mesh: boxMesh,
          data: { ...boxData }
        });
      }
      
      // Update box position and rotation
      const box = staticBoxMeshes.get(boxData.id);
      box.data = { ...boxData };
      
      // Update mesh position
      box.mesh.position.set(
        boxData.position.x,
        boxData.position.y,
        boxData.position.z
      );
      
      // Calculate normal at this position on the planet
      const normal = new THREE.Vector3(
        boxData.position.x,
        boxData.position.y,
        boxData.position.z
      ).normalize();
      
      // Orient box to face away from planet center
      const upVector = new THREE.Vector3(0, 1, 0);
      box.mesh.quaternion.setFromUnitVectors(upVector, normal);
    }
  }
  
  // Update moving boxes
  if (gameStore.lastServerState.movingBoxes) {
    const boxes = gameStore.lastServerState.movingBoxes;
    
    // Create or update moving boxes
    for (const boxData of boxes) {
      if (!movingBoxMeshes.has(boxData.id)) {
        // Create new box mesh
        const boxGeometry = new THREE.BoxGeometry(boxData.width, boxData.height, boxData.depth);
        const boxMaterial = new THREE.MeshStandardMaterial({ 
          color: 0xe74c3c, // Red color for moving boxes
          roughness: 0.6,
          metalness: 0.2,
          emissive: 0x300000, // Slight red glow
          emissiveIntensity: 0.2
        });
        
        const boxMesh = new THREE.Mesh(boxGeometry, boxMaterial);
        scene.add(boxMesh);
        
        movingBoxMeshes.set(boxData.id, {
          mesh: boxMesh,
          data: { ...boxData }
        });
      }
      
      // Update box position and rotation
      const box = movingBoxMeshes.get(boxData.id);
      box.data = { ...boxData };
      
      // Update mesh position
      box.mesh.position.set(
        boxData.position.x,
        boxData.position.y,
        boxData.position.z
      );
      
      // Calculate normal at this position on the planet
      const normal = new THREE.Vector3(
        boxData.position.x,
        boxData.position.y,
        boxData.position.z
      ).normalize();
      
      // Orient box to face away from planet center
      const upVector = new THREE.Vector3(0, 1, 0);
      box.mesh.quaternion.setFromUnitVectors(upVector, normal);
    }
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
    
    // Use direct setting for position instead of interpolation
    player.pos.x = playerData.pos.x;
    player.pos.y = playerData.pos.y;
    player.pos.z = playerData.pos.z;
    player.normal.x = playerData.normal.x;
    player.normal.y = playerData.normal.y;
    player.normal.z = playerData.normal.z;
    player.falling = playerData.falling;
    
    // Update mesh position - no interpolation
    player.mesh.position.set(player.pos.x, player.pos.y, player.pos.z);
    
    if (player.falling) {
      player.mesh.quaternion.setFromEuler(new THREE.Euler(playerData.rot.x, playerData.rot.y, 0, 'YXZ'));
    } else {
      // Orient to surface - direct setting, no slerp
      const normalVector = new THREE.Vector3(
        player.normal.x, player.normal.y, player.normal.z
      ).normalize();
      
      const lookVector = new THREE.Vector3(
        Math.sin(playerData.rot.y) * Math.cos(playerData.rot.x),
        Math.sin(playerData.rot.x),
        Math.cos(playerData.rot.y) * Math.cos(playerData.rot.x)
      );
      
      const matrix = new THREE.Matrix4().lookAt(
        new THREE.Vector3(0, 0, 0),
        lookVector,
        normalVector
      );
      
      player.mesh.quaternion.setFromRotationMatrix(matrix);
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
    // Send input with camera rotation AND current surface normal for jump direction
    const playerData = gameStore.getMyPlayerData();
    const normalVector = playerData && !playerData.falling ? 
      new THREE.Vector3(playerData.normal.x, playerData.normal.y, playerData.normal.z).normalize() : 
      lastNormalVector;
    
    // Convert THREE.Vector3 to simple object for transport
    const normalForJump = {
      x: normalVector.x,
      y: normalVector.y,
      z: normalVector.z
    };
    
    // Send both camera rotation and the normal vector
    gameStore.sendInput(cameraRotation, normalForJump);
  }
  
  updateCameraOrientation();
  updateOtherPlayers();
  updateBoxes(); // Add call to update boxes
  
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