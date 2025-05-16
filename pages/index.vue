<template>
  <canvas ref="canvas" style="width: 100vw; height: 100vh; display: block;"></canvas>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'

const canvas = ref(null)

onMounted(async () => {
  await RAPIER.init()
  
  const renderer = new THREE.WebGLRenderer({ canvas: canvas.value })
  renderer.setSize(window.innerWidth, window.innerHeight)
  const scene = new THREE.Scene().add(new THREE.DirectionalLight(0xffffff, 1).translateY(20), new THREE.AmbientLight(0x888888))
  scene.background = new THREE.Color(0x222233)
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000)
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 })

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
  scene.add(playerMesh)
  const playerBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, planetRadius + 10, 0))
  world.createCollider(
    RAPIER.ColliderDesc.capsule(playerHeight / 2 - playerRadius, playerRadius).setRestitution(0.1).setFriction(0.8),
    playerBody
  )

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
  
  let mouseDown = false, lastMouseX = 0, lastMouseY = 0
  window.addEventListener('mousedown', e => (mouseDown = true, lastMouseX = e.clientX, lastMouseY = e.clientY))
  window.addEventListener('mouseup', () => mouseDown = false)
  window.addEventListener('mousemove', e => {
    if (!mouseDown) return
    const dx = e.clientX - lastMouseX, dy = e.clientY - lastMouseY
    lastMouseX = e.clientX, lastMouseY = e.clientY
    cameraPitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, cameraPitch - dy * 0.005))
    if (falling) cameraYaw += dx * 0.005
    else playerYaw += dx * 0.005
  })

  function animate() {
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
    
    if (onGround && falling) { falling = false; cameraPitch = 0 }
    if (!onGround && !falling) falling = true

    if (!falling) {
      let moveDir = new THREE.Vector3(
        (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0),
        0,
        (keys['KeyS'] ? 1 : 0) - (keys['KeyW'] ? 1 : 0)
      )
      
      if (moveDir.length() > 0) {
        moveDir.normalize().applyAxisAngle(groundNormal, playerYaw)
        const tangent = moveDir.clone().projectOnPlane(groundNormal)
        playerBody.addImpulse({ x: tangent.x * 0.5, y: tangent.y * 0.5, z: tangent.z * 0.5 })
      }
      
      if (keys['Space']) {
        playerBody.addImpulse({ x: groundNormal.x * 3, y: groundNormal.y * 3, z: groundNormal.z * 3 })
      }
    }

    const playerPos = playerBody.translation()
    playerMesh.position.set(playerPos.x, playerPos.y, playerPos.z)
    
    if (!falling) {
      const up = groundNormal.clone()
      const forward = new THREE.Vector3(0, 0, 1).applyAxisAngle(up, playerYaw)
      playerMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up)
      playerMesh.rotateOnWorldAxis(up, playerYaw)
    } else {
      playerMesh.rotation.set(cameraPitch, cameraYaw, 0)
    }
    
    cubes.forEach(({ mesh, body }) => {
      const pos = body.translation()
      mesh.position.set(pos.x, pos.y, pos.z)
      const rot = body.rotation()
      mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w)
    })

    if (falling) {
      camera.position.copy(playerMesh.position).add(new THREE.Vector3(0, 2, 0))
      camera.rotation.set(cameraPitch, cameraYaw, 0)
    } else {
      const up = groundNormal.clone()
      const forward = new THREE.Vector3(0, 0, 1).applyAxisAngle(up, playerYaw)
      camera.position.copy(playerMesh.position).add(forward.clone().multiplyScalar(-4).add(up.clone().multiplyScalar(2)))
      camera.lookAt(playerMesh.position)
      camera.rotateOnWorldAxis(forward.clone().cross(up).normalize(), cameraPitch)
    }

    renderer.render(scene, camera)
    requestAnimationFrame(animate)
  }
  animate()

  onBeforeUnmount(() => renderer.dispose())
})
</script>

<style scoped>
canvas {
  width: 100vw;
  height: 100vh;
  display: block;
}
</style>
