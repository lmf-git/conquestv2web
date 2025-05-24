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
const cameraSmoothingFactor = 0.2; // Directly define here to ensure it's in scope

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
const walkSpeed = 4; // Reduced from 8 to 4
const runSpeed = 8;  // Reduced from 15 to 8
const jumpForce = 8;

// Add these variables for camera smoothing - but keep cameraSmoothingFactor defined above
const lastCameraPosition = shallowRef(new THREE.Vector3());
const lastCameraRotation = shallowRef(new THREE.Euler(0, 0, 0, 'YXZ'));

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

// Add a utility function to get ground normal to avoid duplicate code
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
  
  // Use ray hit normal if available
  if (leftFootHit.value !== null && leftFootHit.value.normal) {
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
  planetColliderDesc.setFriction(1.2); // Increased friction to reduce sliding
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
  platformColliderDesc.setFriction(1.0); // Increased friction
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
  playerColliderDesc.setFriction(0.8); // Increased from 0.2 to 0.8
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
  
  // Add camera to player - position at eye level
  player.value.add(camera.value);
  camera.value.position.set(0, playerHeight * 0.8, 0);
  camera.value.rotation.set(0, 0, 0); // Reset rotation
  
  // Initialize camera rotation
  cameraRotation.value.set(0, 0, 0);
  
  // No need for lastCameraPosition and lastCameraRotation with simplified approach
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

// Define updatePlayerTransform BEFORE animate calls it
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
    
    // With the camera as a child of the player, we only need to handle pitch (looking up/down)
    // The player's rotation handles the yaw (looking left/right)
    if (isGrounded.value) {
      // When grounded, the camera only needs to handle pitch
      camera.value.rotation.x = cameraRotation.value.x;
      camera.value.rotation.y = 0; // No yaw - player handles this
      camera.value.rotation.z = 0; // No roll
    } else {
      // When airborne, camera uses both pitch and yaw
      camera.value.rotation.x = cameraRotation.value.x;
      camera.value.rotation.y = cameraRotation.value.y;
      camera.value.rotation.z = 0;
    }
  } catch (e) {
    console.error("Error updating player transform:", e);
  }
};

// Keep only this one animate function - remove any duplicates
const animate = () => {
  if (!started.value) return;
  
  requestAnimationFrame(animate);
  
  const deltaTime = Math.min(clock.getDelta(), 0.1);
  
  // First check ground contact
  checkGrounded();
  
  // Then update physics simulation
  updatePhysics(deltaTime);
  
  // Then update player position and rotation
  updatePlayerTransform();
  
  // Then handle player movement
  handlePlayerMovement(deltaTime);
  
  // Update UI position display
  if (playerBody.value) {
    const position = playerBody.value.translation();
    const displayPos = playerPosition.value;
    displayPos.set(position.x, position.y, position.z);
  }
  
  // Render scene
  try {
    renderer.value?.render(scene.value, camera.value);
  } catch (e) {
    console.error("Render error:", e);
  }
};

const updatePhysics = (deltaTime) => {
  // Apply point gravity to player
  applyPointGravity();
  
  // Force upright orientation when grounded to prevent rolling
  if (isGrounded.value && playerBody.value) {
    // Get ground normal and related vectors
    const { groundNormal, upVector } = getGroundNormal();
    
    // Force align with ground normal
    alignPlayerWithGround(groundNormal, upVector);
    
    // Force zero angular velocity
    playerBody.value.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
  
  // Step physics world
  physicsWorld.value.step();
  
  // After physics step, get current velocity for debug info
  if (playerBody.value) {
    const vel = playerBody.value.linvel();
    currentSpeed.value = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
  }
};

const applyPointGravity = () => {
  if (!playerBody.value) return;
  
  // Skip gravity if player is grounded
  if (isGrounded.value) return;
  
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
  const rayLength = 0.5; // Increased from 0.3 to 0.5
  
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
  const wasGrounded = isGrounded.value;
  isGrounded.value = (leftFootHit.value !== null) || (rightFootHit.value !== null);
  
  // If just landed, reduce vertical velocity to prevent bouncing
  if (!wasGrounded && isGrounded.value && playerBody.value) {
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
  }
  
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

// Modify the alignPlayerWithGround function to be more stable
const alignPlayerWithGround = (normal, upVector) => {
  if (!isGrounded.value || !playerBody.value) return;
  
  try {
    // Create a rotation that aligns the player with the ground
    
    // Get current forward direction from the player
    const playerForward = new THREE.Vector3(0, 0, -1).applyQuaternion(player.value.quaternion);
    
    // Project the current forward direction onto the ground plane
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
    
    // Create orthogonal basis
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
    
    // Smoothly interpolate between current and target orientation
    // to avoid sudden changes that cause instability
    currentQuat.slerp(quaternion, 0.2); // 20% blend per frame for smooth transition
    
    // Apply the smoothed rotation
    playerBody.value.setRotation(
      { x: currentQuat.x, y: currentQuat.y, z: currentQuat.z, w: currentQuat.w },
      false // Don't wake the body to avoid physics artifacts
    );
  } catch (e) {
    console.error("Error in alignPlayerWithGround:", e);
  }
};

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
    
    // Get ground normal and related vectors
    const { groundNormal, playerPos } = getGroundNormal();
    
    // Create a local rotation space aligned with the ground
    const playerQuat = player.value.quaternion;
    
    // When grounded, use player's forward direction
    // When airborne, use camera's yaw direction
    let movementQuat;
    if (isGrounded.value) {
      // Use player's orientation for movement direction to prevent spinning
      movementQuat = playerQuat.clone();
    } else {
      // Use only the yaw component of camera rotation when airborne
      movementQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, cameraRotation.value.y, 0)
      );
    }
    
    // Apply movement based on determined direction
    const moveVec = moveDir.clone().applyQuaternion(movementQuat);
    
    // For grounded movement, project onto the ground plane
    let finalMoveVec = new THREE.Vector3();
    
    if (isGrounded.value) {
      // Project movement vector onto the ground plane
      // 1. Remove any component pointing along the ground normal
      const dot = moveVec.dot(groundNormal);
      finalMoveVec.copy(moveVec).sub(groundNormal.clone().multiplyScalar(dot));
      
      // 2. Make sure we have a meaningful vector
      if (finalMoveVec.length() > 0.001) {
        finalMoveVec.normalize().multiplyScalar(moveSpeed * deltaTime * 30); // Reduced from 60 to 30
      } else {
        // Fallback: use a default direction along the ground
        finalMoveVec.set(1, 0, 0).applyQuaternion(playerQuat);
        finalMoveVec.sub(groundNormal.clone().multiplyScalar(finalMoveVec.dot(groundNormal)));
        finalMoveVec.normalize().multiplyScalar(moveSpeed * deltaTime * 30); // Reduced from 60 to 30
      }
    } else {
      // Airborne: simpler movement with reduced control
      finalMoveVec.copy(moveVec).multiplyScalar(moveSpeed * 0.1 * deltaTime * 20); // Reduced from 0.2 to 0.1
    }
    
    // Apply the movement force through the center of mass to avoid torque
    if (finalMoveVec.length() > 0) {
      const playerTranslation = playerBody.value.translation();
      playerBody.value.applyImpulseAtPoint(
        { x: finalMoveVec.x, y: finalMoveVec.y, z: finalMoveVec.z },
        playerTranslation, // Apply at center of mass
        true
      );
      
      isMoving.value = true;
      currentSpeed.value = finalMoveVec.length() / (deltaTime * 20);
    }
  }
  
  // Handle jumping - use a gentler jump force when on the planet
  if (keys.jump && isGrounded.value) {
    // Get player position and related vectors
    const { playerPos, gravityDir } = getGroundNormal();
    
    const distToPlanet = playerPos.distanceTo(gravity.center);
    
    // Calculate jump direction (opposite to gravity)
    const jumpDir = gravityDir.clone().negate();
    
    // Apply jump impulse - reduce force when on the planet to prevent glitching
    const jumpMultiplier = distToPlanet < 110 ? 0.7 : 1.0; // Reduce jump force when on planet
    
    playerBody.value.applyImpulse({
      x: jumpDir.x * jumpForce * jumpMultiplier,
      y: jumpDir.y * jumpForce * jumpMultiplier,
      z: jumpDir.z * jumpForce * jumpMultiplier
    }, true);
    
    // Prevent multiple jumps
    keys.jump = false;
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
    // Update vertical camera rotation (pitch)
    cameraRotation.value.x -= event.movementY * sensitivity;
    
    // Limit vertical look angle to avoid flipping
    cameraRotation.value.x = Math.max(
      -Math.PI / 2 + 0.01, 
      Math.min(Math.PI / 2 - 0.01, cameraRotation.value.x)
    );
    
    // Handle horizontal rotation (yaw)
    if (isGrounded.value && playerBody.value) {
      // On ground, rotate the entire player body around the ground normal
      const { groundNormal } = getGroundNormal();
      
      // Create rotation quaternion for horizontal mouse movement
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(
        groundNormal, 
        -event.movementX * sensitivity
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
      
      // Reset camera's yaw since player body handles it
      cameraRotation.value.y = 0;
    } else {
      // When airborne, store yaw in camera rotation
      cameraRotation.value.y -= event.movementX * sensitivity;
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
