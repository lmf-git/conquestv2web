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
const playerPosition = ref(new THREE.Vector3());
const isMoving = ref(false);
const currentSpeed = ref(0);
const isCameraDetached = ref(false); // Track if camera is detached

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
  strength: 10  // Reduced from 20 to 10 for more natural feel
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
  planetColliderDesc.setFriction(2.0); // Increased from 1.2 to 2.0 for even better grip
  planetColliderDesc.setRestitution(0.0); // No bounce at all
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
  platformColliderDesc.setFriction(2.0); // Increased from 1.0 to 2.0 for better grip
  platformColliderDesc.setRestitution(0.0); // No bounce
  physicsWorld.value.createCollider(platformColliderDesc, platformBody);
};

const createPlayer = () => {
  // Create player physics body - spawn higher above platform
  const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, 50, 0)
    .setLinearDamping(2.0) // Increased from 0.5 to 2.0 to reduce bounciness
    .setAngularDamping(10.0)
    .setCcdEnabled(true);
  
  playerBody.value = physicsWorld.value.createRigidBody(playerBodyDesc);
  
  // Add initial downward velocity to start falling immediately
  playerBody.value.setLinvel({ x: 0, y: -1, z: 0 }, true); // Reduced initial velocity
  
  // Create player collider (capsule shape)
  const playerColliderDesc = RAPIER.ColliderDesc.capsule(
    playerHeight / 2 - playerRadius,
    playerRadius
  );
  playerColliderDesc.setFriction(2.5); // Increased from 1.5 to 2.5 for better ground grip
  playerColliderDesc.setRestitution(0.0);
  physicsWorld.value.createCollider(playerColliderDesc, playerBody.value);
  
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
  
  // Calculate end points
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
  
  // Change color based on hit/miss
  leftRayLine.value.material.color.set(leftFootHit.value !== null ? 0x00ff00 : 0xff0000);
  rightRayLine.value.material.color.set(rightFootHit.value !== null ? 0x00ff00 : 0xff0000);
  centerRayLine.value.material.color.set(centerFootHit.value !== null ? 0x00ff00 : 0xff0000); // Update to use centerFootHit.value
};

// Modify checkGrounded to update ray visualizations
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
  
  // Cast rays with slightly longer length for better detection
  const rayLength = 0.7; // Increased for better detection and earlier response
  
  // Add more rays for better ground detection
  const centerFootPos = playerPos.clone().add(
    upVector.clone().multiplyScalar(-footHeight)
  );
  
  // Create rays for left, right, and center feet
  const rayDir = { x: gravityDir.x, y: gravityDir.y, z: gravityDir.z };
  
  const leftRay = new RAPIER.Ray(
    { x: leftFootPos.x, y: leftFootPos.y, z: leftFootPos.z },
    rayDir
  );
  
  const rightRay = new RAPIER.Ray(
    { x: rightFootPos.x, y: rightFootPos.y, z: rightFootPos.z },
    rayDir
  );
  
  // Cast an extra ray from the center for stability
  const centerRay = new RAPIER.Ray(
    { x: centerFootPos.x, y: centerFootPos.y, z: centerFootPos.z },
    rayDir
  );
  
  // Perform raycasts
  leftFootHit.value = physicsWorld.value.castRay(leftRay, rayLength, true);
  rightFootHit.value = physicsWorld.value.castRay(rightRay, rayLength, true);
  centerFootHit.value = physicsWorld.value.castRay(centerRay, rayLength, true); // Update to store in .value
  
  // Update ray visualizations
  updateRayVisualizations(leftFootPos, rightFootPos, centerFootPos, rayDir, rayLength);
  
  // Check if any foot is on ground
  const wasGrounded = isGrounded.value;
  const nowGrounded = (leftFootHit.value !== null) || (rightFootHit.value !== null) || (centerFootHit.value !== null); // Update to use centerFootHit.value
  
  // Update grounded state
  isGrounded.value = nowGrounded;
  
  // If just landed, reduce vertical velocity to prevent bouncing
  if (!wasGrounded && nowGrounded && playerBody.value) {
    const vel = playerBody.value.linvel();
    // If moving downward significantly
    if (vel.y < -2) {
      // Reduce vertical velocity by 90%
      playerBody.value.setLinvel({
        x: vel.x,
        y: vel.y * 0.1, // Absorb 90% of the vertical impact
        z: vel.z
      }, true);
    }
    
    // Initialize the last ground normal when landing
    const { groundNormal } = getGroundNormal();
    lastGroundNormal.value.copy(groundNormal);
  }
  
  // If just left the ground, apply a small impulse to ensure gravity takes effect immediately
  if (wasGrounded && !nowGrounded && playerBody.value) {
    // Add a tiny downward impulse to kickstart falling
    const { gravityDir } = getGroundNormal();
    playerBody.value.applyImpulse({
      x: gravityDir.x * 0.1,
      y: gravityDir.y * 0.1,
      z: gravityDir.z * 0.1
    }, true);
    
    // Reset camera rotation for air state
    resetCameraForAirborne();
  }
  
  // Do NOT align with ground here - moved to updatePhysics to avoid duplicate alignment
};

// Add this variable to track rotation stability
const lastGroundNormal = shallowRef(new THREE.Vector3(0, 1, 0));
const rotationStabilityThreshold = 0.01; // Minimum angle change to apply rotation

// Improve the alignPlayerWithGround function to avoid micro-oscillations
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
    
    // IMPROVED: Use a more adaptive slerp factor based on current speed and stability
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

// Define updatePlayerTransform before animate calls it
const updatePlayerTransform = () => {
  if (!playerBody.value || !player.value) return;
  
  try {
    // Get position from physics body
    const position = playerBody.value.translation();
    
    // Update player position
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

// Improve the startGame function with better error handling
const startGame = () => {
  console.log("Starting game...");
  started.value = true;

  try {
    // Try to request pointer lock, but don't depend on it to start the game
    if (gameCanvas.value) {
      gameCanvas.value.requestPointerLock();
      
      // Add event listener to handle pointer lock errors
      document.addEventListener('pointerlockerror', (e) => {
        console.warn('Pointer lock error, continuing without mouse control:', e);
        // Continue with game anyway
        if (!clock.running) {
          clock.start();
          animate();
        }
      }, { once: true });
    } else {
      console.warn("Game canvas not available for pointer lock");
    }
    
    // Always start the animation loop regardless of pointer lock status
    if (!clock.running) {
      clock.start();
      animate();
    }
  } catch (e) {
    console.error("Error starting game:", e);
    // Ensure game starts even if there's an error
    if (!clock.running) {
      clock.start();
      animate();
    }
  }
};

// Keep only this one animate function
const animate = () => {
  if (!started.value) return;
  
  // Use the browser's requestAnimationFrame for better performance
  requestAnimationFrame(animate);
  
  try {
    const deltaTime = Math.min(clock.getDelta(), 0.1);
    
    // Ensure all necessary components are initialized before proceeding
    if (!physicsWorld.value || !playerBody.value || !player.value) {
      console.warn("Waiting for game components to initialize...");
      return;
    }
    
    // First check ground contact
    checkGrounded();
    
    // Then update physics simulation
    updatePhysics(deltaTime);
    
    // Then update player position and rotation
    updatePlayerTransform();
    
    // Update camera position if detached
    if (isCameraDetached.value) {
      updateDetachedCamera();
    }
    
    // Then handle player movement
    handlePlayerMovement(deltaTime);
    
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
    console.error("Error in animation loop:", e);
    // Continue animation loop despite errors
  }
};

// Function to handle detached camera position
const updateDetachedCamera = () => {
  if (!camera.value || !player.value) return;
  
  // Calculate position behind and above player
  const cameraOffset = new THREE.Vector3(0, 3, 8); // Above and behind
  
  // Convert to world space accounting for player orientation
  const targetPosition = player.value.position.clone();
  
  // Position camera to look at player
  camera.value.position.copy(targetPosition.clone().add(cameraOffset));
  
  // Make camera look at player
  camera.value.lookAt(targetPosition);
};

// Toggle camera attachment with the 'o' key
const toggleCameraAttachment = () => {
  isCameraDetached.value = !isCameraDetached.value;
  
  if (isCameraDetached.value) {
    // Detach camera from player
    const cameraWorldPos = new THREE.Vector3();
    camera.value.getWorldPosition(cameraWorldPos);
    
    // Remove camera from player and add directly to scene
    player.value.remove(camera.value);
    scene.value.add(camera.value);
    
    // Keep camera at same position initially
    camera.value.position.copy(cameraWorldPos);
  } else {
    // Reattach camera to player
    scene.value.remove(camera.value);
    player.value.add(camera.value);
    
    // Reset camera position relative to player
    camera.value.position.set(0, playerHeight * 0.8, 0);
    camera.value.rotation.set(cameraRotation.value.x, 0, 0);
  }
};

// Add 'o' key handler for camera toggle
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
    case 'KeyO':
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
    case 'Escape':
      if (document.pointerLockElement === gameCanvas.value) {
        document.exitPointerLock();
      }
      break;
  }
};

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
        const yawQuat = new THREE.Quaternion().setFromAxisAngle(
          groundNormal, 
          event.movementX * groundTurnSensitivity
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
      cameraRotation.value.y += event.movementX * lookSensitivity;
    }
  } catch (e) {
    console.error("Error in mouse move:", e);
  }
};

// Add the onResize function to handle window resizing
const onResize = () => {
  if (!camera.value || !renderer.value) return;
  
  // Update camera aspect ratio
  camera.value.aspect = window.innerWidth / window.innerHeight;
  camera.value.updateProjectionMatrix();
  
  // Resize renderer
  renderer.value.setSize(window.innerWidth, window.innerHeight);
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

// Add helper to reset camera for airborne state
const resetCameraForAirborne = () => {
  // Save player's current yaw rotation before switching to camera-based rotation
  if (player.value) {
    // Extract yaw from player's current quaternion
    const playerEuler = new THREE.Euler().setFromQuaternion(player.value.quaternion, 'YXZ');
    // Set camera's yaw to match player's current direction
    cameraRotation.value.y = playerEuler.y;
  }
};

// Helper function to project a vector onto a plane defined by its normal
const projectVectorOntoPlane = (vector, planeNormal) => {
  const dot = vector.dot(planeNormal);
  return vector.clone().sub(planeNormal.clone().multiplyScalar(dot));
};

// Add this function to apply gravity to the player
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
  
  // Apply gravity force - stronger when not grounded
  const gravityStrength = gravity.strength * (isGrounded.value ? 0.1 : 1.0);
  const force = {
    x: gravityDir.x * gravityStrength,
    y: gravityDir.y * gravityStrength,
    z: gravityDir.z * gravityStrength
  };
  
  // Use addForce to apply gravity
  playerBody.value.addForce(force);
};

// Add the missing updatePhysics function
const updatePhysics = (deltaTime) => {
  // Apply point gravity to player
  applyPointGravity();
  
  // Force upright orientation when grounded to prevent rolling
  if (isGrounded.value && playerBody.value) {
    // Get ground normal and related vectors
    const { groundNormal, upVector } = getGroundNormal();
    
    // Force align with ground normal
    alignPlayerWithGround(groundNormal, upVector);
    
    // Force zero angular velocity to prevent any rolling
    playerBody.value.setAngvel({ x: 0, y: 0, z: 0 }, isMoving.value);
    
    // Apply a small stabilizing force to keep player pressed against the ground
    // This helps prevent bouncing and sliding
    const stabilizingForce = {
      x: groundNormal.x * -0.8, // Reduced force to prevent jitter
      y: groundNormal.y * -0.8, 
      z: groundNormal.z * -0.8
    };
    playerBody.value.addForce(stabilizingForce);
  }
  
  // Step physics world
  physicsWorld.value.step();
  
  // After physics step, get current velocity for debug info
  if (playerBody.value) {
    const vel = playerBody.value.linvel();
    currentSpeed.value = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
  }
};

// Add player movement handling function
const handlePlayerMovement = (deltaTime) => {
  if (!playerBody.value || !started.value) return;
  
  const moveSpeed = keys.run ? runSpeed : walkSpeed;
  const moveDir = new THREE.Vector3(0, 0, 0);
  
  // Reset moving state
  isMoving.value = false;
  
  // Handle movement input
  if (keys.forward) moveDir.z -= 1;
  if (keys.backward) moveDir.z += 1;
  if (keys.left) moveDir.x -= 1;
  if (keys.right) moveDir.x += 1;
  
  // Check if there's any movement input
  if (moveDir.length() > 0) {
    moveDir.normalize();
    
    if (!playerBody.value) return;
    
    // Get ground normal and related vectors
    const groundData = getGroundNormal();
    const groundNormal = groundData.groundNormal;
    const upVector = groundData.upVector;
    
    // When grounded, use player's forward direction
    // When airborne, use camera's yaw direction
    let finalMoveVec = new THREE.Vector3();
    
    if (isGrounded.value) {
      // Create a rotation basis that's aligned with the ground normal
      const worldUp = new THREE.Vector3(0, 1, 0);
      let tangentX = new THREE.Vector3();
      let tangentZ = new THREE.Vector3();
      
      // If ground normal is close to world-up, use world-forward as reference
      if (Math.abs(groundNormal.dot(worldUp)) > 0.99) {
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
      
      // Now we have a tangent basis aligned with player's orientation
      // Convert input direction to movement in this tangent space
      const moveTangent = new THREE.Vector3(
        moveDir.x * rotatedTangentX.x + moveDir.z * rotatedTangentZ.x,
        moveDir.x * rotatedTangentX.y + moveDir.z * rotatedTangentZ.y,
        moveDir.x * rotatedTangentX.z + moveDir.z * rotatedTangentZ.z
      ).normalize();
      
      // Scale by speed and delta
      finalMoveVec = moveTangent.multiplyScalar(moveSpeed * deltaTime * 30);
      
      // Add minimal upward component to prevent sliding
      finalMoveVec.add(groundNormal.clone().multiplyScalar(0.05 * moveSpeed * deltaTime));
      
      // Get current velocity
      const currentVel = playerBody.value.linvel();
      
      // Blend with current velocity but maintain more directional control
      const newVel = {
        x: finalMoveVec.x * 20 + currentVel.x * 0.1,
        y: currentVel.y, // Preserve vertical velocity
        z: finalMoveVec.z * 20 + currentVel.z * 0.1
      };
      
      // Apply velocity directly
      playerBody.value.setLinvel(newVel, true);
      
      isMoving.value = true;
      currentSpeed.value = finalMoveVec.length() / (deltaTime * 20);
    } else {
      // Airborne movement
      // Use camera's yaw direction
      const movementQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, cameraRotation.value.y, 0)
      );
      
      // Apply movement based on camera's yaw direction
      const moveVec = moveDir.clone().applyQuaternion(movementQuat);
      
      // Reduced control in air
      finalMoveVec = moveVec.multiplyScalar(moveSpeed * 0.1 * deltaTime * 20);
      
      // Apply impulse in air
      const playerTranslation = playerBody.value.translation();
      playerBody.value.applyImpulseAtPoint(
        { x: finalMoveVec.x, y: finalMoveVec.y, z: finalMoveVec.z },
        playerTranslation,
        true
      );
      
      isMoving.value = true;
      currentSpeed.value = finalMoveVec.length() / (deltaTime * 20);
    }
  } else if (isGrounded.value && playerBody.value) {
    // When no input but grounded, apply slight damping to stop sliding
    const currentVel = playerBody.value.linvel();
    if (Math.abs(currentVel.x) > 0.1 || Math.abs(currentVel.z) > 0.1) {
      playerBody.value.setLinvel({
        x: currentVel.x * 0.8,
        y: currentVel.y,
        z: currentVel.z * 0.8
      }, true);
    }
  }
  
  // Handle jumping
  if (keys.jump && isGrounded.value && playerBody.value) {
    // Get player position and related vectors
    const jumpData = getGroundNormal();
    const jumpPlayerPos = jumpData.playerPos;
    const jumpGravityDir = jumpData.gravityDir;
    
    const distToPlanet = jumpPlayerPos.distanceTo(gravity.center);
    
    // Calculate jump direction (opposite to gravity)
    const jumpDir = jumpGravityDir.clone().negate();
    
    // Apply jump impulse - reduce force when on the planet to prevent glitching
    const jumpMultiplier = distToPlanet < 110 ? 0.7 : 1.0;
    
    playerBody.value.applyImpulse({
      x: jumpDir.x * jumpForce * jumpMultiplier,
      y: jumpDir.y * jumpForce * jumpMultiplier,
      z: jumpDir.z * jumpForce * jumpMultiplier
    }, true);
    
    // Prevent multiple jumps
    keys.jump = false;
  }
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
