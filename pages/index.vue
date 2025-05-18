<template>
  <canvas ref="canvas"></canvas>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Constants
const GRAVITY_STRENGTH = 20;
const PLANET_RADIUS = 5;
const PLAYER_RADIUS = 0.2;
const PLAYER_HEIGHT = 0.8;
const GRAVITY_ACCELERATION = 0.01; // Constant gravity acceleration for all objects

const canvas = ref(null);
let renderer, scene, camera, physicsWorld, animationFrameId;
let controls;

let player = null;
let objects = [];
let eventQueue;

onMounted(async () => {
  await RAPIER.init();
  
  // Setup scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050510);
  
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 5, 10);
  
  renderer = new THREE.WebGLRenderer({ 
    canvas: canvas.value,
    antialias: true 
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  
  controls = new OrbitControls(camera, canvas.value);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  
  // Lighting
  scene.add(new THREE.AmbientLight(0x404040));
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(10, 20, 10);
  scene.add(directionalLight);
  
  // Physics setup - no global gravity
  physicsWorld = new RAPIER.World({ x: 0.0, y: 0.0, z: 0.0 });
  eventQueue = new RAPIER.EventQueue(true);
  
  // Create terrain
  createPlanet();
  createTestObjects();
  
  // Create player
  createPlayer();
  
  window.addEventListener('resize', onWindowResize);
  
  scene.add(new THREE.AxesHelper(3));
  
  animate();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(animationFrameId);
  if (renderer) renderer.dispose();
  if (controls) controls.dispose();
  
  window.removeEventListener('resize', onWindowResize);
});

function updateObjectTransform(obj) {
  if (!obj.body || !obj.mesh) return;
  const pos = obj.body.translation();
  const rot = obj.body.rotation();
  obj.mesh.position.set(pos.x, pos.y, pos.z);
  obj.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
}

function createPlayer() {
  // Position player above planet
  const playerRigidBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
  playerRigidBodyDesc.setTranslation(0, PLANET_RADIUS + 5, 0);
  
  const playerBody = physicsWorld.createRigidBody(playerRigidBodyDesc);
  
  const playerColliderDesc = RAPIER.ColliderDesc.capsule(PLAYER_HEIGHT / 2, PLAYER_RADIUS);
  playerColliderDesc.setFriction(0.7);
  const collider = physicsWorld.createCollider(playerColliderDesc, playerBody);
  
  const playerMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT, 20, 20),
    new THREE.MeshStandardMaterial({ color: 0xe53935 })
  );
  scene.add(playerMesh);
  
  player = {
    body: playerBody,
    mesh: playerMesh,
    collider: collider,
    velocity: new THREE.Vector3(0, 0, 0),
    falling: true,
    lastContactNormal: null
  };
}

function createPlanet() {
  const planetBodyDesc = RAPIER.RigidBodyDesc.fixed();
  planetBodyDesc.setTranslation(0, 0, 0);
  
  const planetBody = physicsWorld.createRigidBody(planetBodyDesc);
  
  const planetColliderDesc = RAPIER.ColliderDesc.ball(PLANET_RADIUS);
  planetColliderDesc.setFriction(0.7);
  physicsWorld.createCollider(planetColliderDesc, planetBody);
  
  const planetMesh = new THREE.Mesh(
    new THREE.SphereGeometry(PLANET_RADIUS, 64, 48),
    new THREE.MeshStandardMaterial({ 
      color: 0x1565c0,
      roughness: 0.8,
      metalness: 0.2
    })
  );
  scene.add(planetMesh);
  
  objects.push({
    body: planetBody,
    mesh: planetMesh,
    isFixed: true,
    type: 'planet',
    radius: PLANET_RADIUS
  });
}

function createTestObjects() {
  // Create a few objects for testing collisions
  const shapes = ['box', 'sphere'];
  const colors = [0x7C4DFF, 0x00BFA5, 0xFFD600, 0x64DD17];
  
  for (let i = 0; i < 5; i++) {
    // Create positions in a spiral around the planet
    const phi = Math.acos(-1 + (2 * i) / 5);
    const theta = Math.sqrt(5 * Math.PI) * phi;
    
    // Convert to Cartesian coordinates
    const distance = PLANET_RADIUS + 0.5; // Position slightly above the surface
    const x = distance * Math.sin(phi) * Math.cos(theta);
    const y = distance * Math.sin(phi) * Math.sin(theta);
    const z = distance * Math.cos(phi);
    
    const size = 0.8 + Math.random() * 0.5;
    const shapeType = shapes[Math.floor(Math.random() * shapes.length)];
    const color = colors[Math.floor(Math.random() * colors.length)];
    
    // Align to planet surface
    const position = new THREE.Vector3(x, y, z);
    const upDir = position.clone().normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const rotationQuat = new THREE.Quaternion().setFromUnitVectors(worldUp, upDir);
    
    const bodyDesc = RAPIER.RigidBodyDesc.fixed();
    bodyDesc.setTranslation(x, y, z);
    bodyDesc.setRotation({
      x: rotationQuat.x,
      y: rotationQuat.y,
      z: rotationQuat.z,
      w: rotationQuat.w
    });
    
    const body = physicsWorld.createRigidBody(bodyDesc);
    
    let collider, geometry;
    
    if (shapeType === 'box') {
      collider = RAPIER.ColliderDesc.cuboid(size/2, size/4, size/2);
      geometry = new THREE.BoxGeometry(size, size/2, size);
    } else {
      collider = RAPIER.ColliderDesc.ball(size/2);
      geometry = new THREE.SphereGeometry(size/2, 16, 16);
    }
    
    collider.setFriction(0.7);
    physicsWorld.createCollider(collider, body);
    
    const mesh = new THREE.Mesh(
      geometry, 
      new THREE.MeshStandardMaterial({ color })
    );
    scene.add(mesh);
    
    objects.push({
      body,
      mesh,
      isFixed: true,
      type: shapeType,
      size: size
    });
  }
}

function applyPointGravity() {
  if (!player || !player.body) return;
  
  const playerPos = player.body.translation();
  const playerPosition = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z);
  
  // Find closest object with gravity (usually the planet)
  let closestObj = null;
  let closestDistance = Infinity;
  let gravityDir = new THREE.Vector3();
  
  for (const obj of objects) {
    if (!obj.body) continue;
    
    const objPos = obj.body.translation();
    const objPosition = new THREE.Vector3(objPos.x, objPos.y, objPos.z);
    const direction = new THREE.Vector3().subVectors(objPosition, playerPosition);
    const distance = direction.length();
    
    // Only consider planet and large objects
    if ((obj.type === 'planet' || obj.size > 1) && distance < closestDistance) {
      closestDistance = distance;
      closestObj = obj;
      gravityDir = direction.normalize();
    }
  }
  
  if (closestObj) {
    if (player.falling) {
      // Apply constant gravity acceleration
      const newPosition = new THREE.Vector3(
        playerPos.x + gravityDir.x * GRAVITY_ACCELERATION * GRAVITY_STRENGTH,
        playerPos.y + gravityDir.y * GRAVITY_ACCELERATION * GRAVITY_STRENGTH,
        playerPos.z + gravityDir.z * GRAVITY_ACCELERATION * GRAVITY_STRENGTH
      );
      
      player.body.setTranslation({
        x: newPosition.x,
        y: newPosition.y,
        z: newPosition.z
      });
    } else if (!player.falling && player.lastContactNormal) {
      // When grounded, apply a small force to keep player on the surface
      const stickDirection = player.lastContactNormal.clone().negate();
      const stickForce = 0.001 * GRAVITY_STRENGTH;
      
      const currentPos = player.body.translation();
      const newPosition = new THREE.Vector3(
        currentPos.x + stickDirection.x * stickForce,
        currentPos.y + stickDirection.y * stickForce,
        currentPos.z + stickDirection.z * stickForce
      );
      
      player.body.setTranslation({
        x: newPosition.x,
        y: newPosition.y,
        z: newPosition.z
      });
    }
  }
}

function checkCollisions() {
  if (!player || !player.body) return;
  
  // Reset falling state to true by default
  // We'll set it to false if we detect a collision
  player.falling = true;
  
  const playerPos = player.body.translation();
  const playerPosition = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z);
  
  for (const obj of objects) {
    if (!obj.body) continue;
    
    const objPos = obj.body.translation();
    const objPosition = new THREE.Vector3(objPos.x, objPos.y, objPos.z);
    
    let collisionNormal = null;
    let distance = 0;
    
    // Check collision based on object type
    if (obj.type === 'planet') {
      // For planet, calculate spherical collision
      const direction = new THREE.Vector3().subVectors(playerPosition, objPosition);
      distance = direction.length() - (obj.radius + PLAYER_RADIUS);
      
      if (distance <= 0.05) {
        collisionNormal = direction.normalize();
      }
    } else if (obj.type === 'sphere') {
      // For spheres, check distance from player center to sphere center
      const direction = new THREE.Vector3().subVectors(playerPosition, objPosition);
      distance = direction.length() - (obj.size/2 + PLAYER_RADIUS);
      
      if (distance <= 0.05) {
        collisionNormal = direction.normalize();
      }
    } else if (obj.type === 'box') {
      // For boxes, use simplified box collision (just checking distance)
      const objRot = obj.body.rotation();
      const objQuat = new THREE.Quaternion(objRot.x, objRot.y, objRot.z, objRot.w);
      const invQuat = objQuat.clone().invert();
      
      // Get player position in box local space
      const localPlayerPos = playerPosition.clone().sub(objPosition).applyQuaternion(invQuat);
      
      // Get closest point on box in local space
      const halfSize = obj.size / 2;
      const closestPoint = new THREE.Vector3(
        Math.max(-halfSize, Math.min(halfSize, localPlayerPos.x)),
        Math.max(-halfSize/4, Math.min(halfSize/4, localPlayerPos.y)),
        Math.max(-halfSize, Math.min(halfSize, localPlayerPos.z))
      );
      
      // Convert back to world space
      const worldClosestPoint = closestPoint.clone().applyQuaternion(objQuat).add(objPosition);
      
      // Calculate distance and direction
      const direction = new THREE.Vector3().subVectors(playerPosition, worldClosestPoint);
      distance = direction.length() - PLAYER_RADIUS;
      
      if (distance <= 0.05) {
        collisionNormal = direction.normalize();
      }
    }
    
    // If collision found, update player state
    if (collisionNormal && distance <= 0.05) {
      player.falling = false;
      player.lastContactNormal = collisionNormal;
      
      // Align player with the surface normal
      alignPlayerToSurface(collisionNormal);
      
      // Push the player slightly away from the surface
      const pushDistance = Math.max(0, 0.05 - distance);
      const currentPos = player.body.translation();
      
      player.body.setTranslation({
        x: currentPos.x + collisionNormal.x * pushDistance,
        y: currentPos.y + collisionNormal.y * pushDistance,
        z: currentPos.z + collisionNormal.z * pushDistance
      });
      
      break;
    }
  }
}

function alignPlayerToSurface(normal) {
  if (!player || !player.body || !normal) return;
  
  // Create a rotation that aligns player's up direction with the surface normal
  const worldUp = new THREE.Vector3(0, 1, 0);
  const rotationQuat = new THREE.Quaternion().setFromUnitVectors(worldUp, normal);
  
  player.body.setRotation({
    x: rotationQuat.x,
    y: rotationQuat.y,
    z: rotationQuat.z,
    w: rotationQuat.w
  });
}

function animate() {
  animationFrameId = requestAnimationFrame(animate);
  
  if (player) {
    // Apply point gravity
    applyPointGravity();
    
    // Check for collisions and align to surface
    checkCollisions();
  }
  
  physicsWorld.step(eventQueue);
  controls.update();
  
  if (player) {
    updateObjectTransform(player);
  }
  
  for (const obj of objects) {
    updateObjectTransform(obj);
  }
  
  renderer.render(scene, camera);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
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
