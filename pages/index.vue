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

  // Create player rigid body
  const playerBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
    .setTranslation(0, PLANET_RADIUS + TERRAIN_HEIGHT_SCALE + PLAYER_HEIGHT/2, 0);
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
  
  // Set initial player position
  const initialPosition = new THREE.Vector3(0, PLANET_RADIUS + TERRAIN_HEIGHT_SCALE + PLAYER_HEIGHT/2, 0);
  updatePlayerPosition(initialPosition);
  
  // Add event listeners
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
}

// Update player position and orientation based on physics
function updatePlayerPosition(position) {
  // Set player position
  playerMesh.position.copy(position);
  
  // Calculate up vector (away from planet center)
  const up = position.clone().sub(GRAVITY_CENTER).normalize();
  
  // Calculate right and forward vectors based on up vector
  const right = new THREE.Vector3(1, 0, 0).cross(up).normalize();
  const forward = up.clone().cross(right).normalize();
  
  // Apply orientation
  playerMesh.quaternion.setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, forward)
  );
  
  // Update physics body
  if (physicsInitialized) {
    playerBody.setTranslation({ 
      x: position.x, 
      y: position.y, 
      z: position.z 
    }, true);
    
    // Apply same rotation to physics body
    const rot = playerMesh.quaternion;
    playerBody.setRotation({
      x: rot.x,
      y: rot.y,
      z: rot.z,
      w: rot.w
    }, true);
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
  
  // Calculate up vector (away from planet center)
  const up = position.clone().sub(GRAVITY_CENTER).normalize();
  
  // Apply gravity towards planet center
  const gravity = up.clone().multiplyScalar(-GRAVITY_STRENGTH * deltaTime);
  playerState.velocity.add(gravity);
  
  // Get forward and right vectors relative to the planet surface
  const right = new THREE.Vector3(1, 0, 0).cross(up).normalize();
  const forward = up.clone().cross(right).normalize();
  
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
    playerState.velocity.add(up.multiplyScalar(JUMP_FORCE));
    playerState.onGround = false;
    playerState.jump = false;
  }
  
  // Apply velocity to position
  position.add(playerState.velocity.clone().multiplyScalar(deltaTime));
  
  // Raycast to detect ground
  const raycaster = new THREE.Raycaster();
  raycaster.set(position, up.clone().negate());
  const intersects = raycaster.intersectObject(terrain);
  
  if (intersects.length > 0) {
    const distance = intersects[0].distance;
    
    // Check if on ground
    if (distance < PLAYER_HEIGHT/2 + 0.2) {
      playerState.onGround = true;
      
      // Align with surface and place on ground
      const adjustedPosition = position.clone().add(
        up.clone().multiplyScalar(PLAYER_HEIGHT/2 + 0.1 - distance)
      );
      position.copy(adjustedPosition);
      
      // Dampen velocity when on ground
      playerState.velocity.projectOnPlane(up);
      playerState.velocity.multiplyScalar(0.9); // Friction
    } else {
      playerState.onGround = false;
    }
  } else {
    // No ground detected - ensure minimum distance from center
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
  
  // Update player position
  updatePlayerPosition(position);
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
