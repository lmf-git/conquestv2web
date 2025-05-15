<template>
  <div ref="container" class="game-container">
    <div class="crosshair"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls';
import { useGameStore } from '~/stores/game';

const container = ref<HTMLElement | null>(null);
const gameStore = useGameStore();

// Three.js variables
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: PointerLockControls;
let animationFrameId: number;

// Game objects
const playerMeshes = new Map();

onMounted(() => {
  initThreeJS();
  setupEventListeners();
  gameStore.connectToServer();
  animate();
});

onUnmounted(() => {
  cancelAnimationFrame(animationFrameId);
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('keyup', handleKeyUp);
  if (gameStore.ws) {
    gameStore.ws.close();
  }
  
  if (renderer) {
    renderer.dispose();
    renderer.forceContextLoss();
  }
});

function initThreeJS() {
  if (!container.value) return;
  
  // Scene setup
  scene = new THREE.Scene();
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
  
  // Set up camera controls
  controls = new PointerLockControls(camera, renderer.domElement);
  
  container.value.addEventListener('click', () => {
    controls.lock();
  });
  
  controls.addEventListener('lock', () => {
    console.log('Controls locked');
  });
  
  controls.addEventListener('unlock', () => {
    console.log('Controls unlocked');
  });
}

function setupEventListeners() {
  window.addEventListener('resize', handleResize);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
}

function handleResize() {
  if (camera && renderer) {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (gameStore.keys.hasOwnProperty(e.key.toLowerCase())) {
    gameStore.keys[e.key.toLowerCase() as keyof typeof gameStore.keys] = true;
  }
}

function handleKeyUp(e: KeyboardEvent) {
  if (gameStore.keys.hasOwnProperty(e.key.toLowerCase())) {
    gameStore.keys[e.key.toLowerCase() as keyof typeof gameStore.keys] = false;
  }
}

function updateCameraOrientation() {
  const playerData = gameStore.getMyPlayerData();
  if (!playerData) return;
  
  // Calculate up vector (away from planet center)
  const pos = new THREE.Vector3(
    playerData.pos.x,
    playerData.pos.y,
    playerData.pos.z
  );
  
  const upVector = pos.clone().normalize();
  
  // Position camera at player position
  camera.position.copy(pos);
  
  // Orient camera based on player rotation
  camera.quaternion.setFromEuler(new THREE.Euler(
    playerData.rot.x,
    playerData.rot.y,
    0,
    'YXZ'
  ));
}

function updateOtherPlayers() {
  if (!gameStore.lastServerState) return;
  
  // Set of players we've seen this frame
  const seenIds = new Set();
  
  for (const playerData of gameStore.lastServerState.players) {
    seenIds.add(playerData.id);
    
    if (playerData.id === gameStore.myId) {
      // This is our player
      continue;
    }
    
    if (!playerMeshes.has(playerData.id)) {
      // Create new player model
      const playerGeometry = new THREE.BoxGeometry(1, 2, 1);
      const playerMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
      const playerMesh = new THREE.Mesh(playerGeometry, playerMaterial);
      scene.add(playerMesh);
      
      playerMeshes.set(playerData.id, {
        mesh: playerMesh,
        pos: { ...playerData.pos },
        rot: { ...playerData.rot },
        targetPos: { ...playerData.pos },
        targetRot: { ...playerData.rot }
      });
    }
    
    // Update player data
    const player = playerMeshes.get(playerData.id);
    player.targetPos = { ...playerData.pos };
    player.targetRot = { ...playerData.rot };
    
    // Simple interpolation
    const t = 0.2; // Adjust for smoothness
    player.pos = gameStore.lerpVectors(player.pos, player.targetPos, t);
    
    // Update mesh position
    player.mesh.position.set(player.pos.x, player.pos.y, player.pos.z);
    
    // Orient player to stand on sphere surface
    const normalVector = new THREE.Vector3(
      player.pos.x,
      player.pos.y,
      player.pos.z
    ).normalize();
    
    // Look at direction
    const lookVector = new THREE.Vector3();
    lookVector.x = Math.sin(player.targetRot.y) * Math.cos(player.targetRot.x);
    lookVector.y = Math.sin(player.targetRot.x);
    lookVector.z = Math.cos(player.targetRot.y) * Math.cos(player.targetRot.x);
    
    // Create quaternion from up vector (normal) and forward vector
    const quaternion = new THREE.Quaternion();
    const matrix = new THREE.Matrix4().lookAt(
      lookVector,
      new THREE.Vector3(0, 0, 0),
      normalVector
    );
    quaternion.setFromRotationMatrix(matrix);
    
    player.mesh.quaternion.slerp(quaternion, 0.2);
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
  
  // Get camera direction for input
  if (controls.isLocked) {
    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);
    
    // Extract rotation from camera direction
    const rotation = {
      x: Math.asin(cameraDirection.y),
      y: Math.atan2(cameraDirection.x, cameraDirection.z)
    };
    
    gameStore.sendInput(rotation);
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
</style>