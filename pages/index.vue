<template>
  <canvas ref="canvas"></canvas>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'
import * as RAPIER from '@dimforge/rapier3d-compat'

const GRAVITY_STRENGTH = 50
const PLANET_RADIUS = 2
const PLAYER_RADIUS = 0.2  // Reduced from 0.5
const PLAYER_HEIGHT = 0.8  // Reduced from 2
const NUM_PLAYERS = 3  // We'll create exactly 3 players
const NUM_RANDOM_OBJECTS = 8  // Number of additional objects to create
// Added friction constants
const PLANET_FRICTION = 1.0  // Maximum friction for planets
const OBJECT_FRICTION = 0.7  // High friction for random objects

// Add these constants for collision detection
const RAY_CAST_LENGTH = 0.3; // Length to raycast ahead for collisions
const COLLISION_BUFFER = 0.05; // Extra buffer distance around objects

// Add ref for canvas
const canvas = ref(null)
let renderer, scene, camera, physicsWorld, planetBody, planetMesh, animationFrameId

// Arrays to store multiple players and random objects
let playerBodies = []
let playerMeshes = []
let playerFallingStates = []  // Track which players are falling
let objectBodies = []
let objectMeshes = []
let surfaceCubeBodies = []  // Array for surface cubes
let surfaceCubeMeshes = []  // Array for surface cube meshes

// Map to track collider handles to player indices
let playerColliderMap = new Map()

// Event queue for collision handling
let eventQueue

// Add player velocities to track their movement
let playerVelocities = []

// Track keyboard state for player controls
const keys = {
  w: false,
  a: false,
  s: false,
  d: false
};

// Handle keyboard input - Move these functions up here
function handleKeyDown(event) {
  switch(event.key.toLowerCase()) {
    case 'w': keys.w = true; break;
    case 'a': keys.a = true; break;
    case 's': keys.s = true; break;
    case 'd': keys.d = true; break;
  }
}

function handleKeyUp(event) {
  switch(event.key.toLowerCase()) {
    case 'w': keys.w = false; break;
    case 'a': keys.a = false; break;
    case 's': keys.s = false; break;
    case 'd': keys.d = false; break;
  }
}

onMounted(async () => {
  await RAPIER.init()
  
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)
  
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000)
  camera.position.set(0, 0, 15)
  
  // Use the canvas ref directly
  renderer = new THREE.WebGLRenderer({ 
    canvas: canvas.value,
    antialias: true 
  })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(window.devicePixelRatio)
  
  scene.add(new THREE.AmbientLight(0x404040))
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1)
  directionalLight.position.set(10, 20, 10)
  scene.add(directionalLight)
  
  // Create physics world with event handling
  physicsWorld = new RAPIER.World({ x: 0.0, y: 0.0, z: 0.0 })
  eventQueue = new RAPIER.EventQueue(true) // Enable contact events
  
  // Create the planet (gravity attractor)
  const planetRigidBodyDesc = RAPIER.RigidBodyDesc.fixed()
  planetBody = physicsWorld.createRigidBody(planetRigidBodyDesc)
  
  const planetColliderDesc = RAPIER.ColliderDesc.ball(PLANET_RADIUS)
  // Add high friction to planet surface to help objects stick to it
  planetColliderDesc.setFriction(PLANET_FRICTION)
  // Add restitution (bounciness) to 0 to prevent bouncing off the planet
  planetColliderDesc.setRestitution(0.0)
  physicsWorld.createCollider(planetColliderDesc, planetBody)
  
  const planetGeometry = new THREE.SphereGeometry(PLANET_RADIUS, 32, 32)
  const planetMaterial = new THREE.MeshStandardMaterial({ color: 0x1565c0 })
  planetMesh = new THREE.Mesh(planetGeometry, planetMaterial)
  scene.add(planetMesh)
  
  // Create surface cubes on the planet
  createSurfaceCubes(15); // Add 15 cubes on the surface
  
  // Create players at random positions
  createPlayers(NUM_PLAYERS)
  
  // Create additional random objects (not capsules)
  createRandomObjects(NUM_RANDOM_OBJECTS)
  
  // Add keyboard event listeners
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  
  animate()
})

onBeforeUnmount(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  if (renderer) renderer.dispose()
  
  // Remove keyboard event listeners
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
})

// Function to create players - revert to kinematic bodies with proper setup
function createPlayers(count) {
  const playerColors = [0xe53935, 0x43A047, 0x1E88E5]
  
  for (let i = 0; i < count; i++) {
    // Random position above the planet
    const randomX = (Math.random() - 0.5) * 30
    const randomY = 15 + Math.random() * 15  // Between 15-30 units high
    const randomZ = (Math.random() - 0.5) * 30
    
    // Create player physics body as kinematic for manual movement control
    const playerRigidBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
    playerRigidBodyDesc.setTranslation(randomX, randomY, randomZ)
    
    // Add random rotation
    const randomRotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
      )
    )
    playerRigidBodyDesc.setRotation({
      x: randomRotation.x,
      y: randomRotation.y,
      z: randomRotation.z,
      w: randomRotation.w
    })
    
    const playerBody = physicsWorld.createRigidBody(playerRigidBodyDesc)
    
    // Create collider with proper settings for detection
    const playerColliderDesc = RAPIER.ColliderDesc.capsule(PLAYER_HEIGHT / 2, PLAYER_RADIUS)
    // Keep sensor off for proper collision detection
    playerColliderDesc.setFriction(0.9)  
    const collider = physicsWorld.createCollider(playerColliderDesc, playerBody)
    
    // Instead of using setUserData, track the collider handle with our map
    playerColliderMap.set(collider.handle, i)
    
    // Create player mesh
    const playerGeometry = new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT, 20, 20)
    const playerMaterial = new THREE.MeshStandardMaterial({ color: playerColors[i % playerColors.length] })
    const playerMesh = new THREE.Mesh(playerGeometry, playerMaterial)
    scene.add(playerMesh)
    
    // Store references
    playerBodies.push(playerBody)
    playerMeshes.push(playerMesh)
    playerFallingStates.push(true)  // All players start as falling
    playerVelocities.push(new THREE.Vector3(0, 0, 0)) // Initialize with zero velocity
  }
}

// Function to create random objects (no capsules)
function createRandomObjects(count) {
  const shapes = ['box', 'sphere'] // No capsules here
  const colors = [0xff5252, 0x7C4DFF, 0x00BFA5, 0xFFD600, 0x64DD17]
  
  for (let i = 0; i < count; i++) {
    // Random position above the planet
    const randomX = (Math.random() - 0.5) * 30
    const randomY = 15 + Math.random() * 15  // Between 15-30 units high
    const randomZ = (Math.random() - 0.5) * 30
    
    // Random size
    const size = 0.3 + Math.random() * 1.2
    
    // Random shape (excluding capsules)
    const shapeType = shapes[Math.floor(Math.random() * shapes.length)]
    const color = colors[Math.floor(Math.random() * colors.length)]
    
    // Create physics body
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    bodyDesc.setTranslation(randomX, randomY, randomZ)
    
    // Add random rotation
    const randomRotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
      )
    )
    bodyDesc.setRotation({
      x: randomRotation.x,
      y: randomRotation.y,
      z: randomRotation.z,
      w: randomRotation.w
    })
    
    const body = physicsWorld.createRigidBody(bodyDesc)
    
    // Create collider based on shape type
    let collider, geometry
    
    switch (shapeType) {
      case 'box':
        collider = RAPIER.ColliderDesc.cuboid(size/2, size/2, size/2)
        collider.setFriction(OBJECT_FRICTION)
        geometry = new THREE.BoxGeometry(size, size, size)
        break
      case 'sphere':
        collider = RAPIER.ColliderDesc.ball(size/2)
        collider.setFriction(OBJECT_FRICTION)
        geometry = new THREE.SphereGeometry(size/2, 16, 16)
        break
    }
    
    physicsWorld.createCollider(collider, body)
    
    // Create visual mesh
    const material = new THREE.MeshStandardMaterial({ color })
    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)
    
    // Store references
    objectBodies.push(body)
    objectMeshes.push(mesh)
  }
}

// Function to create static cubes on the planet surface
function createSurfaceCubes(count) {
  const cubeSize = 0.5; // Size of each cube
  const colliderBuffer = 0.1; // INCREASED from 0.05 to 0.1 for even larger collision margin
  
  for (let i = 0; i < count; i++) {
    // Generate random points on a sphere
    const phi = Math.acos(2 * Math.random() - 1);
    const theta = 2 * Math.PI * Math.random();
    
    // Convert to Cartesian coordinates
    const x = PLANET_RADIUS * Math.sin(phi) * Math.cos(theta);
    const y = PLANET_RADIUS * Math.sin(phi) * Math.sin(theta);
    const z = PLANET_RADIUS * Math.cos(phi);
    
    // Calculate position slightly above the planet surface
    const direction = new THREE.Vector3(x, y, z).normalize();
    const position = {
      x: direction.x * (PLANET_RADIUS + cubeSize/2),
      y: direction.y * (PLANET_RADIUS + cubeSize/2),
      z: direction.z * (PLANET_RADIUS + cubeSize/2)
    };
    
    // Create a fixed (static) rigid body for the cube
    const cubeRigidBodyDesc = RAPIER.RigidBodyDesc.fixed();
    cubeRigidBodyDesc.setTranslation(position.x, position.y, position.z);
    
    // Calculate rotation to align with surface normal
    const upVector = new THREE.Vector3(0, 1, 0);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      upVector, direction
    );
    
    cubeRigidBodyDesc.setRotation({
      x: quaternion.x,
      y: quaternion.y,
      z: quaternion.z,
      w: quaternion.w
    });
    
    const cubeBody = physicsWorld.createRigidBody(cubeRigidBodyDesc);
    
    // Create cube collider with much larger size than visual mesh
    const cubeColliderDesc = RAPIER.ColliderDesc.cuboid(
      cubeSize/2 + colliderBuffer, // Wider
      cubeSize/4 + colliderBuffer, // Taller
      cubeSize/2 + colliderBuffer  // Deeper
    );
    cubeColliderDesc.setFriction(PLANET_FRICTION);
    physicsWorld.createCollider(cubeColliderDesc, cubeBody);
    
    // Create cube visual mesh
    const geometry = new THREE.BoxGeometry(cubeSize, cubeSize/2, cubeSize);
    const material = new THREE.MeshStandardMaterial({ color: 0x8BC34A });
    const mesh = new THREE.Mesh(geometry, material);
    
    // Set initial position and rotation
    mesh.position.set(position.x, position.y, position.z);
    mesh.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    
    scene.add(mesh);
    
    // Store references
    surfaceCubeBodies.push(cubeBody);
    surfaceCubeMeshes.push(mesh);
  }
}

// Land player correctly on the surface to prevent penetration
function landPlayerOnSurface(playerIndex, surfaceBody, surfaceCollider, normal) {
  if (playerIndex < 0 || playerIndex >= playerBodies.length) return
  
  const playerBody = playerBodies[playerIndex]
  const surfacePos = surfaceBody.translation()
  
  let offsetDistance = 0;
  
  if (surfaceCollider.shapeType() === RAPIER.ShapeType.Ball) {
    const radius = surfaceCollider.radius();
    // Use PLAYER_RADIUS to properly position the bottom of the capsule on the surface
    offsetDistance = radius + PLAYER_RADIUS;
  } 
  else if (surfaceCollider.shapeType() === RAPIER.ShapeType.Cuboid) {
    const halfExtents = surfaceCollider.halfExtents();
    const halfHeight = halfExtents.y;
    offsetDistance = halfHeight + PLAYER_RADIUS;
  }
  
  const newPosition = {
    x: surfacePos.x + normal.x * offsetDistance,
    y: surfacePos.y + normal.y * offsetDistance,
    z: surfacePos.z + normal.z * offsetDistance
  };
  
  playerBody.setTranslation(newPosition);
}

// Update the alignPlayerWithNormal function to ensure physics collider alignment
function alignPlayerWithNormal(playerIndex, normal) {
  if (playerIndex < 0 || playerIndex >= playerBodies.length) return
  
  const playerBody = playerBodies[playerIndex];
  
  // Create a quaternion that rotates the standard up vector (0,1,0) to align with the normal
  const upVector = new THREE.Vector3(0, 1, 0)
  const quaternion = new THREE.Quaternion()
  quaternion.setFromUnitVectors(upVector, normal)
  
  // Apply rotation to the player's rigid body
  playerBody.setRotation({
    x: quaternion.x,
    y: quaternion.y,
    z: quaternion.z,
    w: quaternion.w
  })
  
  // Reset velocity when landing
  playerVelocities[playerIndex].set(0, 0, 0)
}

// Completely reworked function to test if a ray would hit a cube
function raycastHitsCube(from, direction, maxDistance) {
  // Cast multiple rays to better detect obstacles
  const rayDir = direction.clone().normalize();
  const rayStart = new RAPIER.Vector3(from.x, from.y, from.z);
  const rayDirR = new RAPIER.Vector3(rayDir.x, rayDir.y, rayDir.z);
  
  // Check central ray
  const raycastResult = physicsWorld.castRay(
    new RAPIER.Ray(rayStart, rayDirR),
    maxDistance,
    true, // Solid
    (handle) => {
      const collider = physicsWorld.getCollider(handle);
      if (!collider) return false;
      
      const bodyHandle = collider.parent();
      const body = physicsWorld.getRigidBody(bodyHandle);
      
      return body && body.isFixed();
    }
  );
  
  if (raycastResult !== null) return true;
  
  // Cast some additional rays for better coverage
  // This creates a small cone of rays to better detect edges
  const angles = [Math.PI/12, -Math.PI/12]; // ±15 degrees
  for (const angle of angles) {
    // Create rotated direction vectors
    const rotAxis = new THREE.Vector3().crossVectors(rayDir, new THREE.Vector3(0,1,0)).normalize();
    if (rotAxis.length() > 0.01) {
      const rotQuat = new THREE.Quaternion().setFromAxisAngle(rotAxis, angle);
      const altDir = rayDir.clone().applyQuaternion(rotQuat);
      
      const altRayResult = physicsWorld.castRay(
        new RAPIER.Ray(
          rayStart,
          new RAPIER.Vector3(altDir.x, altDir.y, altDir.z)
        ),
        maxDistance,
        true,
        (handle) => {
          const collider = physicsWorld.getCollider(handle);
          if (!collider) return false;
          
          const bodyHandle = collider.parent();
          const body = physicsWorld.getRigidBody(bodyHandle);
          
          return body && body.isFixed();
        }
      );
      
      if (altRayResult !== null) return true;
    }
  }
  
  return false;
}

// Improve isCollidingWithCube to use the player's actual capsule shape
function isCollidingWithCube(position, excludeHandle, isCurrentPosition = false) {
  // Create a shape matching the player's actual capsule collider
  const bufferMultiplier = isCurrentPosition ? 1.0 : 1.2;
  
  // Use a capsule shape that matches the player's dimensions
  const halfHeight = PLAYER_HEIGHT / 2;
  const radius = PLAYER_RADIUS * bufferMultiplier;
  
  // Create a capsule shape for collision testing
  const shape = new RAPIER.Capsule(halfHeight, radius);
  const pos = new RAPIER.Vector3(position.x, position.y, position.z);
  
  // Use player's orientation for the capsule
  const playerBody = playerBodies[0];
  const rot = playerBody ? playerBody.rotation() : new RAPIER.Quaternion(0, 0, 0, 1);
  
  // Use Rapier's intersectionsWithShape with the actual capsule shape
  const intersections = physicsWorld.intersectionsWithShape(
    pos, rot, shape, (handle) => {
      if (handle === excludeHandle) return false;
      
      const collider = physicsWorld.getCollider(handle);
      if (!collider) return false;
      
      const bodyHandle = collider.parent();
      const body = physicsWorld.getRigidBody(bodyHandle);
      
      // Specifically target cube colliders on fixed bodies
      return body && body.isFixed() && collider.shapeType() === RAPIER.ShapeType.Cuboid;
    }
  );
  
  return Array.isArray(intersections) && intersections.length > 0;
}

// Test collision with objects in a specific direction
function testDirectionalCollision(position, direction, excludeHandle) {
  const rayLength = PLAYER_RADIUS * 2.5;
  
  // Create a ray for testing
  const ray = new RAPIER.Ray(
    new RAPIER.Vector3(position.x, position.y, position.z),
    new RAPIER.Vector3(direction.x, direction.y, direction.z)
  );
  
  // Cast the ray and check for fixed object collisions
  const hit = physicsWorld.castRay(
    ray, 
    rayLength, 
    true, 
    (handle) => {
      if (handle === excludeHandle) return false;
      
      const collider = physicsWorld.getCollider(handle);
      if (!collider) return false;
      
      const bodyHandle = collider.parent();
      const body = physicsWorld.getRigidBody(bodyHandle);
      
      return body && body.isFixed();
    }
  );
  
  return hit ? hit.toi < rayLength : false;
}

// Advanced shape-based collision detection
function detectCollisionsInDirection(playerPos, direction, playerHandle) {
  // Create a test position slightly ahead in the movement direction
  const testDistance = PLAYER_RADIUS * 1.2;
  const testPos = {
    x: playerPos.x + direction.x * testDistance,
    y: playerPos.y + direction.y * testDistance,
    z: playerPos.z + direction.z * testDistance
  };
  
  // Use a capsule shape matching the player's actual collider
  const halfHeight = PLAYER_HEIGHT / 2;
  const radius = PLAYER_RADIUS;
  const shape = new RAPIER.Capsule(halfHeight, radius);
  const pos = new RAPIER.Vector3(testPos.x, testPos.y, testPos.z);
  
  // Use player's orientation for correct capsule alignment
  const playerBody = playerBodies[0];
  const rot = playerBody ? playerBody.rotation() : new RAPIER.Quaternion(0, 0, 0, 1);
  
  // Check for intersections with all fixed objects
  const intersections = physicsWorld.intersectionsWithShape(
    pos, rot, shape, (handle) => {
      if (handle === playerHandle) return false;
      
      const collider = physicsWorld.getCollider(handle);
      if (!collider) return false;
      
      const bodyHandle = collider.parent();
      const body = physicsWorld.getRigidBody(bodyHandle);
      
      return body && body.isFixed();
    }
  );
  
  return Array.isArray(intersections) && intersections.length > 0;
}

// Fix the gravity application to dynamic objects
function applyGravityToObject(objectBody, attractor) {
  // Get positions
  const objectPos = objectBody.translation();
  const attractorPos = attractor.translation();
  
  // Calculate direction FROM object TO attractor (for gravity pull)
  const direction = new THREE.Vector3(
    attractorPos.x - objectPos.x,
    attractorPos.y - objectPos.y,
    attractorPos.z - objectPos.z
  );
  
  const distance = direction.length();
  if (distance === 0) return;
  
  // Calculate force magnitude using inverse square law
  direction.normalize();
  const forceMagnitude = GRAVITY_STRENGTH / (distance * distance) * 0.01;
  
  // Apply impulse to pull object toward attractor
  // Use applyImpulse instead of applyForce (which doesn't exist in Rapier)
  objectBody.applyImpulse(
    {
      x: direction.x * forceMagnitude,
      y: direction.y * forceMagnitude,
      z: direction.z * forceMagnitude
    },
    true // Wake up the body
  );
}

// Update gravity function to handle dynamic players differently
function applyPlanetGravity() {
  // For players that are falling, update velocities and manually set positions
  for (let i = 0; i < playerBodies.length; i++) {
    if (playerFallingStates[i] && playerBodies[i] && planetBody) {
      const playerPos = playerBodies[i].translation();
      const planetPos = planetBody.translation();
      
      // Direction FROM player TO planet (correct direction for gravity)
      const gravityDirection = new THREE.Vector3(
        planetPos.x - playerPos.x,
        planetPos.y - playerPos.y,
        planetPos.z - playerPos.z
      );
      
      const distance = gravityDirection.length();
      if (distance === 0) continue;
      
      gravityDirection.normalize();
      const gravitationalAcceleration = GRAVITY_STRENGTH / (distance * distance) * 0.0005;
      
      // Update velocity
      playerVelocities[i].x += gravityDirection.x * gravitationalAcceleration;
      playerVelocities[i].y += gravityDirection.y * gravitationalAcceleration;
      playerVelocities[i].z += gravityDirection.z * gravitationalAcceleration;
      
      // Limit terminal velocity
      const speed = playerVelocities[i].length();
      const maxSpeed = 0.2;
      if (speed > maxSpeed) {
        playerVelocities[i].multiplyScalar(maxSpeed / speed);
      }
      
      // Update position directly for kinematic body (can't use forces)
      const newPosition = {
        x: playerPos.x + playerVelocities[i].x,
        y: playerPos.y + playerVelocities[i].y,
        z: playerPos.z + playerVelocities[i].z
      };
      
      playerBodies[i].setTranslation(newPosition);
    } else if (!playerFallingStates[i]) {
      // For landed players, stick them to the planet surface each frame
      stickToSphere(playerBodies[i], planetBody);
    }
  }
  
  // For other dynamic objects (which can have forces applied)
  for (const objectBody of objectBodies) {
    if (objectBody && planetBody) {
      applyGravityToObject(objectBody, planetBody);
    }
  }
}

// Add the missing handleCollisions function
function handleCollisions() {
  // Process events from the physics event queue
  eventQueue.drainCollisionEvents((handle1, handle2, started) => {
    // Get colliders from handles
    const collider1 = physicsWorld.getCollider(handle1);
    const collider2 = physicsWorld.getCollider(handle2);
    
    if (!collider1 || !collider2) return;
    
    // Check if any player is involved in this collision
    const playerIndex = playerColliderMap.get(handle1) !== undefined 
      ? playerColliderMap.get(handle1) 
      : playerColliderMap.get(handle2);
    
    if (playerIndex !== undefined && started) {
      // This is a collision involving a player - handle landing detection
      if (playerFallingStates[playerIndex]) {
        const playerBody = playerBodies[playerIndex];
        if (!playerBody) return;
        
        // Get the other collider (the one that's not the player)
        const otherCollider = playerColliderMap.get(handle1) !== undefined ? collider2 : collider1;
        const otherBodyHandle = otherCollider.parent();
        const otherBody = physicsWorld.getRigidBody(otherBodyHandle);
        
        if (otherBody) {
          // If the player has collided with the planet surface
          if (otherBody === planetBody) {
            // Calculate normal direction (from planet center to player)
            const playerPos = playerBody.translation();
            const planetPos = planetBody.translation();
            const normal = new THREE.Vector3(
              playerPos.x - planetPos.x,
              playerPos.y - planetPos.y,
              playerPos.z - planetPos.z
            ).normalize();
            
            // Land the player on the planet surface
            playerFallingStates[playerIndex] = false;
            stickToSphere(playerBody, planetBody);
            alignPlayerWithNormal(playerIndex, normal);
          } 
          // For other objects, handle landing accordingly
          else if (otherBody.isFixed()) {
            // Calculate contact normal (more complex for arbitrary shapes)
            const playerPos = playerBody.translation();
            const otherPos = otherBody.translation();
            const normal = new THREE.Vector3(
              playerPos.x - otherPos.x,
              playerPos.y - otherPos.y,
              playerPos.z - otherPos.z
            ).normalize();
            
            playerFallingStates[playerIndex] = false;
            landPlayerOnSurface(playerIndex, otherBody, otherCollider, normal);
            alignPlayerWithNormal(playerIndex, normal);
          }
        }
      }
    }
  });
}

function animate() {
  animationFrameId = requestAnimationFrame(animate);
  
  // Apply gravity and planet sticking
  applyPlanetGravity();
  
  // Step physics for non-player objects
  physicsWorld.step(eventQueue);
  
  // Handle collision events
  handleCollisions();
  
  // Move player after physics step
  movePlayer();
  
  // Update planet position
  if (planetBody && planetMesh) {
    const position = planetBody.translation()
    planetMesh.position.set(position.x, position.y, position.z)
  }
  
  // Update all player positions and rotations
  for (let i = 0; i < playerBodies.length; i++) {
    const body = playerBodies[i]
    const mesh = playerMeshes[i]
    
    if (body && mesh) {
      const position = body.translation()
      const rotation = body.rotation()
      
      mesh.position.set(position.x, position.y, position.z)
      mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
    }
  }
  
  // Update all random object positions and rotations
  for (let i = 0; i < objectBodies.length; i++) {
    const body = objectBodies[i]
    const mesh = objectMeshes[i]
    
    if (body && mesh) {
      const position = body.translation()
      const rotation = body.rotation()
      
      mesh.position.set(position.x, position.y, position.z)
      mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
    }
  }
  
  // Update surface cube positions and rotations (if needed)
  for (let i = 0; i < surfaceCubeBodies.length; i++) {
    const body = surfaceCubeBodies[i]
    const mesh = surfaceCubeMeshes[i]
    
    if (body && mesh) {
      const position = body.translation()
      const rotation = body.rotation()
      
      mesh.position.set(position.x, position.y, position.z)
      mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
    }
  }
  
  renderer.render(scene, camera)
}

// Add this function to retrieve a player's collider handle by index
function getPlayerColliderHandle(playerIndex) {
  // Iterate through the player collider map to find the handle for this player index
  for (const [handle, index] of playerColliderMap.entries()) {
    if (index === playerIndex) {
      return handle;
    }
  }
  return null; // Return null if no handle found for this player
}

// More conservative movePlayer function with extra cube checks
function movePlayer() {
  // Only control the first player
  if (playerBodies.length === 0) return;
  
  const playerBody = playerBodies[0];
  if (!playerBody) return;
  
  // Get player position
  const playerPos = playerBody.translation();
  if (!playerPos || typeof playerPos.x !== 'number') return;
  
  const isFalling = playerFallingStates[0];
  
  // Get player collider handle
  const playerHandle = getPlayerColliderHandle(0);
  if (!playerHandle) return;
  
  // Get movement direction based on WASD keys
  const moveDirection = new THREE.Vector3(0, 0, 0);
  
  if (keys.w) moveDirection.z -= 1; // Forward
  if (keys.s) moveDirection.z += 1; // Backward
  if (keys.a) moveDirection.x -= 1; // Left
  if (keys.d) moveDirection.x += 1; // Right
  
  // If no movement, return early
  if (moveDirection.length() === 0) return;
  
  // Normalize the movement direction
  moveDirection.normalize();
  
  const MOVE_SPEED = 0.1; // Movement speed
  
  if (isFalling) {
    // When falling, move in the direction the player is facing
    const rotation = playerBody.rotation();
    const playerQuaternion = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
    
    // Apply rotation to the movement direction
    moveDirection.applyQuaternion(playerQuaternion);
    
    // Check planetward direction for potential landing
    const planetPos = planetBody.translation();
    const toPlanet = new THREE.Vector3(
      planetPos.x - playerPos.x, 
      planetPos.y - playerPos.y, 
      planetPos.z - playerPos.z
    ).normalize();
    
    const distance = new THREE.Vector3(
      planetPos.x - playerPos.x,
      planetPos.y - playerPos.y,
      planetPos.z - playerPos.z
    ).length();
    
    // If close enough to planet surface, consider landing
    if (distance <= PLANET_RADIUS + PLAYER_RADIUS + 0.1) {
      // Land on planet
      playerFallingStates[0] = false;
      const normal = stickToSphere(playerBody, planetBody);
      alignPlayerWithNormal(0, normal);
      return;
    }
    
    // Apply falling movement
    const newPosition = {
      x: playerPos.x + moveDirection.x * MOVE_SPEED * 0.5, // Reduced control when falling
      y: playerPos.y + moveDirection.y * MOVE_SPEED * 0.5,
      z: playerPos.z + moveDirection.z * MOVE_SPEED * 0.5
    };
    
    // Apply gravity influence
    playerVelocities[0].add(toPlanet.multiplyScalar(0.005));
    
    // Apply velocity to position
    newPosition.x += playerVelocities[0].x;
    newPosition.y += playerVelocities[0].y;
    newPosition.z += playerVelocities[0].z;
    
    // Check for collision with any object (including planet)
    const wouldCollide = detectCollisionsInDirection(
      playerPos, 
      new THREE.Vector3(
        newPosition.x - playerPos.x,
        newPosition.y - playerPos.y,
        newPosition.z - playerPos.z
      ).normalize(), 
      playerHandle
    );
    
    if (!wouldCollide) {
      playerBody.setTranslation(newPosition);
    } else {
      // If collision detected, player has hit something - land if it's the planet
      playerFallingStates[0] = false;
      
      // Stick to planet surface and align
      const normal = stickToSphere(playerBody, planetBody);
      alignPlayerWithNormal(0, normal);
    }
  } else {
    // On planet surface - manual movement along the tangent plane
    const planetPos = planetBody.translation();
    
    // First, ensure player is stuck to the planet surface
    const surfaceNormal = stickToSphere(playerBody, planetBody);
    
    // Get the player's orientation for movement direction
    const rotation = playerBody.rotation();
    const playerQuat = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
    const playerForward = new THREE.Vector3(0, 0, -1).applyQuaternion(playerQuat);
    
    // Calculate tangent plane basis vectors
    const rightDir = new THREE.Vector3().crossVectors(playerForward, surfaceNormal).normalize();
    const adjustedForward = new THREE.Vector3().crossVectors(surfaceNormal, rightDir).normalize();
    
    // Calculate movement in tangent plane
    const localMoveDir = new THREE.Vector3();
    if (keys.w) localMoveDir.add(adjustedForward);
    if (keys.s) localMoveDir.sub(adjustedForward);
    if (keys.a) localMoveDir.sub(rightDir);
    if (keys.d) localMoveDir.add(rightDir);
    
    if (localMoveDir.length() > 0) {
      localMoveDir.normalize();
      
      // IMPORTANT: First check if we're already colliding with a cube
      // If so, we need to push away from it slightly before allowing movement
      if (isCollidingWithCube(playerPos, playerHandle, true)) {
        // We're already inside or very close to a cube
        // Try to nudge away by sticking to the planet more aggressively
        stickToSphere(playerBody, planetBody);
        return; // Skip movement this frame to prevent moving through objects
      }
      
      // Enhanced collision checking using multiple methods
      const collisionDetected = 
        detectCollisionsInDirection(playerPos, localMoveDir, playerHandle) ||
        raycastHitsCube(playerPos, localMoveDir, PLAYER_RADIUS * 2.0);
      
      if (!collisionDetected) {
        // Calculate new position on sphere surface
        const newPosition = {
          x: playerPos.x + localMoveDir.x * MOVE_SPEED,
          y: playerPos.y + localMoveDir.y * MOVE_SPEED,
          z: playerPos.z + localMoveDir.z * MOVE_SPEED
        };
        
        // Project point back to sphere surface
        const dirToSphere = new THREE.Vector3(
          newPosition.x - planetPos.x,
          newPosition.y - planetPos.y,
          newPosition.z - planetPos.z
        ).normalize();
        
        const surfacePosition = {
          x: planetPos.x + dirToSphere.x * (PLANET_RADIUS + PLAYER_RADIUS),
          y: planetPos.y + dirToSphere.y * (PLANET_RADIUS + PLAYER_RADIUS),
          z: planetPos.z + dirToSphere.z * (PLANET_RADIUS + PLAYER_RADIUS)
        };
        
        // Check for collision at the new surface position
        const collisionAtSurface = detectCollisionsInDirection(
          playerPos,
          new THREE.Vector3(
            surfacePosition.x - playerPos.x,
            surfacePosition.y - playerPos.y,
            surfacePosition.z - playerPos.z
          ).normalize(),
          playerHandle
        );
        
        if (!collisionAtSurface) {
          // Move to the new position
          playerBody.setTranslation(surfacePosition);
          
          // Update player rotation to face movement direction
          const upVector = new THREE.Vector3(0, 1, 0);
          const alignmentQuat = new THREE.Quaternion().setFromUnitVectors(upVector, dirToSphere);
          
          // Calculate rotation to face movement direction
          const stdForward = new THREE.Vector3(0, 0, -1);
          const localForward = stdForward.clone().applyQuaternion(alignmentQuat);
          
          const angle = Math.atan2(
            new THREE.Vector3().crossVectors(localForward, localMoveDir).dot(dirToSphere),
            localForward.dot(localMoveDir)
          );
          
          const rotateQuat = new THREE.Quaternion().setFromAxisAngle(dirToSphere, angle);
          const finalQuat = alignmentQuat.clone().premultiply(rotateQuat);
          
          // Set final rotation
          playerBody.setRotation({
            x: finalQuat.x,
            y: finalQuat.y,
            z: finalQuat.z,
            w: finalQuat.w
          });
        }
      } else {
        // Try to slide along walls when collision is detected
        const rayResults = [];
        const numRays = 8;
        
        // Cast rays in a circle around the player to find possible movement directions
        for (let i = 0; i < numRays; i++) {
          const angle = (i / numRays) * Math.PI * 2;
          const rayDir = new THREE.Vector3(
            Math.cos(angle), 
            0, 
            Math.sin(angle)
          );
          
          // Project ray direction onto tangent plane
          const dot = rayDir.dot(surfaceNormal);
          rayDir.sub(surfaceNormal.clone().multiplyScalar(dot));
          rayDir.normalize();
          
          // Check if this direction would cause a collision
          const isBlocked = testDirectionalCollision(playerPos, rayDir, playerHandle);
          
          // If not blocked, record as a valid movement direction
          if (!isBlocked) {
            // Calculate how closely this matches our desired direction
            const directionMatch = rayDir.dot(localMoveDir);
            
            if (directionMatch > 0.1) { // Only consider directions somewhat aligned with input
              rayResults.push({
                direction: rayDir,
                match: directionMatch
              });
            }
          }
        }
        
        // Find the best alternative direction (most aligned with desired movement)
        if (rayResults.length > 0) {
          // Sort by closest match to desired direction
          rayResults.sort((a, b) => b.match - a.match);
          const bestDir = rayResults[0].direction;
          
          // Move in the best available direction
          const slidePosition = {
            x: playerPos.x + bestDir.x * MOVE_SPEED * 0.7, // Reduced speed when sliding
            y: playerPos.y + bestDir.y * MOVE_SPEED * 0.7,
            z: playerPos.z + bestDir.z * MOVE_SPEED * 0.7
          };
          
          // Project back to sphere surface
          const dirToSphere = new THREE.Vector3(
            slidePosition.x - planetPos.x,
            slidePosition.y - planetPos.y,
            slidePosition.z - planetPos.z
          ).normalize();
          
          const slideSurfacePosition = {
            x: planetPos.x + dirToSphere.x * (PLANET_RADIUS + PLAYER_RADIUS),
            y: planetPos.y + dirToSphere.y * (PLANET_RADIUS + PLAYER_RADIUS),
            z: planetPos.z + dirToSphere.z * (PLANET_RADIUS + PLAYER_RADIUS)
          };
          
          playerBody.setTranslation(slideSurfacePosition);
        }
      }
    }
  }
}

// Function for manual sphere surface sticking
function stickToSphere(playerBody, planetBody) {
  if (!playerBody || !planetBody) return null;
  
  const playerPos = playerBody.translation();
  const planetPos = planetBody.translation();
  
  // Calculate direction from planet center to player
  const toPlayer = new THREE.Vector3(
    playerPos.x - planetPos.x,
    playerPos.y - planetPos.y,
    playerPos.z - planetPos.z
  );
  
  const distance = toPlayer.length();
  if (distance === 0) return null;
  
  toPlayer.normalize();
  
  // Calculate the desired position on the surface of the planet
  const surfacePosition = {
    x: planetPos.x + toPlayer.x * (PLANET_RADIUS + PLAYER_RADIUS),
    y: planetPos.y + toPlayer.y * (PLANET_RADIUS + PLAYER_RADIUS),
    z: planetPos.z + toPlayer.z * (PLANET_RADIUS + PLAYER_RADIUS)
  };
  
  // Check if the player is already close enough to the surface
  const offset = 0.1; // Allowable offset from the surface
  const isCloseEnough = Math.abs(surfacePosition.y - playerPos.y) < offset;
  
  if (!isCloseEnough) {
    // Snap the player to the surface position
    playerBody.setTranslation(surfacePosition);
  }
  
  return toPlayer; // Return the normal direction
}
</script>

<style scoped>
  :global(html), :global(body) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100vh;
    overflow: hidden;
  }
  
  canvas {
    display: block;
    width: 100%;
    height: 100vh;
  }
</style>
