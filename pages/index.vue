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

// Function to create players - update to disable sensor mode for physical collisions
function createPlayers(count) {
  const playerColors = [0xe53935, 0x43A047, 0x1E88E5]
  
  for (let i = 0; i < count; i++) {
    // Random position above the planet
    const randomX = (Math.random() - 0.5) * 30
    const randomY = 15 + Math.random() * 15  // Between 15-30 units high
    const randomZ = (Math.random() - 0.5) * 30
    
    // Create player physics body as kinematic instead of dynamic
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
    
    // Create collider - remove sensor flag to enable physical collisions
    const playerColliderDesc = RAPIER.ColliderDesc.capsule(PLAYER_HEIGHT / 2, PLAYER_RADIUS)
    // No longer set as sensor: playerColliderDesc.setSensor(true)
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
    
    // Create cube collider
    const cubeColliderDesc = RAPIER.ColliderDesc.cuboid(cubeSize/2, cubeSize/4, cubeSize/2);
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

// Update gravity function to handle kinematic players differently
function applyPlanetGravity() {
  // For players that are falling, manually update their positions based on velocity and gravity
  for (let i = 0; i < playerBodies.length; i++) {
    if (playerFallingStates[i] && playerBodies[i] && planetBody) {
      // Get positions
      const playerPos = playerBodies[i].translation()
      const planetPos = planetBody.translation()
      
      // Direction FROM player TO planet (correct for gravity calculation)
      // This should pull the player toward the planet, not push away
      const gravityDirection = new THREE.Vector3(
        planetPos.x - playerPos.x,
        planetPos.y - playerPos.y,
        planetPos.z - playerPos.z
      )
      
      // For surface normal (correct for landing alignment)
      // Direction FROM planet TO player
      const normalDirection = new THREE.Vector3(
        playerPos.x - planetPos.x,
        playerPos.y - planetPos.y,
        playerPos.z - planetPos.z
      )
      
      const distance = gravityDirection.length()  // Distance is the same either way
      
      // Check if we're close enough to land directly on the planet - fix calculation
      if (distance <= PLANET_RADIUS + PLAYER_RADIUS + 0.1) {
        // We're close enough to the planet surface to land
        // Use the normalDirection as the surface normal (points outward from planet)
        const normal = normalDirection.clone().normalize();
        landPlayerOnSurface(i, planetBody, physicsWorld.getCollider(planetBody.collider(0)), normal);
        alignPlayerWithNormal(i, normal);
        playerFallingStates[i] = false;
        continue;
      }
      
      if (distance === 0) continue
      
      // Normalize and scale by gravity
      gravityDirection.normalize()
      const gravitationalAcceleration = GRAVITY_STRENGTH / (distance * distance) * 0.0005
      
      // Update velocity using gravity - pulling TOWARD the planet
      playerVelocities[i].x += gravityDirection.x * gravitationalAcceleration
      playerVelocities[i].y += gravityDirection.y * gravitationalAcceleration
      playerVelocities[i].z += gravityDirection.z * gravitationalAcceleration
      
      // Limit terminal velocity to prevent tunneling
      const speed = playerVelocities[i].length();
      const maxSpeed = 0.2; // Adjust as needed
      if (speed > maxSpeed) {
        playerVelocities[i].multiplyScalar(maxSpeed / speed);
      }
      
      // Update position using velocity
      const newPosition = {
        x: playerPos.x + playerVelocities[i].x,
        y: playerPos.y + playerVelocities[i].y,
        z: playerPos.z + playerVelocities[i].z
      }
      
      // Apply the new position to the kinematic body
      playerBodies[i].setTranslation(newPosition)
    }
  }
  
  // Apply gravity to random objects (which are dynamic)
  for (const objectBody of objectBodies) {
    if (objectBody && planetBody) {
      applyGravityToObject(objectBody, planetBody)
    }
  }
}

// Update this function too to pull objects toward the planet
function applyGravityToObject(objectBody, attractor) {
  const objectPos = objectBody.translation()
  const attractorPos = attractor.translation()
  
  // Direction FROM object TO attractor (for correct gravity)
  const direction = new THREE.Vector3(
    attractorPos.x - objectPos.x,
    attractorPos.y - objectPos.y,
    attractorPos.z - objectPos.z
  )
  
  const distance = direction.length()
  if (distance === 0) return
  
  direction.normalize()
  const forceMagnitude = GRAVITY_STRENGTH / (distance * distance) * 0.01
  
  objectBody.applyImpulse(
    { 
      x: direction.x * forceMagnitude,
      y: direction.y * forceMagnitude, 
      z: direction.z * forceMagnitude 
    },
    true
  )
}

// Handle all collision events
function handleCollisions() {
  // Process events from the event queue
  eventQueue.drainCollisionEvents((handle1, handle2, started) => {
    if (started) {
      // Get colliders
      const collider1 = physicsWorld.getCollider(handle1)
      const collider2 = physicsWorld.getCollider(handle2)
      
      // Check if one of the colliders belongs to a player using our map
      let playerIndex = -1
      let otherCollider = null
      
      if (playerColliderMap.has(handle1)) {
        playerIndex = playerColliderMap.get(handle1)
        otherCollider = collider2
      } else if (playerColliderMap.has(handle2)) {
        playerIndex = playerColliderMap.get(handle2)
        otherCollider = collider1
      }
      
      // If we found a player in this collision
      if (playerIndex >= 0 && playerFallingStates[playerIndex]) {
        // Calculate contact normal - find a point on the surface
        const playerPos = playerBodies[playerIndex].translation()
        
        // Get the other object's position to calculate direction
        const otherBody = physicsWorld.getRigidBody(otherCollider.parent())
        const otherPos = otherBody.translation()
        
        // Fix the normal calculation - it should point FROM planet TO player
        // for proper alignment on the surface
        const normal = new THREE.Vector3(
          playerPos.x - otherPos.x,
          playerPos.y - otherPos.y,
          playerPos.z - otherPos.z
        ).normalize()
        
        // Land the player on the surface 
        landPlayerOnSurface(playerIndex, otherBody, otherCollider, normal)
        
        // Align player with surface normal
        alignPlayerWithNormal(playerIndex, normal)
        
        // Player has landed
        playerFallingStates[playerIndex] = false
      }
    }
  })
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

// Align player with surface normal and reset velocity
function alignPlayerWithNormal(playerIndex, normal) {
  if (playerIndex < 0 || playerIndex >= playerBodies.length) return
  
  // Create a quaternion that rotates the standard up vector (0,1,0) to align with the normal
  const upVector = new THREE.Vector3(0, 1, 0)
  const quaternion = new THREE.Quaternion()
  quaternion.setFromUnitVectors(upVector, normal)
  
  // Apply rotation to the player's rigid body
  playerBodies[playerIndex].setRotation({
    x: quaternion.x,
    y: quaternion.y,
    z: quaternion.z,
    w: quaternion.w
  })
  
  // Reset velocity when landing
  playerVelocities[playerIndex].set(0, 0, 0)
}

// Handle keyboard input
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

// Move player based on keyboard input
function movePlayer() {
  // Only control the first player (index 0)
  if (playerBodies.length === 0) return;
  
  const playerBody = playerBodies[0];
  const isFalling = playerFallingStates[0];
  
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
    // Get the player's current rotation
    const rotation = playerBody.rotation();
    const playerQuaternion = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
    
    // Apply rotation to the movement direction
    moveDirection.applyQuaternion(playerQuaternion);

    // Apply movement
    const playerPos = playerBody.translation();
    const newPosition = {
      x: playerPos.x + moveDirection.x * MOVE_SPEED,
      y: playerPos.y + moveDirection.y * MOVE_SPEED,
      z: playerPos.z + moveDirection.z * MOVE_SPEED
    };
    
    playerBody.setTranslation(newPosition);
  } else {
    // When landed, handle movement on curved surface
    const playerPos = playerBody.translation();
    const planetPos = planetBody.translation();
    
    // Calculate current surface normal at player position (direction from planet to player)
    const surfaceNormal = new THREE.Vector3(
      playerPos.x - planetPos.x,
      playerPos.y - planetPos.y,
      playerPos.z - planetPos.z
    ).normalize();
    
    // Get the player's current forward direction based on their rotation
    const rotation = playerBody.rotation();
    const playerQuat = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
    const playerForward = new THREE.Vector3(0, 0, -1).applyQuaternion(playerQuat);
    
    // Ensure the forward direction is perpendicular to surface normal
    const rightDir = new THREE.Vector3().crossVectors(playerForward, surfaceNormal).normalize();
    const adjustedForward = new THREE.Vector3().crossVectors(surfaceNormal, rightDir).normalize();
    
    // Construct a local movement direction based on current orientation
    const localMoveDir = new THREE.Vector3();
    if (keys.w) localMoveDir.add(adjustedForward);
    if (keys.s) localMoveDir.sub(adjustedForward);
    if (keys.a) localMoveDir.sub(rightDir);
    if (keys.d) localMoveDir.add(rightDir);
    
    if (localMoveDir.length() > 0) {
      localMoveDir.normalize();
      
      // Calculate the movement delta
      localMoveDir.multiplyScalar(MOVE_SPEED);
      
      // Calculate new position
      const newPosition = {
        x: playerPos.x + localMoveDir.x,
        y: playerPos.y + localMoveDir.y,
        z: playerPos.z + localMoveDir.z
      };
      
      // Project the new position onto the planet surface
      const dirToNewPos = new THREE.Vector3(
        newPosition.x - planetPos.x,
        newPosition.y - planetPos.y,
        newPosition.z - planetPos.z
      );
      
      // Calculate the proper distance from planet center to position the bottom of capsule on surface
      // PLAYER_HEIGHT/2 is half the height of the capsule body
      const distanceFromCenter = PLANET_RADIUS + PLAYER_RADIUS;
      dirToNewPos.normalize().multiplyScalar(distanceFromCenter);
      
      // Final corrected position on the surface
      newPosition.x = planetPos.x + dirToNewPos.x;
      newPosition.y = planetPos.y + dirToNewPos.y;
      newPosition.z = planetPos.z + dirToNewPos.z;
      
      // Calculate the NEW surface normal at the new position (points outward from planet)
      const newSurfaceNormal = dirToNewPos.clone().normalize();
      
      // Calculate orientation - make sure player's up direction aligns with surface normal
      const upVector = new THREE.Vector3(0, 1, 0);
      const alignmentQuat = new THREE.Quaternion().setFromUnitVectors(upVector, newSurfaceNormal);
      
      // If we're moving, we want to face the direction of movement
      if (localMoveDir.length() > 0) {
        // First orient with the surface normal
        let targetQuat = alignmentQuat.clone();
        
        // Create a forward direction in the movement direction but perpendicular to normal
        const moveDir = localMoveDir.clone().normalize();
        
        // Make sure move direction is perpendicular to the surface normal
        const dot = moveDir.dot(newSurfaceNormal);
        moveDir.x -= dot * newSurfaceNormal.x;
        moveDir.y -= dot * newSurfaceNormal.y;
        moveDir.z -= dot * newSurfaceNormal.z;
        moveDir.normalize();
        
        // Calculate a rotation to orient forward direction with movement direction
        // This preserves the up direction aligned with the surface normal
        const forwardQuat = new THREE.Quaternion();
        
        // The standard forward is -Z in THREE.js coordinate system
        const stdForward = new THREE.Vector3(0, 0, -1);
        
        // Apply the surface normal alignment first to get the local forward
        const localForward = stdForward.clone().applyQuaternion(alignmentQuat);
        
        // Create another quaternion to rotate from localForward to moveDir
        // while preserving the up direction (surface normal)
        const rotateToMoveDir = new THREE.Quaternion();
        
        // Calculate the angle between vectors in the tangent plane
        const angle = Math.atan2(
          new THREE.Vector3().crossVectors(localForward, moveDir).dot(newSurfaceNormal),
          localForward.dot(moveDir)
        );
        
        // Rotate around the surface normal by this angle
        rotateToMoveDir.setFromAxisAngle(newSurfaceNormal, angle);
        
        // Combine the rotations: first align to surface, then rotate to face movement direction
        targetQuat.premultiply(rotateToMoveDir);
        
        // Set the final rotation
        playerBody.setRotation({
          x: targetQuat.x,
          y: targetQuat.y,
          z: targetQuat.z,
          w: targetQuat.w
        });
      } else {
        // Just align with the surface normal if not moving
        playerBody.setRotation({
          x: alignmentQuat.x, 
          y: alignmentQuat.y, 
          z: alignmentQuat.z, 
          w: alignmentQuat.w
        });
      }
      
      // Set the new position
      playerBody.setTranslation(newPosition);
    }
  }
}

function animate() {
  animationFrameId = requestAnimationFrame(animate)
  
  applyPlanetGravity()
  
  // Process collision events
  physicsWorld.step(eventQueue)
  handleCollisions()
  
  // Move player based on keyboard input (add this line)
  movePlayer()
  
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
