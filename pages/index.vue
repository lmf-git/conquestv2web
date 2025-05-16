<template>
  <div>
    <div id="scene-container"></div>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'
import * as RAPIER from '@dimforge/rapier3d-compat'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'

// Constants
const GRAVITY_STRENGTH = 50
const SPHERE_RADIUS = 2
const CAPSULE_RADIUS = 0.5
const CAPSULE_HEIGHT = 2

// Keep only essential objects as variables
let renderer, scene, camera, controls
let physicsWorld, sphereBody, capsuleBody
let sphereMesh, capsuleMesh
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
  
  // Add orbit controls
  controls = new OrbitControls(camera, renderer.domElement)
  
  // Add lights
  const ambientLight = new THREE.AmbientLight(0x404040)
  scene.add(ambientLight)
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1)
  directionalLight.position.set(10, 20, 10)
  scene.add(directionalLight)
  
  // Add grid helper
  const gridHelper = new THREE.GridHelper(50, 50)
  scene.add(gridHelper)
  
  // Create physics world
  const gravity = { x: 0.0, y: 0.0, z: 0.0 } // We'll handle gravity manually
  physicsWorld = new RAPIER.World(gravity)
  
  // Create a sphere (attractor)
  const sphereRigidBodyDesc = RAPIER.RigidBodyDesc.fixed()
  sphereBody = physicsWorld.createRigidBody(sphereRigidBodyDesc)
  
  const sphereColliderDesc = RAPIER.ColliderDesc.ball(SPHERE_RADIUS)
  physicsWorld.createCollider(sphereColliderDesc, sphereBody)
  
  // Create sphere mesh
  const sphereGeometry = new THREE.SphereGeometry(SPHERE_RADIUS, 32, 32)
  const sphereMaterial = new THREE.MeshStandardMaterial({ color: 0x1565c0 })
  sphereMesh = new THREE.Mesh(sphereGeometry, sphereMaterial)
  scene.add(sphereMesh)
  
  // Create a capsule (will be attracted to the sphere)
  const capsuleRigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
  
  // Random position above the sphere
  const randomX = (Math.random() - 0.5) * 20
  const randomZ = (Math.random() - 0.5) * 20
  capsuleRigidBodyDesc.setTranslation(randomX, 20, randomZ)
  
  capsuleBody = physicsWorld.createRigidBody(capsuleRigidBodyDesc)
  
  const capsuleColliderDesc = RAPIER.ColliderDesc.capsule(CAPSULE_HEIGHT / 2, CAPSULE_RADIUS)
  physicsWorld.createCollider(capsuleColliderDesc, capsuleBody)
  
  // Create capsule mesh
  const capsuleGeometry = new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HEIGHT, 20, 20)
  const capsuleMaterial = new THREE.MeshStandardMaterial({ color: 0xe53935 })
  capsuleMesh = new THREE.Mesh(capsuleGeometry, capsuleMaterial)
  scene.add(capsuleMesh)
  
  // Start animation loop
  animate()
})

onBeforeUnmount(() => {
  // Clean up resources
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
  }
  
  if (renderer) {
    renderer.dispose()
  }
  
  if (controls) {
    controls.dispose()
  }
})

function applyGravityForce() {
  if (!capsuleBody || !sphereBody) return
  
  // Get positions
  const capsulePos = capsuleBody.translation()
  const spherePos = sphereBody.translation()
  
  // Calculate direction vector from capsule to sphere
  const direction = {
    x: spherePos.x - capsulePos.x,
    y: spherePos.y - capsulePos.y,
    z: spherePos.z - capsulePos.z
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
    
    // Apply force using Rapier's API correctly
    capsuleBody.applyImpulse(
      { x: direction.x * forceMagnitude * 0.01, 
        y: direction.y * forceMagnitude * 0.01, 
        z: direction.z * forceMagnitude * 0.01 },
      true
    )
  }
}

function animate() {
  animationFrameId = requestAnimationFrame(animate)
  
  // Apply gravity between sphere and capsule
  applyGravityForce()
  
  // Step the physics world
  physicsWorld.step()
  
  // Update mesh positions based on physics bodies
  if (sphereBody && sphereMesh) {
    const position = sphereBody.translation()
    sphereMesh.position.set(position.x, position.y, position.z)
  }
  
  if (capsuleBody && capsuleMesh) {
    const position = capsuleBody.translation()
    const rotation = capsuleBody.rotation()
    
    capsuleMesh.position.set(position.x, position.y, position.z)
    capsuleMesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
  }
  
  controls.update()
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
