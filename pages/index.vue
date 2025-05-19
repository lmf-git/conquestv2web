<template>
  <div class="container">
    <canvas ref="canvasRef"></canvas>
    <div class="controls-info">
      <p>WASD: Move | SPACE: Jump | MOUSE: Look</p>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import RAPIER from '@dimforge/rapier3d-compat';

const canvasRef = ref(null);

// Three.js variables
let scene, camera, renderer, controls;
let terrain, playerMesh, playerCollider;

// Rapier physics variables
let world, playerBody;
let physicsInitialized = false;

// Player movement
const playerState = {
  velocity: new THREE.Vector3(),
  direction: new THREE.Vector3(),
  onGround: false,
  jump: false,
  moveForward: false,
  moveBackward: false,
  moveLeft: false,
  moveRight: false,
};

// Constants
const GRAVITY_CENTER = new THREE.Vector3(0, 0, 0);
const GRAVITY_STRENGTH = 9.8;
const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.4;
const MOVE_SPEED = 5;
const JUMP_FORCE = 5;
const PLANET_RADIUS = 50;
const TERRAIN_DETAIL = 64; // Resolution of the sphere
const TERRAIN_HEIGHT_SCALE = 5; // How much the terrain varies in height

// Generate spherical terrain vertices with height variations
function generateSphericalTerrain() {
  // Create base icosphere geometry
  const geometry = new THREE.IcosahedronGeometry(PLANET_RADIUS, 4);
  
  // Apply noise to each vertex
  const positionAttribute = geometry.attributes.position;
  
  for (let i = 0; i < positionAttribute.count; i++) {
    const vertex = new THREE.Vector3();
    vertex.fromBufferAttribute(positionAttribute, i);
    
    // Normalize to get direction from center
    const direction = vertex.clone().normalize();
    
    // Get spherical coordinates for noise sampling
    const spherical = new THREE.Spherical().setFromVector3(direction);
    
    // Calculate noise based on position
    const noiseFreq = 0.5;
    let noise = 0;
    
    // Multi-octave noise for more interesting terrain
    noise += Math.sin(spherical.phi * 4.5 * noiseFreq) * Math.cos(spherical.theta * 3.2 * noiseFreq) * 0.5;
    noise += Math.sin(spherical.phi * 9.1 * noiseFreq) * Math.cos(spherical.theta * 7.7 * noiseFreq) * 0.25;
    noise += Math.sin(spherical.phi * 18.3 * noiseFreq) * Math.cos(spherical.theta * 14.2 * noiseFreq) * 0.125;
    
    // Apply height variation
    const scaledNoise = (noise + 1) * 0.5 * TERRAIN_HEIGHT_SCALE;
    vertex.add(direction.multiplyScalar(scaledNoise));
    
    // Update position
    positionAttribute.setXYZ(i, vertex.x, vertex.y, vertex.z);
  }
  
  // Update geometry
  positionAttribute.needsUpdate = true;
  geometry.computeVertexNormals();
  
  return geometry;
}

// Convert Three.js geometry to Rapier trimesh
function createTrimeshCollider(geometry) {
  // Extract vertices from geometry
  const positionAttribute = geometry.attributes.position;
  
  // Create array for vertices
  const vertices = new Float32Array(positionAttribute.count * 3);
  
  // Copy vertex data
  for (let i = 0; i < positionAttribute.count; i++) {
    vertices[i * 3] = positionAttribute.getX(i);
    vertices[i * 3 + 1] = positionAttribute.getY(i);
    vertices[i * 3 + 2] = positionAttribute.getZ(i);
  }
  
  // Create indices array based on whether the geometry is indexed or not
  let indices;
  if (geometry.index) {
    // If geometry is indexed, use its index buffer
    const indexAttribute = geometry.index;
    indices = new Uint32Array(indexAttribute.count);
    
    // Copy index data
    for (let i = 0; i < indexAttribute.count; i++) {
      indices[i] = indexAttribute.getX(i);
    }
  } else {
    // If geometry is not indexed, create indices for triangles
    // Each three consecutive vertices form a triangle in a non-indexed geometry
    indices = new Uint32Array(positionAttribute.count);
    for (let i = 0; i < positionAttribute.count; i++) {
      indices[i] = i;
    }
  }
  
  // Create trimesh collider description
  return RAPIER.ColliderDesc.trimesh(vertices, indices);
}

// Initialize physics
async function initPhysics() {
  await RAPIER.init();
  
  // Create physics world with no gravity (we'll apply our own)
  world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  
  // Create trimesh collider for our spherical terrain
  const terrainGeometry = generateSphericalTerrain();
  const terrainColliderDesc = createTrimeshCollider(terrainGeometry);
  
  // Create the terrain collider
  world.createCollider(terrainColliderDesc);

  // Create player rigid body with initial position high above terrain
  const spawnHeight = 20; // Keep same as in initThree
  const playerBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
    .setTranslation(
      0, 
      PLANET_RADIUS + TERRAIN_HEIGHT_SCALE + PLAYER_HEIGHT/2 + spawnHeight, 
      0
    );
  playerBody = world.createRigidBody(playerBodyDesc);
  
  // Create player collider (capsule)
  const playerColliderDesc = RAPIER.ColliderDesc.capsule(
    PLAYER_HEIGHT/2 - PLAYER_RADIUS, 
    PLAYER_RADIUS
  );
  playerCollider = world.createCollider(playerColliderDesc, playerBody);
  
  physicsInitialized = true;
}

// Initialize Three.js scene
function initThree() {
  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  
  // Camera
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, PLANET_RADIUS * 1.5, PLANET_RADIUS);
  
  // Renderer
  renderer = new THREE.WebGLRenderer({ 
    canvas: canvasRef.value,
    antialias: true
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  
  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, PLANET_RADIUS, 0);
  controls.update();

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(1, 1, 1).normalize().multiplyScalar(100);
  directionalLight.castShadow = true;
  
  // Improve shadow quality
  directionalLight.shadow.mapSize.width = 2048;
  directionalLight.shadow.mapSize.height = 2048;
  directionalLight.shadow.camera.near = 0.5;
  directionalLight.shadow.camera.far = 500;
  directionalLight.shadow.camera.left = -100;
  directionalLight.shadow.camera.right = 100;
  directionalLight.shadow.camera.top = 100;
  directionalLight.shadow.camera.bottom = -100;
  
  scene.add(directionalLight);
  
  // Enable shadows
  renderer.shadowMap.enabled = true;
  
  // Create terrain mesh
  const terrainGeometry = generateSphericalTerrain();
  const terrainMaterial = new THREE.MeshStandardMaterial({ 
    color: 0x3a7e4a,
    flatShading: false,
    wireframe: false,
  });
  terrain = new THREE.Mesh(terrainGeometry, terrainMaterial);
  terrain.castShadow = true;
  terrain.receiveShadow = true;
  scene.add(terrain);
  
  // Create player capsule visual representation
  const capsuleGeometry = new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT - PLAYER_RADIUS * 2, 8, 16);
  const capsuleMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  playerMesh = new THREE.Mesh(capsuleGeometry, capsuleMaterial);
  playerMesh.castShadow = true;
  scene.add(playerMesh);
  
  // Set initial player position high above terrain
  const spawnHeight = 20;
  const initialPosition = new THREE.Vector3(
    0, 
    PLANET_RADIUS + TERRAIN_HEIGHT_SCALE + PLAYER_HEIGHT/2 + spawnHeight,
    0
  );
  
  // Use the gravity direction as initial surface normal and up vector
  const initialGravityUp = initialPosition.clone().sub(GRAVITY_CENTER).normalize();
  
  // Call with all required parameters
  updatePlayerPositionAndOrientation(
    initialPosition, 
    initialGravityUp, 
    false, // not on surface initially
    initialGravityUp
  );
  
  // Reset player velocity to ensure clean falling
  playerState.velocity.set(0, 0, 0);
  
  // Add event listeners
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
}

// Update player position and orientation based on surface normal and gravity
function updatePlayerPositionAndOrientation(position, surfaceNormal, onSurface, gravityUp) {
  // Ensure we have valid vectors to work with
  if (!position) return;
  if (!surfaceNormal) surfaceNormal = new THREE.Vector3(0, 1, 0);
  if (!gravityUp) {
    // If no gravity up is provided, calculate from position
    gravityUp = position.clone().sub(GRAVITY_CENTER).normalize();
  }
  
  // Set player position
  playerMesh.position.copy(position);
  
  // Create a quaternion for orientation
  let orientationQuaternion;
  
  if (onSurface) {
    // Create a weighted blend between gravity up and surface normal
    const angle = Math.acos(THREE.MathUtils.clamp(gravityUp.dot(surfaceNormal), -1, 1));
    const maxSlopeAngle = Math.PI / 4; // 45 degrees
    const blendFactor = Math.min(angle / maxSlopeAngle, 1.0);
    
    const blendedUp = new THREE.Vector3()
      .addScaledVector(gravityUp, 1.0) 
      .addScaledVector(surfaceNormal, blendFactor * 2)
      .normalize();
    
    // Find a stable forward direction
    const worldUp = new THREE.Vector3(0, 1, 0);
    let right = new THREE.Vector3().crossVectors(worldUp, blendedUp);
    
    // If right is too small, use a different reference direction
    if (right.lengthSq() < 0.01) {
      right = new THREE.Vector3(1, 0, 0);
    }
    
    right.normalize();
    
    // Calculate forward from right and up
    const forward = new THREE.Vector3().crossVectors(right, blendedUp).normalize();
    
    // Create the orientation matrix
    const orientationMatrix = new THREE.Matrix4().makeBasis(right, blendedUp, forward);
    orientationQuaternion = new THREE.Quaternion().setFromRotationMatrix(orientationMatrix);
  } else {
    // When in air, align with gravity
    const worldUp = new THREE.Vector3(0, 1, 0);
    let right = new THREE.Vector3().crossVectors(worldUp, gravityUp);
    
    if (right.lengthSq() < 0.01) {
      right = new THREE.Vector3(1, 0, 0);
    }
    
    right.normalize();
    const forward = new THREE.Vector3().crossVectors(right, gravityUp).normalize();
    
    // Create the orientation matrix
    const orientationMatrix = new THREE.Matrix4().makeBasis(right, gravityUp, forward);
    orientationQuaternion = new THREE.Quaternion().setFromRotationMatrix(orientationMatrix);
  }
  
  // Apply the orientation to the capsule
  playerMesh.quaternion.copy(orientationQuaternion);
  
  // Update physics body - only if it exists and orientation is valid
  if (physicsInitialized && playerBody && orientationQuaternion) {
    playerBody.setTranslation({ 
      x: position.x, 
      y: position.y, 
      z: position.z 
    }, true);
    
    // Make sure quaternion values are valid numbers before applying
    if (!isNaN(orientationQuaternion.x) && 
        !isNaN(orientationQuaternion.y) && 
        !isNaN(orientationQuaternion.z) && 
        !isNaN(orientationQuaternion.w)) {
      playerBody.setRotation({
        x: orientationQuaternion.x,
        y: orientationQuaternion.y,
        z: orientationQuaternion.z,
        w: orientationQuaternion.w
      }, true);
    }
  }
}

// Apply point gravity and handle movement
function updatePlayer(deltaTime) {
  if (!physicsInitialized) return;
  
  // Get current position
  const position = new THREE.Vector3(
    playerBody.translation().x,
    playerBody.translation().y,
    playerBody.translation().z
  );
  
  // Calculate gravity direction (towards planet center)
  const gravityDir = GRAVITY_CENTER.clone().sub(position).normalize();
  const up = gravityDir.clone().negate(); // Up is opposite of gravity
  
  // Apply gravity towards planet center
  const gravity = gravityDir.clone().multiplyScalar(GRAVITY_STRENGTH * deltaTime);
  playerState.velocity.add(gravity);
  
  // Multiple raycasts for better ground detection and orientation
  // Perform 5 raycasts - one at center and four around the feet perimeter
  const feetPosition = position.clone().add(gravityDir.clone().multiplyScalar(PLAYER_HEIGHT/2 - PLAYER_RADIUS));
  const rayDirections = [
    gravityDir.clone(), // Center ray
    gravityDir.clone(), // Forward ray
    gravityDir.clone(), // Right ray
    gravityDir.clone(), // Back ray
    gravityDir.clone()  // Left ray
  ];
  
  // Calculate offset positions for the perimeter rays
  const forwardDir = new THREE.Vector3(1, 0, 0).cross(up).normalize();
  const rightDir = up.clone().cross(forwardDir).normalize();
  const rayPositions = [
    feetPosition.clone(), // Center
    feetPosition.clone().add(forwardDir.clone().multiplyScalar(PLAYER_RADIUS * 0.8)), // Forward
    feetPosition.clone().add(rightDir.clone().multiplyScalar(PLAYER_RADIUS * 0.8)),   // Right
    feetPosition.clone().sub(forwardDir.clone().multiplyScalar(PLAYER_RADIUS * 0.8)), // Back
    feetPosition.clone().sub(rightDir.clone().multiplyScalar(PLAYER_RADIUS * 0.8))    // Left
  ];
  
  // Store hit normals and distance
  const hitPoints = [];
  const hitNormals = [];
  let hitDistance = -1;
  let onSurface = false;
  
  // Perform the raycasts
  for (let i = 0; i < rayPositions.length; i++) {
    const raycaster = new THREE.Raycaster();
    raycaster.set(rayPositions[i], rayDirections[i]);
    const intersects = raycaster.intersectObject(terrain);
    
    if (intersects.length > 0) {
      // Get normal and transform to world space
      const normal = intersects[0].face.normal.clone();
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(terrain.matrixWorld);
      normal.applyMatrix3(normalMatrix).normalize();
      
      hitNormals.push(normal);
      hitPoints.push(intersects[0].point);
      
      // Store the center ray distance
      if (i === 0) {
        hitDistance = intersects[0].distance;
        
        // If center ray hit is close enough, we're on the ground
        if (hitDistance < PLAYER_RADIUS + 0.2) {
          onSurface = true;
          playerState.onGround = true;
          
          // Prevent sinking
          if (hitDistance < PLAYER_RADIUS) {
            const pushUpAmount = PLAYER_RADIUS - hitDistance;
            position.add(normal.clone().multiplyScalar(pushUpAmount));
          }
          
          // Apply stronger friction when on ground
          playerState.velocity.multiplyScalar(0.8);
          
          // Cancel velocity in normal direction to improve stability
          const normalVelocity = playerState.velocity.clone().projectOnVector(normal);
          playerState.velocity.sub(normalVelocity);
        } else {
          playerState.onGround = false;
        }
      }
    }
  }
  
  // Calculate average surface normal from all hits
  let surfaceNormal = up.clone(); // Default to gravity-based up
  if (hitNormals.length > 0) {
    surfaceNormal = new THREE.Vector3();
    for (const normal of hitNormals) {
      surfaceNormal.add(normal);
    }
    surfaceNormal.divideScalar(hitNormals.length).normalize();
  } else {
    // No hits from any rays - check if inside planet
    const distToCenter = position.distanceTo(GRAVITY_CENTER);
    const minDistance = PLANET_RADIUS - TERRAIN_HEIGHT_SCALE * 0.5 + PLAYER_HEIGHT/2;
    
    if (distToCenter < minDistance) {
      // Too close to center - push player out to minimum distance
      position.copy(up.clone().multiplyScalar(minDistance));
      playerState.onGround = true;
      playerState.velocity.projectOnPlane(up);
    } else {
      playerState.onGround = false;
    }
  }
  
  // Calculate movement direction based on current orientation
  const orientationMatrix = new THREE.Matrix4().lookAt(
    new THREE.Vector3(0, 0, 0),
    surfaceNormal,
    forwardDir
  );
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(orientationMatrix);
  
  // Calculate orientation-aligned movement vectors
  let right = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
  let forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
  
  // Calculate movement direction
  playerState.direction.set(0, 0, 0);
  if (playerState.moveForward) playerState.direction.add(forward);
  if (playerState.moveBackward) playerState.direction.sub(forward);
  if (playerState.moveRight) playerState.direction.add(right);
  if (playerState.moveLeft) playerState.direction.sub(right);
  
  if (playerState.direction.lengthSq() > 0) {
    playerState.direction.normalize().multiplyScalar(MOVE_SPEED * deltaTime);
    position.add(playerState.direction);
  }
  
  // Apply jump force
  if (playerState.jump && playerState.onGround) {
    playerState.velocity.add(surfaceNormal.clone().multiplyScalar(JUMP_FORCE));
    playerState.onGround = false;
    playerState.jump = false;
  }
  
  // Apply velocity to position
  position.add(playerState.velocity.clone().multiplyScalar(deltaTime));
  
  // Update player position and align to surface
  // Make sure we always pass all four parameters with valid values
  updatePlayerPositionAndOrientation(
    position, 
    surfaceNormal || up.clone(), 
    onSurface, 
    up
  );
}

// Animation loop
function animate() {
  const deltaTime = 1/60; // Fixed time step
  
  if (physicsInitialized) {
    // Update physics
    updatePlayer(deltaTime);
    world.step();
  }
  
  // Render scene
  renderer.render(scene, camera);
  
  requestAnimationFrame(animate);
}

// Event handlers
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onKeyDown(event) {
  switch (event.code) {
    case 'KeyW': playerState.moveForward = true; break;
    case 'KeyS': playerState.moveBackward = true; break;
    case 'KeyA': playerState.moveLeft = true; break;
    case 'KeyD': playerState.moveRight = true; break;
    case 'Space': playerState.jump = true; break;
  }
}

function onKeyUp(event) {
  switch (event.code) {
    case 'KeyW': playerState.moveForward = false; break;
    case 'KeyS': playerState.moveBackward = false; break;
    case 'KeyA': playerState.moveLeft = false; break;
    case 'KeyD': playerState.moveRight = false; break;
  }
}

// Lifecycle hooks
onMounted(async () => {
  await initPhysics();
  initThree();
  animate();
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  
  // Clean up Three.js resources
  if (renderer) {
    renderer.dispose();
  }
});
</script>

<style scoped>
.container {
  width: 100%;
  height: 100vh;
  position: relative;
  overflow: hidden;
}
canvas {
  width: 100%;
  height: 100%;
  display: block;
}
.controls-info {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.5);
  color: white;
  padding: 10px 20px;
  border-radius: 5px;
  pointer-events: none;
}
</style>
