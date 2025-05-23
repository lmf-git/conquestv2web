<template>
  <div class="game-container">
    <div ref="gameCanvas" class="game-canvas"></div>
    <div v-if="loading" class="loading-screen">Loading physics engine...</div>
    <div v-if="!started" class="start-screen">
      <button @click="startGame" class="start-button">Start Game</button>
    </div>
    <div class="debug-info" v-if="started">
      <div>Grounded: {{ isGrounded }}</div>
      <div>Position: {{ playerPosition.x.toFixed(2) }}, {{ playerPosition.y.toFixed(2) }}, {{ playerPosition.z.toFixed(2) }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, shallowRef, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

// Refs for DOM elements
const gameCanvas = ref(null);

// State variables
const loading = ref(true);
const started = ref(false);
const isGrounded = ref(false);
const playerPosition = ref(new THREE.Vector3());

// THREE.js objects - use shallowRef to prevent reactivity issues
const scene = shallowRef(null);
const camera = shallowRef(null);
const renderer = shallowRef(null);
const player = shallowRef(null);
const platform = shallowRef(null);
const planet = shallowRef(null);
const clock = new THREE.Clock();

// Physics
const physicsWorld = shallowRef(null);
const playerBody = shallowRef(null);
const leftFootHit = shallowRef(null);
const rightFootHit = shallowRef(null);

// Player data
const playerHeight = 1.8;
const playerRadius = 0.4;
const cameraRotation = shallowRef(new THREE.Euler(0, 0, 0, 'YXZ'));
const walkSpeed = 8;
const runSpeed = 15;
const jumpForce = 8;

// Controls
const keys = reactive({
  forward: false,
  backward: false,
  left: false,
  right: false,
  jump: false,
  run: false
});

// Physics settings
const gravity = reactive({
  center: new THREE.Vector3(0, -150, 0),
  strength: 20
});

// Initialize the game
onMounted(async () => {
  // Initialize Rapier physics engine
  await RAPIER.init();
  loading.value = false;
  
  // Set up scene
  setupScene();
  
  // Handle browser events
  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointerlockchange', onPointerLockChange);
});

// Cleanup when component is destroyed
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('keyup', onKeyUp);
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('pointerlockchange', onPointerLockChange);
  
  if (renderer.value) {
    renderer.value.dispose();
  }
});

// Setup the 3D scene
const setupScene = () => {
  // Create Three.js scene
  scene.value = new THREE.Scene();
  scene.value.background = new THREE.Color(0x111122);
  scene.value.fog = new THREE.Fog(0x111122, 100, 300);
  
  // Create camera
  camera.value = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.value.position.set(0, playerHeight, 0);
  
  // Create renderer
  renderer.value = new THREE.WebGLRenderer({ antialias: true });
  renderer.value.setSize(window.innerWidth, window.innerHeight);
  renderer.value.setPixelRatio(window.devicePixelRatio);
  renderer.value.shadowMap.enabled = true;
  gameCanvas.value.appendChild(renderer.value.domElement);
  
  // Add lights
  const ambientLight = new THREE.AmbientLight(0x444444);
  scene.value.add(ambientLight);
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(50, 200, 100);
  directionalLight.castShadow = true;
  directionalLight.shadow.mapSize.width = 1024;
  directionalLight.shadow.mapSize.height = 1024;
  scene.value.add(directionalLight);
  
  // Create physics world with zero gravity (we'll apply our own)
  physicsWorld.value = new RAPIER.World({ x: 0, y: 0, z: 0 });
  
  // Create game objects
  createPlanet();
  createPlatform();
  createPlayer();
  
  // Add some stars
  createStars();
};

const createPlanet = () => {
  // Create planet visuals
  const planetRadius = 100;
  const planetGeometry = new THREE.SphereGeometry(planetRadius, 64, 64);
  const planetMaterial = new THREE.MeshStandardMaterial({ 
    color: 0x33aa44,
    roughness: 0.8, 
    metalness: 0.2
  });
  
  planet.value = new THREE.Mesh(planetGeometry, planetMaterial);
  planet.value.position.copy(gravity.center);
  planet.value.receiveShadow = true;
  scene.value.add(planet.value);
  
  // Create planet physics body
  const planetBodyDesc = RAPIER.RigidBodyDesc.fixed();
  planetBodyDesc.setTranslation(
    gravity.center.x, 
    gravity.center.y, 
    gravity.center.z
  );
  const planetBody = physicsWorld.value.createRigidBody(planetBodyDesc);
  
  // Create planet collider
  const planetColliderDesc = RAPIER.ColliderDesc.ball(planetRadius);
  planetColliderDesc.setFriction(0.8);
  physicsWorld.value.createCollider(planetColliderDesc, planetBody);
};

const createPlatform = () => {
  // Create platform visuals
  const platformWidth = 20;
  const platformHeight = 1;
  const platformDepth = 20;
  const platformGeometry = new THREE.BoxGeometry(platformWidth, platformHeight, platformDepth);
  const platformMaterial = new THREE.MeshStandardMaterial({ 
    color: 0x6688cc,
    roughness: 0.5, 
    metalness: 0.5
  });
  
  platform.value = new THREE.Mesh(platformGeometry, platformMaterial);
  platform.value.position.set(0, 20, 0);
  platform.value.castShadow = true;
  platform.value.receiveShadow = true;
  scene.value.add(platform.value);
  
  // Create platform physics body
  const platformBodyDesc = RAPIER.RigidBodyDesc.fixed();
  platformBodyDesc.setTranslation(0, 20, 0);
  const platformBody = physicsWorld.value.createRigidBody(platformBodyDesc);
  
  // Create platform collider
  const platformColliderDesc = RAPIER.ColliderDesc.cuboid(
    platformWidth / 2,
    platformHeight / 2, 
    platformDepth / 2
  );
  platformColliderDesc.setFriction(0.8);
  physicsWorld.value.createCollider(platformColliderDesc, platformBody);
};

const createPlayer = () => {
  // Create player physics body - spawn higher above platform
  const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, 30, 0) // Increased from 25 to 30 for more height
    .setLinearDamping(0.5)
    .setAngularDamping(0.5)
    .setCcdEnabled(true);
  
  playerBody.value = physicsWorld.value.createRigidBody(playerBodyDesc);
  
  // Add initial downward velocity to start falling immediately
  playerBody.value.setLinvel({ x: 0, y: -2, z: 0 }, true);
  
  // Create player collider (capsule shape)
  const playerColliderDesc = RAPIER.ColliderDesc.capsule(
    playerHeight / 2 - playerRadius,
    playerRadius
  );
  playerColliderDesc.setFriction(0.2);
  playerColliderDesc.setRestitution(0.0);
  physicsWorld.value.createCollider(playerColliderDesc, playerBody.value);
  
  // Create player visual representation (invisible in first person)
  const playerGeometry = new THREE.CapsuleGeometry(
    playerRadius, 
    playerHeight - playerRadius * 2, 
    8, 8
  );
  const playerMaterial = new THREE.MeshStandardMaterial({ 
    color: 0xff9900,
    visible: false // Make invisible for first person view
  });
  
  player.value = new THREE.Mesh(playerGeometry, playerMaterial);
  scene.value.add(player.value);
  
  // Add camera to player
  player.value.add(camera.value);
  camera.value.position.set(0, playerHeight * 0.8, 0);
};

const createStars = () => {
  const starGeometry = new THREE.BufferGeometry();
  const starMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.5,
    sizeAttenuation: false
  });
  
  const starVertices = [];
  for (let i = 0; i < 10000; i++) {
    const x = THREE.MathUtils.randFloatSpread(2000);
    const y = THREE.MathUtils.randFloatSpread(2000);
    const z = THREE.MathUtils.randFloatSpread(2000);
    starVertices.push(x, y, z);
  }
  
  starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starVertices, 3));
  const stars = new THREE.Points(starGeometry, starMaterial);
  scene.value.add(stars);
};

const startGame = () => {
  started.value = true;
  gameCanvas.value.requestPointerLock();
  animate();
};

const animate = () => {
  if (!started.value) return;
  
  requestAnimationFrame(animate);
  
  const deltaTime = Math.min(clock.getDelta(), 0.1);
  
  // Update physics simulation
  updatePhysics(deltaTime);
  
  // Create a local copy of player position to avoid reactivity issues
  if (playerBody.value) {
    // Get position directly without triggering reactivity
    const position = playerBody.value.translation();
    
    // Only update the displayed position for UI - don't make it reactive
    const displayPos = playerPosition.value;
    displayPos.set(position.x, position.y, position.z);
  }
  
  // Update player position and rotation
  updatePlayerTransform();
  
  // Check ground contact
  checkGrounded();
  
  // Handle player movement
  handlePlayerMovement(deltaTime);
  
  // Render scene - use try/catch to prevent errors from stopping the game
  try {
    renderer.value?.render(scene.value, camera.value);
  } catch (e) {
    console.error("Render error:", e);
  }
};

const updatePhysics = (deltaTime) => {
  // Apply point gravity to player
  applyPointGravity();
  
  // Step physics world
  physicsWorld.value.step();
};

const applyPointGravity = () => {
  if (!playerBody.value) return;
  
  // Get player position
  const playerTranslation = playerBody.value.translation();
  const playerPos = new THREE.Vector3(
    playerTranslation.x,
    playerTranslation.y,
    playerTranslation.z
  );
  
  // Calculate direction to gravity center
  const gravityDir = new THREE.Vector3()
    .subVectors(gravity.center, playerPos)
    .normalize();
  
  // Apply gravity force
  const gravityStrength = gravity.strength;
  const force = {
    x: gravityDir.x * gravityStrength,
    y: gravityDir.y * gravityStrength,
    z: gravityDir.z * gravityStrength
  };
  
  // Use addForce instead of applyForce
  playerBody.value.addForce(force);
};

const checkGrounded = () => {
  if (!playerBody.value) return;
  
  // Get player position and up vector (opposite to gravity direction)
  const playerTranslation = playerBody.value.translation();
  const playerPos = new THREE.Vector3(
    playerTranslation.x,
    playerTranslation.y,
    playerTranslation.z
  );
  
  // Get gravity direction
  const gravityDir = new THREE.Vector3()
    .subVectors(gravity.center, playerPos)
    .normalize();
  
  // Calculate up vector (opposite to gravity)
  const upVector = gravityDir.clone().negate();
  
  // Get right vector
  const forwardVector = new THREE.Vector3(0, 0, -1).applyQuaternion(player.value.quaternion);
  const rightVector = new THREE.Vector3().crossVectors(upVector, forwardVector).normalize();
  
  // Calculate foot positions (offset left and right from center)
  const footHeight = playerHeight * 0.5 - 0.1;
  const footSpread = playerRadius * 0.7;
  
  const leftFootPos = playerPos.clone().add(
    rightVector.clone().multiplyScalar(-footSpread)
      .add(upVector.clone().multiplyScalar(-footHeight))
  );
  
  const rightFootPos = playerPos.clone().add(
    rightVector.clone().multiplyScalar(footSpread)
      .add(upVector.clone().multiplyScalar(-footHeight))
  );
  
  // Cast rays downward from both feet
  const rayLength = 0.3; // Detection distance
  
  // Create rays
  const rayDir = { x: gravityDir.x, y: gravityDir.y, z: gravityDir.z };
  
  const leftRay = new RAPIER.Ray(
    { x: leftFootPos.x, y: leftFootPos.y, z: leftFootPos.z },
    rayDir
  );
  
  const rightRay = new RAPIER.Ray(
    { x: rightFootPos.x, y: rightFootPos.y, z: rightFootPos.z },
    rayDir
  );
  
  // Perform raycasts
  leftFootHit.value = physicsWorld.value.castRay(leftRay, rayLength, true);
  rightFootHit.value = physicsWorld.value.castRay(rightRay, rayLength, true);
  
  // Check if either foot is on ground
  isGrounded.value = (leftFootHit.value !== null) || (rightFootHit.value !== null);
  
  // If grounded, align player with surface normal
  if (isGrounded.value) {
    let hit = leftFootHit.value !== null ? leftFootHit.value : rightFootHit.value;
    if (hit && hit.normal) {
      const hitPoint = hit.toi; // Time of impact
      const hitNormal = hit.normal; // Surface normal
      
      // Verify hitNormal has the required properties before using
      if (hitNormal.x !== undefined && hitNormal.y !== undefined && hitNormal.z !== undefined) {
        // Check if this is a wall (based on angle between normal and gravity)
        const normalVec = new THREE.Vector3(hitNormal.x, hitNormal.y, hitNormal.z);
        const gravityAngle = normalVec.angleTo(gravityDir);
        
        // If angle is close to 90 degrees, it's a wall not floor
        const isWall = Math.abs(Math.PI/2 - gravityAngle) < Math.PI/4;
        
        if (!isWall) {
          // Align player with ground normal
          alignPlayerWithGround(normalVec, upVector);
        }
      }
    }
  }
};

const alignPlayerWithGround = (normal, upVector) => {
  // When grounded, align player with the ground normal
  // This keeps the player standing "up" relative to the surface
  if (!isGrounded.value) return;
  
  // Calculate rotation to align with ground normal
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    upVector
  );
  
  // Apply only to player body (not camera) when grounded
  // This allows the camera to look up/down independently
  playerBody.value.setRotation(
    { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
    true
  );
};

const handlePlayerMovement = (deltaTime) => {
  if (!playerBody.value || !started.value) return;
  
  const moveSpeed = keys.run ? runSpeed : walkSpeed;
  const moveDir = new THREE.Vector3(0, 0, 0);
  
  // Get player orientation
  const quaternion = player.value.quaternion;
  
  if (isGrounded.value) {
    // Grounded movement - standard FPS controls
    // Movement is relative to camera direction
    if (keys.forward) moveDir.z -= 1;
    if (keys.backward) moveDir.z += 1;
    if (keys.left) moveDir.x -= 1;
    if (keys.right) moveDir.x += 1;
    
    // Normalize direction vector
    if (moveDir.length() > 0) {
      moveDir.normalize();
      
      // Rotate movement direction based on camera yaw only (not pitch)
      const cameraYaw = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, cameraRotation.value.y, 0)
      );
      moveDir.applyQuaternion(cameraYaw);
      
      // Apply movement force
      playerBody.value.applyImpulse({
        x: moveDir.x * moveSpeed * deltaTime * 60,
        y: moveDir.y * moveSpeed * deltaTime * 60,
        z: moveDir.z * moveSpeed * deltaTime * 60
      }, true);
    }
    
    // Handle jumping
    if (keys.jump) {
      // Get gravity direction (towards gravity center)
      const playerTranslation = playerBody.value.translation();
      const playerPos = new THREE.Vector3(
        playerTranslation.x,
        playerTranslation.y,
        playerTranslation.z
      );
      
      // Calculate up vector (opposite to gravity direction)
      const gravityDir = new THREE.Vector3()
        .subVectors(gravity.center, playerPos)
        .normalize();
      const jumpDir = gravityDir.clone().negate();
      
      // Apply jump impulse
      playerBody.value.applyImpulse({
        x: jumpDir.x * jumpForce,
        y: jumpDir.y * jumpForce,
        z: jumpDir.z * jumpForce
      }, true);
      
      // Prevent multiple jumps
      keys.jump = false;
    }
  } else {
    // Airborne movement - quaternion-based aim
    // Limited air control
    const airControlFactor = 0.3;
    
    if (keys.forward) moveDir.z -= 1;
    if (keys.backward) moveDir.z += 1;
    if (keys.left) moveDir.x -= 1;
    if (keys.right) moveDir.x += 1;
    
    if (moveDir.length() > 0) {
      moveDir.normalize();
      moveDir.multiplyScalar(airControlFactor * moveSpeed * deltaTime * 60);
      
      // Apply movement in camera direction
      moveDir.applyQuaternion(quaternion);
      
      playerBody.value.applyImpulse({
        x: moveDir.x,
        y: moveDir.y,
        z: moveDir.z
      }, true);
    }
  }
};

const updatePlayerTransform = () => {
  if (!playerBody.value || !player.value) return;
  
  try {
    // Get position from physics body
    const position = playerBody.value.translation();
    
    // Update Three.js objects directly (not through Vue reactivity)
    player.value.position.set(position.x, position.y, position.z);
    
    // Get rotation from physics body
    const rotation = playerBody.value.rotation();
    player.value.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    
    // Update camera rotation
    if (isGrounded.value) {
      // When grounded, player rotates left/right, camera only looks up/down
      camera.value.rotation.x = cameraRotation.value.x;
    } else {
      // When airborne, full quaternion control for camera
      camera.value.rotation.x = cameraRotation.value.x;
      camera.value.rotation.y = cameraRotation.value.y;
    }
  } catch (e) {
    console.error("Error updating player transform:", e);
  }
};

const onKeyDown = (event) => {
  if (!started.value) return;
  
  switch (event.code) {
    case 'KeyW':
    case 'ArrowUp':
      keys.forward = true;
      break;
    case 'KeyS':
    case 'ArrowDown':
      keys.backward = true;
      break;
    case 'KeyA':
    case 'ArrowLeft':
      keys.left = true;
      break;
    case 'KeyD':
    case 'ArrowRight':
      keys.right = true;
      break;
    case 'Space':
      if (isGrounded.value) {
        keys.jump = true;
      }
      break;
    case 'ShiftLeft':
      keys.run = true;
      break;
  }
};

const onKeyUp = (event) => {
  if (!started.value) return;
  
  switch (event.code) {
    case 'KeyW':
    case 'ArrowUp':
      keys.forward = false;
      break;
    case 'KeyS':
    case 'ArrowDown':
      keys.backward = false;
      break;
    case 'KeyA':
    case 'ArrowLeft':
      keys.left = false;
      break;
    case 'KeyD':
    case 'ArrowRight':
      keys.right = false;
      break;
    case 'Space':
      keys.jump = false;
      break;
    case 'ShiftLeft':
      keys.run = false;
      break;
    case 'Escape':
      if (document.pointerLockElement === gameCanvas.value) {
        document.exitPointerLock();
      }
      break;
  }
};

const onMouseMove = (event) => {
  if (!started.value || document.pointerLockElement !== gameCanvas.value) return;
  
  // Mouse sensitivity
  const sensitivity = 0.002;
  
  try {
    // Update camera rotation without triggering reactivity
    const rotation = cameraRotation.value;
    rotation.y -= event.movementX * sensitivity;
    rotation.x -= event.movementY * sensitivity;
    
    // Limit vertical look angle to avoid flipping
    rotation.x = Math.max(
      -Math.PI / 2 + 0.01, 
      Math.min(Math.PI / 2 - 0.01, rotation.x)
    );
    
    if (isGrounded.value && playerBody.value) {
      // When grounded, rotate the player body when looking left/right
      const playerQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, rotation.y, 0)
      );
      
      playerBody.value.setRotation(
        { x: playerQuat.x, y: playerQuat.y, z: playerQuat.z, w: playerQuat.w },
        true
      );
    }
  } catch (e) {
    console.error("Error in mouse move:", e);
  }
};

const onPointerLockChange = () => {
  if (document.pointerLockElement !== gameCanvas.value) {
    // Pointer lock was exited
    keys.forward = false;
    keys.backward = false;
    keys.left = false;
    keys.right = false;
    keys.jump = false;
    keys.run = false;
  }
};

const onResize = () => {
  if (!camera.value || !renderer.value) return;
  
  camera.value.aspect = window.innerWidth / window.innerHeight;
  camera.value.updateProjectionMatrix();
  renderer.value.setSize(window.innerWidth, window.innerHeight);
};
</script>

<style>
html, body {
  margin: 0;
  padding: 0;
  overflow: hidden;
}

.game-container {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

.game-canvas {
  width: 100%;
  height: 100%;
}

.loading-screen, .start-screen {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: rgba(0, 0, 0, 0.8);
  color: white;
  font-family: Arial, sans-serif;
  font-size: 24px;
}

.start-button {
  padding: 15px 30px;
  font-size: 20px;
  background-color: #4CAF50;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.3s;
}

.start-button:hover {
  background-color: #45a049;
}

.debug-info {
  position: absolute;
  top: 10px;
  left: 10px;
  color: white;
  font-family: monospace;
  font-size: 14px;
  background-color: rgba(0, 0, 0, 0.5);
  padding: 5px;
  border-radius: 4px;
}
</style>
