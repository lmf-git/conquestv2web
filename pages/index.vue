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
}

function createPlanet() {
  // Create visual planet
  const planetGeometry = new THREE.SphereGeometry(planetRadius, 64, 64)
  const planetMaterial = new THREE.MeshStandardMaterial({ color: 0x88aa88 })
  const planetMesh = new THREE.Mesh(planetGeometry, planetMaterial)
  planetMesh.receiveShadow = true
  scene.add(planetMesh)
  
  // Create physics planet
  const rigidBodyDesc = new physics.RigidBodyDesc(physics.RigidBodyType.Fixed)
  sphereBody = world.createRigidBody(rigidBodyDesc)
  
  const colliderDesc = new physics.ColliderDesc(new physics.Ball(planetRadius))
    .setFriction(0.8)
  world.createCollider(colliderDesc, sphereBody)
}

function createCharacterController() {
  // Instead of using character controller, create a dynamic rigid body with a capsule shape
  const startPosition = new THREE.Vector3(0, 0, planetRadius + characterControllerDesc.height);
  
  // Create rigid body for character
  const rigidBodyDesc = new physics.RigidBodyDesc(physics.RigidBodyType.Dynamic)
    .setTranslation(startPosition.x, startPosition.y, startPosition.z);
  characterController = world.createRigidBody(rigidBodyDesc);
  
  // Create capsule collider for the character
  const capsuleHeight = characterControllerDesc.height - characterControllerDesc.radius * 2;
  const capsuleCollider = new physics.ColliderDesc(
    new physics.Capsule(capsuleHeight/2, characterControllerDesc.radius)
  )
    .setFriction(0.7)
    .setDensity(1.0);
  
  world.createCollider(capsuleCollider, characterController);
  
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
  
  // Add camera as a child of character mesh
  const cameraOffset = new THREE.Object3D();
  cameraOffset.position.set(0, characterControllerDesc.height * 0.7, 0);
  cameraOffset.name = 'cameraMount';
  capsuleMesh.add(cameraOffset);
  cameraOffset.add(camera);
  
  scene.add(capsuleMesh);
}

function updateCharacterDirection() {
  // Get current position from rigid body instead of character controller
  const position = characterController.translation();
  const currentPos = new THREE.Vector3(position.x, position.y, position.z);
  
  // Calculate direction to planet center (gravity direction)
  const gravityDir = currentPos.clone().sub(planetCenter).normalize().negate();
  
  // Create a rotation matrix that orients the character to the planet surface
  const up = gravityDir.clone();
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
  forward.sub(up.clone().multiplyScalar(up.dot(forward))).normalize();
  const right = forward.clone().cross(up).normalize();
  
  // Build movement direction based on key states
  playerDirection.set(0, 0, 0);
  if (keyStates['KeyW']) playerDirection.add(forward);
  if (keyStates['KeyS']) playerDirection.sub(forward);
  if (keyStates['KeyA']) playerDirection.sub(right);
  if (keyStates['KeyD']) playerDirection.add(right);
  playerDirection.normalize();
  
  // Apply spherical gravity to rigid body
  const gravity = gravityDir.multiplyScalar(9.8);
  characterController.addForce({ x: gravity.x, y: gravity.y, z: gravity.z }, true);
}

function handleKeyDown(event) {
  keyStates[event.code] = true
}

function handleKeyUp(event) {
  keyStates[event.code] = false
}

function handleMouseMove(event) {
  if (document.pointerLockElement) {
    camera.rotation.y -= event.movementX * 0.002
    camera.rotation.x -= event.movementY * 0.002
    camera.rotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, camera.rotation.x))
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
  
  // Update physics
  updateCharacterDirection();
  
  // Character movement - apply forces for movement
  if (playerDirection.lengthSq() > 0) {
    const moveSpeed = 50.0; // Increased force for movement
    characterController.addForce(
      { 
        x: playerDirection.x * moveSpeed, 
        y: playerDirection.y * moveSpeed, 
        z: playerDirection.z * moveSpeed 
      }, 
      true
    );
  }
  
  world.step();
  
  // Update character visual position and rotation
  const characterMesh = scene.getObjectByName('character');
  if (characterMesh) {
    const position = characterController.translation();
    characterMesh.position.set(position.x, position.y, position.z);
    
    // Align character with planet surface
    const toCenter = new THREE.Vector3(position.x, position.y, position.z).sub(planetCenter).normalize();
    const up = toCenter.clone();
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
    forward.sub(up.clone().multiplyScalar(up.dot(forward))).normalize();
    const quat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(new THREE.Vector3(), forward, up)
    );
    characterMesh.quaternion.copy(quat);
    
    // Also update the rigid body rotation to match the mesh
    characterController.setRotation(quat);
  }
  
  renderer.render(scene, camera);
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
