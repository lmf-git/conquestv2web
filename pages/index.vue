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

// Add ref for canvas
const canvas = ref(null)
let renderer, scene, camera, physicsWorld, planetBody, playerBody, planetMesh, playerMesh, animationFrameId

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
  
  physicsWorld = new RAPIER.World({ x: 0.0, y: 0.0, z: 0.0 })
  
  const planetRigidBodyDesc = RAPIER.RigidBodyDesc.fixed()
  planetBody = physicsWorld.createRigidBody(planetRigidBodyDesc)
  
  const planetColliderDesc = RAPIER.ColliderDesc.ball(PLANET_RADIUS)
  physicsWorld.createCollider(planetColliderDesc, planetBody)
  
  const planetGeometry = new THREE.SphereGeometry(PLANET_RADIUS, 32, 32)
  const planetMaterial = new THREE.MeshStandardMaterial({ color: 0x1565c0 })
  planetMesh = new THREE.Mesh(planetGeometry, planetMaterial)
  scene.add(planetMesh)
  
  const playerRigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
  
  playerRigidBodyDesc.setTranslation((Math.random() - 0.5) * 20, 20, (Math.random() - 0.5) * 20);
  
  playerBody = physicsWorld.createRigidBody(playerRigidBodyDesc)
  
  const playerColliderDesc = RAPIER.ColliderDesc.capsule(PLAYER_HEIGHT / 2, PLAYER_RADIUS)
  physicsWorld.createCollider(playerColliderDesc, playerBody)
  
  const playerGeometry = new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT, 20, 20)
  const playerMaterial = new THREE.MeshStandardMaterial({ color: 0xe53935 })
  playerMesh = new THREE.Mesh(playerGeometry, playerMaterial)
  scene.add(playerMesh)
  
  animate()
})

onBeforeUnmount(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  if (renderer) renderer.dispose()
})

function applyPlanetGravity() {
  if (!playerBody || !planetBody) return
  
  const playerPos = playerBody.translation()
  const planetPos = planetBody.translation()
  
  const direction = new THREE.Vector3(
    planetPos.x - playerPos.x,
    planetPos.y - playerPos.y,
    planetPos.z - playerPos.z
  )
  
  const distance = direction.length()
  if (distance === 0) return
  
  direction.normalize()
  const forceMagnitude = GRAVITY_STRENGTH / (distance * distance) * 0.01
  
  playerBody.applyImpulse(
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
