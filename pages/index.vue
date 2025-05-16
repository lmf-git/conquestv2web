<template>
  <canvas ref="canvas"></canvas>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'
import * as RAPIER from '@dimforge/rapier3d-compat'

const GRAVITY_STRENGTH = 50
const PLANET_RADIUS = 2
const PLAYER_RADIUS = 0.5
const PLAYER_HEIGHT = 2
const NUM_PLAYERS = 3  // We'll create exactly 3 players
const NUM_RANDOM_OBJECTS = 8  // Number of additional objects to create

// Add ref for canvas
const canvas = ref(null)
let renderer, scene, camera, physicsWorld, planetBody, planetMesh, animationFrameId

// Arrays to store multiple players and random objects
let playerBodies = []
let playerMeshes = []
let objectBodies = []
let objectMeshes = []

onMounted(async () => {
  await RAPIER.init()
  
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)
  
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000)
  camera.position.set(0, 15, 30)
  
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
  
  // Create physics world and planet first
  physicsWorld = new RAPIER.World({ x: 0.0, y: 0.0, z: 0.0 })
  
  // Create the planet (gravity attractor)
  const planetRigidBodyDesc = RAPIER.RigidBodyDesc.fixed()
  planetBody = physicsWorld.createRigidBody(planetRigidBodyDesc)
  
  const planetColliderDesc = RAPIER.ColliderDesc.ball(PLANET_RADIUS)
  physicsWorld.createCollider(planetColliderDesc, planetBody)
  
  const planetGeometry = new THREE.SphereGeometry(PLANET_RADIUS, 32, 32)
  const planetMaterial = new THREE.MeshStandardMaterial({ color: 0x1565c0 })
  planetMesh = new THREE.Mesh(planetGeometry, planetMaterial)
  scene.add(planetMesh)
  
  // Create players at random positions
  createPlayers(NUM_PLAYERS)
  
  // Create additional random objects (not capsules)
  createRandomObjects(NUM_RANDOM_OBJECTS)
  
  animate()
})

onBeforeUnmount(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  if (renderer) renderer.dispose()
})

// Function to create players (capsules)
function createPlayers(count) {
  const playerColors = [0xe53935, 0x43A047, 0x1E88E5]
  
  for (let i = 0; i < count; i++) {
    // Random position above the planet
    const randomX = (Math.random() - 0.5) * 30
    const randomY = 15 + Math.random() * 15  // Between 15-30 units high
    const randomZ = (Math.random() - 0.5) * 30
    
    // Create player physics body
    const playerRigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
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
    
    const playerColliderDesc = RAPIER.ColliderDesc.capsule(PLAYER_HEIGHT / 2, PLAYER_RADIUS)
    physicsWorld.createCollider(playerColliderDesc, playerBody)
    
    // Create player mesh
    const playerGeometry = new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT, 20, 20)
    const playerMaterial = new THREE.MeshStandardMaterial({ color: playerColors[i % playerColors.length] })
    const playerMesh = new THREE.Mesh(playerGeometry, playerMaterial)
    scene.add(playerMesh)
    
    // Store references
    playerBodies.push(playerBody)
    playerMeshes.push(playerMesh)
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
        geometry = new THREE.BoxGeometry(size, size, size)
        break
      case 'sphere':
        collider = RAPIER.ColliderDesc.ball(size/2)
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

// Update gravity function to apply to all objects
function applyPlanetGravity() {
  // Apply gravity to players
  for (const playerBody of playerBodies) {
    if (playerBody && planetBody) {
      applyGravityToObject(playerBody, planetBody)
    }
  }
  
  // Apply gravity to random objects
  for (const objectBody of objectBodies) {
    if (objectBody && planetBody) {
      applyGravityToObject(objectBody, planetBody)
    }
  }
}

// Helper function to apply gravity to a specific object
function applyGravityToObject(objectBody, attractor) {
  const objectPos = objectBody.translation()
  const attractorPos = attractor.translation()
  
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

function animate() {
  animationFrameId = requestAnimationFrame(animate)
  
  applyPlanetGravity()
  
  physicsWorld.step()
  
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
