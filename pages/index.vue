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
  jump: false,
  moveForward: false,
  moveBackward: false,
  moveLeft: false,
  moveRight: false,

  facingDirection: new THREE.Vector3(0, 0, -1),

  turnLeft: false,
  turnRight: false,
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

  const blendedNormal = normal.clone().add(worldUp).normalize();

  let orientQuaternion;

  const worldX = new THREE.Vector3(1, 0, 0);
  const right = worldX.clone().projectOnPlane(blendedNormal).normalize();
  if (right.lengthSq() < 0.01) {
    right.set(0, 0, 1).projectOnPlane(blendedNormal).normalize();
  }
  const forward = new THREE.Vector3()
    .crossVectors(right, blendedNormal)
    .normalize();
  const rotMatrix = new THREE.Matrix4().makeBasis(
    right,
    blendedNormal,
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
  let isReorienting = false;

  // Check for collisions with fixed boxes
  for (const box of fixedBoxes) {
    if (!box.body || !box.collider) continue;

    const contact = world.contactPair(
      box.collider.handle,
      playerCollider.handle
    );

    if (
      contact &&
      typeof contact.hasAnyContact === "function" &&
      contact.hasAnyContact()
    ) {
      hasCollision = true;

      const manifolds = contact.manifolds();
      for (let i = 0; i < manifolds.length; i++) {
        const manifold = manifolds[i];
        const worldNormal = manifold.normal();
        const normal = new THREE.Vector3(
          worldNormal.x,
          worldNormal.y,
          worldNormal.z
        );
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

  // If no collision detected through physics system, use raycasting as fallback
  if (!hasCollision) {
    const capsuleBottomOffset = PLAYER_HEIGHT / 2;
    const feetPosition = playerPosition.clone().add(
      gravityUp.clone().negate().multiplyScalar(capsuleBottomOffset - 0.05)
    );

    const forwardDir = new THREE.Vector3(1, 0, 0).cross(gravityUp).normalize();
    const rightDir = gravityUp.clone().cross(forwardDir).normalize();
    
    const rayPositions = [
      feetPosition.clone(),
      feetPosition.clone().add(forwardDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7)),
      feetPosition.clone().add(rightDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7)),
      feetPosition.clone().sub(forwardDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7)),
      feetPosition.clone().sub(rightDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7)),
    ];

    let closestHitDistance = Infinity;
    const objectMeshes = fixedBoxes.map((box) => box.mesh);
    const gravDirNeg = gravityUp.clone().negate();

    for (let i = 0; i < rayPositions.length; i++) {
      const raycaster = new THREE.Raycaster();
      raycaster.set(rayPositions[i], gravDirNeg);

      const intersects = raycaster.intersectObjects(objectMeshes);

      if (intersects.length > 0) {
        const hit = intersects[0];
        const hitBox = fixedBoxes.find((box) => box.mesh === hit.object);
        if (!hitBox) continue;

        const normal = hit.face.normal.clone();
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(
          hit.object.matrixWorld
        );
        const worldNormal = normal.applyMatrix3(normalMatrix).normalize();

        if (hit.distance < closestHitDistance) {
          closestHitDistance = hit.distance;
          bestCollisionNormal = worldNormal;
          bestPenetrationDepth = PLAYER_RADIUS + 0.05 - hit.distance;
          hasCollision = true;
        }
      }
    }
  }

  // Handle collision resolution
  if (hasCollision && bestCollisionNormal && bestPenetrationDepth > 0) {
    playerState.lastContactNormal = bestCollisionNormal.clone();

    const dotWithUp = bestCollisionNormal.dot(gravityUp);
    const isGroundContact = dotWithUp > 0.5;

    if (isGroundContact) {
      playerState.onGround = true;
      playerState.falling = false;
      isReorienting = true;
    }

    // Push player out of collision
    playerPosition.add(bestCollisionNormal.clone().multiplyScalar(bestPenetrationDepth * 1.01));

    // Adjust velocity to reflect off surface
    const normalVelocity = bestCollisionNormal.clone().multiplyScalar(
      playerState.velocity.dot(bestCollisionNormal)
    );

    if (normalVelocity.dot(bestCollisionNormal) < 0) {
      const tangentialVelocity = playerState.velocity.clone().sub(normalVelocity);
      const frictionFactor = isGroundContact ? 0.7 : 0.95;
      tangentialVelocity.multiplyScalar(frictionFactor);
      playerState.velocity.copy(tangentialVelocity);
    }
  }

  // Update player body position
  playerBody.setTranslation({
    x: playerPosition.x,
    y: playerPosition.y,
    z: playerPosition.z,
  }, true);

  // Update orientation if needed
  if (hasCollision && isReorienting && playerState.lastContactNormal) {
    updatePlayerPositionAndOrientation(
      playerPosition.clone(),
      playerState.lastContactNormal,
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

  const position = new THREE.Vector3(
    playerBody.translation().x,
    playerBody.translation().y,
    playerBody.translation().z
  );

  const gravityDir = GRAVITY_CENTER.clone().sub(position).normalize();
  const up = gravityDir.clone().negate();

  let onSurface = false;
  const wasJumping = playerState.jump && playerState.onGround;

  if (wasJumping) {
    playerState.onGround = false;
  }

  // Ground checking with raycasts
  const hitNormals = [];
  let closestHitDistance = Infinity;

  if (!wasJumping) {
    const capsuleBottomOffset = PLAYER_HEIGHT / 2;
    const feetPosition = position.clone().add(
      gravityDir.clone().multiplyScalar(capsuleBottomOffset - 0.05)
    );
    const groundCheckDistance = PLAYER_RADIUS + 0.5;

    const forwardDir = new THREE.Vector3(1, 0, 0).cross(up).normalize();
    const rightDir = up.clone().cross(forwardDir).normalize();
    
    const rayPositions = [
      feetPosition.clone(),
      feetPosition.clone().add(forwardDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7)),
      feetPosition.clone().add(rightDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7)),
      feetPosition.clone().sub(forwardDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7)),
      feetPosition.clone().sub(rightDir.clone().multiplyScalar(PLAYER_RADIUS * 0.7)),
    ];

    for (let i = 0; i < rayPositions.length; i++) {
      const raycaster = new THREE.Raycaster();
      raycaster.set(rayPositions[i], gravityDir);
      const intersects = raycaster.intersectObject(terrain);

      if (intersects.length > 0) {
        const normal = intersects[0].face.normal.clone();
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(
          terrain.matrixWorld
        );
        normal.applyMatrix3(normalMatrix).normalize();

        hitNormals.push(normal);

        if (intersects[0].distance < closestHitDistance) {
          closestHitDistance = intersects[0].distance;
        }

        if (i === 0 && intersects[0].distance < groundCheckDistance) {
          onSurface = true;
          playerState.onGround = true;
        }
      }
    }
  }

  // Determine surface normal and ground status
  let surfaceNormal = up.clone();
  if (hitNormals.length > 0) {
    surfaceNormal = new THREE.Vector3();
    for (const normal of hitNormals) {
      surfaceNormal.add(normal);
    }
    surfaceNormal.divideScalar(hitNormals.length).normalize();

    const groundCheckDistance = PLAYER_RADIUS + 0.5;
    if (closestHitDistance < groundCheckDistance) {
      onSurface = true;
      playerState.onGround = true;

      // Project velocity onto surface
      const normalVelocity = playerState.velocity.clone().projectOnVector(surfaceNormal);
      if (normalVelocity.dot(surfaceNormal) < 0) {
        playerState.velocity.sub(normalVelocity);
      }
    } else {
      playerState.onGround = false;
    }
  } else if (playerState.lastContactNormal && playerState.onGround) {
    // Use last known contact normal if we still consider ourselves grounded
    surfaceNormal = playerState.lastContactNormal.clone();
    onSurface = true;
  } else {
    // Check if we're inside the planet and push out if needed
    const distToCenter = position.distanceTo(GRAVITY_CENTER);
    const minDistance = PLANET_RADIUS - TERRAIN_HEIGHT_SCALE * 0.5 + PLAYER_HEIGHT / 2;

    if (distToCenter < minDistance) {
      position.copy(up.clone().multiplyScalar(minDistance));
      playerState.onGround = true;
      playerState.velocity.projectOnPlane(up);
    } else {
      playerState.onGround = false;
    }
  }

  // Apply gravity if not on ground
  if (!playerState.onGround) {
    playerState.velocity.add(gravityDir.clone().multiplyScalar(GRAVITY_STRENGTH * deltaTime));
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
  const surfaceAlignedFacing = playerState.facingDirection.clone()
    .projectOnPlane(surfaceNormal)
    .normalize();

  const right = new THREE.Vector3()
    .crossVectors(surfaceNormal, surfaceAlignedFacing)
    .normalize();

  playerState.direction.set(0, 0, 0);
  if (playerState.moveForward) playerState.direction.add(surfaceAlignedFacing);
  if (playerState.moveBackward) playerState.direction.sub(surfaceAlignedFacing);
  if (playerState.moveRight) playerState.direction.add(right);
  if (playerState.moveLeft) playerState.direction.sub(right);

  const isMoving = playerState.moveForward || playerState.moveBackward || 
                  playerState.moveLeft || playerState.moveRight;

  // Apply movement if there is input
  if (playerState.direction.lengthSq() > 0) {
    const slopeAngle = Math.acos(Math.min(1, Math.abs(surfaceNormal.dot(up))));
    
    // Remove slope checking and always allow full movement speed
    let moveSpeedMultiplier = 1.0;

    playerState.direction.normalize()
      .multiplyScalar(MOVE_SPEED * moveSpeedMultiplier * deltaTime);

    // Add movement to position
    if (playerState.lastContactNormal && playerState.onGround && hitNormals.length === 0) {
      const contactNormal = playerState.lastContactNormal;
      const projectedDirection = playerState.direction.clone().projectOnPlane(contactNormal);
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
    if (!isMoving) {
      // Higher friction when not moving
      playerState.velocity.multiplyScalar(0.05);
      
      if (playerState.velocity.lengthSq() < 0.03) {
        playerState.velocity.set(0, 0, 0);
      }
    } else {
      // Some friction when moving
      playerState.velocity.multiplyScalar(0.8);
    }
    
    // Project velocity onto surface
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

  // Handle collisions after movement
  handlePlayerCollisions();
}

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

  const spawnHeight = 20;
  const playerBodyDesc =
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
      0,
      PLANET_RADIUS + TERRAIN_HEIGHT_SCALE + PLAYER_HEIGHT / 2 + spawnHeight,
      0
    );
  playerBody = world.createRigidBody(playerBodyDesc);

  const playerColliderDesc = RAPIER.ColliderDesc.capsule(
    PLAYER_HEIGHT / 2 - PLAYER_RADIUS,
    PLAYER_RADIUS
  );

  playerColliderDesc.setCollisionGroups(0x00010001);

  playerCollider = world.createCollider(playerColliderDesc, playerBody);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);

  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, PLANET_RADIUS * 1.5, PLANET_RADIUS);

  renderer = new THREE.WebGLRenderer({
    canvas: canvasRef.value,
    antialias: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, PLANET_RADIUS, 0);
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
