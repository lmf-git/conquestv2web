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
const initTimeout = ref(null); // For physics initialization timeout

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

// Add missing jump-related variables
const jumpInProgress = shallowRef(false);
const jumpTime = ref(0);
const jumpDuration = 0.5; // Jump duration in seconds
const lastGroundNormal = shallowRef(new THREE.Vector3(0, 1, 0));

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
  center: new THREE.Vector3(0, -230, 0), // Planet center position
  strength: 25  // Reduced from 50 to 25 for lighter, more comfortable gravity
});

// Initialize debugInfo as a reactive object to store debugging information
const debugInfo = reactive({
  planetHandle: null,
  platformHandle: null,
  wallHandle: null,
  rampHandle: null,
  playerColliderHandle: null,
  lastQueryResult: null,
  colliderCount: 0
});

// Modify the utility function to get ground normal to use planet-centered gravity
const getGroundNormal = () => {
  // Get player position
  const playerTranslation = playerBody.value.translation();
  const playerPos = new THREE.Vector3(
    playerTranslation.x,
    playerTranslation.y,
    playerTranslation.z
  );
  
  // Calculate gravity direction from planet center
  const gravityDir = new THREE.Vector3()
    .subVectors(gravity.center, playerPos)
    .normalize();
  
  // Use surface normal from ray hits if available
  let groundNormal = gravityDir.clone().multiplyScalar(-1); // Default to opposite of gravity
  
  if (centerFootHit.value && centerFootHit.value.normal) {
    groundNormal = new THREE.Vector3(
      centerFootHit.value.normal.x,
      centerFootHit.value.normal.y,
      centerFootHit.value.normal.z
    );
  }
  
  // Up vector is the ground normal
  const upVector = groundNormal.clone();
  
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
  
  const lookSensitivity = 0.001;
  const groundTurnSensitivity = 0.0008;
  
  try {
    // Always update camera pitch
    cameraRotation.value.x -= event.movementY * lookSensitivity;
    cameraRotation.value.x = Math.max(
      -Math.PI / 2 + 0.01, 
      Math.min(Math.PI / 2 - 0.01, cameraRotation.value.x)
    );
    
    if (isGrounded.value && playerBody.value) {
      // On ground - rotate around surface normal
      const { groundNormal } = getGroundNormal();
      
      if (Math.abs(event.movementX) > 1) {
        const yawQuat = new THREE.Quaternion().setFromAxisAngle(
          groundNormal, 
          -event.movementX * groundTurnSensitivity
        );
        
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
        
        if (lastGroundNormal && lastGroundNormal.value) {
          lastGroundNormal.value.copy(groundNormal);
        }
      }
      
      cameraRotation.value.y = 0;
    } else {
      // In space - full quaternion rotation
      cameraRotation.value.y -= event.movementX * lookSensitivity;
      
      // Apply roll with Q/E keys if desired
      // This gives full 6DOF control in space
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

// Modify the startGame function to handle physics initialization more carefully
const startGame = async () => {
  try {
    console.log("Starting game...");
    
    // Make sure RAPIER is properly initialized before proceeding
    if (!RAPIER.World) {
      console.log("Rapier not fully initialized, initializing now...");
      try {
        await RAPIER.init({
          locateFile: (path) => {
            return `https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.11.2/${path}`;
          }
        });
        console.log("Rapier initialized successfully");
      } catch (rapierError) {
        console.error("Failed to initialize Rapier:", rapierError);
        errorMessage.value = "Failed to initialize physics engine. Please refresh.";
      }
    }
    
    // Check if physics world exists, if not create it properly
    if (!physicsWorld.value && RAPIER.World) {
      console.log("Creating physics world");
      try {
        // Create with standard gravity first
        const gravityVec = { x: 0, y: 0, z: 0 };
        physicsWorld.value = new RAPIER.World(gravityVec);
        console.log("Physics world created successfully");
        
        // Create necessary game objects if they don't exist
        if (!platform.value) createPlatform();
        if (!player.value) createPlayer();
      } catch (worldError) {
        console.error("Error creating physics world:", worldError);
        errorMessage.value = "Error creating physics world: " + worldError.message;
        return; // Don't proceed if we can't create the physics world
      }
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
  }
};

// Modify the onMounted function to ensure proper initialization sequence
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
    }, 8000); // 8 second timeout (increased from 5)
    
    // Initialize Rapier physics engine with explicit version and better error handling
    try {
      await RAPIER.init({
        locateFile: (path) => {
          console.log("Locating Rapier file:", path);
          return `https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.11.2/${path}`;
        }
      });
      console.log("Rapier physics engine initialized successfully");
      
      // Create physics world with gravity that matches our planet-centered gravity
      if (!physicsWorld.value) {
        // Disable global gravity - we'll apply our own planet-centered gravity
        const gravityVec = { x: 0, y: 0, z: 0 };
        physicsWorld.value = new RAPIER.World(gravityVec);
        console.log("Physics world created with disabled gravity:", gravityVec);
      }
    } catch (rapierError) {
      console.error("Error initializing Rapier:", rapierError);
      errorMessage.value = "Failed to initialize physics engine: " + rapierError.message;
      // Continue to allow user to try starting the game anyway
    }
    
    // Clear timeout since initialization completed (successfully or not)
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
    errorMessage.value = "Failed to initialize game: " + e.message;
    loading.value = false;
  }
}); // <-- This closing parenthesis was missing

// Rewrite the createPlayer function to use kinematic body for proper control
const createPlayer = () => {
  if (!scene.value || !physicsWorld.value) {
    console.error("Scene or physics world not initialized");
    return;
  }
  
  try {
    console.log("Creating player...");
    
    // Position player closer to platform - platform is at y=30, so spawn just above it
    const spawnHeight = 33; // Just 3 units above the platform for better detection
    
    // Create player physics body as DYNAMIC with much lower damping
    const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, spawnHeight, 0)
      .lockRotations() // Prevent the capsule from tipping over
      .setLinearDamping(0.1) // Much lower damping for better movement
      .setAngularDamping(1.0); // Full angular damping
    
    playerBody.value = physicsWorld.value.createRigidBody(playerBodyDesc);
    
    // Create player collider with improved settings
    const playerColliderDesc = RAPIER.ColliderDesc.capsule(
      playerHeight / 2 - playerRadius,
      playerRadius
    )
    .setFriction(0.0) // Zero friction to prevent sticking
    .setRestitution(0.0)
    .setDensity(1.0)
    .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.DEFAULT)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS); // Enable collision events
    
    // Create collider
    const playerCollider = physicsWorld.value.createCollider(playerColliderDesc, playerBody.value);
    console.log("Player collider created:", playerCollider.handle);
    
    // Store the player collider handle for collision filtering
    if (debugInfo) {
      debugInfo.playerColliderHandle = playerCollider.handle;
    }
    
    // Create player visual mesh
    const playerGeometry = new THREE.CapsuleGeometry(
      playerRadius,
      playerHeight - playerRadius * 2,
      8, 8
    );
    const playerMaterial = new THREE.MeshStandardMaterial({
      color: 0xff9900,
      transparent: true,
      opacity: 0.7
    });
    
    // Create the mesh and add it to the scene
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
    
    // Set up collision handling
    setupCollisionHandling();
    
    console.log("Player created successfully at position:", spawnHeight);
  } catch (e) {
    console.error("Error creating player:", e);
  }
};

// Add collision tracking variables near other state variables
const groundCollisions = shallowRef(new Set()); // Track which colliders we're touching
const lastGroundContact = ref(0); // Track when we last had ground contact

// Add function to process collision events
const processCollisionEvents = () => {
  if (!physicsWorld.value?.eventQueue || !playerBody.value) return;
  
  try {
    physicsWorld.value.eventQueue.drainCollisionEvents((handle1, handle2, started) => {
      // Check if one of the colliders belongs to the player
      let playerColliderHandle = null;
      let otherColliderHandle = null;
      
      if (debugInfo.playerColliderHandle) {
        if (handle1 === debugInfo.playerColliderHandle) {
          playerColliderHandle = handle1;
          otherColliderHandle = handle2;
        } else if (handle2 === debugInfo.playerColliderHandle) {
          playerColliderHandle = handle2;
          otherColliderHandle = handle1;
        }
      }
      
      if (playerColliderHandle) {
        const currentTime = performance.now();
        
        if (started) {
          // Collision started - add to ground collisions
          groundCollisions.value.add(otherColliderHandle);
          lastGroundContact.value = currentTime;
          
          console.log("Collision started with handle:", otherColliderHandle, "Total collisions:", groundCollisions.value.size);
        } else {
          // Collision ended - remove from ground collisions
          groundCollisions.value.delete(otherColliderHandle);
          
          console.log("Collision ended with handle:", otherColliderHandle, "Remaining collisions:", groundCollisions.value.size);
        }
      }
    });
  } catch (e) {
    console.error("Error processing collision events:", e);
  }
};

// Replace the checkGrounded function with improved collision and ray-based detection
const checkGrounded = () => {
  if (!playerBody.value || !physicsWorld.value) return;
  
  try {
    // Check collision-based grounding
    wasGrounded.value = isGrounded.value;
    
    // Ground detection based on collision events and velocity
    const currentTime = performance.now();
    const velocityRapier = playerBody.value.linvel();
    
    // Convert RAPIER velocity to THREE.js Vector3
    const velocity = new THREE.Vector3(velocityRapier.x, velocityRapier.y, velocityRapier.z);
    
    // Get player position for ray casting
    const playerTranslation = playerBody.value.translation();
    const playerPos = new THREE.Vector3(
      playerTranslation.x,
      playerTranslation.y,
      playerTranslation.z
    );
    
    // Calculate gravity direction from planet center to player for ray casting
    const gravityDir = new THREE.Vector3()
      .subVectors(gravity.center, playerPos)
      .normalize();
    
    // Update ray direction to match gravity
    rayDir.value.copy(gravityDir);
    
    // Update foot positions for ray casting
    const playerQuat = new THREE.Quaternion(
      playerBody.value.rotation().x,
      playerBody.value.rotation().y,
      playerBody.value.rotation().z,
      playerBody.value.rotation().w
    );
    
    const footOffset = playerRadius * 0.8;
    const footLevel = -playerHeight * 0.5; // Bottom of capsule
    
    // Calculate foot positions at bottom of capsule
    const leftOffset = new THREE.Vector3(-footOffset, footLevel, 0).applyQuaternion(playerQuat);
    const rightOffset = new THREE.Vector3(footOffset, footLevel, 0).applyQuaternion(playerQuat);
    const centerOffset = new THREE.Vector3(0, footLevel, 0).applyQuaternion(playerQuat);
    
    leftFootPos.value.copy(playerPos).add(leftOffset);
    rightFootPos.value.copy(playerPos).add(rightOffset);
    centerFootPos.value.copy(playerPos).add(centerOffset);
    
    // Cast rays for grounding detection using gravity direction
    const castGroundingRay = (footPos) => {
      const footRay = new RAPIER.Ray(
        { x: footPos.x, y: footPos.y, z: footPos.z },
        { x: rayDir.value.x, y: rayDir.value.y, z: rayDir.value.z }
      );
      
      return physicsWorld.value.castRay(
        footRay,
        0.3, // Slightly longer distance for better surface detection
        true,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        (colliderHandle) => {
          if (debugInfo.playerColliderHandle && colliderHandle === debugInfo.playerColliderHandle) {
            return false;
          }
          return true;
        }
      );
    };
    
    // Update foot hits for grounding
    leftFootHit.value = castGroundingRay(leftFootPos.value);
    rightFootHit.value = castGroundingRay(rightFootPos.value);
    centerFootHit.value = castGroundingRay(centerFootPos.value);
    
    // Determine grounding based on multiple criteria
    const hasGroundCollisions = groundCollisions.value.size > 0;
    const hasRayHits = leftFootHit.value || rightFootHit.value || centerFootHit.value;
    const lowDownwardVelocity = velocity.dot(gravityDir) < 2.0; // Check velocity relative to gravity
    const recentGroundContact = (currentTime - lastGroundContact.value) < 200; // 200ms grace period
    
    // We're grounded if we have collisions or ray hits with appropriate velocity
    isGrounded.value = (hasGroundCollisions && lowDownwardVelocity) || 
                      (hasRayHits && lowDownwardVelocity) ||
                      (recentGroundContact && Math.abs(velocity.dot(gravityDir)) < 0.5);
    
    // If we have collisions or ray hits, update last ground contact time
    if (hasGroundCollisions || hasRayHits) {
      lastGroundContact.value = currentTime;
    }
    
    // Align player to surface when grounded
    if (isGrounded.value && (centerFootHit.value || leftFootHit.value || rightFootHit.value)) {
      alignPlayerToSurface(gravityDir);
    }
    
    // Log grounding state changes
    if (isGrounded.value !== wasGrounded.value) {
      if (isGrounded.value) {
        console.log("Player became grounded - Collisions:", groundCollisions.value.size, "Ray hits:", hasRayHits);
      } else {
        console.log("Player became airborne - Collisions:", groundCollisions.value.size, "Ray hits:", hasRayHits);
      }
    }
    
    // Debug logging every 60 frames (1 second at 60fps)
    if (frameCount.value % 60 === 0) {
      console.log("Ground check - Collisions:", groundCollisions.value.size, 
                  "Ray hits:", hasRayHits, 
                  "Grounded:", isGrounded.value,
                  "Player pos:", playerPos.x.toFixed(1), playerPos.y.toFixed(1), playerPos.z.toFixed(1));
    }
  } catch (e) {
    console.error("Error checking grounded state:", e);
  }
};

// Add function to align player to surface normal
const alignPlayerToSurface = (gravityDirection) => {
  if (!playerBody.value) return;
  
  try {
    // Get the best surface normal from ray hits
    let surfaceNormal = null;
    
    // Priority: center hit, then average of left/right hits
    if (centerFootHit.value && centerFootHit.value.normal) {
      surfaceNormal = new THREE.Vector3(
        centerFootHit.value.normal.x,
        centerFootHit.value.normal.y,
        centerFootHit.value.normal.z
      );
    } else if (leftFootHit.value?.normal || rightFootHit.value?.normal) {
      // Average the normals if we have multiple hits
      surfaceNormal = new THREE.Vector3(0, 0, 0);
      let normalCount = 0;
      
      if (leftFootHit.value?.normal) {
        surfaceNormal.add(new THREE.Vector3(
          leftFootHit.value.normal.x,
          leftFootHit.value.normal.y,
          leftFootHit.value.normal.z
        ));
        normalCount++;
      }
      
      if (rightFootHit.value?.normal) {
        surfaceNormal.add(new THREE.Vector3(
          rightFootHit.value.normal.x,
          rightFootHit.value.normal.y,
          rightFootHit.value.normal.z
        ));
        normalCount++;
      }
      
      if (normalCount > 0) {
        surfaceNormal.divideScalar(normalCount).normalize();
      } else {
        surfaceNormal = null;
      }
    }
    
    // If no surface normal found, use opposite of gravity direction
    if (!surfaceNormal) {
      surfaceNormal = gravityDirection.clone().multiplyScalar(-1);
    }
    
    // Calculate target orientation: align player's "up" with surface normal
    const currentQuat = new THREE.Quaternion(
      playerBody.value.rotation().x,
      playerBody.value.rotation().y,
      playerBody.value.rotation().z,
      playerBody.value.rotation().w
    );
    
    // Get current forward direction (preserve yaw when possible)
    const currentForward = new THREE.Vector3(0, 0, -1).applyQuaternion(currentQuat);
    
    // Project current forward onto the surface plane
    const projectedForward = currentForward.clone()
      .sub(surfaceNormal.clone().multiplyScalar(currentForward.dot(surfaceNormal)))
      .normalize();
    
    // If projected forward is too small, use a default direction
    if (projectedForward.lengthSq() < 0.1) {
      // Find a reasonable forward direction on the surface
      const up = new THREE.Vector3(0, 1, 0);
      projectedForward.crossVectors(surfaceNormal, up);
      if (projectedForward.lengthSq() < 0.1) {
        projectedForward.set(1, 0, 0).projectOnPlane(surfaceNormal);
      }
      projectedForward.normalize();
    }
    
    // Create target rotation matrix
    const right = new THREE.Vector3().crossVectors(projectedForward, surfaceNormal).normalize();
    const targetMatrix = new THREE.Matrix4().makeBasis(right, surfaceNormal, projectedForward.clone().multiplyScalar(-1));
    const targetQuat = new THREE.Quaternion().setFromRotationMatrix(targetMatrix);
    
    // Smoothly interpolate to target orientation
    const lerpFactor = 0.1; // Adjust for smoother/faster alignment
    currentQuat.slerp(targetQuat, lerpFactor);
    
    // Apply the rotation
    playerBody.value.setRotation({
      x: currentQuat.x,
      y: currentQuat.y,
      z: currentQuat.z,
      w: currentQuat.w
    }, true);
    
    // Update last ground normal for reference
    if (lastGroundNormal && lastGroundNormal.value) {
      lastGroundNormal.value.copy(surfaceNormal);
    }
    
  } catch (e) {
    console.error("Error aligning player to surface:", e);
  }
};

// Add collision event handling after createPlayer function
const setupCollisionHandling = () => {
  if (!physicsWorld.value) return;
  
  try {
    // Set up collision event handling
    physicsWorld.value.eventQueue = new RAPIER.EventQueue(true);
    
    console.log("Collision event handling set up successfully");
    
    // Also set up contact force events for additional detection
    physicsWorld.value.contactForceEventQueue = new RAPIER.EventQueue(true);
    
  } catch (e) {
    console.error("Error setting up collision handling:", e);
  }
};

// Modify the animate function to include better collision processing
const animate = () => {
  if (!started.value) return;
  
  requestAnimationFrame(animate);
  
  try {
    if (!rayDir || !rayDir.value) {
      console.warn("rayDir not initialized, creating default");
      rayDir.value = new THREE.Vector3(0, -1, 0);
    }
    
    if (errorMessage.value) {
      errorMessage.value = '';
    }
    
    const deltaTime = Math.min(clock.getDelta(), 0.1);
    
    if (physicsWorld.value) {
      try {
        physicsWorld.value.step();
        // Process collision events after physics step
        processCollisionEvents();
        
        // Also process contact force events if available
        if (physicsWorld.value.contactForceEventQueue) {
          physicsWorld.value.contactForceEventQueue.drainContactForceEvents((event) => {
            // Contact force events can help with grounding detection
            if (debugInfo.playerColliderHandle && 
                (event.collider1() === debugInfo.playerColliderHandle || 
                 event.collider2() === debugInfo.playerColliderHandle)) {
              lastGroundContact.value = performance.now();
            }
          });
        }
      } catch (e) {
        console.error("Error stepping physics world:", e);
      }
    }
    
    if (!physicsWorld.value || !playerBody.value || !player.value) {
      if (renderer.value && scene.value && camera.value) {
        renderer.value.render(scene.value, camera.value);
      }
      console.warn("Waiting for game components to initialize...");
      return;
    }
    
    frameCount.value++;
    
    // Update physics and player - IMPORTANT: Order matters!
    checkGrounded();
    
    // Handle all movement in one place including gravity
    handleAllMovement(deltaTime);
    
    // Update visual transform after physics
    updatePlayerTransform();
    
    // Update ray visualizations
    if (player.value && rayDir.value) {
      updateRayVisualizations(
        leftFootPos.value.clone(), 
        rightFootPos.value.clone(), 
        centerFootPos.value.clone(), 
        rayDir.value, 
        2.0  // Shorter rays for grounding
      );
    }
    
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
    
    // Render scene
    if (renderer.value && scene.value && camera.value) {
      renderer.value.render(scene.value, camera.value);
    }
  } catch (e) {
    errorMessage.value = "Error in animation loop: " + e.message;
    console.error("Error in animation loop:", e);
  }
};

// Add detachedCameraAngle declaration near the top with other state variables
const detachedCameraAngle = ref(0);

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

// Add missing setupScene function before onMounted
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
    
    // Create renderer
    renderer.value = new THREE.WebGLRenderer({ antialias: true });
    renderer.value.setSize(window.innerWidth, window.innerHeight);
    renderer.value.setPixelRatio(window.devicePixelRatio);
    renderer.value.shadowMap.enabled = true;
    renderer.value.shadowMap.type = THREE.PCFSoftShadowMap; // Better shadow quality
    
    // Add to DOM
    if (gameCanvas.value) {
      gameCanvas.value.appendChild(renderer.value.domElement);
    } else {
      console.error("Game canvas element not found");
      throw new Error("Game canvas element not found");
    }
    
    // Add lights
    const ambientLight = new THREE.AmbientLight(0x444444, 0.4);
    scene.value.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(50, 200, 100);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far = 500;
    directionalLight.shadow.camera.left = -100;
    directionalLight.shadow.camera.right = 100;
    directionalLight.shadow.camera.top = 100;
    directionalLight.shadow.camera.bottom = -100;
    scene.value.add(directionalLight);
    
    // Create game objects if physics is ready
    if (physicsWorld.value) {
      createPlanet();
      createPlatform(); // This will now also create wall and ramp
      createPlayer();
      createRayVisualizations();
    } else {
      console.warn("Physics not initialized, skipping physics object creation");
    }
    
    console.log("Scene setup complete!");
    return true;
  } catch (e) {
    console.error("Error in setupScene:", e);
    errorMessage.value = "Failed to set up scene: " + e.message;
    return false;
  }
};

// Add missing createPlanet function
const createPlanet = () => {
  if (!scene.value || !physicsWorld.value) {
    console.error("Scene or physics world not initialized");
    return;
  }
  
  try {
    console.log("Creating planet...");
    
    const planetRadius = 200;
    const planetGeometry = new THREE.SphereGeometry(planetRadius, 64, 64);
    const planetMaterial = new THREE.MeshStandardMaterial({
      color: 0x3366cc,
      roughness: 0.8,
      metalness: 0.2,
    });
    
    planet.value = new THREE.Mesh(planetGeometry, planetMaterial);
    planet.value.position.set(0, -planetRadius - 30, 0);
    planet.value.receiveShadow = true;
    scene.value.add(planet.value);
    
    const planetBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(
        planet.value.position.x,
        planet.value.position.y,
        planet.value.position.z
      );
    
    const planetBody = physicsWorld.value.createRigidBody(planetBodyDesc);
    const planetColliderDesc = RAPIER.ColliderDesc.ball(planetRadius)
      .setFriction(0.8)
      .setRestitution(0.2);
    
    const planetCollider = physicsWorld.value.createCollider(planetColliderDesc, planetBody);
    
    if (debugInfo) {
      debugInfo.planetHandle = planetCollider.handle;
    }
    
    console.log("Planet created successfully");
    
    // Update gravity center to match planet position
    gravity.center.copy(planet.value.position);
    
    return planet.value;
  } catch (e) {
    console.error("Error creating planet:", e);
    return null;
  }
};

// Add missing createPlatform function
const createPlatform = () => {
  if (!scene.value || !physicsWorld.value) {
    console.error("Scene or physics world not initialized");
    return;
  }
  
  try {
    console.log("Creating platform...");
    
    const platformWidth = 50;
    const platformHeight = 3;
    const platformDepth = 50;
    const platformGeometry = new THREE.BoxGeometry(
      platformWidth, platformHeight, platformDepth
    );
    
    const platformMaterial = new THREE.MeshStandardMaterial({
      color: 0x888888,
      roughness: 0.7,
      metalness: 0.2
    });
    
    platform.value = new THREE.Mesh(platformGeometry, platformMaterial);
    platform.value.position.set(0, 30, 0);
    platform.value.receiveShadow = true;
    scene.value.add(platform.value);
    
    const platformBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(
        platform.value.position.x,
        platform.value.position.y,
        platform.value.position.z
      );
    
    const platformBody = physicsWorld.value.createRigidBody(platformBodyDesc);
    const platformColliderDesc = RAPIER.ColliderDesc.cuboid(
      platformWidth / 2,
      platformHeight / 2,
      platformDepth / 2
    )
    .setFriction(0.8)
    .setRestitution(0.2);
    
    const platformCollider = physicsWorld.value.createCollider(platformColliderDesc, platformBody);
    
    if (debugInfo) {
      debugInfo.platformHandle = platformCollider.handle;
    }
    
    console.log("Platform created successfully at position:", platform.value.position, "with collider handle:", platformCollider.handle);
    
    // Create wall on one side of the platform
    createWall();
    
    // Create ramp on another side of the platform
    createRamp();
    
    return platform.value;
  } catch (e) {
    console.error("Error creating platform:", e);
    return null;
  }
};

// Add createWall function
const createWall = () => {
  if (!scene.value || !physicsWorld.value) {
    console.error("Scene or physics world not initialized for wall");
    return;
  }
  
  try {
    console.log("Creating wall...");
    
    const wallWidth = 20;
    const wallHeight = 8;
    const wallDepth = 2;
    
    const wallGeometry = new THREE.BoxGeometry(wallWidth, wallHeight, wallDepth);
    const wallMaterial = new THREE.MeshStandardMaterial({
      color: 0x666666,
      roughness: 0.8,
      metalness: 0.1
    });
    
    const wall = new THREE.Mesh(wallGeometry, wallMaterial);
    // Position wall at the edge of the platform (north side)
    wall.position.set(0, 30 + (wallHeight / 2) + 1.5, 20); // 20 units north of platform center
    wall.receiveShadow = true;
    wall.castShadow = true;
    scene.value.add(wall);
    
    // Create physics body for wall
    const wallBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(wall.position.x, wall.position.y, wall.position.z);
    
    const wallBody = physicsWorld.value.createRigidBody(wallBodyDesc);
    const wallColliderDesc = RAPIER.ColliderDesc.cuboid(
      wallWidth / 2,
      wallHeight / 2,
      wallDepth / 2
    )
    .setFriction(0.8)
    .setRestitution(0.1);
    
    const wallCollider = physicsWorld.value.createCollider(wallColliderDesc, wallBody);
    
    if (debugInfo) {
      debugInfo.wallHandle = wallCollider.handle;
    }
    
    console.log("Wall created successfully at position:", wall.position);
    return wall;
  } catch (e) {
    console.error("Error creating wall:", e);
    return null;
  }
};

// Add createRamp function
const createRamp = () => {
  if (!scene.value || !physicsWorld.value) {
    console.error("Scene or physics world not initialized for ramp");
    return;
  }
  
  try {
    console.log("Creating ramp...");
    
    const rampWidth = 12;
    const rampHeight = 6;
    const rampDepth = 15;
    
    const rampGeometry = new THREE.BoxGeometry(rampWidth, rampHeight, rampDepth);
    const rampMaterial = new THREE.MeshStandardMaterial({
      color: 0x999944,
      roughness: 0.9,
      metalness: 0.0
    });
    
    const ramp = new THREE.Mesh(rampGeometry, rampMaterial);
    // Position ramp lower and closer to platform edge for easier access
    ramp.position.set(15, 30 - 1, 0); // Moved closer (15 instead of 18) and lowered by 1 unit
    
    // Rotate the ramp to create a much gentler incline (8 degrees instead of 15)
    ramp.rotation.z = -Math.PI / 22.5; // About 8 degrees (much gentler slope)
    
    ramp.receiveShadow = true;
    ramp.castShadow = true;
    scene.value.add(ramp);
    
    // Create physics body for ramp
    const rampBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(ramp.position.x, ramp.position.y, ramp.position.z)
      .setRotation({ x: 0, y: 0, z: -Math.PI / 22.5, w: Math.cos(Math.PI / 45) }); // Convert rotation to quaternion
    
    const rampBody = physicsWorld.value.createRigidBody(rampBodyDesc);
    const rampColliderDesc = RAPIER.ColliderDesc.cuboid(
      rampWidth / 2,
      rampHeight / 2,
      rampDepth / 2
    )
    .setFriction(0.3) // Much lower friction for easier climbing
    .setRestitution(0.0); // No bounce to prevent sliding back
    
    const rampCollider = physicsWorld.value.createCollider(rampColliderDesc, rampBody);
    
    if (debugInfo) {
      debugInfo.rampHandle = rampCollider.handle;
    }
    
    console.log("Ramp created successfully at position:", ramp.position, "with low friction:", 0.3);
    return ramp;
  } catch (e) {
    console.error("Error creating ramp:", e);
    return null;
  }
};

// Add missing createRayVisualizations function
const createRayVisualizations = () => {
  if (!scene.value || !player.value) {
    console.error("Scene or player not initialized");
    return;
  }
  
  try {
    // Create material for ray lines
    const rayMaterial = new THREE.LineBasicMaterial({ 
      color: 0x00ff00,
      opacity: 0.5,
      transparent: true
    });
    
    // Create ray line geometries with proper buffer attributes
    const createRayLine = () => {
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(6); // 2 vertices * 3 components
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setDrawRange(0, 2);
      return new THREE.Line(geometry, rayMaterial.clone());
    };
    
    // Create ray lines as children of the player so they follow automatically
    leftRayLine.value = createRayLine();
    rightRayLine.value = createRayLine();
    centerRayLine.value = createRayLine();
    
    // Add rays to player instead of scene so they move with the player
    player.value.add(leftRayLine.value);
    player.value.add(rightRayLine.value);
    player.value.add(centerRayLine.value);
    
    console.log("Ray visualizations created and attached to player");
  } catch (e) {
    console.error("Error creating ray visualizations:", e);
  }
};

// Update the updateRayVisualizations function to work with local coordinates
const updateRayVisualizations = (leftFoot, rightFoot, centerFoot, rayDirection, rayLength) => {
  if (!leftRayLine.value || !rightRayLine.value || !centerRayLine.value || !player.value) return;
  
  try {
    // Convert world positions to local positions relative to player
    const worldToLocal = player.value.worldToLocal.bind(player.value);
    
    // Convert foot positions to local space
    const leftFootLocal = worldToLocal(leftFoot.clone());
    const rightFootLocal = worldToLocal(rightFoot.clone());
    const centerFootLocal = worldToLocal(centerFoot.clone());
    
    // Calculate end points in world space then convert to local
    const leftEndWorld = leftFoot.clone().add(rayDirection.clone().multiplyScalar(rayLength));
    const rightEndWorld = rightFoot.clone().add(rayDirection.clone().multiplyScalar(rayLength));
    const centerEndWorld = centerFoot.clone().add(rayDirection.clone().multiplyScalar(rayLength));
    
    const leftEndLocal = worldToLocal(leftEndWorld);
    const rightEndLocal = worldToLocal(rightEndWorld);
    const centerEndLocal = worldToLocal(centerEndWorld);
    
    // Update geometry positions in local space
    const updateRayGeometry = (rayLine, startLocal, endLocal) => {
      const positions = rayLine.geometry.attributes.position.array;
      positions[0] = startLocal.x;
      positions[1] = startLocal.y;
      positions[2] = startLocal.z;
      positions[3] = endLocal.x;
      positions[4] = endLocal.y;
      positions[5] = endLocal.z;
      rayLine.geometry.attributes.position.needsUpdate = true;
    };
    
    updateRayGeometry(leftRayLine.value, leftFootLocal, leftEndLocal);
    updateRayGeometry(rightRayLine.value, rightFootLocal, rightEndLocal);
    updateRayGeometry(centerRayLine.value, centerFootLocal, centerEndLocal);
    
    // Update colors based on hits
    leftRayLine.value.material.color.setHex(leftFootHit.value ? 0xff0000 : 0x00ff00);
    rightRayLine.value.material.color.setHex(rightFootHit.value ? 0xff0000 : 0x00ff00);
    centerRayLine.value.material.color.setHex(centerFootHit.value ? 0xff0000 : 0x00ff00);
  } catch (e) {
    console.error("Error updating ray visualizations:", e);
  }
};

// Add missing onBeforeUnmount
onBeforeUnmount(() => {
  // Clean up event listeners
  window.removeEventListener('resize', onResize);
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('keyup', onKeyUp);
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('pointerlockchange', onPointerLockChange);
  
  // Clear timeout if it exists
  if (initTimeout.value) {
    clearTimeout(initTimeout.value);
  }
  
  // Dispose of Three.js resources
  if (renderer.value) {
    renderer.value.dispose();
  }
  
  // Exit pointer lock
  if (document.pointerLockElement === gameCanvas.value) {
    document.exitPointerLock();
  }
});

// Add the missing handleAllMovement function before the animate function
const handleAllMovement = (deltaTime) => {
  if (!playerBody.value || !physicsWorld.value) return;
  
  try {
    const velocity = playerBody.value.linvel();
    const playerTranslation = playerBody.value.translation();
    const playerPos = new THREE.Vector3(playerTranslation.x, playerTranslation.y, playerTranslation.z);
    
    // Calculate planet-centered gravity
    const gravityDir = new THREE.Vector3()
      .subVectors(gravity.center, playerPos)
      .normalize();
    
    // Calculate distance for gravity falloff (optional)
    const distanceToPlanet = playerPos.distanceTo(gravity.center);
    const gravityStrength = gravity.strength; // Could add distance falloff here: / (distanceToPlanet * distanceToPlanet)
    
    // Apply custom gravity force
    const gravityForce = gravityDir.clone().multiplyScalar(gravityStrength * deltaTime);
    
    // Calculate movement input
    let moveX = 0;
    let moveZ = 0;
    
    if (keys.forward) moveZ -= 1;
    if (keys.backward) moveZ += 1;
    if (keys.left) moveX -= 1;
    if (keys.right) moveX += 1;
    
    // Normalize movement vector
    const moveLength = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (moveLength > 0) {
      moveX /= moveLength;
      moveZ /= moveLength;
    }
    
    // Apply speed
    const speed = keys.run ? runSpeed : walkSpeed;
    moveX *= speed;
    moveZ *= speed;
    
    // Update isMoving and currentSpeed for UI
    isMoving.value = moveLength > 0;
    currentSpeed.value = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    
    // Get player's forward and right vectors
    const playerQuat = new THREE.Quaternion(
      playerBody.value.rotation().x,
      playerBody.value.rotation().y,
      playerBody.value.rotation().z,
      playerBody.value.rotation().w
    );
    
    // Calculate movement direction in world space
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(playerQuat);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(playerQuat);
    
    // Calculate final movement vector
    const moveDir = new THREE.Vector3();
    moveDir.addScaledVector(forward, moveZ);
    moveDir.addScaledVector(right, moveX);
    
    // Start with current velocity and apply planet gravity
    let newVelX = velocity.x + gravityForce.x;
    let newVelY = velocity.y + gravityForce.y;
    let newVelZ = velocity.z + gravityForce.z;
    
    // Apply movement forces - use impulses instead of direct velocity for better physics
    if (isGrounded.value) {
      // Ground movement - apply impulses for more responsive control
      const groundAccel = 50.0; // Acceleration on ground
      newVelX += moveDir.x * groundAccel * deltaTime;
      newVelZ += moveDir.z * groundAccel * deltaTime;
      
      // Apply ground friction when not moving
      if (moveLength === 0) {
        newVelX *= 0.8; // Ground friction
        newVelZ *= 0.8;
      }
      
      // Clamp to max speed (but don't limit gravity component)
      const horizontalVel = new THREE.Vector3(newVelX, 0, newVelZ);
      const gravityComponent = new THREE.Vector3(gravityForce.x, 0, gravityForce.z);
      const movementVel = horizontalVel.clone().sub(gravityComponent);
      
      if (movementVel.length() > speed) {
        movementVel.normalize().multiplyScalar(speed);
        newVelX = movementVel.x + gravityComponent.x;
        newVelZ = movementVel.z + gravityComponent.z;
      }
    } else {
      // Air movement - reduced control
      const airControl = 10.0;
      newVelX += moveDir.x * airControl * deltaTime;
      newVelZ += moveDir.z * airControl * deltaTime;
      
      // Apply air resistance
      newVelX *= 0.99;
      newVelZ *= 0.99;
    }
    
    // Handle jumping - jump against gravity direction
    if (keys.jump && isGrounded.value && !jumpInProgress.value) {
      const jumpVector = gravityDir.clone().multiplyScalar(-jumpForce);
      newVelX += jumpVector.x;
      newVelY += jumpVector.y;
      newVelZ += jumpVector.z;
      jumpInProgress.value = true;
      jumpTime.value = 0;
      console.log("Jump initiated against gravity direction with force:", jumpForce);
    }
    
    // Update jump progress
    if (jumpInProgress.value) {
      jumpTime.value += deltaTime;
      if (jumpTime.value >= jumpDuration || isGrounded.value) {
        jumpInProgress.value = false;
      }
    }
    
    // Apply the new velocity
    playerBody.value.setLinvel({
      x: newVelX,
      y: newVelY,
      z: newVelZ
    }, true);
    
    // Debug logging for movement
    if (frameCount.value % 60 === 0 && (moveLength > 0 || !isGrounded.value)) {
      console.log("Movement - Gravity dir:", gravityDir.x.toFixed(2), gravityDir.y.toFixed(2), gravityDir.z.toFixed(2),
                  "Distance to planet:", distanceToPlanet.toFixed(1),
                  "Vel:", newVelX.toFixed(2), newVelY.toFixed(2), newVelZ.toFixed(2),
                  "Grounded:", isGrounded.value);
    }
  } catch (e) {
    console.error("Error in handleAllMovement:", e);
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
