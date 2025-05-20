<template>
  <div class="container">
    <canvas ref="canvasRef"></canvas>
    <div class="controls-info">
      <p>WASD: Move | Q/E: Turn | SPACE: Jump | Push objects with your body</p>
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

// Add a variable to track collider initialization 
let collidersInitialized = false;

// Arrays to store colliders and their mesh representations
let fixedBoxes = [];
let dynamicObjects = [];

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
  // Add current facing direction
  facingDirection: new THREE.Vector3(0, 0, -1),
  // Track rotation input for turning
  turnLeft: false,
  turnRight: false,
};

// Constants
const GRAVITY_CENTER = new THREE.Vector3(0, 0, 0);
const GRAVITY_STRENGTH = 9.8;
const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.4;
const MOVE_SPEED = 5;
const JUMP_FORCE = 18; // Increased jump force from 12 to 18 for a much stronger jump
const PLANET_RADIUS = 50;
const TERRAIN_DETAIL = 64; // Resolution of the sphere
const TERRAIN_HEIGHT_SCALE = 50; // How much the terrain varies in height
const TURN_SPEED = 2; // How fast the player rotates
// Adjust this to reduce the gap
const GROUND_OFFSET = 0; // Make GROUND_OFFSET exactly zero to completely eliminate the gap
// Add a small "sink" value to push player slightly into the terrain (visually imperceptible)
const TERRAIN_SINK = 0.02; // This makes the capsule sink slightly into the terrain to eliminate any gap
const ORIENTATION_SMOOTHING = 0.9; // Higher value = smoother but slower orientation changes
const MAX_SLOPE_CLIMB_ANGLE = Math.PI / 4; // Maximum slope the player can climb (45 degrees)
// Add slope constants for movement limitations but not visual orientation
const MAX_CLIMBABLE_SLOPE = Math.PI / 5; // Maximum slope angle the player can climb (36 degrees)
const NUM_FIXED_BOXES = 5; // Number of fixed box colliders
const NUM_DYNAMIC_OBJECTS = 10; // Number of dynamic objects to create
const BOX_SIZE = 2; // Size of fixed boxes
const DYNAMIC_OBJECT_SIZE = 1; // Size of dynamic objects
const DYNAMIC_OBJECT_MASS = 1; // Mass of dynamic objects

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

// Create a fixed box collider with a visual mesh
function createFixedBox(position, size) {
  // Create the collider
  const boxColliderDesc = RAPIER.ColliderDesc.cuboid(
    size.x / 2, size.y / 2, size.z / 2
  );
  
  // Adjust the collision groups for user-controlled detection
  boxColliderDesc.setCollisionGroups(0x00010001); // Group 1, can collide with Group 1
  
  // Calculate position based on gravity direction at that point
  const gravityDir = position.clone().sub(GRAVITY_CENTER).normalize();
  const worldUp = gravityDir.clone().negate();
  
  // Create quaternion to orient box with gravity direction
  const worldX = new THREE.Vector3(1, 0, 0);
  const right = worldX.clone().projectOnPlane(worldUp).normalize();
  if (right.lengthSq() < 0.01) {
    right.set(0, 0, 1);
  }
  const forward = new THREE.Vector3().crossVectors(right, worldUp).normalize();
  const rotMatrix = new THREE.Matrix4().makeBasis(right, worldUp, forward);
  const orientation = new THREE.Quaternion().setFromRotationMatrix(rotMatrix);
  
  // Create a rigid body description
  const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed()
    .setTranslation(position.x, position.y, position.z)
    .setRotation({
      x: orientation.x,
      y: orientation.y,
      z: orientation.z,
      w: orientation.w
    });
  
  // Create the rigid body and collider
  const boxBody = world.createRigidBody(rigidBodyDesc);
  const boxCollider = world.createCollider(boxColliderDesc, boxBody);
  
  // Create a visual representation in Three.js
  const boxGeometry = new THREE.BoxGeometry(size.x, size.y, size.z);
  const boxMaterial = new THREE.MeshStandardMaterial({ 
    color: 0x8844aa,
    roughness: 0.7
  });
  const boxMesh = new THREE.Mesh(boxGeometry, boxMaterial);
  boxMesh.position.copy(position);
  boxMesh.quaternion.copy(orientation);
  boxMesh.castShadow = true;
  boxMesh.receiveShadow = true;
  scene.add(boxMesh);
  
  // Return both the physics body and the mesh
  return {
    body: boxBody,
    collider: boxCollider,
    mesh: boxMesh
  };
}

// Create a dynamic physics object with visual representation
function createDynamicObject(position, size, isSphere = false) {
  // Create the appropriate collider description based on shape
  let colliderDesc;
  
  if (isSphere) {
    colliderDesc = RAPIER.ColliderDesc.ball(size / 2);
  } else {
    colliderDesc = RAPIER.ColliderDesc.cuboid(size / 2, size / 2, size / 2);
  }
  
  // Set material properties for the collider
  colliderDesc.setRestitution(0.4); // Bounciness
  colliderDesc.setFriction(0.8);    // Friction
  colliderDesc.setDensity(1.0);     // Add density for better mass properties
  
  // Calculate gravity direction for initial orientation
  const gravityDir = position.clone().sub(GRAVITY_CENTER).normalize();
  const worldUp = gravityDir.clone().negate();
  
  // Create quaternion to orient object with gravity
  const worldX = new THREE.Vector3(1, 0, 0);
  const right = worldX.clone().projectOnPlane(worldUp).normalize();
  if (right.lengthSq() < 0.01) {
    right.set(0, 0, 1);
  }
  const forward = new THREE.Vector3().crossVectors(right, worldUp).normalize();
  const rotMatrix = new THREE.Matrix4().makeBasis(right, worldUp, forward);
  const orientation = new THREE.Quaternion().setFromRotationMatrix(rotMatrix);
  
  // Create rigid body description
  const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(position.x, position.y, position.z)
    .setRotation({
      x: orientation.x,
      y: orientation.y, 
      z: orientation.z,
      w: orientation.w
    })
    // Add some linear damping to prevent excessive bouncing
    .setLinearDamping(0.2)
    .setAngularDamping(0.3);
  
  // Create the rigid body and collider
  const dynamicBody = world.createRigidBody(rigidBodyDesc);
  const dynamicCollider = world.createCollider(colliderDesc, dynamicBody);
  
  // Create the appropriate visual geometry
  let geometry;
  if (isSphere) {
    geometry = new THREE.SphereGeometry(size / 2, 16, 16);
  } else {
    geometry = new THREE.BoxGeometry(size, size, size);
  }
  
  // Random color for variety
  const hue = Math.random();
  const material = new THREE.MeshStandardMaterial({ 
    color: new THREE.Color().setHSL(hue, 0.7, 0.5),
    roughness: 0.5
  });
  
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  
  // Return the object data
  return {
    body: dynamicBody,
    collider: dynamicCollider,
    mesh: mesh,
    isSphere: isSphere
  };
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
  // Set collision groups for player
  playerColliderDesc.setCollisionGroups(0x00010001); // Group 1, can collide with Group 1
  
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
  
  // Add ALL event listeners - this was the source of the error
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  
  // Add dynamic objects scattered around
  for (let i = 0; i < NUM_DYNAMIC_OBJECTS; i++) {
    // Calculate positions distributed around the planet surface
    const phi = Math.PI * (0.2 + 0.6 * Math.random()); // Avoid poles
    const theta = Math.PI * 2 * Math.random();
    
    // Convert spherical to cartesian coordinates
    const x = Math.sin(phi) * Math.cos(theta);
    const y = Math.cos(phi);
    const z = Math.sin(phi) * Math.sin(theta);
    
    // Set position higher above the terrain for a more dramatic fall
    const pos = new THREE.Vector3(x, y, z).normalize();
    // Increase height to ensure objects start well above terrain
    const heightVariation = 10 + 20 * Math.random(); // Between 10 and 30 units above terrain
    const distance = PLANET_RADIUS + TERRAIN_HEIGHT_SCALE + heightVariation;
    pos.multiplyScalar(distance);
    
    // Randomly choose between sphere and cube
    const isSphere = Math.random() > 0.5;
    
    // Randomize size slightly for more variety
    const objectSize = DYNAMIC_OBJECT_SIZE * (0.5 + Math.random());
    
    // Create the dynamic object and add it to our array
    const dynamicObj = createDynamicObject(pos, objectSize, isSphere);
    
    // Add some initial velocity for more interesting motion
    // Random direction perpendicular to gravity
    const gravityDir = pos.clone().sub(GRAVITY_CENTER).normalize();
    const perpAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
      .normalize()
      .cross(gravityDir)
      .normalize();
    
    // Small randomized impulse to get things moving
    const impulseStrength = Math.random() * 5;
    
    try {
      // Try different Rapier method naming conventions
      // Use applyImpulse instead of addImpulse
      dynamicObj.body.applyImpulse(
        {
          x: perpAxis.x * impulseStrength,
          y: perpAxis.y * impulseStrength,
          z: perpAxis.z * impulseStrength
        },
        true
      );
    } catch (error) {
      console.warn("Error applying impulse with applyImpulse:", error);
      
      try {
        // Fall back to direct velocity setting
        dynamicObj.body.setLinvel(
          {
            x: perpAxis.x * impulseStrength * 0.1,
            y: perpAxis.y * impulseStrength * 0.1,
            z: perpAxis.z * impulseStrength * 0.1
          },
          true
        );
      } catch (e) {
        console.warn("Fallback also failed, using alternative method:", e);
      }
    }
    
    dynamicObjects.push(dynamicObj);
  }
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
    case 'KeyQ': playerState.turnLeft = true; break;
    case 'KeyE': playerState.turnRight = true; break;
  }
}

function onKeyUp(event) {
  switch (event.code) {
    case 'KeyW': playerState.moveForward = false; break;
    case 'KeyS': playerState.moveBackward = false; break;
    case 'KeyA': playerState.moveLeft = false; break;
    case 'KeyD': playerState.moveRight = false; break;
    case 'KeyQ': playerState.turnLeft = false; break;
    case 'KeyE': playerState.turnRight = false; break;
    case 'Space': playerState.jump = false; break; // Add this to reset jump on key up
  }
}

// Update player position and orientation based on surface normal and gravity
function updatePlayerPositionAndOrientation(position, surfaceNormal, onSurface, gravityUp) {
  // Ensure we have valid vectors to work with
  if (!position) return;
  if (!surfaceNormal) surfaceNormal = new THREE.Vector3(0, 1, 0);
  if (!gravityUp) {
    gravityUp = position.clone().sub(GRAVITY_CENTER).normalize();
  }
  
  // Set player position
  playerMesh.position.copy(position);
  
  // Create a quaternion for orientation
  let orientationQuaternion;
  
  // Store old facing direction
  const oldFacingDir = playerState.facingDirection.clone();
  
  if (onSurface) {
    // Allow full alignment with any surface normal without capping the angle
    // This lets the player visually orient to any surface
    const blendedUp = surfaceNormal.clone();
    
    // Find a stable forward direction
    const worldUp = new THREE.Vector3(0, 1, 0);
    let right = new THREE.Vector3().crossVectors(worldUp, blendedUp);
    
    if (right.lengthSq() < 0.01) {
      right = new THREE.Vector3(1, 0, 0);
    }
    right.normalize();
    
    // Calculate forward from right and up
    let forward = new THREE.Vector3().crossVectors(right, blendedUp).normalize();
    
    // Create the orientation matrix
    const orientationMatrix = new THREE.Matrix4().makeBasis(right, blendedUp, forward);
    orientationQuaternion = new THREE.Quaternion().setFromRotationMatrix(orientationMatrix);
    
    // Update player facing direction to maintain direction on surface
    playerState.facingDirection = oldFacingDir.clone()
      .projectOnPlane(blendedUp)
      .normalize();
  } else {
    // When in air, calculate orientation based on gravity direction
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
  playerMesh.position.copy(position);
  playerMesh.quaternion.copy(orientationQuaternion);
  
  // Update physics body - only if it exists and orientation is valid
  if (physicsInitialized && playerBody && orientationQuaternion) {
    // Ensure visual and physics representations match exactly
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

// Detect and resolve collisions between player and fixed boxes
function handlePlayerCollisions() {
  // Get player position
  const playerPosition = new THREE.Vector3(
    playerBody.translation().x,
    playerBody.translation().y,
    playerBody.translation().z
  );
  
  // Loop through all fixed boxes
  for (const box of fixedBoxes) {
    // Get box position
    const boxPosition = new THREE.Vector3(
      box.body.translation().x,
      box.body.translation().y,
      box.body.translation().z
    );
    
    // Create a Box3 for the fixed box
    const boxSize = new THREE.Vector3(
      box.mesh.geometry.parameters.width,
      box.mesh.geometry.parameters.height,
      box.mesh.geometry.parameters.depth
    );
    
    // Use Rapier's collision detection
    const boxCollider = box.collider;
    const playerColliderHandle = playerCollider.handle;
    
    // Get contact pair between the two colliders
    const contact = world.contactPair(boxCollider.handle, playerColliderHandle);
    
    if (contact !== null && contact.hasAnyContact()) {
      // Get the manifold points
      const manifolds = contact.manifolds();
      
      for (let i = 0; i < manifolds.length; i++) {
        const manifold = manifolds[i];
        const points = manifold.points();
        
        // Handle each contact point
        for (let j = 0; j < points.length; j++) {
          const point = points[j];
          const depth = point.depth();
          
          // Only handle significant penetration
          if (depth > 0.01) {
            // Get normal direction
            const worldNormal = manifold.normal();
            const normal = new THREE.Vector3(worldNormal.x, worldNormal.y, worldNormal.z);
            
            // Push player out along normal based on penetration depth
            // For kinematic bodies, we need to manually update position
            playerPosition.add(normal.multiplyScalar(depth * 1.01)); // Slightly more than depth
            
            // Zero out velocity in the direction of the normal if moving into the object
            const velDotNormal = playerState.velocity.dot(normal);
            if (velDotNormal < 0) {
              // Only remove velocity component going into the object
              playerState.velocity.sub(normal.clone().multiplyScalar(velDotNormal));
              
              // Add some friction
              playerState.velocity.multiplyScalar(0.8);
            }
          }
        }
      }
    }
  }
  
  // Update player position after handling collisions
  playerBody.setTranslation({
    x: playerPosition.x,
    y: playerPosition.y,
    z: playerPosition.z
  }, true);
}

// Update dynamic objects based on gravity
function updateDynamicObjects() {
  // Update each dynamic object
  for (const obj of dynamicObjects) {
    // Get object position
    const position = new THREE.Vector3(
      obj.body.translation().x,
      obj.body.translation().y,
      obj.body.translation().z
    );
    
    // Calculate gravity direction towards planet center
    const gravityDir = GRAVITY_CENTER.clone().sub(position).normalize();
    
    // Check if the body is dynamic
    if (obj.body.bodyType() === RAPIER.RigidBodyType.Dynamic) {
      try {
        // Get mass
        const mass = obj.body.mass();
        
        // Calculate gravity force
        const gravityForce = gravityDir.clone().multiplyScalar(GRAVITY_STRENGTH * mass);
        
        // Try using applyForce instead of addForce
        obj.body.applyForce(
          { x: gravityForce.x, y: gravityForce.y, z: gravityForce.z },
          true
        );
        
        // For non-spheres, try to align with gravity
        if (!obj.isSphere) {
          const worldUp = gravityDir.clone().negate();
          const objQuat = obj.mesh.quaternion;
          const objUp = new THREE.Vector3(0, 1, 0).applyQuaternion(objQuat);
          const alignmentTorque = new THREE.Vector3().crossVectors(objUp, worldUp);
          
          if (alignmentTorque.lengthSq() > 0.01) {
            const strength = 0.5 * objUp.angleTo(worldUp);
            alignmentTorque.normalize().multiplyScalar(strength);
            
            // Try using applyTorque instead of addTorque
            obj.body.applyTorque(
              { x: alignmentTorque.x, y: alignmentTorque.y, z: alignmentTorque.z },
              true
            );
          }
        }
      } catch (error) {
        console.warn("Error applying physics:", error);
        
        // Ultimate fallback - try direct velocity modification as a gravity simulation
        try {
          // Get current velocity
          const vel = obj.body.linvel();
          const currentVel = new THREE.Vector3(vel.x, vel.y, vel.z);
          
          // Add gravity increment (scaled down for direct velocity change)
          const gravityChange = gravityDir.clone().multiplyScalar(GRAVITY_STRENGTH * 0.016); // ~1/60 for a frame
          currentVel.add(gravityChange);
          
          // Apply the new velocity
          obj.body.setLinvel(
            { x: currentVel.x, y: currentVel.y, z: currentVel.z },
            true
          );
        } catch (e) {
          console.error("All physics methods failed:", e);
        }
      }
    }
    
    // Update visual representation to match physics
    obj.mesh.position.set(
      obj.body.translation().x,
      obj.body.translation().y,
      obj.body.translation().z
    );
    
    obj.mesh.quaternion.set(
      obj.body.rotation().x,
      obj.body.rotation().y,
      obj.body.rotation().z,
      obj.body.rotation().w
    );
  }
}

// Add a new function to properly set up collider materials to prevent excessive bouncing
function initDynamicObjectCollisions() {
  // Update all dynamic object colliders to have appropriate restitution and friction
  for (const obj of dynamicObjects) {
    try {
      // Get collider handle
      const colliderHandle = obj.collider.handle;
      
      // Set low restitution (bounciness) - we don't want too much bounce off terrain
      const materialProps = world.getMaterialForCollider(colliderHandle);
      if (materialProps) {
        world.setRestitutionForCollider(colliderHandle, 0.1); // Very low bounce
        world.setFrictionForCollider(colliderHandle, 0.9);    // High friction
      }
    } catch (error) {
      console.warn("Could not set material properties:", error);
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
  
  // Store initial ground state before ray casting
  const wasOnGround = playerState.onGround;
  
  // Initialize onSurface variable
  let onSurface = false;
  
  // Process jumping before ground detection
  const wasJumping = playerState.jump && playerState.onGround;
  
  // If we're actively jumping this frame, force not on ground 
  // to prevent immediate re-grounding
  if (wasJumping) {
    playerState.onGround = false;
    // onSurface is already false by default, no need to set it again
  }
  
  // Get the exact capsule bottom position (feet)
  const capsuleBottomOffset = PLAYER_HEIGHT/2; 
  const feetPosition = position.clone().add(gravityDir.clone().multiplyScalar(capsuleBottomOffset - 0.05));
  
  // Use more aggressive ground detection with zero tolerance
  const perfectGroundDistance = 0; // Exact contact
  const groundCheckDistance = PLAYER_RADIUS + 0.5; // Larger search distance but exact positioning
  
  // Multiple raycasts for better ground detection and orientation
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
    feetPosition.clone().add(forwardDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7)), // Forward
    feetPosition.clone().add(rightDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7)),   // Right
    feetPosition.clone().sub(forwardDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7)), // Back
    feetPosition.clone().sub(rightDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7))    // Left
  ];
  
  // Store hit normals and distance
  const hitPoints = [];
  const hitNormals = [];
  let closestHitDistance = Infinity;
  
  // Skip ground detection entirely if we just jumped
  if (!wasJumping) {
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
        
        // Store hit info
        hitNormals.push(normal);
        hitPoints.push(intersects[0].point);
        
        // Track the closest hit distance for precise positioning
        if (intersects[0].distance < closestHitDistance) {
          closestHitDistance = intersects[0].distance;
        }
        
        // Check if center ray hit
        if (i === 0 && intersects[0].distance < groundCheckDistance) {
          onSurface = true;
          playerState.onGround = true;
        }
      }
    }
  }
  
  // Calculate average surface normal from all hits
  let surfaceNormal = up.clone(); 
  if (hitNormals.length > 0) {
    surfaceNormal = new THREE.Vector3();
    for (const normal of hitNormals) {
      surfaceNormal.add(normal);
    }
    surfaceNormal.divideScalar(hitNormals.length).normalize();
    
    // If we have any hits, position player precisely above the ground
    if (closestHitDistance < groundCheckDistance) {
      onSurface = true;
      playerState.onGround = true;
      
      // Position adjustment logic
      // Calculate where feet should be relative to the hit point
      const feetTargetHeight = PLAYER_RADIUS - TERRAIN_SINK;
      
      // Instead of directly setting position, move it gradually towards the correct height
      // This avoids abrupt repositioning that can cause sticking
      if (closestHitDistance < feetTargetHeight) {
        // Only adjust position if we're too close to or penetrating the ground
        const penetrationDepth = feetTargetHeight - closestHitDistance;
        
        // Apply a partial correction - don't snap fully to the target position
        const correctionFactor = 0.4; // Lower = more gradual correction
        position.add(surfaceNormal.clone().multiplyScalar(penetrationDepth * correctionFactor));
      }
      
      // Cancel velocity going into the ground, but preserve parallel motion
      const normalVelocity = playerState.velocity.clone().projectOnVector(surfaceNormal);
      if (normalVelocity.dot(surfaceNormal) < 0) {
        playerState.velocity.sub(normalVelocity);
      }
    } else {
      playerState.onGround = false;
    }
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
  
  // Only apply gravity if the player is not on the ground
  // This is the key change to prevent sliding after movement
  if (!playerState.onGround) {
    const gravity = gravityDir.clone().multiplyScalar(GRAVITY_STRENGTH * deltaTime);
    playerState.velocity.add(gravity);
  }
  
  // Handle turning and movement direction calculations
  if (playerState.turnLeft) {
    // Rotate facing direction left around the up vector
    const upAxis = position.clone().sub(GRAVITY_CENTER).normalize();
    const rotationMatrix = new THREE.Matrix4().makeRotationAxis(upAxis, TURN_SPEED * deltaTime);
    playerState.facingDirection.applyMatrix4(rotationMatrix);
  }
  if (playerState.turnRight) {
    // Rotate facing direction right around the up vector
    const upAxis = position.clone().sub(GRAVITY_CENTER).normalize();
    const rotationMatrix = new THREE.Matrix4().makeRotationAxis(upAxis, -TURN_SPEED * deltaTime);
    playerState.facingDirection.applyMatrix4(rotationMatrix);
  }
  
  // Ensure facing direction is normalized
  playerState.facingDirection.normalize();
  
  // Get the surface-aligned facing direction
  const surfaceAlignedFacing = playerState.facingDirection.clone()
    .projectOnPlane(surfaceNormal)
    .normalize();
  
  // Calculate the right vector perpendicular to facing and surface normal
  const right = new THREE.Vector3()
    .crossVectors(surfaceNormal, surfaceAlignedFacing)
    .normalize();
  
  // Calculate movement direction based on player's facing direction
  playerState.direction.set(0, 0, 0);
  if (playerState.moveForward) playerState.direction.add(surfaceAlignedFacing);
  if (playerState.moveBackward) playerState.direction.sub(surfaceAlignedFacing);
  if (playerState.moveRight) playerState.direction.add(right);
  if (playerState.moveLeft) playerState.direction.sub(right);
  
  // Calculate if player is actively moving (WASD keys pressed)
  const isMoving = playerState.moveForward || playerState.moveBackward || 
                   playerState.moveLeft || playerState.moveRight;
  
  // Apply movement if player is actively trying to move
  if (playerState.direction.lengthSq() > 0) {
    // Calculate slope angle between movement direction and gravity up vector
    const slopeAngle = Math.acos(Math.min(1, Math.abs(surfaceNormal.dot(up))));
    
    // Only allow full movement speed on slopes that aren't too steep
    let moveSpeedMultiplier = 1.0;
    
    // If slope is too steep, limit or prevent movement in uphill directions
    if (slopeAngle > MAX_CLIMBABLE_SLOPE && playerState.onGround) {
      // Calculate the horizontal component (relative to gravity) of the movement direction
      const upComponent = playerState.direction.dot(surfaceNormal);
      
      // If trying to move uphill on a steep slope
      if (upComponent > 0) {
        // Calculate how much steeper than the limit the slope is (0-1 range)
        const steepnessFactor = (slopeAngle - MAX_CLIMBABLE_SLOPE) / 
                              (Math.PI/2 - MAX_CLIMBABLE_SLOPE);
        
        // Gradually reduce movement speed as slope gets steeper
        moveSpeedMultiplier = Math.max(0, 1 - steepnessFactor * 1.5);
        
        // If completely vertical or beyond, prevent uphill movement entirely
        if (slopeAngle >= Math.PI/2) {
          moveSpeedMultiplier = 0;
        }
      }
    }
    
    // Apply movement with the slope limitation
    playerState.direction.normalize().multiplyScalar(MOVE_SPEED * moveSpeedMultiplier * deltaTime);
    position.add(playerState.direction);
  }
  
  // Jump logic
  if (wasJumping) {
    console.log("Applying jump force!");
    
    // Calculate jump direction with stronger up component
    const jumpDirection = new THREE.Vector3();
    
    // Slightly stronger forward component (1.5 instead of 1.2)
    jumpDirection.add(surfaceAlignedFacing.clone().multiplyScalar(1.5));
    
    // Much stronger up component (3.0 instead of 2.0)
    jumpDirection.add(surfaceNormal.clone().multiplyScalar(3.0));
    
    // Normalize and apply the force
    jumpDirection.normalize().multiplyScalar(JUMP_FORCE);
    
    // Apply a larger immediate position boost to break contact with ground
    position.add(surfaceNormal.clone().multiplyScalar(0.3));
    
    // Reset velocity and set the jump direction as the new velocity
    playerState.velocity = jumpDirection.clone();
    
    // Set player to falling state
    playerState.onGround = false;
    playerState.jump = false;
  }
  
  // Special handling for when player is on ground
  if (playerState.onGround) {
    if (!isMoving) {
      // Apply stronger stopping force when player is not actively moving
      // This prevents sliding after movement stops
      playerState.velocity.multiplyScalar(0.05); // Much stronger friction when standing still
      
      // Cancel very small velocities completely (prevents any micro-sliding)
      if (playerState.velocity.lengthSq() < 0.03) { // Higher threshold to catch more small movements
        playerState.velocity.set(0, 0, 0);
      }
      
      // Don't need counter-force for gravity on slopes since we're not applying gravity
    } else {
      // Still apply normal friction when moving to prevent excessive speed buildup
      playerState.velocity.multiplyScalar(0.8);
    }
    
    // For all ground cases, ensure velocity stays along the surface
    playerState.velocity = playerState.velocity.projectOnPlane(surfaceNormal);
  }
  
  // Apply velocity to position
  position.add(playerState.velocity.clone().multiplyScalar(deltaTime));
  
  // Update player position and orientation
  updatePlayerPositionAndOrientation(
    position, 
    surfaceNormal || up.clone(), 
    onSurface && !wasJumping, 
    up
  );
  
  // Also apply collision handling
  handlePlayerCollisions();
}

// Animation loop
function animate() {
  const deltaTime = 1/60; // Fixed time step
  
  if (physicsInitialized) {
    // Update physics
    updatePlayer(deltaTime);
    updateDynamicObjects();
    
    // Execute collision configuration once after objects are created
    if (dynamicObjects.length > 0 && !collidersInitialized) {
      initDynamicObjectCollisions();
      collidersInitialized = true;
    }
    
    world.step();
    
    // Uncomment to add debug visualization
    // const position = new THREE.Vector3(playerBody.translation().x, playerBody.translation().y, playerBody.translation().z);
    // debugDrawGroundContact(position, up);
  }
  
  // Render scene
  renderer.render(scene, camera);
  
  requestAnimationFrame(animate);
}

// After updating player and physics, add a small debug function to visualize the contact point
// This can help identify any remaining gaps (can be removed in production)
function debugDrawGroundContact(position, surfaceNormal) {
  if (!playerState.onGround) return;
  
  // Calculate the exact bottom point of the capsule
  const up = position.clone().sub(GRAVITY_CENTER).normalize();
  const bottomPosition = position.clone().add(up.clone().negate().multiplyScalar(PLAYER_HEIGHT/2 - PLAYER_RADIUS));
  
  // Project slightly down to where ground should be
  const groundPosition = bottomPosition.clone().add(up.clone().negate().multiplyScalar(PLAYER_RADIUS + GROUND_OFFSET));
  
  // Draw a debug point (you would need to implement this with a small sphere or marker)
  // This is just a pseudo-code example
  // drawDebugPoint(groundPosition, 0xff0000); // Red marker at exact ground contact point
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
