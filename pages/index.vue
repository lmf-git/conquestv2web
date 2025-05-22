<template>
  <canvas ref="canvasRef"></canvas>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import RAPIER from "@dimforge/rapier3d-compat";

const canvasRef = ref(null);

let scene, camera, renderer, controls;
let terrain, playerMesh, playerCollider;

let world, playerBody;

let fixedBoxes = [];
let dynamicObjects = [];

const playerState = {
  velocity: new THREE.Vector3(),
  direction: new THREE.Vector3(),
  onGround: false,
  falling: false, // Add falling state property
  jump: false,
  moveForward: false,
  moveBackward: false,
  moveLeft: false,
  moveRight: false,

  facingDirection: new THREE.Vector3(0, 0, -1),

  turnLeft: false,
  turnRight: false,
  
  onFixedObject: false, // Initialize here rather than in update function
};

const GRAVITY_CENTER = new THREE.Vector3(0, 0, 0);
const GRAVITY_STRENGTH = 9.8;
const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.4;
const MOVE_SPEED = 5;
const JUMP_FORCE = 18;
const PLANET_RADIUS = 50;
const TERRAIN_HEIGHT_SCALE = 50;
const TURN_SPEED = 2;
const NUM_DYNAMIC_OBJECTS = 10;
const DYNAMIC_OBJECT_SIZE = 1;
const SPAWN_HEIGHT = 20; // Add this constant at the top level

function generateSphericalTerrain() {
  const geometry = new THREE.IcosahedronGeometry(PLANET_RADIUS, 4);

  const positionAttribute = geometry.attributes.position;

  for (let i = 0; i < positionAttribute.count; i++) {
    const vertex = new THREE.Vector3();
    vertex.fromBufferAttribute(positionAttribute, i);

    const direction = vertex.clone().normalize();

    const spherical = new THREE.Spherical().setFromVector3(direction);

    const noiseFreq = 0.5;
    let noise = 0;

    noise +=
      Math.sin(spherical.phi * 4.5 * noiseFreq) *
      Math.cos(spherical.theta * 3.2 * noiseFreq) *
      0.5;
    noise +=
      Math.sin(spherical.phi * 9.1 * noiseFreq) *
      Math.cos(spherical.theta * 7.7 * noiseFreq) *
      0.25;
    noise +=
      Math.sin(spherical.phi * 18.3 * noiseFreq) *
      Math.cos(spherical.theta * 14.2 * noiseFreq) *
      0.125;

    const scaledNoise = (noise + 1) * 0.5 * TERRAIN_HEIGHT_SCALE;
    vertex.add(direction.multiplyScalar(scaledNoise));

    positionAttribute.setXYZ(i, vertex.x, vertex.y, vertex.z);
  }

  positionAttribute.needsUpdate = true;
  geometry.computeVertexNormals();

  return geometry;
}

function createTrimeshCollider(geometry) {
  const positionAttribute = geometry.attributes.position;

  const vertices = new Float32Array(positionAttribute.count * 3);

  for (let i = 0; i < positionAttribute.count; i++) {
    vertices[i * 3] = positionAttribute.getX(i);
    vertices[i * 3 + 1] = positionAttribute.getY(i);
    vertices[i * 3 + 2] = positionAttribute.getZ(i);
  }

  let indices;
  if (geometry.index) {
    const indexAttribute = geometry.index;
    indices = new Uint32Array(indexAttribute.count);

    for (let i = 0; i < indexAttribute.count; i++) {
      indices[i] = indexAttribute.getX(i);
    }
  } else {
    indices = new Uint32Array(positionAttribute.count);
    for (let i = 0; i < positionAttribute.count; i++) {
      indices[i] = i;
    }
  }

  return RAPIER.ColliderDesc.trimesh(vertices, indices);
}

function createFixedCollidersOnTerrain() {
  const MAX_ATTEMPTS = 50;

  const NUM_TERRAIN_COLLIDERS = 15;

  const MIN_SEPARATION = 5;

  const SIZE_RANGE = { min: 1, max: 3 };

  const SHAPES = ["box", "cylinder", "sphere"];

  const placedPositions = [];

  for (let i = 0; i < NUM_TERRAIN_COLLIDERS; i++) {
    let validSpot = false;
    let attempts = 0;
    let position, normal;

    while (!validSpot && attempts < MAX_ATTEMPTS) {
      const phi = Math.PI * Math.random();
      const theta = Math.PI * 2 * Math.random();

      const x = Math.sin(phi) * Math.cos(theta);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(theta);

      const dir = new THREE.Vector3(x, y, z).normalize();

      const raycaster = new THREE.Raycaster();

      const rayStart = dir
        .clone()
        .multiplyScalar(PLANET_RADIUS + TERRAIN_HEIGHT_SCALE * 2);

      const rayDir = GRAVITY_CENTER.clone().sub(rayStart).normalize();

      raycaster.set(rayStart, rayDir);
      const intersects = raycaster.intersectObject(terrain);

      if (intersects.length > 0) {
        position = intersects[0].point;

        normal = intersects[0].face.normal.clone();
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(
          terrain.matrixWorld
        );
        normal.applyMatrix3(normalMatrix).normalize();

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

    if (validSpot) {
      placedPositions.push(position.clone());

      const size =
        SIZE_RANGE.min + Math.random() * (SIZE_RANGE.max - SIZE_RANGE.min);

      const shapeType = SHAPES[Math.floor(Math.random() * SHAPES.length)];

      let collider;

      const up = position.clone().sub(GRAVITY_CENTER).normalize();

      switch (shapeType) {
        case "box":
          const width = size;
          const height = size * 0.5;
          const depth = size * (0.5 + Math.random() * 0.5);

          collider = createFixedColliderOnSurface(
            position,
            normal,
            new THREE.Vector3(width, height, depth),
            0x8855aa,
            shapeType
          );
          break;

        case "cylinder":
          collider = createFixedColliderOnSurface(
            position,
            normal,
            new THREE.Vector3(size * 0.5, size, size * 0.5),
            0x55aa88,
            shapeType
          );
          break;

        case "sphere":
          collider = createFixedColliderOnSurface(
            position,
            normal,
            new THREE.Vector3(size, size, size),
            0xaa5588,
            shapeType
          );
          break;
      }

      if (collider) {
        fixedBoxes.push(collider);
      }
    }
  }
}

function createFixedColliderOnSurface(
  position,
  normal,
  size,
  color,
  shape = "box"
) {
  const gravityDir = position.clone().sub(GRAVITY_CENTER).normalize();
  const worldUp = gravityDir.clone().negate();

  // Use the normal directly without blending with gravity
  // const blendedNormal = normal.clone().add(worldUp).normalize();
  const useNormal = normal.clone();

  let orientQuaternion;

  const worldX = new THREE.Vector3(1, 0, 0);
  const right = worldX.clone().projectOnPlane(useNormal).normalize();
  if (right.lengthSq() < 0.01) {
    right.set(0, 0, 1).projectOnPlane(useNormal).normalize();
  }
  const forward = new THREE.Vector3()
    .crossVectors(right, useNormal)
    .normalize();
  const rotMatrix = new THREE.Matrix4().makeBasis(
    right,
    useNormal,
    forward
  );
  orientQuaternion = new THREE.Quaternion().setFromRotationMatrix(rotMatrix);

  let colliderDesc;
  let geometry;

  switch (shape) {
    case "box":
      colliderDesc = RAPIER.ColliderDesc.cuboid(
        size.x / 2,
        size.y / 2,
        size.z / 2
      );
      geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
      break;

    case "cylinder":
      colliderDesc = RAPIER.ColliderDesc.cylinder(size.y / 2, size.x);
      geometry = new THREE.CylinderGeometry(size.x, size.x, size.y, 16);
      break;

    case "sphere":
      colliderDesc = RAPIER.ColliderDesc.ball(size.x / 2);
      geometry = new THREE.SphereGeometry(size.x / 2, 16, 16);
      break;

    default:
      colliderDesc = RAPIER.ColliderDesc.cuboid(
        size.x / 2,
        size.y / 2,
        size.z / 2
      );
      geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
  }

  colliderDesc.setCollisionGroups(0x00010001);

  const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed()
    .setTranslation(position.x, position.y, position.z)
    .setRotation({
      x: orientQuaternion.x,
      y: orientQuaternion.y,
      z: orientQuaternion.z,
      w: orientQuaternion.w,
    });

  const body = world.createRigidBody(rigidBodyDesc);
  const collider = world.createCollider(colliderDesc, body);

  const material = new THREE.MeshStandardMaterial({
    color: color,
    roughness: 0.6,
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
    mesh: mesh,
  };
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onKeyDown(event) {
  switch (event.code) {
    case "KeyW":
      playerState.moveForward = true;
      break;
    case "KeyS":
      playerState.moveBackward = true;
      break;
    case "KeyA":
      playerState.moveLeft = true;
      break;
    case "KeyD":
      playerState.moveRight = true;
      break;
    case "Space":
      playerState.jump = true;
      break;
    case "KeyQ":
      playerState.turnLeft = true;
      break;
    case "KeyE":
      playerState.turnRight = true;
      break;
  }
}

function onKeyUp(event) {
  switch (event.code) {
    case "KeyW":
      playerState.moveForward = false;
      break;
    case "KeyS":
      playerState.moveBackward = false;
      break;
    case "KeyA":
      playerState.moveLeft = false;
      break;
    case "KeyD":
      playerState.moveRight = false;
      break;
    case "KeyQ":
      playerState.turnLeft = false;
      break;
    case "KeyE":
      playerState.turnRight = false;
      break;
    case "Space":
      playerState.jump = false;
      break;
  }
}

function handlePlayerCollisions() {
  if (!playerBody || !playerCollider) return;

  const playerPosition = new THREE.Vector3(
    playerBody.translation().x,
    playerBody.translation().y,
    playerBody.translation().z
  );

  const gravityUp = playerPosition.clone().sub(GRAVITY_CENTER).normalize();

  let hasCollision = false;
  let bestCollisionNormal = null;
  let bestPenetrationDepth = 0;
  let collisionWithFixed = false;


  // Enhanced raycasting as fallback to catch more collisions
  if (!hasCollision) {
    // Perform more comprehensive raycast collision detection
    // Cast rays in more directions, including the movement direction
    const directionNormalized = playerState.direction.clone().normalize();

    const capsuleBottomOffset = PLAYER_HEIGHT / 2;
    const capsuleCenterOffset = 0; // Added to check the center of the capsule too

    // Positions to raycast from - include more points around capsule
    const rayStartPositions = [
      // Bottom of capsule
      playerPosition
        .clone()
        .add(
          gravityUp.clone().negate().multiplyScalar(capsuleBottomOffset - 0.05)
        ),
      // Middle of capsule
      playerPosition.clone().add(gravityUp.clone().negate().multiplyScalar(capsuleCenterOffset)),
      // Top of capsule
      playerPosition.clone().add(gravityUp.clone().multiplyScalar(capsuleBottomOffset - 0.05)),
    ];

    const forwardDir = new THREE.Vector3(1, 0, 0).cross(gravityUp).normalize();
    const rightDir = gravityUp.clone().cross(forwardDir).normalize();

    // Generate rays in a more comprehensive pattern
    const rayPositions = [];

    for (const startPos of rayStartPositions) {
      // Center ray
      rayPositions.push(startPos.clone());

      // Rays around the capsule
      const radius = PLAYER_RADIUS * 0.9; // Slightly inside the capsule
      const rayDirections = [
        forwardDir.clone().multiplyScalar(radius),
        rightDir.clone().multiplyScalar(radius),
        forwardDir.clone().negate().multiplyScalar(radius),
        rightDir.clone().negate().multiplyScalar(radius),
        // Add diagonal rays
        forwardDir
          .clone()
          .add(rightDir)
          .normalize()
          .multiplyScalar(radius),
        forwardDir
          .clone()
          .add(rightDir.clone().negate())
          .normalize()
          .multiplyScalar(radius),
        forwardDir
          .clone()
          .negate()
          .add(rightDir)
          .normalize()
          .multiplyScalar(radius),
        forwardDir
          .clone()
          .negate()
          .add(rightDir.clone().negate())
          .normalize()
          .multiplyScalar(radius),
      ];

      // Add movement direction ray - important to prevent tunneling
      if (playerState.direction.lengthSq() > 0) {
        rayDirections.push(directionNormalized.clone().multiplyScalar(radius));
      }

      for (const dir of rayDirections) {
        rayPositions.push(startPos.clone().add(dir));
      }
    }

    let closestHitDistance = Infinity;
    const objectMeshes = fixedBoxes.map((box) => box.mesh);

    // Cast rays in all directions, not just gravity direction
    const rayDirections = [
      gravityUp.clone().negate(), // Down
      // Using direction of movement for rays to prevent tunneling
      directionNormalized.clone().negate(), // Opposite to movement
      directionNormalized.clone(), // Direction of movement
      forwardDir,
      forwardDir.clone().negate(),
      rightDir,
      rightDir.clone().negate(),
    ];

    for (const rayPos of rayPositions) {
      for (const rayDir of rayDirections) {
        const raycaster = new THREE.Raycaster();
        raycaster.set(rayPos, rayDir);
        raycaster.far = PLAYER_RADIUS * 1.2; // Check slightly beyond the capsule radius

        const intersects = raycaster.intersectObjects(objectMeshes);

        if (intersects.length > 0) {
          const hit = intersects[0];
          const hitBox = fixedBoxes.find((box) => box.mesh === hit.object);
          if (!hitBox) continue;

          // Fix: Define hitNormal variable from the hit face normal
          const hitNormal = hit.face.normal.clone();
          const normalMatrix = new THREE.Matrix3().getNormalMatrix(
            hit.object.matrixWorld
          );
          const worldNormal = hitNormal.applyMatrix3(normalMatrix).normalize();

          if (hit.distance < closestHitDistance) {
            closestHitDistance = hit.distance;
            bestCollisionNormal = worldNormal;
            bestPenetrationDepth = PLAYER_RADIUS * 1.1 - hit.distance;
            hasCollision = true;
            collisionWithFixed = true;
          }
        }
      }
    }
  }

  // Handle collision resolution with improved logic
  if (hasCollision && bestCollisionNormal && bestPenetrationDepth > 0) {
    // Remove storing contact normal
    const dotWithUp = bestCollisionNormal.dot(gravityUp);
    const isGroundContact = dotWithUp > 0.5;

    // Only use normal for current physics calculations, don't store it
    if (isGroundContact) {
      playerState.onGround = true;
      playerState.falling = false;
      playerState.onFixedObject = collisionWithFixed;

      // Zero out downward velocity
      const downwardVelocity = gravityUp.clone().negate().multiplyScalar(
        Math.max(0, -playerState.velocity.dot(gravityUp))
      );

      if (downwardVelocity.lengthSq() > 0) {
        playerState.velocity.sub(downwardVelocity);
      }

      // When not moving on fixed objects, eliminate ALL velocity
      if (collisionWithFixed && !playerState.moveForward && !playerState.moveBackward && 
          !playerState.moveLeft && !playerState.moveRight) {
        playerState.velocity.set(0, 0, 0);
      }
    } else {
      // For side collisions, we don't want to change orientation
      // Just deflect the velocity and push out
    }

    // More aggressive push out of collision with objects
    const pushMultiplier = collisionWithFixed ? 1.2 : 1.05;
    playerPosition.add(bestCollisionNormal.clone().multiplyScalar(bestPenetrationDepth * pushMultiplier));

    // More precise velocity reflection
    const normalVelocity = bestCollisionNormal.clone().multiplyScalar(
      playerState.velocity.dot(bestCollisionNormal)
    );

    if (normalVelocity.dot(bestCollisionNormal) < 0) {
      // Reflect velocity off the surface with higher friction for fixed objects
      const tangentialVelocity = playerState.velocity.clone().sub(normalVelocity);
      const frictionFactor = isGroundContact ? 
        (collisionWithFixed ? 0.4 : 0.7) : 0.95;
      tangentialVelocity.multiplyScalar(frictionFactor);
      playerState.velocity.copy(tangentialVelocity);
      
      // Ensure velocity is strictly parallel to the surface for fixed objects
      if (collisionWithFixed) {
        playerState.velocity = playerState.velocity.projectOnPlane(bestCollisionNormal);
      }
    }
  }

  // Update player body position with more precision
  playerBody.setTranslation({
    x: playerPosition.x,
    y: playerPosition.y,
    z: playerPosition.z,
  }, true);

  // Update orientation ONLY if we need to reorient (ground contact)
  if (hasCollision && bestCollisionNormal && 
      bestCollisionNormal.dot(gravityUp) > 0.5) {
    updatePlayerPositionAndOrientation(
      playerPosition.clone(),
      bestCollisionNormal, // Pass directly instead of using stored value
      true,
      gravityUp
    );
  }
}

function updatePlayerPositionAndOrientation(
  position,
  surfaceNormal,
  onSurface,
  gravityUp
) {
  if (!position) return;
  if (!surfaceNormal) surfaceNormal = new THREE.Vector3(0, 1, 0);
  if (!gravityUp) gravityUp = position.clone().sub(GRAVITY_CENTER).normalize();

  let orientationQuaternion;
  const oldFacingDir = playerState.facingDirection.clone();

  if (onSurface) {
    // Create orientation aligned with surface
    const blendedUp = surfaceNormal.clone();
    const worldUp = new THREE.Vector3(0, 1, 0);
    let right = new THREE.Vector3().crossVectors(worldUp, blendedUp);

    if (right.lengthSq() < 0.01) {
      right = new THREE.Vector3(1, 0, 0);
    }
    right.normalize();

    const forward = new THREE.Vector3().crossVectors(right, blendedUp).normalize();
    const orientationMatrix = new THREE.Matrix4().makeBasis(right, blendedUp, forward);
    orientationQuaternion = new THREE.Quaternion().setFromRotationMatrix(orientationMatrix);

    // Keep facing direction projected on the surface
    playerState.facingDirection = oldFacingDir.clone()
      .projectOnPlane(blendedUp)
      .normalize();
  } else {
    // Create orientation aligned with gravity
    const worldUp = new THREE.Vector3(0, 1, 0);
    let right = new THREE.Vector3().crossVectors(worldUp, gravityUp);

    if (right.lengthSq() < 0.01) {
      right = new THREE.Vector3(1, 0, 0);
    }
    right.normalize();
    
    const forward = new THREE.Vector3().crossVectors(right, gravityUp).normalize();
    const orientationMatrix = new THREE.Matrix4().makeBasis(right, gravityUp, forward);
    orientationQuaternion = new THREE.Quaternion().setFromRotationMatrix(orientationMatrix);
  }

  // Update visual mesh and physics body once
  playerMesh.position.copy(position);
  playerMesh.quaternion.copy(orientationQuaternion);

  if (playerBody && !isNaN(orientationQuaternion.x) && !isNaN(orientationQuaternion.y) &&
      !isNaN(orientationQuaternion.z) && !isNaN(orientationQuaternion.w)) {
    playerBody.setTranslation({
      x: position.x,
      y: position.y,
      z: position.z,
    }, true);
    
    playerBody.setRotation({
      x: orientationQuaternion.x,
      y: orientationQuaternion.y,
      z: orientationQuaternion.z,
      w: orientationQuaternion.w,
    }, true);
  }
}

function updatePlayer(deltaTime) {
  if (!playerBody) return;
  
  // Save previous fixed object state to detect transitions
  const wasOnFixedObject = playerState.onFixedObject;
  
  // Reset fixed object status at the beginning of each frame
  playerState.onFixedObject = false;

  // Create this array at the function level so it's available throughout the function
  let hitNormals = [];
  let closestHitDistance = Infinity;
  
  const position = new THREE.Vector3(
    playerBody.translation().x,
    playerBody.translation().y,
    playerBody.translation().z
  );

  // Save previous position for tunneling prevention
  const previousPosition = position.clone();

  const gravityDir = GRAVITY_CENTER.clone().sub(position).normalize();
  const up = gravityDir.clone().negate();

  let onSurface = false;
  const wasJumping = playerState.jump && playerState.onGround;

  if (wasJumping) {
    playerState.onGround = false;
  }

  // Process collisions with fixed objects BEFORE ground checks
  // This ensures fixed object contacts take precedence
  handlePlayerCollisions();

  // If we were on a fixed object last frame but not this frame, 
  // we need to immediately start falling unless we have terrain contact
  if (wasOnFixedObject && !playerState.onFixedObject) {
    playerState.onGround = false; // Reset ground state when leaving a fixed object
    playerState.falling = true;   // Start falling immediately
  }

  // Skip terrain ground checking if we're already on a fixed object
  // This prevents normal conflicts between terrain and fixed objects
  if (!playerState.onFixedObject && !wasJumping) {
    // Simplify to use just one ray for ground detection
    hitNormals = [];
    closestHitDistance = Infinity;

    const capsuleBottomOffset = PLAYER_HEIGHT / 2;
    // Use a single ray cast from the feet position
    const feetPosition = position.clone().add(
      gravityDir.clone().multiplyScalar(capsuleBottomOffset - 0.1)
    );
    const groundCheckDistance = PLAYER_RADIUS + 0.8;

    // Cast a single ray directly down
    const raycaster = new THREE.Raycaster();
    raycaster.set(feetPosition, gravityDir);
    raycaster.far = groundCheckDistance * 2;
    const intersects = raycaster.intersectObject(terrain);

    if (intersects.length > 0) {
      const normal = intersects[0].face.normal.clone();
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(
        terrain.matrixWorld
      );
      normal.applyMatrix3(normalMatrix).normalize();

      hitNormals.push(normal);
      closestHitDistance = intersects[0].distance;

      // Determine if we're on ground based on the single ray
      if (closestHitDistance < groundCheckDistance) {
        onSurface = true;
        playerState.onGround = true;
        playerState.falling = false;

        // Project velocity onto surface
        const normalVelocity = playerState.velocity.clone().projectOnVector(normal);
        if (normalVelocity.dot(normal) < 0) {
          playerState.velocity.sub(normalVelocity);
        }
      } else {
        playerState.onGround = false;
        playerState.falling = playerState.velocity.dot(gravityDir) > 0;
      }
    } else {
      // No ray hit - we're not on ground
      playerState.onGround = false;
      playerState.falling = true;
    }

    // Determine surface normal from the hit normal or use up vector
    let surfaceNormal = up.clone();
    if (hitNormals.length > 0) {
      surfaceNormal = hitNormals[0].clone(); // Just use the one normal we got
    } else if (playerState.onGround) {
      // Use gravity-aligned normal if we consider ourselves grounded but don't have a hit
      surfaceNormal = up.clone();
      onSurface = true;
      playerState.falling = false;
    } else {
      // Check if we're inside the planet and push out if needed
      const distToCenter = position.distanceTo(GRAVITY_CENTER);
      const minDistance = PLANET_RADIUS - TERRAIN_HEIGHT_SCALE * 0.5 + PLAYER_HEIGHT / 2;

      if (distToCenter < minDistance) {
        position.copy(up.clone().multiplyScalar(minDistance));
        playerState.onGround = true;
        playerState.falling = false;
        playerState.velocity.projectOnPlane(up);
      } else {
        playerState.onGround = false;
        playerState.falling = true;
      }
    }

    // Don't store surface normal anymore
  }

  // Use directly calculated normal for this frame
  // If we're on a fixed object, this will be calculated later during collision detection
  const surfaceNormal = up.clone();

  // Apply gravity if not on ground
  if (!playerState.onGround) {
    playerState.velocity.add(gravityDir.clone().multiplyScalar(GRAVITY_STRENGTH * deltaTime));
    playerState.falling = true; // Ensure falling flag is set whenever not on ground
  }

  // Handle turning
  if (playerState.turnLeft || playerState.turnRight) {
    const turnDir = playerState.turnLeft ? 1 : -1;
    const upAxis = position.clone().sub(GRAVITY_CENTER).normalize();
    const rotationMatrix = new THREE.Matrix4().makeRotationAxis(
      upAxis,
      TURN_SPEED * deltaTime * turnDir
    );
    playerState.facingDirection.applyMatrix4(rotationMatrix);
    playerState.facingDirection.normalize();
  }

  // Calculate movement direction based on inputs
  // Use the player's facing direction for forward/backward movement
  const surfaceAlignedFacing = playerState.facingDirection.clone()
    .projectOnPlane(surfaceNormal)
    .normalize();

  const right = new THREE.Vector3()
    .crossVectors(surfaceNormal, surfaceAlignedFacing)
    .normalize();

  playerState.direction.set(0, 0, 0);
  
  // Keep track of the movement strength to make backward movement as strong as forward
  let movementStrength = 0;
  
  if (playerState.moveForward) {
    playerState.direction.add(surfaceAlignedFacing);
    movementStrength++;
  }
  if (playerState.moveBackward) {
    playerState.direction.sub(surfaceAlignedFacing);
    movementStrength++;
  }
  if (playerState.moveRight) {
    playerState.direction.add(right);
    movementStrength++;
  }
  if (playerState.moveLeft) {
    playerState.direction.sub(right);
    movementStrength++;
  }

  // Apply movement with consistent strength regardless of direction
  const isMoving = movementStrength > 0;
  if (isMoving) {
    playerState.direction.normalize();
    
    const slopeAngle = Math.acos(Math.min(1, Math.abs(surfaceNormal.dot(up))));
    
    // Remove slope checking and always allow full movement speed
    let moveSpeedMultiplier = 1.0;

    // Apply consistent movement speed regardless of direction
    playerState.direction.multiplyScalar(MOVE_SPEED * moveSpeedMultiplier * deltaTime);

    // Add movement to position - ensure it's projected on the surface
    if (playerState.onGround) {
      // Use the same surface normal for movement projection in all directions
      const movementSurfaceNormal = playerState.onFixedObject && playerState.surfaceNormal 
        ? playerState.surfaceNormal 
        : (playerState.lastContactNormal || surfaceNormal);
      
      const projectedDirection = playerState.direction.clone().projectOnPlane(movementSurfaceNormal);
      position.add(projectedDirection);
    } else {
      position.add(playerState.direction);
    }
  }

  // Handle jumping
  if (wasJumping) {
    const jumpDirection = new THREE.Vector3();
    
    // Add some forward momentum to the jump
    jumpDirection.add(surfaceAlignedFacing.clone().multiplyScalar(1.5));
    
    // Add upward force
    jumpDirection.add(surfaceNormal.clone().multiplyScalar(3.0));
    
    // Normalize and scale by jump force
    jumpDirection.normalize().multiplyScalar(JUMP_FORCE);
    
    // Add a little lift to avoid getting stuck
    position.add(surfaceNormal.clone().multiplyScalar(0.3));
    
    // Set velocity to jump direction
    playerState.velocity = jumpDirection.clone();
    
    playerState.onGround = false;
    playerState.jump = false;
  }

  // Apply friction when on ground
  if (playerState.onGround) {
    const isMoving = playerState.moveForward || playerState.moveBackward || 
                    playerState.moveLeft || playerState.moveRight;
                    
    if (!isMoving) {
      // Higher friction when not moving - even higher for fixed objects
      const frictionMultiplier = playerState.onFixedObject ? 0.0001 : 0.05;
      playerState.velocity.multiplyScalar(frictionMultiplier);
      
      // Lower threshold for fixed objects to stop completely
      const velocityThreshold = playerState.onFixedObject ? 0.0001 : 0.03;
      if (playerState.velocity.lengthSq() < velocityThreshold) {
        playerState.velocity.set(0, 0, 0);
      }
    } else if (playerState.onFixedObject) {
      // Special case: when moving on fixed objects, maintain a clean
      // velocity that's exactly what we want
      playerState.velocity.copy(playerState.direction);
    } else {
      // Normal friction when moving on terrain
      playerState.velocity.multiplyScalar(0.8);
    }
    
    // Always project velocity onto current surface normal
    // Use a more exact projection for fixed objects
    if (playerState.onFixedObject && playerState.surfaceNormal) {
      playerState.velocity = playerState.velocity.projectOnPlane(playerState.surfaceNormal);
    } else {
      playerState.velocity = playerState.velocity.projectOnPlane(surfaceNormal);
    }
  }

  // Apply velocity to position
  position.add(playerState.velocity.clone().multiplyScalar(deltaTime));

  // Add tunneling prevention - must come BEFORE updating position and orientation
  if (playerState.direction.lengthSq() > 0) {
    const movement = position.clone().sub(previousPosition);
    if (movement.lengthSq() > 0) {
      // Check if we'd tunnel through any fixed objects
      const ray = new THREE.Raycaster();
      ray.set(previousPosition, movement.clone().normalize());
      ray.far = movement.length() * 1.1; // Check slightly beyond movement distance
      
      const fixedMeshes = fixedBoxes.map(box => box.mesh);
      const hits = ray.intersectObjects(fixedMeshes);
      
      if (hits.length > 0) {
        // We might be tunneling - use a more conservative position update
        const hit = hits[0];
        if (hit.distance < movement.length()) {
          // Stop just before the collision point
          const safeDistance = Math.max(0, hit.distance - 0.05);
          const safeMovement = movement.clone().normalize().multiplyScalar(safeDistance);
          position.copy(previousPosition).add(safeMovement);
          
          // Update velocity to stop in this direction
          const hitNormal = hit.face.normal.clone();
          const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
          const worldNormal = hitNormal.applyMatrix3(normalMatrix).normalize();
          
          playerState.velocity = playerState.velocity.projectOnPlane(worldNormal);
        }
      }
    }
  }

  // Update player position and orientation
  updatePlayerPositionAndOrientation(
    position,
    surfaceNormal || up.clone(),
    onSurface && !wasJumping,
    up
  );

  // Handle collisions AFTER updating position and orientation 
  // to ensure proper resolution with updated alignment
  handlePlayerCollisions();
}

function createSpawnPlatform() {
  const spawnPlatformSize = new THREE.Vector3(10, 1, 10); // Width, height, depth
  const spawnPosition = new THREE.Vector3(
    0,
    PLANET_RADIUS + TERRAIN_HEIGHT_SCALE + SPAWN_HEIGHT - 5, // Fixed: using SPAWN_HEIGHT instead of spawnHeight
    0
  );
  
  // Calculate direction to center for orientation
  const gravityDir = spawnPosition.clone().sub(GRAVITY_CENTER).normalize();
  const worldUp = gravityDir.clone().negate();
  
  // Create the platform with a distinct color
  const platformObj = createFixedColliderOnSurface(
    spawnPosition,
    worldUp,
    spawnPlatformSize,
    0x2299ff, // Blue color
    "box"
  );
  
  if (platformObj) {
    fixedBoxes.push(platformObj);
    console.log("Created spawn platform");
    
    // Add a ramp (stair-like structure) from the platform to the ground
    
    // Calculate the position of the ramp - put it at the north edge of the platform
    const northVector = new THREE.Vector3(0, 0, -1); // Assuming Z- is north
    const worldX = new THREE.Vector3(1, 0, 0);
    const right = worldX.clone().projectOnPlane(worldUp).normalize();
    const forward = new THREE.Vector3().crossVectors(right, worldUp).normalize();
    
    // Move 5 units along the forward vector (half of platform size)
    const rampStartPos = spawnPosition.clone().add(forward.clone().multiplyScalar(5));
    
    // Calculate length and slope of the ramp
    const rampLength = 15; // Length of the ramp
    const rampHeight = 5;  // Height difference from top to bottom
    const rampWidth = 4;   // Width of the ramp
    
    // Move down along gravity half the ramp height to center the ramp
    rampStartPos.add(gravityDir.clone().multiplyScalar(rampHeight/2));
    
    // Move forward half the ramp length to center the ramp
    rampStartPos.add(forward.clone().multiplyScalar(rampLength/2));
    
    // Create a rotated box for the ramp
    // Calculate the angle needed to tilt the ramp in the gravitational field
    const tiltAngle = Math.atan2(rampHeight, rampLength);
    
    // Build a rotation quaternion to tilt the ramp around the right axis
    const rampQuaternion = new THREE.Quaternion().setFromAxisAngle(right, tiltAngle);
    
    // Create the ramp object
    const rampSize = new THREE.Vector3(rampWidth, 0.5, rampLength); // Width, height, length
    
    // Create a custom fixed collider for the ramp
    const rampBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(rampStartPos.x, rampStartPos.y, rampStartPos.z)
      .setRotation({
        x: rampQuaternion.x,
        y: rampQuaternion.y,
        z: rampQuaternion.z,
        w: rampQuaternion.w,
      });
    
    const rampBody = world.createRigidBody(rampBodyDesc);
    
    const rampColliderDesc = RAPIER.ColliderDesc.cuboid(
      rampSize.x / 2,
      rampSize.y / 2,
      rampSize.z / 2
    );
    rampColliderDesc.setCollisionGroups(0x00010001);
    
    const rampCollider = world.createCollider(rampColliderDesc, rampBody);
    
    // Create visual mesh for the ramp
    const rampGeometry = new THREE.BoxGeometry(rampSize.x, rampSize.y, rampSize.z);
    const rampMaterial = new THREE.MeshStandardMaterial({
      color: 0x1188ff, // Slightly different blue than the platform
      roughness: 0.6,
    });
    
    const rampMesh = new THREE.Mesh(rampGeometry, rampMaterial);
    rampMesh.position.copy(rampStartPos);
    rampMesh.quaternion.copy(rampQuaternion);
    rampMesh.castShadow = true;
    rampMesh.receiveShadow = true;
    scene.add(rampMesh);
    
    // Add the ramp to fixed boxes for collision
    fixedBoxes.push({
      body: rampBody,
      collider: rampCollider,
      mesh: rampMesh,
    });
    
    console.log("Created ramp for spawn platform");
  }
}

function updateDynamicObjects() {
  for (const obj of dynamicObjects) {
    const position = new THREE.Vector3(
      obj.body.translation().x,
      obj.body.translation().y,
      obj.body.translation().z
    );

    const gravityDir = GRAVITY_CENTER.clone().sub(position).normalize();

    if (obj.body.bodyType() === RAPIER.RigidBodyType.Dynamic) {
      const mass = obj.isSphere ? 1 : 2;

      const gravityImpulse = gravityDir
        .clone()
        .multiplyScalar(GRAVITY_STRENGTH * mass * 0.016);

      obj.body.applyImpulse(
        { x: gravityImpulse.x, y: gravityImpulse.y, z: gravityImpulse.z },
        true
      );

      if (!obj.isSphere) {
        const worldUp = gravityDir.clone().negate();
        const objQuat = obj.mesh.quaternion;
        const objUp = new THREE.Vector3(0, 1, 0).applyQuaternion(objQuat);
        const alignmentTorque = new THREE.Vector3().crossVectors(
          objUp,
          worldUp
        );

        if (alignmentTorque.lengthSq() > 0.01) {
          const strength = 0.1 * objUp.angleTo(worldUp);
          alignmentTorque.normalize().multiplyScalar(strength);

          obj.body.applyTorqueImpulse(
            {
              x: alignmentTorque.x,
              y: alignmentTorque.y,
              z: alignmentTorque.z,
            },
            true
          );
        }
      }
    }

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

// Add the missing animate function
function animate() {
  const deltaTime = 1 / 60;

  updatePlayer(deltaTime);
  updateDynamicObjects();

  world.step();

  renderer.render(scene, camera);

  requestAnimationFrame(animate);
}

onMounted(async () => {
  await RAPIER.init();

  world = new RAPIER.World({ x: 0, y: 0, z: 0 });

  const terrainGeometry = generateSphericalTerrain();
  const terrainColliderDesc = createTrimeshCollider(terrainGeometry);

  world.createCollider(terrainColliderDesc);

  // Initialize scene and renderer first
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);

  camera = new THREE.PerspectiveCamera(
    60, // Slightly wider field of view
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  
  // Define the spawn position for reference
  const spawnPosition = new THREE.Vector3(
    0,
    PLANET_RADIUS + TERRAIN_HEIGHT_SCALE + SPAWN_HEIGHT,
    0
  );
  
  // Position camera to look at the spawn point from a distance
  camera.position.set(
    spawnPosition.x + 30, 
    spawnPosition.y + 20, 
    spawnPosition.z + 30
  );

  renderer = new THREE.WebGLRenderer({
    canvas: canvasRef.value,
    antialias: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  controls = new OrbitControls(camera, renderer.domElement);
  // Set orbit controls to target the spawn position
  controls.target.copy(spawnPosition);
  controls.update();

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(1, 1, 1).normalize().multiplyScalar(100);
  directionalLight.castShadow = true;

  directionalLight.shadow.mapSize.width = 2048;
  directionalLight.shadow.mapSize.height = 2048;
  directionalLight.shadow.camera.near = 0.5;
  directionalLight.shadow.camera.far = 500;
  directionalLight.shadow.camera.left = -100;
  directionalLight.shadow.camera.right = 100;
  directionalLight.shadow.camera.top = 100;
  directionalLight.shadow.camera.bottom = -100;

  scene.add(directionalLight);

  renderer.shadowMap.enabled = true;

  const terrainMaterial = new THREE.MeshStandardMaterial({
    color: 0x3a7e4a,
    flatShading: false,
    wireframe: false,
  });
  terrain = new THREE.Mesh(terrainGeometry, terrainMaterial);
  terrain.castShadow = true;
  terrain.receiveShadow = true;
  scene.add(terrain);
  
  // Now create the spawn platform AFTER scene initialization
  createSpawnPlatform();
  
  // Then create the player
  const playerBodyDesc =
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
      0,
      PLANET_RADIUS + TERRAIN_HEIGHT_SCALE + PLAYER_HEIGHT / 2 + SPAWN_HEIGHT,
      0
    );
  playerBody = world.createRigidBody(playerBodyDesc);

  const playerColliderDesc = RAPIER.ColliderDesc.capsule(
    PLAYER_HEIGHT / 2 - PLAYER_RADIUS,
    PLAYER_RADIUS
  );

  playerColliderDesc.setCollisionGroups(0x00010001);

  playerCollider = world.createCollider(playerColliderDesc, playerBody);

  const capsuleGeometry = new THREE.CapsuleGeometry(
    PLAYER_RADIUS,
    PLAYER_HEIGHT - PLAYER_RADIUS * 2,
    8,
    16
  );
  const capsuleMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  playerMesh = new THREE.Mesh(capsuleGeometry, capsuleMaterial);
  playerMesh.castShadow = true;
  scene.add(playerMesh);

  window.addEventListener("resize", onWindowResize);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  createFixedCollidersOnTerrain();

  for (let i = 0; i < NUM_DYNAMIC_OBJECTS; i++) {
    const phi = Math.PI * (0.2 + 0.6 * Math.random());
    const theta = Math.PI * 2 * Math.random();

    const x = Math.sin(phi) * Math.cos(theta);
    const y = Math.cos(phi);
    const z = Math.sin(phi) * Math.sin(theta);

    const pos = new THREE.Vector3(x, y, z).normalize();

    const heightVariation = 10 + 20 * Math.random();
    const distance = PLANET_RADIUS + TERRAIN_HEIGHT_SCALE + heightVariation;
    pos.multiplyScalar(distance);

    const isSphere = Math.random() > 0.5;

    const objectSize = DYNAMIC_OBJECT_SIZE * (0.5 + Math.random());

    const dynamicObj = createDynamicObject(pos, objectSize, isSphere);
    dynamicObjects.push(dynamicObj);
  }

  animate();
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onWindowResize);
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);

  if (renderer) {
    renderer.dispose();
  }
});

function createDynamicObject(position, size, isSphere = false) {
  let colliderDesc;

  if (isSphere) {
    colliderDesc = RAPIER.ColliderDesc.ball(size / 2);
  } else {
    colliderDesc = RAPIER.ColliderDesc.cuboid(size / 2, size / 2, size / 2);
  }

  colliderDesc.setRestitution(0.4);
  colliderDesc.setFriction(0.8);
  colliderDesc.setDensity(1.0);

  const gravityDir = position.clone().sub(GRAVITY_CENTER).normalize();
  const worldUp = gravityDir.clone().negate();

  const worldX = new THREE.Vector3(1, 0, 0);
  const right = worldX.clone().projectOnPlane(worldUp).normalize();
  if (right.lengthSq() < 0.01) {
    right.set(0, 0, 1);
  }
  const forward = new THREE.Vector3().crossVectors(right, worldUp).normalize();
  const rotMatrix = new THREE.Matrix4().makeBasis(right, worldUp, forward);
  const orientation = new THREE.Quaternion().setFromRotationMatrix(rotMatrix);

  const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(position.x, position.y, position.z)
    .setRotation({
      x: orientation.x,
      y: orientation.y,
      z: orientation.z,
      w: orientation.w,
    })

    .setLinearDamping(0.2)
    .setAngularDamping(0.3);

  const dynamicBody = world.createRigidBody(rigidBodyDesc);
  const dynamicCollider = world.createCollider(colliderDesc, dynamicBody);

  let geometry;
  if (isSphere) {
    geometry = new THREE.SphereGeometry(size / 2, 16, 16);
  } else {
    geometry = new THREE.BoxGeometry(size, size, size);
  }

  const hue = Math.random();
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(hue, 0.7, 0.5),
    roughness: 0.5,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  return {
    body: dynamicBody,
    collider: dynamicCollider,
    mesh: mesh,
    isSphere: isSphere,
  };
}
</script>

<style scoped>
:global(html),
:global(body) {
  width: 100%;
  height: 100vh;
  margin: 0;
}
canvas {
  width: 100%;
  height: 100%;
}
</style>
