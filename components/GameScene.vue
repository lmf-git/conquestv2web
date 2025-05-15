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
let scene;
let camera;
let renderer;
let animationFrameId;
let cameraRotation = { x: 0, y: 0 }; // Track camera rotation separately

// Game objects
const playerMeshes = new Map();
let localPlayerObject; // Parent object for the camera
let localPlayerMesh; // Visual mesh for local player

onMounted(() => {
  // Connect to server
  gameStore.connectToServer();
  
  // Initialize Three.js
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
  const ambientLight = new THREE.AmbientLight(0x404040);
  scene.add(ambientLight);
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(0, 1, 0);
  scene.add(directionalLight);
  
  // Create planet (sphere)
  const planetGeometry = new THREE.SphereGeometry(gameStore.planetRadius, 32, 32);
  const planetMaterial = new THREE.MeshStandardMaterial({ 
    color: 0x5555ff,
    roughness: 0.8,
    metalness: 0.2
  });
  const planet = new THREE.Mesh(planetGeometry, planetMaterial);
  scene.add(planet);
  
  // Create local player object to hold the camera
  localPlayerObject = new THREE.Group();
  scene.add(localPlayerObject);
  
  // Create local player mesh
  const playerGeometry = new THREE.CapsuleGeometry(0.5, 1, 4, 8);
  const playerMaterial = new THREE.MeshStandardMaterial({ color: 0x00ff00 }); // Green for local player
  localPlayerMesh = new THREE.Mesh(playerGeometry, playerMaterial);
  localPlayerObject.add(localPlayerMesh);
  
  // Create a separate object to handle camera rotation
  const cameraHolder = new THREE.Object3D();
  cameraHolder.position.set(0, 0.7, 0); // Position camera at head height
  localPlayerObject.add(cameraHolder);
  
  // Add camera to the camera holder
  camera.position.set(0, 0, 0);
  cameraHolder.add(camera);
  
  // Manual pointer lock implementation
  container.value.addEventListener('click', requestPointerLock);
  
  // Initial position
  localPlayerObject.position.set(0, gameStore.planetRadius + 10, 0);
  
  // Set up event listeners
  setupEventListeners();
  
  // Start animation loop
  animate();
});

onUnmounted(() => {
  cancelAnimationFrame(animationFrameId);
  document.removeEventListener('pointerlockchange', handlePointerLockChange);
  document.removeEventListener('pointerlockerror', handlePointerLockError);
  document.removeEventListener('mousemove', handleMouseMove);
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('keyup', handleKeyUp);
  
  if (document.exitPointerLock) {
    document.exitPointerLock();
  }
  
  if (gameStore.ws) {
    gameStore.ws.close();
  }
  
  if (renderer) {
    renderer.dispose();
  }
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
  if (camera && renderer) {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
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
  if (isPointerLocked.value) {
    // Mouse sensitivity (adjust as needed)
    const sensitivity = 0.002;
    
    // Update camera rotation based on mouse movement
    cameraRotation.x -= event.movementY * sensitivity;
    cameraRotation.y -= event.movementX * sensitivity;
    
    // Limit vertical rotation to avoid flipping
    cameraRotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, cameraRotation.x));
  }
}

function updateCameraOrientation() {
  const playerData = gameStore.getMyPlayerData();
  if (!playerData) return;
  
  // Update the local player object position
  localPlayerObject.position.set(
    playerData.pos.x,
    playerData.pos.y,
    playerData.pos.z
  );
  
  // Get surface normal vector
  const normalVector = new THREE.Vector3(
    playerData.normal.x,
    playerData.normal.y,
    playerData.normal.z
  ).normalize();
  
  if (!playerData.falling) {
    // When on surface, align the player's up direction with the surface normal
    const upQuat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), // Original up vector
      normalVector                // New up vector (surface normal)
    );
    
    // Apply the upward orientation to the player object
    localPlayerObject.quaternion.copy(upQuat);
    
    // Now apply the camera's local rotation
    // We want to rotate around the local Y axis for horizontal rotation
    const yawQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      cameraRotation.y
    );
    
    // And around the local X axis for vertical rotation
    const pitchQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      cameraRotation.x
    );
    
    // Apply the rotations to camera's parent
    const cameraHolder = camera.parent;
    cameraHolder.quaternion.copy(new THREE.Quaternion());
    cameraHolder.quaternion.multiply(yawQuat).multiply(pitchQuat);
  } else {
    // When falling, use direct camera control without surface normal influence
    localPlayerObject.quaternion.identity();
    
    // Apply camera rotation directly
    const euler = new THREE.Euler(cameraRotation.x, cameraRotation.y, 0, 'YXZ');
    camera.parent.quaternion.setFromEuler(euler);
  }
  
  // Orient the player mesh
  if (localPlayerMesh) {
    if (playerData.falling) {
      // When falling, match player mesh to camera orientation
      localPlayerMesh.quaternion.copy(camera.parent.quaternion);
    } else {
      // When grounded, keep player mesh upright on the surface but facing camera direction
      const cameraDirection = new THREE.Vector3(0, 0, -1);
      cameraDirection.applyQuaternion(camera.parent.quaternion);
      cameraDirection.projectOnPlane(normalVector);
      
      if (cameraDirection.length() > 0.001) {
        cameraDirection.normalize();
        const lookQuat = new THREE.Quaternion();
        const lookMatrix = new THREE.Matrix4().lookAt(
          localPlayerMesh.position,
          new THREE.Vector3().addVectors(localPlayerMesh.position, cameraDirection),
          normalVector
        );
        lookQuat.setFromRotationMatrix(lookMatrix);
        localPlayerMesh.quaternion.copy(lookQuat);
      }
    }
  }
}

function updateOtherPlayers() {
  if (!gameStore.lastServerState) return;
  
  // Set of players we've seen this frame
  const seenIds = new Set();
  
  for (const playerData of gameStore.lastServerState.players) {
    seenIds.add(playerData.id);
    
    if (playerData.id === gameStore.myId) continue;
    
    if (!playerMeshes.has(playerData.id)) {
      // Create new player model with capsule geometry from core Three.js
      const playerGeometry = new THREE.CapsuleGeometry(0.5, 1, 4, 8);
      const playerMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
      const playerMesh = new THREE.Mesh(playerGeometry, playerMaterial);
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
    
    // Simple interpolation
    const t = 0.2;
    player.pos = gameStore.lerpVectors(player.pos, player.targetPos, t);
    player.normal = gameStore.lerpVectors(player.normal, player.targetNormal, t);
    
    // Update mesh position
    player.mesh.position.set(player.pos.x, player.pos.y, player.pos.z);
    
    if (player.falling) {
      // When falling, allow free rotation without normal constraint
      const euler = new THREE.Euler(playerData.rot.x, playerData.rot.y, 0, 'YXZ');
      player.mesh.quaternion.setFromEuler(euler);
    } else {
      // When grounded, orient player to stand on surface using the normal
      const normalVector = new THREE.Vector3(
        player.normal.x,
        player.normal.y,
        player.normal.z
      ).normalize();
      
      // Look at direction
      const lookVector = new THREE.Vector3();
      lookVector.x = Math.sin(player.targetRot.y) * Math.cos(player.targetRot.x);
      lookVector.y = Math.sin(player.targetRot.x);
      lookVector.z = Math.cos(player.targetRot.y) * Math.cos(player.targetRot.x);
      
      // Create quaternion from up vector and forward vector
      const quaternion = new THREE.Quaternion();
      const matrix = new THREE.Matrix4().lookAt(
        new THREE.Vector3(0, 0, 0),
        lookVector,
        normalVector
      );
      quaternion.setFromRotationMatrix(matrix);
      
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
  
  if (isPointerLocked.value) {
    const playerData = gameStore.getMyPlayerData();
    if (playerData) {
      // Send the current camera rotation to the server
      gameStore.sendInput(cameraRotation);
    }
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