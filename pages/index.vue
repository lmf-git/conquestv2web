<template>
  <div class="game-container">
    <div ref="gameCanvas" class="game-canvas"></div>
    <div v-if="loading" class="loading-screen">Loading physics engine...</div>
    <div v-if="!started" class="start-screen">
      <button @click="startGame" class="start-button">Start Game</button>
    </div>
    <div v-if="errorMessage" class="error-message">{{ errorMessage }}</div>
    <div class="debug-info" v-if="started">
      <div>Grounded: {{ isGrounded }}</div>
      <div>Position: {{ playerPosition.x.toFixed(2) }}, {{ playerPosition.y.toFixed(2) }}, {{ playerPosition.z.toFixed(2) }}</div>
      <div>Moving: {{ isMoving }}</div>
      <div>Speed: {{ currentSpeed.toFixed(2) }}</div>
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
const wasGrounded = ref(false);
const playerPosition = ref(new THREE.Vector3());
const isMoving = ref(false);
const currentSpeed = ref(0);
const isCameraDetached = ref(false);
const errorMessage = ref(''); // Add error message state
const lastPlayerPosition = shallowRef(null); // Add this declaration
const positionStuckFrames = ref(0); // Add this declaration
const lastDebugTime = ref(0); // Add this declaration
const frameCount = ref(0); // Add frameCount as a reactive variable

// THREE.js objects - use shallowRef to prevent reactivity issues
const scene = shallowRef(null);
const camera = shallowRef(null);
const renderer = shallowRef(null);
const player = shallowRef(null);
const platform = shallowRef(null);
const planet = shallowRef(null);
const clock = new THREE.Clock();

// Debug visualization objects
const leftRayLine = shallowRef(null);
const rightRayLine = shallowRef(null);
const centerRayLine = shallowRef(null);

// Physics
const physicsWorld = shallowRef(null);
const playerBody = shallowRef(null);
const leftFootHit = shallowRef(null);
const rightFootHit = shallowRef(null);
const centerFootHit = shallowRef(null); // Add this line to define centerFootHit as a shallowRef

// Player data
const playerHeight = 1.8;
const playerRadius = 0.4;
const cameraRotation = shallowRef(new THREE.Euler(0, 0, 0, 'YXZ'));
const walkSpeed = 4; // Reduced from 8 to 4
const runSpeed = 8;  // Reduced from 15 to 8
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
  strength: 20  // Increased from 10 to 20 for more obvious effect
});

// Modify the utility function to get ground normal to use averaged normals
const getGroundNormal = () => {
  // Get player position for gravity calculation
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
  const upVector = gravityDir.clone().negate();
  
  // Default to up vector if no hit
  let groundNormal = upVector.clone();
  
  // When both feet have valid normals, use their average for smoother alignment
  if (leftFootHit.value !== null && leftFootHit.value.normal && 
      rightFootHit.value !== null && rightFootHit.value.normal) {
    
    // Create vectors from both normals
    const leftNormal = new THREE.Vector3(
      leftFootHit.value.normal.x,
      leftFootHit.value.normal.y,
      leftFootHit.value.normal.z
    );
    
    const rightNormal = new THREE.Vector3(
      rightFootHit.value.normal.x,
      rightFootHit.value.normal.y,
      rightFootHit.value.normal.z
    );
    
    // Get TOI (time of impact) for each foot - lower TOI means closer to surface
    const leftToi = leftFootHit.value.toi;
    const rightToi = rightFootHit.value.toi;
    
    // Weight the normals based on which foot is closer to the ground
    // This creates more natural movement when one foot is on a different surface
    const leftWeight = 1.0 / (leftToi + 0.01); // Avoid division by zero
    const rightWeight = 1.0 / (rightToi + 0.01);
    const totalWeight = leftWeight + rightWeight;
    
    // Weighted average of normals
    groundNormal.copy(leftNormal.multiplyScalar(leftWeight / totalWeight)
                     .add(rightNormal.multiplyScalar(rightWeight / totalWeight)))
                     .normalize();
    
    // If the normals are very different (e.g., straddling an edge), 
    // prefer the normal that's closer to the up vector
    const leftDot = leftNormal.dot(upVector);
    const rightDot = rightNormal.dot(upVector);
    const avgDot = groundNormal.dot(upVector);
    
    // If average is much worse than either individual normal, use the better one
    if (avgDot < leftDot - 0.2 || avgDot < rightDot - 0.2) {
      if (leftDot > rightDot) {
        groundNormal.copy(leftNormal);
      } else {
        groundNormal.copy(rightNormal);
      }
    }
  } 
  // Use single ray hit normal if only one is available
  else if (leftFootHit.value !== null && leftFootHit.value.normal) {
    groundNormal.set(
      leftFootHit.value.normal.x,
      leftFootHit.value.normal.y,
      leftFootHit.value.normal.z
    );
  } else if (rightFootHit.value !== null && rightFootHit.value.normal) {
    groundNormal.set(
      rightFootHit.value.normal.x,
      rightFootHit.value.normal.y,
      rightFootHit.value.normal.z
    );
  }
  
  return { groundNormal, upVector, gravityDir, playerPos };
};

// Define the onResize function earlier in the file, before onMounted
const onResize = () => {
  if (!camera.value || !renderer.value) return;
  
  // Update camera aspect ratio
  camera.value.aspect = window.innerWidth / window.innerHeight;
  camera.value.updateProjectionMatrix();
  
  // Resize renderer
  renderer.value.setSize(window.innerWidth, window.innerHeight);
};

// Fix the onMouseMove function to correct inverted horizontal controls
const onMouseMove = (event) => {
  if (!started.value || document.pointerLockElement !== gameCanvas.value) return;
  
  // Mouse sensitivity - reduced for smoother control
  const lookSensitivity = 0.001;
  const groundTurnSensitivity = 0.0008;
  
  try {
    // Update vertical camera rotation (pitch)
    cameraRotation.value.x -= event.movementY * lookSensitivity;
    
    // Limit vertical look angle to avoid flipping
    cameraRotation.value.x = Math.max(
      -Math.PI / 2 + 0.01, 
      Math.min(Math.PI / 2 - 0.01, cameraRotation.value.x)
    );
    
    // Handle horizontal rotation (yaw) based on grounded state
    if (isGrounded.value && playerBody.value) {
      // Only apply rotation if mouse movement is significant enough
      if (Math.abs(event.movementX) > 1) {
        // On ground, rotate the entire player body around the ground normal
        const { groundNormal } = getGroundNormal();
        
        // Create rotation quaternion for horizontal mouse movement
        // FIXED: Negate movement X to correct inverted controls
        const yawQuat = new THREE.Quaternion().setFromAxisAngle(
          groundNormal, 
          -event.movementX * groundTurnSensitivity // Negative sign added here
        );
        
        // Apply to player's physics body
        const currentQuat = new THREE.Quaternion(
          playerBody.value.rotation().x,
          playerBody.value.rotation().y,
          playerBody.value.rotation().z,
          playerBody.value.rotation().w
        );
        currentQuat.premultiply(yawQuat);
        
        playerBody.value.setRotation(
          { x: currentQuat.x, y: currentQuat.y, z: currentQuat.z, w: currentQuat.w },
          true
        );
        
        // Update the last ground normal to prevent fighting between systems
        lastGroundNormal.value.copy(groundNormal);
      }
      
      // Reset camera's yaw since player body handles it
      cameraRotation.value.y = 0;
    } else {
      // When airborne, store yaw in camera rotation
      // FIXED: Negate movement X to correct inverted controls
      cameraRotation.value.y -= event.movementX * lookSensitivity; // Negative sign added here
    }
  } catch (e) {
    console.error("Error in mouse move:", e);
  }
};

// Add missing onPointerLockChange function before onMounted
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

// Add missing resetCameraForAirborne function
const resetCameraForAirborne = () => {
  // Save player's current yaw rotation before switching to camera-based rotation
  if (player.value) {
    // Extract yaw from player's current quaternion
    const playerEuler = new THREE.Euler().setFromQuaternion(player.value.quaternion, 'YXZ');
    // Set camera's yaw to match player's current direction
    cameraRotation.value.y = playerEuler.y;
  }
};

// Add missing projectVectorOntoPlane function
const projectVectorOntoPlane = (vector, planeNormal) => {
  const dot = vector.dot(planeNormal);
  return vector.clone().sub(planeNormal.clone().multiplyScalar(dot));
};

// Add onKeyDown and onKeyUp functions before onMounted
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
    case 'KeyO': // Add 'o' key handler
      toggleCameraAttachment();
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
  }
};

// Add missing startGame function
const startGame = () => {
  try {
    console.log("Starting game...");
    
    // Check if game canvas is available
    if (!gameCanvas.value) {
      errorMessage.value = "Game canvas not found";
      console.error(errorMessage.value);
      return;
    }
    
    // Set started state
    started.value = true;

    // Try to request pointer lock
    gameCanvas.value.requestPointerLock();
      
    // Add event listener for pointer lock errors
    document.addEventListener('pointerlockerror', (e) => {
      console.warn('Pointer lock error, continuing without mouse control:', e);
      // Continue with game anyway
      if (!clock.running) {
        clock.start();
        animate();
      }
    }, { once: true });
    
    // Always start the animation loop regardless of pointer lock status
    if (!clock.running) {
      clock.start();
      console.log("Starting animation loop");
      animate();
    }
  } catch (e) {
    errorMessage.value = "Error starting game: " + e.message;
    console.error("Error starting game:", e);
    
    // Try to start the game anyway
    started.value = true;
    if (!clock.running) {
      clock.start();
      animate();
    }
  }
};

// Initialize the game
onMounted(async () => {
  try {
    // Initialize Rapier physics engine
    await RAPIER.init();
    loading.value = false;
    
    // Set up scene - add error handling
    setupScene();
    
    // Handle browser events
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    
    console.log("Game initialization complete, ready to start");
  } catch (e) {
    console.error("Error during game initialization:", e);
    loading.value = false;
  }
});

// Cleanup when component is destroyed
onBeforeUnmount(() => {
  // Stop animation loop first
  started.value = false;
  
  // Clear event listeners
  window.removeEventListener('resize', onResize);
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('keyup', onKeyUp);
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('pointerlockchange', onPointerLockChange);
  
  // Safely clean up Three.js resources
  if (renderer.value) {
    try {
      // Remove the canvas element from the DOM
      if (renderer.value.domElement && renderer.value.domElement.parentNode) {
        renderer.value.domElement.parentNode.removeChild(renderer.value.domElement);
      }
      
      // Dispose of the renderer
      renderer.value.dispose();
      renderer.value = null;
    } catch (e) {
      console.error("Error cleaning up renderer:", e);
    }
  }
  
  // Clean up other resources
  scene.value = null;
  camera.value = null;
  physicsWorld.value = null;
  playerBody.value = null;
}); // Add missing closing brace here

// Create stars in the scene
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

// Modify the setupScene function to check DOM elements before manipulation
const setupScene = () => {
  // Create Three.js scene
  scene.value = new THREE.Scene();
  scene.value.background = new THREE.Color(0x111122);
  scene.value.fog = new THREE.Fog(0x111122, 100, 300);
  
  // Create camera
  camera.value = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.value.position.set(0, playerHeight, 0);
  
  // Create renderer with proper DOM element checks
  renderer.value = new THREE.WebGLRenderer({ antialias: true });
  renderer.value.setSize(window.innerWidth, window.innerHeight);
  renderer.value.setPixelRatio(window.devicePixelRatio);
  renderer.value.shadowMap.enabled = true;
  
  // Add null check before appending to DOM
  if (gameCanvas.value) {
    gameCanvas.value.appendChild(renderer.value.domElement);
  } else {
    console.error("Game canvas element not found");
    return; // Exit early if DOM element is missing
  }
  
  // Add lights
  const ambientLight = new THREE.AmbientLight(0x444444);
  scene.value.add(ambientLight);
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(50, 200, 100);
  directionalLight.castShadow = true;
  directionalLight.shadow.mapSize.width = 1024;
  directionalLight.shadow.mapSize.height = 1024;
  scene.value.add(directionalLight);
  
  // Create physics world with gravity that matches our planet-centered gravity
  // Note: Rapier gravity is just a baseline, we're primarily using our custom gravity for the player
  const gravityStrength = 20;
  const gravityVec = { 
    x: 0, 
    y: -gravityStrength, // Point down as an approximation
    z: 0 
  };
  physicsWorld.value = new RAPIER.World(gravityVec);
  console.log("Created physics world with gravity:", gravityVec, 
              "Custom gravity center at:", gravity.center);
  
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
  
  // Create planet collider with slightly expanded sensor shell
  const planetColliderDesc = RAPIER.ColliderDesc.ball(planetRadius);
  planetColliderDesc.setFriction(2.0);
  planetColliderDesc.setRestitution(0.1); // Allow some bounce
  physicsWorld.value.createCollider(planetColliderDesc, planetBody);
  
  // Create a slightly larger sensor collider for better detection
  const sensorRadius = planetRadius + 0.2;
  const sensorColliderDesc = RAPIER.ColliderDesc.ball(sensorRadius)
    .setSensor(true);
  physicsWorld.value.createCollider(sensorColliderDesc, planetBody);
};

const createPlatform = () => {
  // Create platform visuals
  const platformWidth = 50;  // Increased from 40
  const platformHeight = 4;  // Increased from 2
  const platformDepth = 50;  // Increased from 40
  const platformGeometry = new THREE.BoxGeometry(platformWidth, platformHeight, platformDepth);
  const platformMaterial = new THREE.MeshStandardMaterial({ 
    color: 0x3388ee, // Brighter blue color
    roughness: 0.5, 
    metalness: 0.5,
    emissive: 0x112244 // Add slight emissive quality to make it more visible
  });
  
  platform.value = new THREE.Mesh(platformGeometry, platformMaterial);
  // Position the platform higher and offset it slightly for better visibility
  const platformPosition = { x: 0, y: 30, z: 10 };
  platform.value.position.set(platformPosition.x, platformPosition.y, platformPosition.z); 
  platform.value.castShadow = true;
  platform.value.receiveShadow = true;
  scene.value.add(platform.value);
  
  // Create platform physics body with matching position
  const platformBodyDesc = RAPIER.RigidBodyDesc.fixed();
  platformBodyDesc.setTranslation(
    platformPosition.x, 
    platformPosition.y, 
    platformPosition.z
  );
  const platformBody = physicsWorld.value.createRigidBody(platformBodyDesc);
  
  // Create slightly LARGER collider than visual for more reliable collision
  const platformColliderDesc = RAPIER.ColliderDesc.cuboid(
    platformWidth / 2 + 0.5, // Slightly bigger collider
    platformHeight / 2 + 0.5,
    platformDepth / 2 + 0.5
  );
  
  // Add higher friction to prevent sliding
  platformColliderDesc.setFriction(10.0);
  platformColliderDesc.setRestitution(0.0);
  platformColliderDesc.setDensity(1.0);
  
  // Create the collider and store the handle for debugging
  const platformCollider = physicsWorld.value.createCollider(platformColliderDesc, platformBody);
  console.log("Platform collider created - Handle:", platformCollider.handle);
};

const createPlayer = () => {
  // Position player directly above platform with a small gap
  const spawnHeight = 31.5; // Just 1.5 units above platform at y=30
  const playerBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
    .setTranslation(0, spawnHeight, 10) // Directly above platform
    .setCcdEnabled(true);
  
  playerBody.value = physicsWorld.value.createRigidBody(playerBodyDesc);
  
  // Verify kinematic status
  console.log("Player is kinematic position-based:", 
              playerBody.value.isKinematic(), 
              "Body type:", playerBody.value.bodyType());
  
  // Create player collider with similar properties
  const playerColliderDesc = RAPIER.ColliderDesc.capsule(
    playerHeight / 2 - playerRadius,
    playerRadius
  )
  .setFriction(0.7)
  .setRestitution(0.0)
  .setDensity(1.0);
  
  physicsWorld.value.createCollider(playerColliderDesc, playerBody.value);
  
  // Set initial grounded state
  isGrounded.value = false;
  wasGrounded.value = false;

  // No need for initial impulse since we'll manually position the body
  console.log("Created kinematic position-based player body");
  
  // Create player visual representation (make it visible but transparent)
  const playerGeometry = new THREE.CapsuleGeometry(
    playerRadius, 
    playerHeight - playerRadius * 2, 
    8, 8
  );
  const playerMaterial = new THREE.MeshStandardMaterial({ 
    color: 0xff9900,
    transparent: true,
    opacity: 0.5 // Make it semi-transparent instead of invisible
  });
  
  player.value = new THREE.Mesh(playerGeometry, playerMaterial);
  scene.value.add(player.value);
  
  // Add camera to player - position at eye level
  player.value.add(camera.value);
  camera.value.position.set(0, playerHeight * 0.8, 0);
  camera.value.rotation.set(0, 0, 0); // Reset rotation
  
  // Initialize camera rotation
  cameraRotation.value.set(0, 0, 0);
  
  // Create ray visualizations
  createRayVisualizations();
};

// Create line objects to visualize the foot rays
const createRayVisualizations = () => {
  // Create material for ray lines
  const rayMaterial = new THREE.LineBasicMaterial({ 
    color: 0xffff00, // Yellow color for rays
    linewidth: 2
  });
  
  // Create geometries for ray lines (will be updated during gameplay)
  const rayGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, -1, 0) // Initial direction, will be updated
  ]);
  
  // Create lines for each ray
  leftRayLine.value = new THREE.Line(rayGeometry.clone(), rayMaterial);
  rightRayLine.value = new THREE.Line(rayGeometry.clone(), rayMaterial);
  centerRayLine.value = new THREE.Line(rayGeometry.clone(), rayMaterial);
  
  // Add to scene
  scene.value.add(leftRayLine.value);
  scene.value.add(rightRayLine.value);
  scene.value.add(centerRayLine.value);
};

// Update ray visualizations based on current foot positions
const updateRayVisualizations = (leftFootPos, rightFootPos, centerFootPos, rayDir, rayLength) => {
  if (!leftRayLine.value || !rightRayLine.value || !centerRayLine.value) return;
  
  // Convert rayDir to THREE.Vector3
  const rayDirVector = new THREE.Vector3(rayDir.x, rayDir.y, rayDir.z);
  
  // Calculate end points - using full ray length
  const leftRayEnd = leftFootPos.clone().add(rayDirVector.clone().multiplyScalar(rayLength));
  const rightRayEnd = rightFootPos.clone().add(rayDirVector.clone().multiplyScalar(rayLength));
  const centerRayEnd = centerFootPos.clone().add(rayDirVector.clone().multiplyScalar(rayLength));
  
  // Update line geometries
  leftRayLine.value.geometry.dispose();
  leftRayLine.value.geometry = new THREE.BufferGeometry().setFromPoints([
    leftFootPos, leftRayEnd
  ]);
  
  rightRayLine.value.geometry.dispose();
  rightRayLine.value.geometry = new THREE.BufferGeometry().setFromPoints([
    rightFootPos, rightRayEnd
  ]);
  
  centerRayLine.value.geometry.dispose();
  centerRayLine.value.geometry = new THREE.BufferGeometry().setFromPoints([
    centerFootPos, centerRayEnd
  ]);
  
  // Make ray colors more obvious - bright green/red and thicker
  leftRayLine.value.material.color.set(leftFootHit.value !== null ? 0x00ff00 : 0xff0000);
  rightRayLine.value.material.color.set(rightFootHit.value !== null ? 0x00ff00 : 0xff0000);
  centerRayLine.value.material.color.set(centerFootHit.value !== null ? 0x00ff00 : 0xff0000);
  
  // Try to make the lines thicker (note: some browsers/GPUs ignore this)
  leftRayLine.value.material.linewidth = 5;
  rightRayLine.value.material.linewidth = 5;
  centerRayLine.value.material.linewidth = 5;
};

// 1. Add collision point visualization for debugging
const collisionPoints = shallowRef([]);
const leftFootPos = shallowRef(new THREE.Vector3());
const rightFootPos = shallowRef(new THREE.Vector3());
const centerFootPos = shallowRef(new THREE.Vector3());
const rayDir = shallowRef(new THREE.Vector3(0, -1, 0));

// Add after createRayVisualizations
const updateCollisionVisualization = () => {
  // Remove old points
  if (collisionPoints.value.length > 0) {
    collisionPoints.value.forEach(point => {
      if (scene.value) scene.value.remove(point);
    });
    collisionPoints.value = [];
  }
  
  // Create visualization for hit points
  [leftFootHit.value, rightFootHit.value, centerFootHit.value].forEach((hit, index) => {
    if (!hit) return;
    
    const footPos = [leftFootPos.value, rightFootPos.value, centerFootPos.value][index];
    if (!footPos) return;
    
    // Calculate hit position
    const hitPos = new THREE.Vector3(
      footPos.x + rayDir.value.x * hit.toi,
      footPos.y + rayDir.value.y * hit.toi,
      footPos.z + rayDir.value.z * hit.toi
    );
    
    // Create hit point visualization
    const sphereGeometry = new THREE.SphereGeometry(0.1, 8, 8);
    const sphereMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
    sphere.position.copy(hitPos);
    
    scene.value.add(sphere);
    collisionPoints.value.push(sphere);
  });
};

// 2. Completely revamp the checkGrounded function for better collision detection
const checkGrounded = () => {
  if (!playerBody.value || !physicsWorld.value) return;
  
  // Get player position
  const playerTranslation = playerBody.value.translation();
  const playerPos = new THREE.Vector3(
    playerTranslation.x,
    playerTranslation.y,
    playerTranslation.z
  );
  
  // Calculate gravity direction at player's current position
  const gravityDir = new THREE.Vector3()
    .subVectors(gravity.center, playerPos)
    .normalize();
  
  // Store gravity direction for visualization
  rayDir.value.copy(gravityDir);
  
  // Calculate up vector (opposite to gravity)
  const upVector = gravityDir.clone().negate();
  
  // Get player orientation to calculate foot positions
  const forwardVector = new THREE.Vector3(0, 0, -1).applyQuaternion(player.value.quaternion);
  const rightVector = new THREE.Vector3().crossVectors(upVector, forwardVector).normalize();
  
  // Calculate foot positions with greater spread and lower position
  const footHeight = playerHeight * 0.5; // Place at bottom of capsule
  const footSpread = playerRadius * 1.2; // Increased spread for better coverage
  
  leftFootPos.value.copy(playerPos).add(
    rightVector.clone().multiplyScalar(-footSpread)
      .add(upVector.clone().multiplyScalar(-footHeight))
  );
  
  rightFootPos.value.copy(playerPos).add(
    rightVector.clone().multiplyScalar(footSpread)
      .add(upVector.clone().multiplyScalar(-footHeight))
  );
  
  centerFootPos.value.copy(playerPos).add(
    upVector.clone().multiplyScalar(-footHeight - 0.1) // Slightly lower than feet
  );
  
  // Use much longer rays for more reliable detection
  const rayLength = 5.0; // Significantly increased for better detection
  
  // Create RAPIER ray objects using gravity direction
  const leftRay = new RAPIER.Ray(
    { x: leftFootPos.value.x, y: leftFootPos.value.y, z: leftFootPos.value.z },
    { x: gravityDir.x, y: gravityDir.y, z: gravityDir.z }
  );
  
  const rightRay = new RAPIER.Ray(
    { x: rightFootPos.value.x, y: rightFootPos.value.y, z: rightFootPos.value.z },
    { x: gravityDir.x, y: gravityDir.y, z: gravityDir.z }
  );
  
  const centerRay = new RAPIER.Ray(
    { x: centerFootPos.value.x, y: centerFootPos.value.y, z: centerFootPos.value.z },
    { x: gravityDir.x, y: gravityDir.y, z: gravityDir.z }
  );
  
  // Set a very generous maxToi for initial contact
  const maxToi = 5.0; // Very generous distance
  
  // Cast rays - use true to ignore sensors and only detect solid colliders
  const leftResult = physicsWorld.value.castRay(leftRay, rayLength, true);
  leftFootHit.value = leftResult && leftResult.toi < maxToi ? leftResult : null;
  
  const rightResult = physicsWorld.value.castRay(rightRay, rayLength, true);
  rightFootHit.value = rightResult && rightResult.toi < maxToi ? rightResult : null;
  
  const centerResult = physicsWorld.value.castRay(centerRay, rayLength, true);
  centerFootHit.value = centerResult && centerResult.toi < maxToi ? centerResult : null;
  
  // Always log ray results for the first 100 frames
  if (frameCount.value < 100) {
    console.log(
      `Frame ${frameCount.value} - Ray hits:` +
      ` Left: ${leftFootHit.value ? leftFootHit.value.toi.toFixed(3) : 'none'},` +
      ` Right: ${rightFootHit.value ? rightFootHit.value.toi.toFixed(3) : 'none'},` +
      ` Center: ${centerFootHit.value ? centerFootHit.value.toi.toFixed(3) : 'none'}`
    );
  }
  
  // Update visualization of rays and hit points
  updateRayVisualizations(leftFootPos.value, rightFootPos.value, centerFootPos.value, 
                        {x: gravityDir.x, y: gravityDir.y, z: gravityDir.z}, rayLength);
  updateCollisionVisualization();
  
  // Check if any foot is touching ground (and we're not jumping)
  wasGrounded.value = isGrounded.value;
  const nowGrounded = !jumpInProgress.value && 
                     (leftFootHit.value !== null || 
                      rightFootHit.value !== null || 
                      centerFootHit.value !== null);
  
  // Log when grounded state changes
  if (wasGrounded.value !== nowGrounded) {
    console.log(`Grounded changed: ${wasGrounded.value} -> ${nowGrounded}`);
    
    isGrounded.value = nowGrounded;
    
    if (!wasGrounded.value && nowGrounded) {
      // We just landed
      console.log("Player landed on ground!");
      
      // Get ground normal for alignment
      const { groundNormal } = getGroundNormal();
      lastGroundNormal.value.copy(groundNormal);
    } else if (wasGrounded.value && !nowGrounded && !jumpInProgress.value) {
      // We just left the ground (not due to jumping)
      console.log("Player left ground!");
      resetCameraForAirborne();
    }
  } else {
    isGrounded.value = nowGrounded;
  }
};

// 3. Modify applyGroundFollowing to have stronger hover force
const applyGroundFollowing = () => {
  if (!playerBody.value) return;
  
  // Get player position
  const playerTranslation = playerBody.value.translation();
  const playerPos = new THREE.Vector3(
    playerTranslation.x,
    playerTranslation.y,
    playerTranslation.z
  );
  
  // Calculate gravity direction toward center of planet
  const gravityDir = new THREE.Vector3()
    .subVectors(gravity.center, playerPos)
    .normalize();
  
  // Only process if we have ground hit information
  if (leftFootHit.value || rightFootHit.value || centerFootHit.value) {
    // Get the closest hit to determine desired hover height
    let closestHit = null;
    let closestToi = Infinity;
    
    if (leftFootHit.value && leftFootHit.value.toi < closestToi) {
      closestHit = leftFootHit.value;
      closestToi = leftFootHit.value.toi;
    }
    
    if (rightFootHit.value && rightFootHit.value.toi < closestToi) {
      closestHit = rightFootHit.value;
      closestToi = rightFootHit.value.toi;
    }
    
    if (centerFootHit.value && centerFootHit.value.toi < closestToi) {
      closestHit = centerFootHit.value;
      closestToi = centerFootHit.value.toi;
    }
    
    if (closestHit) {
      // Calculate desired hover height - increased significantly
      const targetHoverHeight = 0.3; // Increased for more obvious separation
      const currentHeight = closestToi; // Current distance to ground
      
      // Calculate adjustment needed
      const heightAdjustment = targetHoverHeight - currentHeight;
      
      // Apply stronger hover force
      if (Math.abs(heightAdjustment) > 0.001) {
        // Apply 3x stronger correction to ensure player stays above ground
        const adjustmentVector = gravityDir.clone().multiplyScalar(heightAdjustment * 3.0);
        
        // Get new position
        const newPos = {
          x: playerPos.x + adjustmentVector.x,
          y: playerPos.y + adjustmentVector.y,
          z: playerPos.z + adjustmentVector.z
        };
        
        // Set position directly
        playerBody.value.setNextKinematicTranslation(newPos);
        
        // Log for first 100 frames or occasionally
        if (frameCount.value < 100 || Math.random() < 0.01) {
          console.log(`Hover: height=${currentHeight.toFixed(3)}, adjustment=${heightAdjustment.toFixed(3)}`);
        }
      }
    }
  } else {
    // Apply falling - use MUCH slower fall speed initially to give rays time to detect ground
    const fallSpeed = frameCount.value < 100 ? 0.05 : 0.2; // Start with slower fall
    
    const newPos = {
      x: playerPos.x + gravityDir.x * fallSpeed,
      y: playerPos.y + gravityDir.y * fallSpeed,
      z: playerPos.z + gravityDir.z * fallSpeed
    };
    
    playerBody.value.setNextKinematicTranslation(newPos);
    
    // Log falling occasionally
    if (frameCount.value < 100 || Math.random() < 0.01) {
      console.log("Falling toward planet center, speed:", fallSpeed);
    }
  }
  
  // Update stuck detection
  if (!lastPlayerPosition.value) {
    lastPlayerPosition.value = playerPos.clone();
    positionStuckFrames.value = 0;
  } else if (playerPos.distanceTo(lastPlayerPosition.value) < 0.001) {
    positionStuckFrames.value++;
    if (positionStuckFrames.value > 60) { // Allow more frames before considering stuck
      console.log("Player stuck for too long - applying unstuck adjustment");
      
      // Move player up slightly to unstick
      const unstuckPos = {
        x: playerPos.x - gravityDir.x * 0.5,
        y: playerPos.y - gravityDir.y * 0.5, 
        z: playerPos.z - gravityDir.z * 0.5
      };
      
      playerBody.value.setNextKinematicTranslation(unstuckPos);
      positionStuckFrames.value = 0;
    }
  } else {
    // Player is moving, update last position and reset counter
    lastPlayerPosition.value.copy(playerPos);
    positionStuckFrames.value = 0;
  }
};

// Update updatePhysics to use the new approach
const updatePhysics = (deltaTime) => {
  // Apply ground following - this replaces gravity for kinematic bodies
  applyGroundFollowing();
  
  // Handle ground alignment when grounded
  if (isGrounded.value && playerBody.value) {
    const { groundNormal, upVector } = getGroundNormal();
    alignPlayerWithGround(groundNormal, upVector);
  }
  
  // Periodically log position for debugging
  const currentTime = performance.now();
  if (currentTime - lastDebugTime.value > 1000) { // Once per second
    lastDebugTime.value = currentTime;
    if (playerBody.value) {
      const pos = playerBody.value.translation();
      
      console.log(
        `Player - Position: Y=${pos.y.toFixed(2)}, ` +
        `Speed: ${currentSpeed.value.toFixed(2)}, ` +
        `Grounded: ${isGrounded.value}, ` +
        `Kinematic: ${playerBody.value.isKinematic()}`
      );
    }
  }
  
  // Step the physics world - single call to avoid conflicts
  physicsWorld.value.step();
  
  // After physics step, update speed (only for UI)
  currentSpeed.value = isMoving.value ? (keys.run ? runSpeed : walkSpeed) : 0;
};

// Modify handlePlayerMovement for kinematic body
const handlePlayerMovement = (deltaTime) => {
  if (!playerBody.value || !started.value) return;
  
  const moveSpeed = keys.run ? runSpeed : walkSpeed;
  const moveDir = new THREE.Vector3(0, 0, 0);
  
  // Reset moving state
  isMoving.value = false;
  
  // Get input direction
  if (keys.forward) moveDir.z -= 1;
  if (keys.backward) moveDir.z += 1;
  if (keys.left) moveDir.x -= 1;
  if (keys.right) moveDir.x += 1;
  
  // Check if there's any movement input
  if (moveDir.length() > 0) {
    moveDir.normalize();
    isMoving.value = true;
    
    // Get current position
    const playerTranslation = playerBody.value.translation();
    const playerPos = new THREE.Vector3(
      playerTranslation.x,
      playerTranslation.y,
      playerTranslation.z
    );
    
    // Handle movement differently based on grounded state
    if (isGrounded.value) {
      // On ground, use terrain-aligned movement
      const groundData = getGroundNormal();
      const groundNormal = groundData.groundNormal;
      
      // Get right vector using cross product with world-up
      const worldUp = new THREE.Vector3(0, 1, 0);
      let tangentX = new THREE.Vector3();
      let tangentZ = new THREE.Vector3();
      
      if (Math.abs(groundNormal.dot(worldUp)) > 0.99) {
        // If ground normal is close to world-up, use world-forward as reference
        tangentX = new THREE.Vector3(1, 0, 0);
        tangentZ = new THREE.Vector3(0, 0, 1);
      } else {
        // Get right vector using cross product with world-up
        tangentX = new THREE.Vector3().crossVectors(worldUp, groundNormal).normalize();
        // Get forward vector using cross product with right vector
        tangentZ = new THREE.Vector3().crossVectors(groundNormal, tangentX).normalize();
      }
      
      // Get player's yaw rotation around the ground normal
      const playerForward = new THREE.Vector3(0, 0, -1).applyQuaternion(player.value.quaternion);
      
      // Project player forward onto the tangent plane
      const playerForwardOnPlane = projectVectorOntoPlane(playerForward, groundNormal);
      playerForwardOnPlane.normalize();
      
      // Get the angle between tangentZ and playerForwardOnPlane
      let angle = Math.atan2(
        new THREE.Vector3().crossVectors(tangentZ, playerForwardOnPlane).dot(groundNormal),
        tangentZ.dot(playerForwardOnPlane)
      );
      
      // Rotate tangent basis by this angle
      const rotatedTangentX = tangentX.clone().applyAxisAngle(groundNormal, angle);
      const rotatedTangentZ = tangentZ.clone().applyAxisAngle(groundNormal, angle);
      
      // Convert input direction to movement in this tangent space
      const moveTangent = new THREE.Vector3(
        moveDir.x * rotatedTangentX.x + moveDir.z * rotatedTangentZ.x,
        moveDir.x * rotatedTangentX.y + moveDir.z * rotatedTangentZ.y,
        moveDir.x * rotatedTangentX.z + moveDir.z * rotatedTangentZ.z
      ).normalize();
      
      // Scale by speed and deltaTime for consistent movement
      const adjustedSpeed = moveSpeed * deltaTime * 60; // Normalize for 60fps
      const moveVector = moveTangent.multiplyScalar(adjustedSpeed);
      
      // Calculate new position by adding movement vector
      const newPos = {
        x: playerPos.x + moveVector.x,
        y: playerPos.y + moveVector.y,
        z: playerPos.z + moveVector.z
      };
      
      // Set next position directly
      playerBody.value.setNextKinematicTranslation(newPos);
      
      currentSpeed.value = moveSpeed;
    } else {
      // In air, allow limited control
      // Get camera direction for air movement
      const movementQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, cameraRotation.value.y, 0)
      );
      
      // Apply movement based on camera's yaw direction
      const moveVec = moveDir.clone().applyQuaternion(movementQuat);
      
      // Reduced control in air
      const airControlMultiplier = moveSpeed * 0.3 * deltaTime * 60; 
      
      // Calculate new position
      const newPos = {
        x: playerPos.x + moveVec.x * airControlMultiplier,
        y: playerPos.y, // Height handled by applyGroundFollowing
        z: playerPos.z + moveVec.z * airControlMultiplier
      };
      
      // Set next position directly
      playerBody.value.setNextKinematicTranslation(newPos);
    }
  }
  
  // Handle jumping - completely different for kinematic bodies
  if (keys.jump && isGrounded.value && playerBody.value) {
    keys.jump = false; // Prevent multiple jumps
    
    // For kinematic bodies, we'll just set a "jump state" and handle in applyGroundFollowing
    jumpInProgress.value = true;
    jumpTime.value = 0;
    console.log("Jump initiated");
  }
};

// Add variables for jump handling
const jumpInProgress = ref(false);
const jumpTime = ref(0);
const jumpDuration = 0.5; // seconds
const jumpHeight = 2; // maximum jump height

// 4. Update the animation loop to ensure physics is updated after movement
const animate = () => {
  if (!started.value) return;
  
  requestAnimationFrame(animate);
  
  try {
    // Clear any previous error message if things are working
    if (errorMessage.value) {
      errorMessage.value = '';
    }
    
    const deltaTime = Math.min(clock.getDelta(), 0.1);
    
    // Handle jump state progression
    if (jumpInProgress.value) {
      jumpTime.value += deltaTime;
      
      if (jumpTime.value >= jumpDuration) {
        jumpInProgress.value = false;
        jumpTime.value = 0;
        console.log("Jump completed");
      } else {
        // Calculate jump height using sine wave (smooth up and down)
        const jumpProgress = jumpTime.value / jumpDuration;
        const jumpOffset = Math.sin(jumpProgress * Math.PI) * jumpHeight;
        
        // Get current position
        const playerTranslation = playerBody.value.translation();
        const playerPos = new THREE.Vector3(
          playerTranslation.x,
          playerTranslation.y,
          playerTranslation.z
        );
        
        // Get jump direction (opposite to gravity)
        const gravityDir = new THREE.Vector3()
          .subVectors(gravity.center, playerPos)
          .normalize();
        const jumpDir = gravityDir.clone().negate();
        
        // Apply jump offset
        const newPos = {
          x: playerPos.x + jumpDir.x * jumpOffset * deltaTime * 10,
          y: playerPos.y + jumpDir.y * jumpOffset * deltaTime * 10,
          z: playerPos.z + jumpDir.z * jumpOffset * deltaTime * 10
        };
        
        // Set next position directly
        playerBody.value.setNextKinematicTranslation(newPos);
      }
    }
    
    // Ensure all necessary components are initialized before proceeding
    if (!physicsWorld.value || !playerBody.value || !player.value) {
      console.warn("Waiting for game components to initialize...");
      return;
    }
    
    // Log initial positions in the first few frames to help with debugging
    if (frameCount.value < 10) {  // Add .value here
      const playerPos = playerBody.value.translation();
      const meshPos = player.value.position;
      const platformPos = platform.value ? platform.value.position : null;
      console.log(`Frame ${frameCount.value}: Physics at Y=${playerPos.y.toFixed(2)}, Mesh at Y=${meshPos.y.toFixed(2)}, Platform at Y=${platformPos ? platformPos.y : 'unknown'}`);
      frameCount.value++;  // Add .value here
    }
    
    // Increment frame counter for debugging
    frameCount.value++;
    
    // First check for ground contact
    checkGrounded();
    
    // Then apply hover/gravity
    applyGroundFollowing();
    
    // Handle player movement input
    handlePlayerMovement(deltaTime);
    
    // Then step physics simulation
    physicsWorld.value.step();
    
    // Update player transform to match physics body
    updatePlayerTransform();
    
    // Update camera if detached
    if (isCameraDetached.value) {
      updateDetachedCamera();
    }
    
    // Update UI position display
    if (playerBody.value) {
      const position = playerBody.value.translation();
      const displayPos = playerPosition.value;
      displayPos.set(position.x, position.y, position.z);
    }
    
    // Render scene if available
    if (renderer.value && scene.value && camera.value) {
      renderer.value.render(scene.value, camera.value);
    }
  } catch (e) {
    errorMessage.value = "Error in animation loop: " + e.message;
    console.error("Error in animation loop:", e);
    // Continue animation loop despite errors
  }
};

// Add this variable near other declarations
const lastGroundNormal = shallowRef(new THREE.Vector3(0, 1, 0));
const rotationStabilityThreshold = 0.01; // Minimum angle change to apply rotation

// Add function to align player with ground
const alignPlayerWithGround = (normal, upVector) => {
  if (!isGrounded.value || !playerBody.value) return;
  
  try {
    // Check if the ground normal has changed significantly
    const normalDifference = normal.clone().sub(lastGroundNormal.value).length();
    
    // Only apply alignment if standing on a significantly different normal
    // or if moving (which requires constant alignment to the terrain)
    const shouldAlign = normalDifference > rotationStabilityThreshold || isMoving.value;
    
    if (!shouldAlign) {
      // Skip alignment if ground normal hasn't changed enough and we're not moving
      return;
    }
    
    // Update the last ground normal
    lastGroundNormal.value.copy(normal);
    
    // Create a rotation that aligns the player with the ground
    
    // Get current forward direction from the player
    const playerForward = new THREE.Vector3(0, 0, -1).applyQuaternion(player.value.quaternion);
    
    // Project the current forward direction onto the ground plane defined by the normal
    const dot = playerForward.dot(normal);
    const projectedForward = playerForward.clone().sub(normal.clone().multiplyScalar(dot));
    
    // If the projection is too small, use camera forward as a fallback
    if (projectedForward.length() < 0.1) {
      const cameraForward = new THREE.Vector3(0, 0, -1).applyEuler(
        new THREE.Euler(0, cameraRotation.value.y, 0)
      );
      const cameraDot = cameraForward.dot(normal);
      projectedForward.copy(cameraForward).sub(normal.clone().multiplyScalar(cameraDot));
    }
    
    // Normalize to get direction
    if (projectedForward.length() > 0.001) {
      projectedForward.normalize();
    } else {
      // Last resort fallback - arbitrary direction perpendicular to normal
      projectedForward.set(1, 0, 0);
      if (Math.abs(normal.dot(projectedForward)) > 0.9) {
        projectedForward.set(0, 0, 1);
      }
      const tempDot = projectedForward.dot(normal);
      projectedForward.sub(normal.clone().multiplyScalar(tempDot)).normalize();
    }
    
    // Create orthogonal basis using the normal and projected forward
    const right = new THREE.Vector3().crossVectors(normal, projectedForward).normalize();
    const forward = new THREE.Vector3().crossVectors(right, normal).normalize();
    
    // Create rotation matrix from the orthogonal vectors
    const rotMatrix = new THREE.Matrix4().makeBasis(right, normal, forward);
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(rotMatrix);
    
    // Get current player quaternion
    const currentQuat = new THREE.Quaternion(
      playerBody.value.rotation().x,
      playerBody.value.rotation().y,
      playerBody.value.rotation().z,
      playerBody.value.rotation().w
    );
    
    // Use a more adaptive slerp factor based on current speed and stability
    const isMovingOnGround = isMoving.value && isGrounded.value;
    const speed = currentSpeed.value;
    let slerpFactor;
    
    if (isMovingOnGround) {
      // Faster alignment when moving at higher speeds (up to 0.35)
      slerpFactor = Math.min(0.35, 0.2 + speed * 0.01);
    } else {
      // Even slower, gentler alignment when standing still to prevent jitter
      slerpFactor = 0.05;
    }
    
    // Smoothly interpolate between current and target orientation
    currentQuat.slerp(quaternion, slerpFactor);
    
    // Apply the smoothed rotation - only wake the body if moving
    playerBody.value.setRotation(
      { x: currentQuat.x, y: currentQuat.y, z: currentQuat.z, w: currentQuat.w },
      isMovingOnGround // Only wake the body if moving to reduce jitter
    );
  } catch (e) {
    console.error("Error in alignPlayerWithGround:", e);
  }
};

// Add updatePlayerTransform function if it's missing
const updatePlayerTransform = () => {
  if (!playerBody.value || !player.value) return;
  
  try {
    // Get position from physics body
    const position = playerBody.value.translation();
    
    // Update player mesh position to match physics body
    player.value.position.set(position.x, position.y, position.z);
    
    // Get rotation from physics body
    const rotation = playerBody.value.rotation();
    player.value.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    
    // Handle camera rotation with better state transitions
    if (isGrounded.value) {
      // When grounded, the camera only needs to handle pitch
      camera.value.rotation.x = cameraRotation.value.x;
      // Explicitly zero out other rotations to avoid any residual values
      camera.value.rotation.y = 0;
      camera.value.rotation.z = 0;
    } else {
      // When airborne, camera handles both pitch and yaw
      camera.value.rotation.x = cameraRotation.value.x;
      camera.value.rotation.y = cameraRotation.value.y;
      camera.value.rotation.z = 0;
    }
  } catch (e) {
    console.error("Error updating player transform:", e);
  }
};

// Add updateDetachedCamera function if it's missing
const updateDetachedCamera = () => {
  if (!isCameraDetached.value || !camera.value || !player.value) return;
  
  // Position camera behind and above the player
  const playerPos = player.value.position.clone();
  const detachedDistance = 10; // Distance from player
  const detachedHeight = 5;   // Height above player
  
  // Get camera position based on player's forward direction
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(player.value.quaternion);
  const backward = forward.clone().negate();
  
  // Set camera position behind and above player
  camera.value.position.copy(playerPos)
    .add(backward.multiplyScalar(detachedDistance))
    .add(new THREE.Vector3(0, detachedHeight, 0));
  
  // Look at player
  camera.value.lookAt(playerPos);
};

// Add toggleCameraAttachment function if it's missing
const toggleCameraAttachment = () => {
  if (!camera.value || !player.value || !scene.value) {
    console.warn("Cannot toggle camera attachment - required components not initialized");
    return;
  }
  
  isCameraDetached.value = !isCameraDetached.value;
  console.log("Camera detached:", isCameraDetached.value);
  
  if (isCameraDetached.value) {
    // Detach camera from player
    const cameraWorldPos = new THREE.Vector3();
    camera.value.getWorldPosition(cameraWorldPos);
    
    try {
      // Remove camera from player and add directly to scene
      player.value.remove(camera.value);
      scene.value.add(camera.value);
      
      // Set initial detached camera position
      updateDetachedCamera();
    } catch (e) {
      console.error("Error detaching camera:", e);
      isCameraDetached.value = false; // Revert state change
    }
  } else {
    try {
      // Reattach camera to player
      scene.value.remove(camera.value);
      player.value.add(camera.value);
      
      // Reset camera position relative to player
      camera.value.position.set(0, playerHeight * 0.8, 0);
      camera.value.rotation.set(cameraRotation.value.x, 0, 0);
    } catch (e) {
      console.error("Error reattaching camera:", e);
      isCameraDetached.value = true; // Revert state change
    }
  }
};

// Remove the duplicate checkGrounded function that begins at line 897
// Keep only the kinematic version at line 1308

// Remove this entire function and its comment from around line 897:
// const checkGrounded = () => {
//   ...entire function implementation...
// };

// The kinematic version at line 1308 should remain untouched since it's 
// specifically designed for the kinematic position-based player character
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

.error-message {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background-color: rgba(200, 0, 0, 0.8);
  color: white;
  padding: 15px 20px;
  border-radius: 5px;
  font-family: Arial, sans-serif;
  font-size: 16px;
  max-width: 80%;
  text-align: center;
  z-index: 1000;
}
</style>
