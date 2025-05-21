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
  const TERRAIN_HEIGHT_SCALE = 50; // How much the terrain varies in height
  const TURN_SPEED = 2; // How fast the player rotates
  const MAX_CLIMBABLE_SLOPE = Math.PI / 5; // Maximum slope angle the player can climb (36 degrees)
  const NUM_DYNAMIC_OBJECTS = 10; // Number of dynamic objects to create
  const DYNAMIC_OBJECT_SIZE = 1; // Size of dynamic objects

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

  // Add a function to create fixed colliders on terrain
  function createFixedCollidersOnTerrain() {
    // Number of attempts to find valid placement spots
    const MAX_ATTEMPTS = 50;
    // Desired number of fixed colliders
    const NUM_TERRAIN_COLLIDERS = 15;
    // Minimum separation between colliders
    const MIN_SEPARATION = 5;
    // Variety of collider sizes
    const SIZE_RANGE = { min: 1, max: 3 };
    // Variety of collider shapes
    const SHAPES = ['box', 'cylinder', 'sphere'];
    
    // Track placed collider positions to ensure spacing
    const placedPositions = [];
    
    for (let i = 0; i < NUM_TERRAIN_COLLIDERS; i++) {
      let validSpot = false;
      let attempts = 0;
      let position, normal;
      
      // Try to find a valid spot that's not too close to existing colliders
      while (!validSpot && attempts < MAX_ATTEMPTS) {
        // Generate random point on sphere
        const phi = Math.PI * Math.random();
        const theta = Math.PI * 2 * Math.random();
        
        // Convert to cartesian coordinates (unit sphere)
        const x = Math.sin(phi) * Math.cos(theta);
        const y = Math.cos(phi);
        const z = Math.sin(phi) * Math.sin(theta);
        
        // Create direction vector
        const dir = new THREE.Vector3(x, y, z).normalize();
        
        // Cast ray from above terrain toward planet center
        const raycaster = new THREE.Raycaster();
        // Start ray from well above terrain
        const rayStart = dir.clone().multiplyScalar(PLANET_RADIUS + TERRAIN_HEIGHT_SCALE * 2);
        // Ray points toward planet center
        const rayDir = GRAVITY_CENTER.clone().sub(rayStart).normalize();
        
        raycaster.set(rayStart, rayDir);
        const intersects = raycaster.intersectObject(terrain);
        
        if (intersects.length > 0) {
          // Get intersection point and normal
          position = intersects[0].point;
          
          // Get normal and transform to world space
          normal = intersects[0].face.normal.clone();
          const normalMatrix = new THREE.Matrix3().getNormalMatrix(terrain.matrixWorld);
          normal.applyMatrix3(normalMatrix).normalize();
          
          // Check slope - reject too steep surfaces
          const up = position.clone().sub(GRAVITY_CENTER).normalize();
          const slopeAngle = Math.acos(Math.min(1, Math.abs(normal.dot(up))));
          const MAX_ACCEPTABLE_SLOPE = Math.PI / 6; // 30 degrees
          
          if (slopeAngle > MAX_ACCEPTABLE_SLOPE) {
            attempts++;
            continue;
          }
          
          // Check distance from other colliders
          validSpot = true;
          for (const pos of placedPositions) {
            if (position.distanceTo(pos) < MIN_SEPARATION) {
              validSpot = false;
              break;
            }
          }
        }
        
        attempts++;
      }
      
      // If we found a valid spot, create a collider
      if (validSpot) {
        // Remember this position
        placedPositions.push(position.clone());
        
        // Randomize size
        const size = SIZE_RANGE.min + Math.random() * (SIZE_RANGE.max - SIZE_RANGE.min);
        
        // Randomly choose shape type
        const shapeType = SHAPES[Math.floor(Math.random() * SHAPES.length)];
        
        // Create the collider based on shape type
        let collider;
        
        // The up vector points away from gravity
        const up = position.clone().sub(GRAVITY_CENTER).normalize();
        
        switch (shapeType) {
          case 'box':
            // Create box with random width/depth ratio but shorter height
            const width = size;
            const height = size * 0.5;
            const depth = size * (0.5 + Math.random() * 0.5);
            
            collider = createFixedColliderOnSurface(
              position, normal, 
              new THREE.Vector3(width, height, depth), 
              0x8855aa, shapeType
            );
            break;
            
          case 'cylinder':
            collider = createFixedColliderOnSurface(
              position, normal,
              new THREE.Vector3(size * 0.5, size, size * 0.5),
              0x55aa88, shapeType
            );
            break;
            
          case 'sphere':
            collider = createFixedColliderOnSurface(
              position, normal,
              new THREE.Vector3(size, size, size),
              0xaa5588, shapeType
            );
            break;
        }
        
        // Add to fixed boxes array to enable collision handling
        if (collider) {
          fixedBoxes.push(collider);
        }
      }
    }
  }

  // Create a fixed collider aligned to the terrain surface
  function createFixedColliderOnSurface(position, normal, size, color, shape = 'box') {
    // Calculate the orientation based on the surface normal
    const gravityDir = position.clone().sub(GRAVITY_CENTER).normalize();
    const worldUp = gravityDir.clone().negate();
    
    // Blend the provided normal with the gravity direction to prevent extreme angles
    const blendedNormal = normal.clone().add(worldUp).normalize();
    
    // Create quaternion for orientation
    let orientQuaternion;
    
    // Create a basis with the normal as the up direction
    const worldX = new THREE.Vector3(1, 0, 0);
    const right = worldX.clone().projectOnPlane(blendedNormal).normalize();
    if (right.lengthSq() < 0.01) {
      right.set(0, 0, 1).projectOnPlane(blendedNormal).normalize();
    }
    const forward = new THREE.Vector3().crossVectors(right, blendedNormal).normalize();
    const rotMatrix = new THREE.Matrix4().makeBasis(right, blendedNormal, forward);
    orientQuaternion = new THREE.Quaternion().setFromRotationMatrix(rotMatrix);
    
    // Create the appropriate collider description based on shape
    let colliderDesc;
    let geometry;
    
    switch (shape) {
      case 'box':
        colliderDesc = RAPIER.ColliderDesc.cuboid(
          size.x / 2, size.y / 2, size.z / 2
        );
        geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
        break;
        
      case 'cylinder':
        colliderDesc = RAPIER.ColliderDesc.cylinder(
          size.y / 2, size.x
        );
        geometry = new THREE.CylinderGeometry(size.x, size.x, size.y, 16);
        break;
        
      case 'sphere':
        colliderDesc = RAPIER.ColliderDesc.ball(size.x / 2);
        geometry = new THREE.SphereGeometry(size.x / 2, 16, 16);
        break;
        
      default:
        colliderDesc = RAPIER.ColliderDesc.cuboid(
          size.x / 2, size.y / 2, size.z / 2
        );
        geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    }
    
    // Set collision properties
    colliderDesc.setCollisionGroups(0x00010001);
    
    // Create rigid body description
    const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(position.x, position.y, position.z)
      .setRotation({
        x: orientQuaternion.x,
        y: orientQuaternion.y,
        z: orientQuaternion.z,
        w: orientQuaternion.w
      });
    
    // Create the rigid body and collider
    const body = world.createRigidBody(rigidBodyDesc);
    const collider = world.createCollider(colliderDesc, body);
    
    // Create visual representation
    const material = new THREE.MeshStandardMaterial({ 
      color: color,
      roughness: 0.6
    });
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.quaternion.copy(orientQuaternion);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    
    return {
      body: body,
      collider: collider,
      mesh: mesh
    };
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

  // Detect and resolve collisions between player and fixed boxes
  function handlePlayerCollisions() {
    if (!physicsInitialized || !playerBody || !playerCollider) return;
    
    // Get player position
    const playerPosition = new THREE.Vector3(
      playerBody.translation().x,
      playerBody.translation().y,
      playerBody.translation().z
    );
    
    // Get gravity-based up direction for this position
    const gravityUp = playerPosition.clone().sub(GRAVITY_CENTER).normalize();
    
    // Track collision info
    let hasCollision = false;
    let bestCollisionNormal = null;
    let bestPenetrationDepth = 0;
    let isReorienting = false;
    
    // First attempt: Use Rapier's contact API
    for (const box of fixedBoxes) {
      if (!box.body || !box.collider) continue;
      
      // Get contact pair between the two colliders
      const contact = world.contactPair(box.collider.handle, playerCollider.handle);
      
      if (contact && typeof contact.hasAnyContact === 'function' && contact.hasAnyContact()) {
        hasCollision = true;
        
        const manifolds = contact.manifolds();
        for (let i = 0; i < manifolds.length; i++) {
          const manifold = manifolds[i];
          const worldNormal = manifold.normal();
          const normal = new THREE.Vector3(worldNormal.x, worldNormal.y, worldNormal.z);
          const points = manifold.points();
          
          for (let j = 0; j < points.length; j++) {
            const point = points[j];
            const depth = point.depth();
            
            if (depth > bestPenetrationDepth) {
              bestPenetrationDepth = depth;
              bestCollisionNormal = normal.clone();
            }
          }
        }
      }
    }
    
    // If no collision found through Rapier API, use raycasts for fixed objects (similar to terrain)
    if (!hasCollision) {
      // Get the exact capsule bottom position (feet)
      const capsuleBottomOffset = PLAYER_HEIGHT/2; 
      const feetPosition = playerPosition.clone().add(gravityUp.clone().negate().multiplyScalar(capsuleBottomOffset - 0.05));
      
      // Multiple raycasts for better detection
      const rayDirections = [
        gravityUp.clone().negate(), // Center ray
        gravityUp.clone().negate(), // Forward ray
        gravityUp.clone().negate(), // Right ray
        gravityUp.clone().negate(), // Back ray
        gravityUp.clone().negate()  // Left ray
      ];
      
      // Calculate offset positions for the perimeter rays
      const forwardDir = new THREE.Vector3(1, 0, 0).cross(gravityUp).normalize();
      const rightDir = gravityUp.clone().cross(forwardDir).normalize();
      const rayPositions = [
        feetPosition.clone(), // Center
        feetPosition.clone().add(forwardDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7)), // Forward
        feetPosition.clone().add(rightDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7)),   // Right
        feetPosition.clone().sub(forwardDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7)), // Back
        feetPosition.clone().sub(rightDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7))    // Left
      ];
      
      // Store hit information
      let closestHitDistance = Infinity;
      
      // Create an array of meshes to check against
      const objectMeshes = fixedBoxes.map(box => box.mesh);
      
      // Perform the raycasts
      for (let i = 0; i < rayPositions.length; i++) {
        const raycaster = new THREE.Raycaster();
        raycaster.set(rayPositions[i], rayDirections[i]);
        
        // Cast against all fixed object meshes
        const intersects = raycaster.intersectObjects(objectMeshes);
        
        if (intersects.length > 0) {
          const hit = intersects[0];
          
          // Find which fixed box was hit
          const hitBox = fixedBoxes.find(box => box.mesh === hit.object);
          if (!hitBox) continue;
          
          // Get the normal in world space
          const normal = hit.face.normal.clone();
          const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
          const worldNormal = normal.applyMatrix3(normalMatrix).normalize();
          
          // Store collision if it's closer than previous hits
          if (hit.distance < closestHitDistance) {
            closestHitDistance = hit.distance;
            bestCollisionNormal = worldNormal;
            bestPenetrationDepth = PLAYER_RADIUS + 0.05 - hit.distance;
            hasCollision = true;
          }
        }
      }
    }
    
    // Process the best collision if found
    if (hasCollision && bestCollisionNormal && bestPenetrationDepth > 0) {
      // Store this normal for later use in player movement
      playerState.lastContactNormal = bestCollisionNormal.clone();
      
      // Check if this is a ground contact (normal pointing same direction as gravity up)
      const dotWithUp = bestCollisionNormal.dot(gravityUp);
      const isGroundContact = dotWithUp > 0.5; // Approx 30 degrees or less from up
      
      // Update player ground state based on collision
      if (isGroundContact) {
        playerState.onGround = true;
        playerState.falling = false;
        isReorienting = true;
      }
      
      // Push player out along collision normal to resolve penetration
      playerPosition.add(bestCollisionNormal.clone().multiplyScalar(bestPenetrationDepth * 1.01));
      
      // Modify velocity for proper sliding
      const normalVelocity = bestCollisionNormal.clone().multiplyScalar(
        playerState.velocity.dot(bestCollisionNormal)
      );
      
      // Only cancel velocity going into the surface
      if (normalVelocity.dot(bestCollisionNormal) < 0) {
        // Keep tangential component for sliding
        const tangentialVelocity = playerState.velocity.clone().sub(normalVelocity);
        
        // Apply friction based on surface type
        const frictionFactor = isGroundContact ? 0.7 : 0.95; // Less friction on walls
        tangentialVelocity.multiplyScalar(frictionFactor);
        
        // Update player velocity
        playerState.velocity.copy(tangentialVelocity);
      }
    }
    
    // Update player position after handling collisions
    playerBody.setTranslation({
      x: playerPosition.x,
      y: playerPosition.y,
      z: playerPosition.z
    }, true);
    
    // If colliding with a surface, properly orient player to it
    if (hasCollision && isReorienting && playerState.lastContactNormal) {
      // Calculate orientation based on collision normal
      const surfaceNormal = playerState.lastContactNormal;
      const position = playerPosition.clone();
      const onSurface = true;
      
      // Update player's orientation to match the surface normal from collision
      updatePlayerPositionAndOrientation(position, surfaceNormal, onSurface, gravityUp);
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
        
        // Also update the player's visual mesh to ensure they align
        playerMesh.position.copy(position);
        playerMesh.quaternion.copy(orientationQuaternion);
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
        
        // Cancel velocity going into the ground, but preserve parallel motion
        const normalVelocity = playerState.velocity.clone().projectOnVector(surfaceNormal);
        if (normalVelocity.dot(surfaceNormal) < 0) {
          // Only remove velocity component going INTO the object
          playerState.velocity.sub(normalVelocity);
        }
      } else {
        playerState.onGround = false;
      }
    } else {
      // No hits from any rays - check if we have a collision normal from fixed objects
      if (playerState.lastContactNormal && playerState.onGround) {
        // Use the collision normal from fixed objects as our primary surface normal
        surfaceNormal = playerState.lastContactNormal.clone();
        onSurface = true; // Consider on surface if we have a valid contact normal
      } else {
        // No hits from rays and no collision normals - check if inside planet
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
      
      // When on a fixed object, project movement along the surface
      if (playerState.lastContactNormal && playerState.onGround && hitNormals.length === 0) {
        // Project movement onto the contact surface
        const contactNormal = playerState.lastContactNormal;
        const projectedDirection = playerState.direction.clone().projectOnPlane(contactNormal);
        position.add(projectedDirection);
      } else {
        position.add(playerState.direction);
      }
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
      
      world.step();
    }
    
    // Render scene
    renderer.render(scene, camera);
    
    requestAnimationFrame(animate);
  }
  // Lifecycle hooks
  onMounted(async () => {
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
    
    

    // Add event listeners
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    
    // Add fixed colliders on the terrain
    createFixedCollidersOnTerrain();
    
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
        // Use a fixed mass value - simpler approach
        const mass = obj.isSphere ? 1 : 2;
        
        // Calculate gravity force scaled for impulse application
        const gravityImpulse = gravityDir.clone().multiplyScalar(GRAVITY_STRENGTH * mass * 0.016);
        
        // Apply impulse directly
        obj.body.applyImpulse(
          { x: gravityImpulse.x, y: gravityImpulse.y, z: gravityImpulse.z },
          true
        );
        
        // For non-spheres, align with gravity
        if (!obj.isSphere) {
          const worldUp = gravityDir.clone().negate();
          const objQuat = obj.mesh.quaternion;
          const objUp = new THREE.Vector3(0, 1, 0).applyQuaternion(objQuat);
          const alignmentTorque = new THREE.Vector3().crossVectors(objUp, worldUp);
          
          if (alignmentTorque.lengthSq() > 0.01) {
            const strength = 0.1 * objUp.angleTo(worldUp);
            alignmentTorque.normalize().multiplyScalar(strength);
            
            obj.body.applyTorqueImpulse(
              { x: alignmentTorque.x, y: alignmentTorque.y, z: alignmentTorque.z },
              true
            );
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
</script>

<style scoped>
  :global(html), :global(body) {
    width: 100%;
    height: 100vh;
    margin: 0;
  }
  canvas {
    width: 100%;
    height: 100%;
  }
</style>
