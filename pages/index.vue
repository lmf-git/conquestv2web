<template>
  <div @click="lockControls" style="width: 100vw; height: 100vh;">
    <canvas ref="canvas" style="width: 100vw; height: 100vh; display: block;"></canvas>
    <div v-if="!isPointerLocked" class="instructions">
      Click to play
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'

const canvas = ref(null)
const isPointerLocked = ref(false)

// Function to lock/unlock pointer
function lockControls() {
  if (!document.pointerLockElement) {
    canvas.value.requestPointerLock()
  }
}

onMounted(async () => {
  await RAPIER.init()
  
  // Set up pointer lock events
  document.addEventListener('pointerlockchange', () => {
    isPointerLocked.value = document.pointerLockElement === canvas.value
  })
  
  const renderer = new THREE.WebGLRenderer({ canvas: canvas.value })
  renderer.setSize(window.innerWidth, window.innerHeight)
  const scene = new THREE.Scene().add(new THREE.DirectionalLight(0xffffff, 1).translateY(20), new THREE.AmbientLight(0x888888))
  scene.background = new THREE.Color(0x222233)
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000)
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 })

  // Window resize handler
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  const planetRadius = 10
  const planetMesh = new THREE.Mesh(new THREE.SphereGeometry(planetRadius, 32, 32), new THREE.MeshStandardMaterial({ color: 0x2266cc }))
  scene.add(planetMesh)
  const planetBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.ball(planetRadius), planetBody)

  const playerHeight = 2, playerRadius = 0.5
  const playerMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(playerRadius, playerHeight - 2 * playerRadius, 16, 8),
    new THREE.MeshStandardMaterial({ color: 0xffaa00 })
  )
  // Rotate capsule so it's oriented correctly (pointing up along Y axis)
  playerMesh.rotation.set(0, 0, 0)
  scene.add(playerMesh)
  const playerBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, planetRadius + 10, 0)
  )
  
  world.createCollider(
    RAPIER.ColliderDesc.capsule(playerHeight / 2 - playerRadius, playerRadius)
      .setRestitution(0.1)
      .setFriction(0.8),
    playerBody
  )

  // Create a head position for the camera (separate from the mesh)
  const cameraOffset = new THREE.Vector3(0, playerHeight / 2 - playerRadius, 0)

  // Weapon mesh (optional - adds an FPS gun model)
  const weaponMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.1, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x333333 })
  )
  weaponMesh.position.set(0.2, -0.2, -0.3)
  camera.add(weaponMesh)
  scene.add(camera)

  const cubes = []
  for (let i = 0; i < 5; i++) {
    const size = 1
    const cubeMesh = new THREE.Mesh(
      new THREE.BoxGeometry(size, size, size),
      new THREE.MeshStandardMaterial({ color: 0x44ff44 })
    )
    cubeMesh.position.set(Math.random() * 8 - 4, planetRadius + 2 + i * 2, Math.random() * 8 - 4)
    scene.add(cubeMesh)
    const cubeBodyDesc = i < 2 
      ? RAPIER.RigidBodyDesc.fixed() 
      : RAPIER.RigidBodyDesc.dynamic()
    cubeBodyDesc.setTranslation(cubeMesh.position.x, cubeMesh.position.y, cubeMesh.position.z)
    const cubeBody = world.createRigidBody(cubeBodyDesc)
    world.createCollider(RAPIER.ColliderDesc.cuboid(size/2, size/2, size/2), cubeBody)
    cubes.push({ mesh: cubeMesh, body: cubeBody })
  }

  let falling = true, cameraPitch = 0, cameraYaw = 0, playerYaw = 0
  
  const keys = {}
  window.addEventListener('keydown', e => keys[e.code] = true)
  window.addEventListener('keyup', e => keys[e.code] = false)
  
  // Replace mouse events with pointer lock based controls
  window.addEventListener('mousemove', e => {
    if (!isPointerLocked.value) return
    
    const movementX = e.movementX || 0
    const movementY = e.movementY || 0
    
    // Update camera pitch (up/down)
    cameraPitch = Math.max(-Math.PI/2 + 0.1, Math.min(Math.PI/2 - 0.1, cameraPitch - movementY * 0.002))
    
    // Update yaw (left/right)
    if (falling) {
      cameraYaw += movementX * 0.002
    } else {
      playerYaw += movementX * 0.002
    }
  })

  function animate() {
    // Apply gravity to dynamic objects
    world.forEachRigidBody(body => {
      if (body.isDynamic() && body !== playerBody) {
        const pos = body.translation()
        const dir = new THREE.Vector3(-pos.x, -pos.y, -pos.z).normalize()
        body.addForce({ x: dir.x * 9.8, y: dir.y * 9.8, z: dir.z * 9.8 })
      }
    })
    
    if (falling) {
      const pos = playerBody.translation()
      const dir = new THREE.Vector3(-pos.x, -pos.y, -pos.z).normalize()
      playerBody.addForce({ x: dir.x * 9.8, y: dir.y * 9.8, z: dir.z * 9.8 })
    }

    world.step()

    let onGround = false, groundNormal = new THREE.Vector3(0, 1, 0)
    const playerBodyHandle = playerBody.handle
    
    // Check for ground contact
    for (let i = 0; i < world.bodies.length; i++) {
      if (world.bodies[i].handle !== playerBodyHandle) {
        for (let contact of world.contactsWith(playerBodyHandle)) {
          if (contact.dist <= 0.05) {
            onGround = true
            groundNormal.set(contact.normal.x, contact.normal.y, contact.normal.z)
            break
          }
        }
      }
      if (onGround) break
    }
    
    if (onGround && falling) { 
      falling = false
      
      // Stabilize player orientation when landing - align capsule with normal
      const playerPos = playerBody.translation()
      const toPlanet = new THREE.Vector3(-playerPos.x, -playerPos.y, -playerPos.z).normalize()
      playerBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }) // Reset rotation
      playerYaw = 0 // Reset yaw when landing
    }
    if (!onGround && !falling) falling = true

    // Handle movement based on keys
    if (!falling) {
      let moveDir = new THREE.Vector3(
        (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0),
        0,
        (keys['KeyS'] ? 1 : 0) - (keys['KeyW'] ? 1 : 0)
      )
      
      if (moveDir.length() > 0) {
        moveDir.normalize().applyAxisAngle(groundNormal, playerYaw)
        const tangent = moveDir.clone().projectOnPlane(groundNormal)
        playerBody.addForce({ x: tangent.x * 10, y: tangent.y * 10, z: tangent.z * 10 }) // Changed from addImpulse to addForce with increased value
      }
      
      if (keys['Space']) {
        playerBody.addForce({ x: groundNormal.x * 60, y: groundNormal.y * 60, z: groundNormal.z * 60 }) // Changed from addImpulse to addForce with increased value
      }
    } else {
      // Allow some air control
      let moveDir = new THREE.Vector3(
        (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0),
        0,
        (keys['KeyS'] ? 1 : 0) - (keys['KeyW'] ? 1 : 0)
      )
      
      if (moveDir.length() > 0) {
        moveDir.normalize().applyEuler(new THREE.Euler(0, cameraYaw, 0))
        playerBody.addForce({ x: moveDir.x * 5, y: 0, z: moveDir.z * 5 }) // Changed from addImpulse to addForce with adjusted value
      }
    }

    // Update player mesh position and rotation
    const playerPos = playerBody.translation()
    playerMesh.position.set(playerPos.x, playerPos.y, playerPos.z)
    
    if (!falling) {
      const up = groundNormal.clone()
      // Create a proper forward vector that respects the ground normal
      const worldUp = new THREE.Vector3(0, 1, 0);
      const axis = new THREE.Vector3().crossVectors(worldUp, up).normalize();
      const angle = Math.acos(worldUp.dot(up));
      
      // Calculate the forward direction based on the player's yaw and surface normal
      const forward = new THREE.Vector3(0, 0, -1);
      if (angle > 0.01) { // Only apply rotation if the angle is significant
        forward.applyAxisAngle(axis, angle);
      }
      forward.applyAxisAngle(up, playerYaw);
      
      // Align player mesh with the ground normal
      playerMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      playerMesh.rotateOnWorldAxis(up, playerYaw);
      
      // Position camera at player's head position
      const headPos = playerMesh.position.clone().add(
        cameraOffset.clone().applyQuaternion(playerMesh.quaternion)
      );
      camera.position.copy(headPos);
      
      // Set camera's base orientation to align with the surface normal
      const right = new THREE.Vector3().crossVectors(forward, up).normalize();
      const cameraRotMatrix = new THREE.Matrix4().makeBasis(right, up, forward.clone().multiplyScalar(-1));
      camera.quaternion.setFromRotationMatrix(cameraRotMatrix);
      
      // Apply the pitch rotation around the right axis
      camera.rotateOnAxis(right, cameraPitch);
    } else {
      // When falling, the camera follows the player directly
      camera.position.copy(playerMesh.position).add(new THREE.Vector3(0, playerHeight/2, 0))
      camera.rotation.set(cameraPitch, cameraYaw, 0)
      
      // Update player mesh rotation to match camera in freefall
      playerMesh.rotation.y = cameraYaw
    }
    
    // Update cube positions
    cubes.forEach(({ mesh, body }) => {
      const pos = body.translation()
      mesh.position.set(pos.x, pos.y, pos.z)
      const rot = body.rotation()
      mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w)
    })

    renderer.render(scene, camera)
    requestAnimationFrame(animate)
  }
  animate()

  onBeforeUnmount(() => {
    document.exitPointerLock()
    renderer.dispose()
    window.removeEventListener('resize', null)
  })
})
</script>

<style scoped>
canvas {
  width: 100vw;
  height: 100vh;
  display: block;
}

.instructions {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: white;
  font-size: 24px;
  font-family: Arial, sans-serif;
  text-align: center;
  background-color: rgba(0, 0, 0, 0.6);
  padding: 20px;
  border-radius: 10px;
  pointer-events: none;
}
</style>
