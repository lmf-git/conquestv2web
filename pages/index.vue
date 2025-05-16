<template>
  <div ref="container"></div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'
import * as RAPIER from '@dimforge/rapier3d-compat'

const container = ref(null)
let camera, scene, renderer
let physics, world
let sphereBody, characterController
let planetCenter = new THREE.Vector3(0, 0, 0)
let planetRadius = 100
let playerDirection = new THREE.Vector3()
let keyStates = {}
let playerIsGrounded = false
let playerRotationY = 0
let eventQueue // Add event queue for collision detection
let characterColliderId // Store the player collider's ID for collision detection

// FPS character controller settings
const characterControllerDesc = {
  offset: 0.6,
  radius: 0.4,
  height: 1.8,
  maxSlopeClimbAngle: 0.8,
  minSlopeSlideAngle: 0.6,
  autostep: {
    maxHeight: 0.3,
    minWidth: 0.1,
    includeDynamicBodies: true,
  },
  enableSnapToGround: 2.0,
}

const clock = new THREE.Clock()

onMounted(async () => {
  await init()
  animate()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  window.removeEventListener('mousemove', handleMouseMove)
  renderer.dispose()
})

async function init() {
  // Scene
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x88ccff)
  scene.fog = new THREE.Fog(0x88ccff, 0, 300)

  // Camera
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000)
  
  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  container.value.appendChild(renderer.domElement)

  // Light
  const light = new THREE.DirectionalLight(0xffffff, 1)
  light.position.set(0, 100, 0)
  light.castShadow = true
  light.shadow.camera.top = 180
  light.shadow.camera.bottom = -100
  light.shadow.camera.left = -120
  light.shadow.camera.right = 120
  scene.add(light)

  // Physics
  await initPhysics()
  createPlanet()
  createCharacterController()
  
  // Event listeners
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  window.addEventListener('mousemove', handleMouseMove)
  document.body.requestPointerLock = document.body.requestPointerLock || document.body.mozRequestPointerLock
  container.value.addEventListener('click', () => document.body.requestPointerLock())

  window.addEventListener('resize', onWindowResize)
}

async function initPhysics() {
  // Initialize Rapier properly for compat version
  await RAPIER.init();
  physics = RAPIER;
  
  // Create physics world with zero gravity (we'll apply spherical gravity manually)
  const gravity = { x: 0, y: 0, z: 0 };
  world = new RAPIER.World(gravity);
  
  // Create event queue for collision detection
  eventQueue = new physics.EventQueue(true);
}

function createPlanet() {
  // Create visual planet
  const planetGeometry = new THREE.SphereGeometry(planetRadius, 64, 64)
  const planetMaterial = new THREE.MeshStandardMaterial({ color: 0x88aa88 })
  const planetMesh = new THREE.Mesh(planetGeometry, planetMaterial)
  planetMesh.receiveShadow = true
  scene.add(planetMesh)
  
  // Create physics planet with appropriate friction
  const rigidBodyDesc = new physics.RigidBodyDesc(physics.RigidBodyType.Fixed)
  sphereBody = world.createRigidBody(rigidBodyDesc)
  
  const colliderDesc = new physics.ColliderDesc(new physics.Ball(planetRadius))
    .setFriction(1.0)
    .setRestitution(0.1)
  world.createCollider(colliderDesc, sphereBody)
}

function createCharacterController() {
  // Start player far away from the planet to watch it fall
  const spawnDistance = planetRadius * 5;
  const startPosition = new THREE.Vector3(spawnDistance, 0, 0);
  
  // Create rigid body for character
  const rigidBodyDesc = new physics.RigidBodyDesc(physics.RigidBodyType.Dynamic)
    .setTranslation(startPosition.x, startPosition.y, startPosition.z)
    .setCcdEnabled(true);
  
  characterController = world.createRigidBody(rigidBodyDesc);
  
  // Create capsule collider for the character
  const capsuleHeight = characterControllerDesc.height - characterControllerDesc.radius * 2;
  const capsuleCollider = new physics.ColliderDesc(
    new physics.Capsule(capsuleHeight/2, characterControllerDesc.radius)
  )
    .setFriction(1.0)
    .setDensity(1.0);
  
  const collider = world.createCollider(capsuleCollider, characterController);
  characterColliderId = collider.handle; // Store collider ID for later comparison
  
  // Create a visual representation of the character
  const capsuleGeometry = new THREE.CapsuleGeometry(
    characterControllerDesc.radius, 
    capsuleHeight,
    4, 8
  );
  const capsuleMaterial = new THREE.MeshStandardMaterial({ color: 0xff8888 });
  const capsuleMesh = new THREE.Mesh(capsuleGeometry, capsuleMaterial);
  capsuleMesh.castShadow = true;
  capsuleMesh.name = 'character';
  
  // Create separate player rotation group
  const playerGroup = new THREE.Group();
  playerGroup.name = 'playerGroup';
  playerGroup.add(capsuleMesh);
  scene.add(playerGroup);
  
  // Add camera to a separate mount that only handles vertical rotation
  const cameraOffset = new THREE.Object3D();
  cameraOffset.position.set(0, characterControllerDesc.height * 0.7, 0);
  cameraOffset.name = 'cameraMount';
  capsuleMesh.add(cameraOffset);
  cameraOffset.add(camera);
}

function updateCharacterDirection() {
  const position = characterController.translation();
  const currentPos = new THREE.Vector3(position.x, position.y, position.z);
  
  // Calculate direction to planet center (gravity direction)
  const gravityDir = currentPos.clone().sub(planetCenter).normalize().negate();
  
  // Only apply gravity when falling
  if (!playerIsGrounded) {
    // Use normal Earth gravity (9.8) for a more realistic fall
    const gravity = gravityDir.multiplyScalar(9.8);
    characterController.addForce({ x: gravity.x, y: gravity.y, z: gravity.z }, true);
    return;
  }
  
  // When grounded, we don't use physics forces for movement
  // Instead we'll use direct kinematic positioning
  // For grounded player, ensure they stay locked to the surface by applying a small
  // gravity force even when grounded
  const surfaceGravity = gravityDir.multiplyScalar(5.0);
  characterController.addForce({ x: surfaceGravity.x, y: surfaceGravity.y, z: surfaceGravity.z }, true);
  
  // For grounded player, movement is along the surface
  const characterMesh = scene.getObjectByName('character');
  const playerGroup = scene.getObjectByName('playerGroup');
  
  if (characterMesh && playerGroup) {
    // Use player rotation for forward/back movement
    const forward = new THREE.Vector3(0, 0, 1);
    forward.applyQuaternion(playerGroup.quaternion);
    forward.sub(gravityDir.clone().multiplyScalar(gravityDir.dot(forward))).normalize();
    
    // Get right vector for strafing
    const right = forward.clone().cross(gravityDir.clone().negate()).normalize();
    
    // Build movement direction based on key states
    playerDirection.set(0, 0, 0);
    if (keyStates['KeyW']) playerDirection.add(forward);
    if (keyStates['KeyS']) playerDirection.sub(forward);
    if (keyStates['KeyA']) playerDirection.sub(right);
    if (keyStates['KeyD']) playerDirection.add(right);
    playerDirection.normalize();
  }
}

function lockPlayerToSurface() {
  if (!playerIsGrounded) return;
  
  const position = characterController.translation();
  const currentPos = new THREE.Vector3(position.x, position.y, position.z);
  
  // Get direction from center to current position
  const dirFromCenter = currentPos.clone().sub(planetCenter).normalize();
  
  // Set new position at exact distance from planet center
  const distanceFromSurface = characterControllerDesc.height / 2;
  const newPos = dirFromCenter.clone().multiplyScalar(planetRadius + distanceFromSurface);
  
  // Update rigid body position
  characterController.setTranslation(newPos);
  
  // Reset velocity when locked to surface - player movement will be fully kinematic
  characterController.setLinvel({ x: 0, y: 0, z: 0 }, true);
  characterController.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

function handleKeyDown(event) {
  keyStates[event.code] = true
}

function handleKeyUp(event) {
  keyStates[event.code] = false
}

function handleMouseMove(event) {
  if (!document.pointerLockElement) return;
  
  // Vertical rotation only affects camera pitch
  camera.rotation.x -= event.movementY * 0.002;
  camera.rotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, camera.rotation.x));
  
  // Horizontal rotation affects the whole player
  if (playerIsGrounded) {
    playerRotationY -= event.movementX * 0.002;
    const playerGroup = scene.getObjectByName('playerGroup');
    if (playerGroup) {
      // Need to recalculate orientation on the sphere
      const position = characterController.translation();
      const currentPos = new THREE.Vector3(position.x, position.y, position.z);
      const up = currentPos.clone().sub(planetCenter).normalize();
      
      // Create a rotation that first aligns with the surface normal
      // and then applies the player's yaw rotation around that normal
      const alignQuat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0), up
      );
      
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), playerRotationY
      );
      
      // Apply alignQuat first, then yawQuat
      playerGroup.quaternion.copy(yawQuat).premultiply(alignQuat);
    }
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}

function animate() {
  requestAnimationFrame(animate);
  
  const deltaTime = clock.getDelta();
  
  // Update physics direction and forces
  updateCharacterDirection();
  
  // Process collision events
  processCollisionEvents();
  
  // When grounded, the player is fully controlled kinematically
  if (playerIsGrounded) {
    // Always lock to surface when grounded
    lockPlayerToSurface();
    
    // Handle player movement
    if (playerDirection.lengthSq() > 0) {
      const moveSpeed = 5.0 * deltaTime;
      const moveVector = playerDirection.clone().multiplyScalar(moveSpeed);
      
      const position = characterController.translation();
      const currentPos = new THREE.Vector3(position.x, position.y, position.z);
      
      // Calculate new position with movement
      currentPos.add(moveVector);
      
      // Project back to sphere surface
      const dirFromCenter = currentPos.clone().sub(planetCenter).normalize();
      const newPos = dirFromCenter.multiplyScalar(planetRadius + (characterControllerDesc.height / 2));
      
      // Directly set new position (kinematic control)
      characterController.setTranslation(newPos);
    }
  }
  
  // Always step the physics world and collect events
  world.step(eventQueue);
  
  // Update character visual position and rotation
  const characterMesh = scene.getObjectByName('character');
  const playerGroup = scene.getObjectByName('playerGroup');
  
  if (characterMesh && playerGroup) {
    const position = characterController.translation();
    playerGroup.position.set(position.x, position.y, position.z);
    
    // Only update character rotation if not grounded
    // If grounded, rotation is handled by mouse movement
    if (!playerIsGrounded) {
      // Align character with planet surface
      const toCenter = new THREE.Vector3(position.x, position.y, position.z).sub(planetCenter).normalize();
      const up = toCenter.clone();
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
      forward.sub(up.clone().multiplyScalar(up.dot(forward))).normalize();
      const quat = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().lookAt(new THREE.Vector3(), forward, up)
      );
      characterMesh.quaternion.copy(quat);
      characterController.setRotation(quat);
    }
  }
  
  renderer.render(scene, camera);
}

// New function to process collision events
function processCollisionEvents() {
  // Skip if already grounded
  if (playerIsGrounded) return;
  
  // Process all collision events
  eventQueue.drainCollisionEvents((handle1, handle2, started) => {
    // Check if one of the colliders is the player
    if (handle1 === characterColliderId || handle2 === characterColliderId) {
      if (started) {
        console.log("Player collision detected");
        
        // Player has landed on the planet
        playerIsGrounded = true;
        
        // Switch to kinematic mode
        characterController.setBodyType(physics.RigidBodyType.KinematicPositionBased);
        
        // Lock player to surface
        lockPlayerToSurface();
      }
    }
  });
}
</script>

<style scoped>
div {
  width: 100vw;
  height: 100vh;
  margin: 0;
  padding: 0;
  overflow: hidden;
}
</style>
