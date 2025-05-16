<template>
  <div id="scene-container"></div>
</template>

<script setup>
import { onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'
import * as RAPIER from '@dimforge/rapier3d-compat'

// Constants
const GRAVITY_STRENGTH = 50
const PLANET_RADIUS = 2
const PLAYER_RADIUS = 0.5
const PLAYER_HEIGHT = 2

// Keep only essential objects as variables
let renderer, scene, camera
let physicsWorld, planetBody, playerBody
let planetMesh, playerMesh
let animationFrameId

onMounted(async () => {
  // Initialize physics
  await RAPIER.init()
  
  // Create Three.js scene
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)
  
  // Create camera
  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  )
  camera.position.set(0, 15, 30)
  
  // Create renderer
  const container = document.getElementById('scene-container')
  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(window.devicePixelRatio)
  container.appendChild(renderer.domElement)
  
  // Add lights
  const ambientLight = new THREE.AmbientLight(0x404040)
  scene.add(ambientLight)
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1)
  directionalLight.position.set(10, 20, 10)
  scene.add(directionalLight)
  
  const gridHelper = new THREE.GridHelper(50, 50)
  scene.add(gridHelper)
  
  // Create physics world
  const gravity = { x: 0.0, y: 0.0, z: 0.0 } // We'll handle gravity manually
  physicsWorld = new RAPIER.World(gravity)
  
  // Create a planet (gravity attractor)
  const planetRigidBodyDesc = RAPIER.RigidBodyDesc.fixed()
  planetBody = physicsWorld.createRigidBody(planetRigidBodyDesc)
  
  const planetColliderDesc = RAPIER.ColliderDesc.ball(PLANET_RADIUS)
  physicsWorld.createCollider(planetColliderDesc, planetBody)
  
  // Create planet mesh
  const planetGeometry = new THREE.SphereGeometry(PLANET_RADIUS, 32, 32)
  const planetMaterial = new THREE.MeshStandardMaterial({ color: 0x1565c0 })
  planetMesh = new THREE.Mesh(planetGeometry, planetMaterial)
  scene.add(planetMesh)
  
  // Create a player (will be attracted to the planet)
  const playerRigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
  
  // Random position above the planet
  const randomX = (Math.random() - 0.5) * 20
  const randomZ = (Math.random() - 0.5) * 20
  playerRigidBodyDesc.setTranslation(randomX, 20, randomZ)
  
  playerBody = physicsWorld.createRigidBody(playerRigidBodyDesc)
  
  const playerColliderDesc = RAPIER.ColliderDesc.capsule(PLAYER_HEIGHT / 2, PLAYER_RADIUS)
  physicsWorld.createCollider(playerColliderDesc, playerBody)
  
  // Create player mesh
  const playerGeometry = new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT, 20, 20)
  const playerMaterial = new THREE.MeshStandardMaterial({ color: 0xe53935 })
  playerMesh = new THREE.Mesh(playerGeometry, playerMaterial)
  scene.add(playerMesh)
  
  // Start animation loop
  animate()
})

onBeforeUnmount(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  if (renderer) renderer.dispose()
})

function applyPlanetGravity() {
  if (!playerBody || !planetBody) return
  
  // Get positions
  const playerPos = playerBody.translation()
  const planetPos = planetBody.translation()
  
  // Calculate direction vector from player to planet
  const direction = {
    x: planetPos.x - playerPos.x,
    y: planetPos.y - playerPos.y,
    z: planetPos.z - playerPos.z
  }
  
  // Calculate distance
  const distance = Math.sqrt(
    direction.x * direction.x +
    direction.y * direction.y +
    direction.z * direction.z
  )
  
  // Normalize direction
  if (distance > 0) {
    direction.x /= distance
    direction.y /= distance
    direction.z /= distance
    
    // Force is proportional to 1/distance²
    const forceMagnitude = GRAVITY_STRENGTH / (distance * distance)
    
    // Apply planet's gravitational pull on the player
    playerBody.applyImpulse(
      { x: direction.x * forceMagnitude * 0.01, 
        y: direction.y * forceMagnitude * 0.01, 
        z: direction.z * forceMagnitude * 0.01 },
      true
    )
  }
}

function animate() {
  animationFrameId = requestAnimationFrame(animate)
  
  // Apply gravity between planet and player
  applyPlanetGravity()
  
  // Step the physics world
  physicsWorld.step()
  
  // Update mesh positions based on physics bodies
  if (planetBody && planetMesh) {
    const position = planetBody.translation()
    planetMesh.position.set(position.x, position.y, position.z)
  }
  
  if (playerBody && playerMesh) {
    const position = playerBody.translation()
    const rotation = playerBody.rotation()
    
    playerMesh.position.set(position.x, position.y, position.z)
    playerMesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
  }
  
  renderer.render(scene, camera)
}
</script>

<style scoped>
  #scene-container {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
</style>
