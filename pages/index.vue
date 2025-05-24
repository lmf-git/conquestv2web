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

// Make sure rayDir exists globally first thing
window.rayDir = new THREE.Vector3(0, -1, 0);

// Define the reactive version and all related ray variables properly
const rayDir = shallowRef(window.rayDir);
const leftFootPos = shallowRef(new THREE.Vector3());
const rightFootPos = shallowRef(new THREE.Vector3());
const centerFootPos = shallowRef(new THREE.Vector3());
const collisionPoints = shallowRef([]);

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
    
    // Check if physics world exists, if not create a fallback
    if (!physicsWorld.value && RAPIER.World) {
      console.warn("Physics world not initialized, creating a fallback");
      physicsWorld.value = new RAPIER.World({ x: 0, y: -20, z: 0 });
      
      // Create necessary game objects if they don't exist
      if (!platform.value) createPlatform();
      if (!player.value) createPlayer();
    }
    
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

// Fix by adding the missing animate function
const animate = () => {
  if (!started.value) return;
  
  requestAnimationFrame(animate);
  
  try {
    // Ensure rayDir is initialized
    if (!rayDir || !rayDir.value) {
      console.warn("rayDir not initialized, creating default");
      if (!rayDir) {
        window.rayDir = shallowRef(new THREE.Vector3(0, -1, 0));
      } else {
        rayDir.value = new THREE.Vector3(0, -1, 0);
      }
    }
    
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
    if (frameCount.value < 10) {
      try {
        // Try to get collider count safely (different ways depending on Rapier version)
        let numColliders = "unknown";
        if (physicsWorld.value.colliders) {
          // Use the colliders collection if available
          numColliders = physicsWorld.value.colliders.len();
        } else if (physicsWorld.value.bodies) {
          // Fall back to counting bodies if colliders not available
          numColliders = physicsWorld.value.bodies.len();
        }
        
        const playerPos = playerBody.value.translation();
        console.log(`Frame ${frameCount.value}: Physics world has ${numColliders} colliders, ` +
                   `Player at Y=${playerPos.y.toFixed(2)}, X=${playerPos.x.toFixed(2)}, Z=${playerPos.z.toFixed(2)}`);
      } catch (e) {
        console.log(`Frame ${frameCount.value}: Physics debug info unavailable - ${e.message}`);
      }
    }
    
    // Increment frame counter for debugging
    frameCount.value++;
    
    // First step the physics world
    physicsWorld.value.step();
    
    // Debug physics state in early frames
    if (frameCount.value < 10) {
      try {
        // Try to get collider count safely (different ways depending on Rapier version)
        let numColliders = "unknown";
        if (physicsWorld.value.colliders) {
          // Use the colliders collection if available
          numColliders = physicsWorld.value.colliders.len();
        } else if (physicsWorld.value.bodies) {
          // Fall back to counting bodies if colliders not available
          numColliders = physicsWorld.value.bodies.len();
        }
        
        const playerPos = playerBody.value.translation();
        console.log(`Frame ${frameCount.value}: Physics world has ${numColliders} colliders, ` +
                   `Player at Y=${playerPos.y.toFixed(2)}, X=${playerPos.x.toFixed(2)}, Z=${playerPos.z.toFixed(2)}`);
      } catch (e) {
        console.log(`Frame ${frameCount.value}: Physics debug info unavailable - ${e.message}`);
      }
    }
    
    // Then check ground contact after physics is updated
    checkGrounded();
    
    // Then apply hover/gravity forces
    applyGroundFollowing();
    
    // Then handle player movement input
    handlePlayerMovement(deltaTime);
    
    // Update player transform
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

// Add jump variables that might be missing
const jumpInProgress = ref(false);
const jumpTime = ref(0);
const jumpDuration = 0.5; // seconds
const jumpHeight = 2; // maximum jump height

// Modify the applyGroundFollowing function to improve the hover force
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
      // Calculate desired hover height - increased for more clearance
      const targetHoverHeight = 0.5; // Increased from 0.3
      const currentHeight = closestToi;
      
      // Calculate adjustment needed
      const heightAdjustment = targetHoverHeight - currentHeight;
      
      // Apply stronger hover force with logging for early frames
      if (Math.abs(heightAdjustment) > 0.001) {
        // Apply 5x stronger correction to ensure player stays above ground
        const hoverMultiplier = 5.0; // Increased from 3.0
        const adjustmentVector = gravityDir.clone().multiplyScalar(heightAdjustment * hoverMultiplier);
        
        // Get new position
        const newPos = {
          x: playerPos.x + adjustmentVector.x,
          y: playerPos.y + adjustmentVector.y,
          z: playerPos.z + adjustmentVector.z
        };
        
        // Log hover force during early frames
        if (frameCount.value < 20) {
          console.log(`Applying hover force: toi=${closestToi.toFixed(2)}, adj=${heightAdjustment.toFixed(2)}`);
        }
        
        // Set position directly
        playerBody.value.setNextKinematicTranslation(newPos);
      }
    }
  } else {
    // Apply falling - use slower fall speed
    const fallSpeed = 0.05; // Keep consistently slow to give rays time to detect
    
    const newPos = {
      x: playerPos.x + gravityDir.x * fallSpeed,
      y: playerPos.y + gravityDir.y * fallSpeed,
      z: playerPos.z + gravityDir.z * fallSpeed
    };
    
    playerBody.value.setNextKinematicTranslation(newPos);
    
    // Log that we're falling during early frames
    if (frameCount.value < 20) {
      console.log(`Falling: no ground detected, applying fallSpeed=${fallSpeed}`);
    }
  }
  
  // Update stuck detection
  if (!lastPlayerPosition.value) {
    lastPlayerPosition.value = playerPos.clone();
    positionStuckFrames.value = 0;
  } else if (playerPos.distanceTo(lastPlayerPosition.value) < 0.001) {
    positionStuckFrames.value++;
    if (positionStuckFrames.value > 60) {
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

// Add missing function for applyGroundFollowing
// const applyGroundFollowing = () => {
//   if (!playerBody.value) return;
//   ...
// };

// The code should transition directly from the end of the first applyGroundFollowing
// function (around line 647) to the handlePlayerMovement function (around line 760)

// Add missing handlePlayerMovement function
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
      
      // Calculate movement basis vectors
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
      
      // Get player's current orientation
      const playerForward = new THREE.Vector3(0, 0, -1).applyQuaternion(player.value.quaternion);
      const playerForwardOnPlane = projectVectorOntoPlane(playerForward, groundNormal).normalize();
      
      // Calculate angle between reference and player orientation
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
      const adjustedSpeed = moveSpeed * deltaTime * 60;
      const moveVector = moveTangent.multiplyScalar(adjustedSpeed);
      
      // Calculate new position by adding movement vector
      const newPos = {
        x: playerPos.x + moveVector.x,
        y: playerPos.y + moveVector.y,
        z: playerPos.z + moveVector.z
      };
      
      // Set next position directly
      playerBody.value.setNextKinematicTranslation(newPos);
    } else {
      // In air, allow limited control
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
  
  // Handle jumping
  if (keys.jump && isGrounded.value && playerBody.value) {
    keys.jump = false; // Prevent multiple jumps
    jumpInProgress.value = true;
    jumpTime.value = 0;
    console.log("Jump initiated");
  }
};

// Update the checkGrounded function to improve ray detection
const checkGrounded = () => {
  if (!playerBody.value || !physicsWorld.value || !player.value) return;
  
  // Get player position
  const playerTranslation = playerBody.value.translation();
  const playerPos = new THREE.Vector3(
    playerTranslation.x,
    playerTranslation.y,
    playerTranslation.z
  );
  
  // Calculate gravity direction at player's position
  const gravityDir = new THREE.Vector3()
    .subVectors(gravity.center, playerPos)
    .normalize();
  
  // Store for visualization
  if (rayDir && rayDir.value) {
    rayDir.value.copy(gravityDir);
  }
  
  // Get up vector (opposite to gravity)
  const upVector = gravityDir.clone().negate();
  
  // Calculate foot positions - INCREASED foot height and spread for better detection
  const footHeight = playerHeight * 0.5;
  const footSpread = playerRadius * 1.5; // Increased from 1.2
  
  // Get right vector based on player orientation
  const forwardVector = new THREE.Vector3(0, 0, -1).applyQuaternion(player.value.quaternion);
  const rightVector = new THREE.Vector3().crossVectors(upVector, forwardVector).normalize();
  
  // Calculate foot positions - use higher offsets to start rays from player's capsule edge
  leftFootPos.value.copy(playerPos).add(
    rightVector.clone().multiplyScalar(-footSpread)
      .add(upVector.clone().multiplyScalar(-footHeight))
  );
  
  rightFootPos.value.copy(playerPos).add(
    rightVector.clone().multiplyScalar(footSpread)
      .add(upVector.clone().multiplyScalar(-footHeight))
  );
  
  centerFootPos.value.copy(playerPos).add(
    upVector.clone().multiplyScalar(-footHeight - 0.1)
  );
  
  // Use a MUCH longer ray length to ensure we reach the platform and planet
  const rayLength = 100.0; // Increased from 20.0 to 100.0
  
  try {
    // Create rays from foot positions - IMPORTANT: ensure ray direction is exactly toward gravity center
    const leftRayDir = new THREE.Vector3().subVectors(gravity.center, leftFootPos.value).normalize();
    const rightRayDir = new THREE.Vector3().subVectors(gravity.center, rightFootPos.value).normalize();
    const centerRayDir = new THREE.Vector3().subVectors(gravity.center, centerFootPos.value).normalize();
    
    const leftRay = new RAPIER.Ray(
      { x: leftFootPos.value.x, y: leftFootPos.value.y, z: leftFootPos.value.z },
      { x: leftRayDir.x, y: leftRayDir.y, z: leftRayDir.z }
    );
    
    const rightRay = new RAPIER.Ray(
      { x: rightFootPos.value.x, y: rightFootPos.value.y, z: rightFootPos.value.z },
      { x: rightRayDir.x, y: rightRayDir.y, z: rightRayDir.z }
    );
    
    const centerRay = new RAPIER.Ray(
      { x: centerFootPos.value.x, y: centerFootPos.value.y, z: centerFootPos.value.z },
      { x: centerRayDir.x, y: centerRayDir.y, z: centerRayDir.z }
    );
    
    // Cast rays with a very generous maxToi
    const maxToi = 100.0; // Increased from 10.0
    
    // Cast rays - use solid=false for first hit
    const leftResult = physicsWorld.value.castRay(leftRay, rayLength, false);
    leftFootHit.value = leftResult && leftResult.toi < maxToi ? leftResult : null;
    
    const rightResult = physicsWorld.value.castRay(rightRay, rayLength, false);
    rightFootHit.value = rightResult && rightResult.toi < maxToi ? rightResult : null;
    
    const centerResult = physicsWorld.value.castRay(centerRay, rayLength, false);
    centerFootHit.value = centerResult && centerResult.toi < maxToi ? centerResult : null;
    
    // Add debug logs to see what's being hit
    if (frameCount.value < 20) {
      console.log(`Ray hits: left=${leftFootHit.value ? leftFootHit.value.toi.toFixed(2) : 'none'}, ` +
                 `right=${rightFootHit.value ? rightFootHit.value.toi.toFixed(2) : 'none'}, ` +
                 `center=${centerFootHit.value ? centerFootHit.value.toi.toFixed(2) : 'none'}`);
    }
    
    // Also try direct shape intersection test
    const sphereRadius = 0.2;
    const spherePos = { 
      x: centerFootPos.value.x, 
      y: centerFootPos.value.y, 
      z: centerFootPos.value.z 
    };
    const sphereShape = new RAPIER.Ball(sphereRadius);
    
    // Query for shape intersections
    let shapeQueryResult;
    try {
      shapeQueryResult = physicsWorld.value.intersectionsWithShape(
        spherePos,
        { x: 0, y: 0, z: 0, w: 1 }, // Identity quaternion
        sphereShape,
        (collider) => {
          // Accept collisions not with player
          const isPlayer = collider.parent() === playerBody.value.handle;
          if (debugInfo) {
            debugInfo.lastQueryResult = {
              collider: collider.handle,
              isPlayer
            };
          }
          return !isPlayer;
        }
      );
    } catch (queryError) {
      console.warn("Shape query failed:", queryError);
      shapeQueryResult = null;
    }
    
    // Add null check before accessing length
    if (shapeQueryResult && shapeQueryResult.length > 0 && 
        !leftFootHit.value && !rightFootHit.value && !centerFootHit.value) {
      console.log("Shape intersection detected!", shapeQueryResult.length);
      centerFootHit.value = { toi: 0.1, normal: { x: 0, y: 1, z: 0 } };
    }
    
    // Update visualizations
    updateRayVisualizations(leftFootPos.value, rightFootPos.value, centerFootPos.value, 
                          {x: gravityDir.x, y: gravityDir.y, z: gravityDir.z}, rayLength);
    updateCollisionVisualization();
    
    // Determine grounded state
    wasGrounded.value = isGrounded.value;
    const nowGrounded = !jumpInProgress.value && 
                      (leftFootHit.value !== null || 
                       rightFootHit.value !== null || 
                       centerFootHit.value !== null);
    
    // Update state
    isGrounded.value = nowGrounded;
    
  } catch (e) {
    console.error("Error in checkGrounded:", e);
  }
};

// Add a timeout to prevent hanging on loading screen
const initTimeout = ref(null);

// Modify the onMounted function to include better error handling and a timeout
onMounted(async () => {
  try {
    console.log("Starting to initialize Rapier physics engine...");
    
    // Set a timeout to prevent hanging on loading screen
    initTimeout.value = setTimeout(() => {
      if (loading.value) {
        console.warn("Physics initialization timed out - forcing start anyway");
        loading.value = false;
        errorMessage.value = "Physics engine may not be working correctly, but you can try to play anyway.";
      }
    }, 5000); // 5 second timeout
    
    // Initialize Rapier physics engine with explicit version
    await RAPIER.init({
      locateFile: (path) => {
        console.log("Locating Rapier file:", path);
        return `https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.11.2/${path}`;
      }
    });
    
    console.log("Rapier physics engine initialized successfully");
    
    // Clear timeout since initialization succeeded
    if (initTimeout.value) {
      clearTimeout(initTimeout.value);
      initTimeout.value = null;
    }
    
    // Set loading to false
    loading.value = false;
    
    // Set up scene
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
    
    // Clear timeout since we hit the catch block
    if (initTimeout.value) {
      clearTimeout(initTimeout.value);
      initTimeout.value = null;
    }
    
    // Set error message and hide loading screen
    errorMessage.value = "Failed to initialize physics engine: " + e.message;
    loading.value = false;
    
    // Try a fallback initialization
    tryFallbackInitialization();
  }
});

// Add a fallback initialization function for when the main one fails
const tryFallbackInitialization = async () => {
  try {
    console.log("Trying fallback initialization...");
    
    // Try an alternative CDN or method
    await RAPIER.init();
    
    console.log("Fallback initialization succeeded");
    errorMessage.value = "Using fallback physics engine - some features may not work correctly";
    
    // Set up scene if fallback worked
    setupScene();
    
    // Set up event listeners
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);
  } catch (e) {
    console.error("Fallback initialization also failed:", e);
    errorMessage.value = "Could not initialize physics engine. Please try refreshing the page.";
  }
};

// Add the missing setupScene function
const setupScene = () => {
  try {
    console.log("Setting up scene...");
    
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
      throw new Error("Game canvas element not found");
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
    const gravityVec = { x: 0, y: -20, z: 0 };
    physicsWorld.value = new RAPIER.World(gravityVec);
    console.log("Physics world created with gravity:", gravityVec);
    
    // Create game objects - make sure these functions exist and are defined before setupScene
    createPlanet();
    createPlatform();
    createPlayer();
    
    // Add stars for background
    createStars();
    
    console.log("Scene setup complete!");
    return true;
  } catch (e) {
    console.error("Error in setupScene:", e);
    errorMessage.value = "Failed to set up scene: " + e.message;
    return false;
  }
};

// Add missing createStars function if it doesn't exist
const createStars = () => {
  if (!scene.value) return;
  
  const starGeometry = new THREE.BufferGeometry();
  const starMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.5,
    sizeAttenuation: false
  });
  
  const starVertices = [];
  for (let i = 0; i < 5000; i++) {
    const x = THREE.MathUtils.randFloatSpread(2000);
    const y = THREE.MathUtils.randFloatSpread(2000);
    const z = THREE.MathUtils.randFloatSpread(2000);
    starVertices.push(x, y, z);
  }
  
  starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starVertices, 3));
  const stars = new THREE.Points(starGeometry, starMaterial);
  scene.value.add(stars);
  
  console.log("Stars created");
};

// Add the missing createPlanet function
const createPlanet = () => {
  if (!scene.value || !physicsWorld.value) return;
  
  try {
    // Create planet visuals
    const planetRadius = 100;
    const planetGeometry = new THREE.SphereGeometry(planetRadius, 32, 32);
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
    planetColliderDesc.setFriction(2.0);
    const planetCollider = physicsWorld.value.createCollider(planetColliderDesc, planetBody);
    
    console.log("Planet created with collider:", planetCollider.handle);
  } catch (e) {
    console.error("Error creating planet:", e);
  }
};

// Improve the createPlatform function to ensure proper collision detection
const createPlatform = () => {
  if (!scene.value || !physicsWorld.value) {
    console.error("Scene or physics world not initialized");
    return;
  }
  
  try {
    console.log("Creating platform...");
    
    // Create platform visuals
    const platformWidth = 50;
    const platformHeight = 4;
    const platformDepth = 50;
    const platformGeometry = new THREE.BoxGeometry(platformWidth, platformHeight, platformDepth);
    const platformMaterial = new THREE.MeshStandardMaterial({ 
      color: 0x3388ee,
      roughness: 0.5, 
      metalness: 0.5,
      emissive: 0x112244
    });
    
    platform.value = new THREE.Mesh(platformGeometry, platformMaterial);
    const platformPosition = { x: 0, y: 30, z: 10 };
    platform.value.position.set(platformPosition.x, platformPosition.y, platformPosition.z);
    platform.value.castShadow = true;
    platform.value.receiveShadow = true;
    scene.value.add(platform.value);
    
    // Create platform physics body - ensure it's properly fixed
    const platformBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(platformPosition.x, platformPosition.y, platformPosition.z);
    const platformBody = physicsWorld.value.createRigidBody(platformBodyDesc);
    
    // Create collider - use exact platform dimensions (no extra padding which can cause issues)
    const platformColliderDesc = RAPIER.ColliderDesc.cuboid(
      platformWidth / 2,  // Use exact half-width
      platformHeight / 2, // Use exact half-height
      platformDepth / 2   // Use exact half-depth
    );
    
    // Set collision properties - increase friction
    platformColliderDesc.setFriction(10.0);
    platformColliderDesc.setRestitution(0.0);
    platformColliderDesc.setDensity(1.0);
    platformColliderDesc.setSensor(false);
    
    // IMPORTANT: Make sure active events are properly set
    platformColliderDesc.setActiveEvents(
      RAPIER.ActiveEvents.COLLISION_EVENTS | 
      RAPIER.ActiveEvents.CONTACT_EVENTS
    );
    
    const platformCollider = physicsWorld.value.createCollider(platformColliderDesc, platformBody);
    console.log("Platform created with collider:", platformCollider.handle);
    
    // Store platform collider handle in debugInfo for reference
    if (debugInfo) {
      debugInfo.platformHandle = platformCollider.handle;
    }
    
    // Add visual wireframe to show collider bounds
    const colliderGeometry = new THREE.BoxGeometry(
      platformWidth + 4, platformHeight + 4, platformDepth + 4
    );
    const colliderMaterial = new THREE.MeshBasicMaterial({
      color: 0xff00ff,
      wireframe: true,
      transparent: true,
      opacity: 0.3
    });
    const colliderMesh = new THREE.Mesh(colliderGeometry, colliderMaterial);
    colliderMesh.position.copy(platform.value.position);
    scene.value.add(colliderMesh);
    
    return platformCollider.handle;
  } catch (e) {
    console.error("Error creating platform:", e);
    return null;
  }
};

// Add the missing createPlayer function
const createPlayer = () => {
  if (!scene.value || !physicsWorld.value) {
    console.error("Scene or physics world not initialized");
    return;
  }
  
  try {
    console.log("Creating player...");
    
    // Position player above platform
    const spawnHeight = 31.5; // Just above platform at y=30
    const playerBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(0, spawnHeight, 10)
      .setCcdEnabled(true);
    
    playerBody.value = physicsWorld.value.createRigidBody(playerBodyDesc);
    
    // Create player collider
    const playerColliderDesc = RAPIER.ColliderDesc.capsule(
      playerHeight / 2 - playerRadius,
      playerRadius
    )
    .setFriction(0.7)
    .setRestitution(0.0)
    .setDensity(1.0);
    
    const playerCollider = physicsWorld.value.createCollider(playerColliderDesc, playerBody.value);
    console.log("Player collider created:", playerCollider.handle);
    
    // Create player visual mesh
    const playerGeometry = new THREE.CapsuleGeometry(
      playerRadius,
      playerHeight - playerRadius * 2,
      8, 8
    );
    const playerMaterial = new THREE.MeshStandardMaterial({
      color: 0xff9900,
      transparent: true,
      opacity: 0.5
    });
    
    player.value = new THREE.Mesh(playerGeometry, playerMaterial);
    scene.value.add(player.value);
    
    // Add camera to player at eye level
    player.value.add(camera.value);
    camera.value.position.set(0, playerHeight * 0.8, 0);
    camera.value.rotation.set(0, 0, 0);
    
    // Initialize camera rotation
    cameraRotation.value.set(0, 0, 0);
    
    // Create ray visualizations
    createRayVisualizations();
  } catch (e) {
    console.error("Error creating player:", e);
  }
};

// Add missing ray visualization functions
const createRayVisualizations = () => {
  if (!scene.value) return;
  
  try {
    // Create material for rays
    const rayMaterial = new THREE.LineBasicMaterial({ 
      color: 0xffff00,
      linewidth: 2
    });
    
    // Create geometries for rays
    const rayGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, -1, 0)
    ]);
    
    // Create line objects
    leftRayLine.value = new THREE.Line(rayGeometry.clone(), rayMaterial);
    rightRayLine.value = new THREE.Line(rayGeometry.clone(), rayMaterial);
    centerRayLine.value = new THREE.Line(rayGeometry.clone(), rayMaterial);
    
    // Add to scene
    scene.value.add(leftRayLine.value);
    scene.value.add(rightRayLine.value);
    scene.value.add(centerRayLine.value);
    
    console.log("Ray visualizations created");
  } catch (e) {
    console.error("Error creating ray visualizations:", e);
  }
};

// Add updateRayVisualizations function
const updateRayVisualizations = (leftFootPos, rightFootPos, centerFootPos, rayDir, rayLength) => {
  if (!leftRayLine.value || !rightRayLine.value || !centerRayLine.value) return;
  
  try {
    // Calculate the correct direction vectors for each ray - point toward gravity center
    const leftRayDir = new THREE.Vector3().subVectors(gravity.center, leftFootPos).normalize();
    const rightRayDir = new THREE.Vector3().subVectors(gravity.center, rightFootPos).normalize();
    const centerRayDir = new THREE.Vector3().subVectors(gravity.center, centerFootPos).normalize();
    
    // Calculate end points with the correct directions
    const leftRayEnd = leftFootPos.clone().add(leftRayDir.clone().multiplyScalar(rayLength));
    const rightRayEnd = rightFootPos.clone().add(rightRayDir.clone().multiplyScalar(rayLength));
    const centerRayEnd = centerFootPos.clone().add(centerRayDir.clone().multiplyScalar(rayLength));
    
    // Update geometries
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
    
    // Set colors based on hit status
    leftRayLine.value.material.color.set(leftFootHit.value ? 0x00ff00 : 0xff0000);
    rightRayLine.value.material.color.set(rightFootHit.value ? 0x00ff00 : 0xff0000);
    centerRayLine.value.material.color.set(centerFootHit.value ? 0x00ff00 : 0xff0000);
  } catch (e) {
    console.error("Error updating ray visualizations:", e);
  }
};

// Add updateCollisionVisualization function 
const updateCollisionVisualization = () => {
  if (!scene.value) return;
  
  // Get safe rayDir
  const safeRayDir = getSafeRayDir();
  
  // Remove old collision points
  if (collisionPoints.value && collisionPoints.value.length > 0) {
    collisionPoints.value.forEach(point => {
      if (scene.value) scene.value.remove(point);
    });
    collisionPoints.value = [];
  }
  
  // Create visualization for each hit point
  const hits = [leftFootHit.value, rightFootHit.value, centerFootHit.value];
  const positions = [leftFootPos.value, rightFootPos.value, centerFootPos.value];
  
  hits.forEach((hit, index) => {
    if (!hit || !hit.toi || !positions[index]) return;
    
    // Calculate hit position using safe rayDir
    const hitPos = new THREE.Vector3(
      positions[index].x + safeRayDir.x * hit.toi,
      positions[index].y + safeRayDir.y * hit.toi,
      positions[index].z + safeRayDir.z * hit.toi
    );
    
    // Create a sphere at the hit point
    const sphereGeometry = new THREE.SphereGeometry(0.1, 8, 8);
    const sphereMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
    sphere.position.copy(hitPos);
    
    scene.value.add(sphere);
    collisionPoints.value.push(sphere);
  });
};

// Initialize missing variables for debugInfo
const debugInfo = reactive({
  colliderCount: 0,
  platformHandle: null,
  planetHandle: null,
  lastQueryResult: null
});

// Add the missing lastGroundNormal variable declaration if it doesn't exist
const lastGroundNormal = shallowRef(new THREE.Vector3(0, 1, 0));

// Make sure getSafeRayDir function is defined
const getSafeRayDir = () => {
  // First try the local rayDir
  if (rayDir && rayDir.value) {
    return rayDir.value;
  }
  
  // Fall back to global if local isn't available
  if (typeof window !== 'undefined' && window.globalRayDir) {
    return window.globalRayDir;
  }
  
  // Create new as last resort
  console.warn("Creating new rayDir as fallback");
  return new THREE.Vector3(0, -1, 0);
};

// Add the missing updatePlayerTransform function
const updatePlayerTransform = () => {
  if (!playerBody.value || !player.value || !camera.value) return;
  
  try {
    // Update player mesh position from physics body
    const position = playerBody.value.translation();
    player.value.position.set(position.x, position.y, position.z);
    
    // Update player mesh rotation from physics body
    const rotation = playerBody.value.rotation();
    player.value.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    
    // Update camera rotation based on grounded state
    if (isGrounded.value) {
      // When grounded, only apply pitch (X rotation)
      camera.value.rotation.x = cameraRotation.value.x;
      camera.value.rotation.y = 0;
      camera.value.rotation.z = 0;
    } else {
      // When in air, apply both pitch and yaw
      camera.value.rotation.x = cameraRotation.value.x;
      camera.value.rotation.y = cameraRotation.value.y;
      camera.value.rotation.z = 0;
    }
  } catch (e) {
    console.error("Error updating player transform:", e);
  }
};

// Add the toggleCameraAttachment function after the onKeyUp function
const toggleCameraAttachment = () => {
  // Toggle the camera attachment state
  isCameraDetached.value = !isCameraDetached.value;
  
  if (isCameraDetached.value) {
    // Remove camera from player when detaching
    if (player.value && camera.value) {
      // Store current world position before removing
      const worldPos = new THREE.Vector3();
      camera.value.getWorldPosition(worldPos);
      
      // Store current rotation
      const worldRot = new THREE.Euler();
      camera.value.getWorldQuaternion(new THREE.Quaternion().setFromEuler(worldRot));
      
      // Remove from player and add to scene
      player.value.remove(camera.value);
      scene.value.add(camera.value);
      
      // Position the camera at the same world position
      camera.value.position.copy(worldPos);
      camera.value.rotation.copy(worldRot);
      
      // Move camera back for better view
      const cameraOffset = new THREE.Vector3(0, 5, 15);
      camera.value.position.add(cameraOffset);
      
      console.log("Camera detached from player");
    }
  } else {
    // Reattach camera to player
    if (player.value && camera.value) {
      // Remove from scene
      scene.value.remove(camera.value);
      
      // Add back to player
      player.value.add(camera.value);
      
      // Reset camera position relative to player
      camera.value.position.set(0, playerHeight * 0.8, 0);
      camera.value.rotation.set(cameraRotation.value.x, 0, 0);
      
      console.log("Camera reattached to player");
    }
  }
};

// Add the missing updateDetachedCamera function before updatePlayerTransform
const updateDetachedCamera = () => {
  if (!isCameraDetached.value || !camera.value || !player.value) return;
  
  // Get player's current world position
  const playerWorldPos = new THREE.Vector3();
  player.value.getWorldPosition(playerWorldPos);
  
  // Create an orbit-like camera that follows the player
  // Calculate the camera position in an orbit
  const cameraDistance = 15; // Distance from player
  const cameraHeight = 8;   // Height above player
  
  // Update camera position based on key input for camera control
  if (keys.left) {
    // Orbit left
    detachedCameraAngle.value += 0.02;
  }
  if (keys.right) {
    // Orbit right
    detachedCameraAngle.value -= 0.02;
  }
  
  // Calculate camera position on a circle around player
  const cameraX = playerWorldPos.x + Math.sin(detachedCameraAngle.value) * cameraDistance;
  const cameraZ = playerWorldPos.z + Math.cos(detachedCameraAngle.value) * cameraDistance;
  const cameraY = playerWorldPos.y + cameraHeight;
  
  camera.value.position.set(cameraX, cameraY, cameraZ);
  
  // Make camera look at player
  camera.value.lookAt(playerWorldPos);
};

// Add the detachedCameraAngle variable at the top with other state variables
const detachedCameraAngle = ref(0); // Initialize angle for orbiting camera
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
