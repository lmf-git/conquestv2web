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
  center: new THREE.Vector3(0, -150, 0),
  strength: 20  // Increased from 10 to 20 for more obvious effect
});

// Initialize debugInfo as a reactive object to store debugging information
const debugInfo = reactive({
  planetHandle: null,
  platformHandle: null,
  playerColliderHandle: null,
  lastQueryResult: null,
  colliderCount: 0
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
        const gravityVec = { x: 0, y: -20, z: 0 };
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
        const gravityVec = { x: 0, y: -20, z: 0 };
        physicsWorld.value = new RAPIER.World(gravityVec);
        console.log("Physics world created with gravity:", gravityVec);
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
    
    // Position player higher above platform to avoid initial intersection
    const spawnHeight = 35;
    
    // Create player physics body as KINEMATIC for direct control
    const playerBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(0, spawnHeight, 10);
    
    playerBody.value = physicsWorld.value.createRigidBody(playerBodyDesc);
    
    // Create player collider with improved settings
    const playerColliderDesc = RAPIER.ColliderDesc.capsule(
      playerHeight / 2 - playerRadius,
      playerRadius
    )
    .setFriction(0.7)
    .setRestitution(0.0)
    .setDensity(1.0);
    
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
    
    console.log("Player created successfully");
  } catch (e) {
    console.error("Error creating player:", e);
  }
};

// Add missing checkGrounded function
const checkGrounded = () => {
  if (!playerBody.value || !physicsWorld.value) return;
  
  try {
    // Get player position
    const playerTranslation = playerBody.value.translation();
    const playerPos = new THREE.Vector3(
      playerTranslation.x,
      playerTranslation.y,
      playerTranslation.z
    );
    
    // Calculate gravity direction
    const gravityDir = new THREE.Vector3()
      .subVectors(gravity.center, playerPos)
      .normalize();
    
    // Set ray direction
    rayDir.value = gravityDir.clone();
    
    // Single ray from player center is more stable for kinematic bodies
    const rayOrigin = {
      x: playerPos.x,
      y: playerPos.y,
      z: playerPos.z
    };
    
    // Cast a single ray from player center
    const ray = new RAPIER.Ray(rayOrigin, {
      x: rayDir.value.x,
      y: rayDir.value.y,
      z: rayDir.value.z
    });
    
    // Cast ray with proper filtering - REMOVE EXCLUDE_SOLIDS!
    const maxDistance = playerHeight * 0.6 + 0.5; // Just beyond bottom of capsule
    const hit = physicsWorld.value.castRay(
      ray,
      maxDistance,
      true, // solid
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, // Only exclude sensors, NOT solids!
      undefined,
      undefined,
      (colliderHandle) => {
        // Filter out the player's own collider
        const collider = physicsWorld.value.getCollider(colliderHandle);
        if (collider) {
          const body = collider.parent();
          // Check if this is the player's body
          if (body && body.handle === playerBody.value.handle) {
            return false; // Exclude player's own collider
          }
        }
        return true; // Include all other colliders
      }
    );
    
    // Update foot positions for visualization
    const playerQuat = new THREE.Quaternion(
      playerBody.value.rotation().x,
      playerBody.value.rotation().y,
      playerBody.value.rotation().z,
      playerBody.value.rotation().w
    );
    
    const footOffset = playerRadius * 0.8;
    const footLevel = -playerHeight * 0.45;
    
    // Calculate foot positions
    const leftOffset = new THREE.Vector3(-footOffset, footLevel, 0).applyQuaternion(playerQuat);
    const rightOffset = new THREE.Vector3(footOffset, footLevel, 0).applyQuaternion(playerQuat);
    const centerOffset = new THREE.Vector3(0, footLevel, 0).applyQuaternion(playerQuat);
    
    leftFootPos.value.copy(playerPos).add(leftOffset);
    rightFootPos.value.copy(playerPos).add(rightOffset);
    centerFootPos.value.copy(playerPos).add(centerOffset);
    
    // Cast visualization rays from foot positions
    const castFootRay = (footPos) => {
      const footRay = new RAPIER.Ray(
        { x: footPos.x, y: footPos.y, z: footPos.z },
        { x: rayDir.value.x, y: rayDir.value.y, z: rayDir.value.z }
      );
      
      return physicsWorld.value.castRay(
        footRay,
        5.0, // visualization distance
        true,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, // Only exclude sensors, NOT solids!
        undefined,
        undefined,
        (colliderHandle) => {
          const collider = physicsWorld.value.getCollider(colliderHandle);
          if (collider) {
            const body = collider.parent();
            if (body && body.handle === playerBody.value.handle) {
              return false;
            }
          }
          return true;
        }
      );
    };
    
    // Update foot hits for visualization
    leftFootHit.value = castFootRay(leftFootPos.value);
    rightFootHit.value = castFootRay(rightFootPos.value);
    centerFootHit.value = castFootRay(centerFootPos.value);
    
    // Determine grounded state based on main ray
    const groundThreshold = playerHeight * 0.55; // Slightly more than half height + small margin
    wasGrounded.value = isGrounded.value;
    
    // Check if we have a hit and it's within threshold
    if (hit && hit.toi !== undefined && hit.toi < groundThreshold) {
      isGrounded.value = true;
      // Store the ground hit info for use in ground following
      centerFootHit.value = hit;
      
      if (!wasGrounded.value) {
        console.log("Player landed at distance:", hit.toi);
      }
    } else {
      isGrounded.value = false;
      
      if (wasGrounded.value) {
        console.log("Player became airborne");
      }
    }
    
    // Debug logging
    if (frameCount.value % 60 === 0) { // Log every second
      console.log("Ground check - Hit:", hit ? hit.toi : "none", "Grounded:", isGrounded.value);
    }
  } catch (e) {
    console.error("Error checking grounded state:", e);
  }
};

// Improved applyGroundFollowing function with better collision handling
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
  
  // Handle grounded and ungrounded states differently
  if (isGrounded.value) {
    // We're grounded - align to surface and maintain proper height
    const { groundNormal, upVector } = getGroundNormal();
    
    // Calculate target rotation to align with ground normal
    const targetUp = groundNormal;
    const currentUp = new THREE.Vector3(0, 1, 0).applyQuaternion(player.value.quaternion);
    
    // Create rotation quaternion to align player with surface
    const alignmentQuat = new THREE.Quaternion();
    alignmentQuat.setFromUnitVectors(currentUp, targetUp);
    
    // Apply alignment smoothly
    const currentQuat = player.value.quaternion.clone();
    const targetQuat = alignmentQuat.multiply(currentQuat);
    
    // Slerp for smooth transition
    const slerpedQuat = currentQuat.slerp(targetQuat, 0.1);
    
    // Apply rotation to physics body
    playerBody.value.setRotation({
      x: slerpedQuat.x,
      y: slerpedQuat.y,
      z: slerpedQuat.z,
      w: slerpedQuat.w
    }, true);
    
    // Maintain proper distance from ground using center ray hit
    if (centerFootHit.value && centerFootHit.value.toi !== undefined) {
      const currentDistance = centerFootHit.value.toi;
      const desiredDistance = playerHeight * 0.5 + 0.02; // Half height plus small gap
      
      if (Math.abs(currentDistance - desiredDistance) > 0.01) {
        // Adjust position to maintain correct height
        const adjustment = (desiredDistance - currentDistance) * 0.3; // Smooth adjustment
        const correction = groundNormal.clone().multiplyScalar(adjustment);
        
        const newPos = {
          x: playerPos.x + correction.x,
          y: playerPos.y + correction.y,
          z: playerPos.z + correction.z
        };
        
        playerBody.value.setNextKinematicTranslation(newPos);
      } else {
        // Just update position without adjustment
        playerBody.value.setNextKinematicTranslation({
          x: playerPos.x,
          y: playerPos.y,
          z: playerPos.z
        });
      }
    }
  } else {
    // Not grounded - apply gravity
    const gravityStrength = 0.5; // Gravity acceleration
    
    // Apply gravity acceleration
    const fallVector = gravityDir.clone().multiplyScalar(gravityStrength);
    
    const newPos = {
      x: playerPos.x + fallVector.x,
      y: playerPos.y + fallVector.y,
      z: playerPos.z + fallVector.z
    };
    
    playerBody.value.setNextKinematicTranslation(newPos);
  }
};

// Add missing setupScene function before onMounted (around line 480)
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
    
    // Add to DOM
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
    
    // Create game objects if physics is ready
    if (physicsWorld.value) {
      createPlanet();
      createPlatform();
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

// Add missing createPlanet function (around line 540)
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
      platformWidth / 2 + 0.1,
      platformHeight / 2 + 0.1,
      platformDepth / 2 + 0.1
    )
    .setFriction(0.8)
    .setRestitution(0.2);
    
    const platformCollider = physicsWorld.value.createCollider(platformColliderDesc, platformBody);
    
    if (debugInfo) {
      debugInfo.platformHandle = platformCollider.handle;
    }
    
    console.log("Platform created successfully");
    return platform.value;
  } catch (e) {
    console.error("Error creating platform:", e);
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

// Improved handlePlayerMovement function to handle the jump better
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
    currentSpeed.value = moveSpeed;
    
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
  } else {
    // Not moving
    currentSpeed.value = 0;
  }
  
  // Handle jumping
  if (keys.jump && isGrounded.value && !jumpInProgress.value) {
    // Start jump
    jumpInProgress.value = true;
    jumpTime.value = 0;
    
    // Store the ground normal at jump start
    const { groundNormal } = getGroundNormal();
    lastGroundNormal.value.copy(groundNormal);
    
    console.log("Jump started");
  }
  
  // Apply jump force during jump
  if (jumpInProgress.value) {
    jumpTime.value += deltaTime;
    
    // Calculate jump progress (0 to 1)
    const jumpProgress = Math.min(jumpTime.value / jumpDuration, 1.0);
    
    // Use a parabolic curve for jump force
    const jumpStrength = Math.sin(jumpProgress * Math.PI) * jumpForce * 0.1;
    
    if (jumpStrength > 0) {
      // Apply jump force in the direction of the last ground normal
      const jumpVector = lastGroundNormal.value.clone().multiplyScalar(jumpStrength);
      
      // Get current position
      const playerTranslation = playerBody.value.translation();
      const playerPos = new THREE.Vector3(
        playerTranslation.x,
        playerTranslation.y,
        playerTranslation.z
      );
      
      // Apply jump displacement
      const newPos = {
        x: playerPos.x + jumpVector.x,
        y: playerPos.y + jumpVector.y,
        z: playerPos.z + jumpVector.z
      };
      
      playerBody.value.setNextKinematicTranslation(newPos);
    }
    
    // End jump after duration
    if (jumpTime.value >= jumpDuration) {
      jumpInProgress.value = false;
      console.log("Jump ended");
    }
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

// Remove duplicate createPlayer function - keep only the kinematic version
// Remove duplicate applyGroundFollowing function - keep only the improved version
// Remove duplicate checkGrounded function - keep only the improved dual ray version

// Add missing animate function
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
    
    // Update physics and player
    checkGrounded();
    applyGroundFollowing();
    handlePlayerMovement(deltaTime);
    updatePlayerTransform();
    
    // Update ray visualizations
    if (player.value && rayDir.value) {
      // Use the actual calculated foot positions from checkGrounded
      updateRayVisualizations(
        leftFootPos.value.clone(), 
        rightFootPos.value.clone(), 
        centerFootPos.value.clone(), 
        rayDir.value, 
        5.0
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
