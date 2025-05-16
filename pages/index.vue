<template>
  <canvas ref="canvas"></canvas>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'
import * as RAPIER from '@dimforge/rapier3d-compat'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const GRAVITY_STRENGTH = 50
const PLANET_RADIUS = 2
const PLAYER_RADIUS = 0.2
const PLAYER_HEIGHT = 0.8
const NUM_PLAYERS = 3
const NUM_RANDOM_OBJECTS = 8
const PLANET_FRICTION = 1.0
const OBJECT_FRICTION = 0.7
const RAY_CAST_LENGTH = 0.3
const COLLISION_BUFFER = 0.05

const canvas = ref(null)
let renderer, scene, camera, physicsWorld, planetBody, planetMesh, animationFrameId
let controls

let playerBodies = []
let playerMeshes = []
let playerFallingStates = []
let objectBodies = []
let objectMeshes = []
let surfaceCubeBodies = []
let surfaceCubeMeshes = []

let playerColliderMap = new Map()
let eventQueue
let playerVelocities = []

const keys = {
  w: false,
  a: false,
  s: false,
  d: false
};

function handleKeyDown(event) {
  switch(event.key.toLowerCase()) {
    case 'w': keys.w = true; break;
    case 'a': keys.a = true; break;
    case 's': keys.s = true; break;
    case 'd': keys.d = true; break;
  }
}

function handleKeyUp(event) {
  switch(event.key.toLowerCase()) {
    case 'w': keys.w = false; break;
    case 'a': keys.a = false; break;
    case 's': keys.s = false; break;
    case 'd': keys.d = false; break;
  }
}

onMounted(async () => {
  await RAPIER.init()
  
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)
  
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000)
  camera.position.set(0, 0, 15)
  
  renderer = new THREE.WebGLRenderer({ 
    canvas: canvas.value,
    antialias: true 
  })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(window.devicePixelRatio)
  
  controls = new OrbitControls(camera, canvas.value)
  controls.enableDamping = true
  controls.dampingFactor = 0.05
  controls.screenSpacePanning = false
  controls.minDistance = 5
  controls.maxDistance = 30
  
  scene.add(new THREE.AmbientLight(0x404040))
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1)
  directionalLight.position.set(10, 20, 10)
  scene.add(directionalLight)
  
  physicsWorld = new RAPIER.World({ x: 0.0, y: 0.0, z: 0.0 })
  eventQueue = new RAPIER.EventQueue(true)
  
  const planetRigidBodyDesc = RAPIER.RigidBodyDesc.fixed()
  planetBody = physicsWorld.createRigidBody(planetRigidBodyDesc)
  
  const planetColliderDesc = RAPIER.ColliderDesc.ball(PLANET_RADIUS)
  planetColliderDesc.setFriction(PLANET_FRICTION)
  planetColliderDesc.setRestitution(0.0)
  physicsWorld.createCollider(planetColliderDesc, planetBody)
  
  const planetGeometry = new THREE.SphereGeometry(PLANET_RADIUS, 32, 32)
  const planetMaterial = new THREE.MeshStandardMaterial({ color: 0x1565c0 })
  planetMesh = new THREE.Mesh(planetGeometry, planetMaterial)
  scene.add(planetMesh)
  
  createSurfaceCubes(15)
  
  createPlayers(NUM_PLAYERS)
  
  createRandomObjects(NUM_RANDOM_OBJECTS)
  
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  window.addEventListener('resize', onWindowResize)
  
  const axesHelper = new THREE.AxesHelper(5)
  scene.add(axesHelper)
  
  animate()
})

onBeforeUnmount(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId)
  if (renderer) renderer.dispose()
  if (controls) controls.dispose()
  
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  window.removeEventListener('resize', onWindowResize)
})

function createPlayers(count) {
  const playerColors = [0xe53935, 0x43A047, 0x1E88E5]
  
  for (let i = 0; i < count; i++) {
    const randomX = (Math.random() - 0.5) * 30
    const randomY = 15 + Math.random() * 15
    const randomZ = (Math.random() - 0.5) * 30
    
    const playerRigidBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
    playerRigidBodyDesc.setTranslation(randomX, randomY, randomZ)
    
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
    playerColliderDesc.setFriction(0.9)  
    const collider = physicsWorld.createCollider(playerColliderDesc, playerBody)
    
    playerColliderMap.set(collider.handle, i)
    
    const playerGeometry = new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT, 20, 20)
    const playerMaterial = new THREE.MeshStandardMaterial({ color: playerColors[i % playerColors.length] })
    const playerMesh = new THREE.Mesh(playerGeometry, playerMaterial)
    scene.add(playerMesh)
    
    playerBodies.push(playerBody)
    playerMeshes.push(playerMesh)
    playerFallingStates.push(true)
    playerVelocities.push(new THREE.Vector3(0, 0, 0))
  }
}

function createRandomObjects(count) {
  const shapes = ['box', 'sphere']
  const colors = [0xff5252, 0x7C4DFF, 0x00BFA5, 0xFFD600, 0x64DD17]
  
  for (let i = 0; i < count; i++) {
    const randomX = (Math.random() - 0.5) * 30
    const randomY = 15 + Math.random() * 15
    const randomZ = (Math.random() - 0.5) * 30
    
    const size = 0.3 + Math.random() * 1.2
    
    const shapeType = shapes[Math.floor(Math.random() * shapes.length)]
    const color = colors[Math.floor(Math.random() * colors.length)]
    
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    bodyDesc.setTranslation(randomX, randomY, randomZ)
    
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
    
    let collider, geometry
    
    switch (shapeType) {
      case 'box':
        collider = RAPIER.ColliderDesc.cuboid(size/2, size/2, size/2)
        collider.setFriction(OBJECT_FRICTION)
        geometry = new THREE.BoxGeometry(size, size, size)
        break
      case 'sphere':
        collider = RAPIER.ColliderDesc.ball(size/2)
        collider.setFriction(OBJECT_FRICTION)
        geometry = new THREE.SphereGeometry(size/2, 16, 16)
        break
    }
    
    physicsWorld.createCollider(collider, body)
    
    const material = new THREE.MeshStandardMaterial({ color })
    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)
    
    objectBodies.push(body)
    objectMeshes.push(mesh)
  }
}

function createSurfaceCubes(count) {
  const cubeSize = 0.5
  const colliderBuffer = 0.1
  
  for (let i = 0; i < count; i++) {
    const phi = Math.acos(2 * Math.random() - 1)
    const theta = 2 * Math.PI * Math.random()
    
    const x = PLANET_RADIUS * Math.sin(phi) * Math.cos(theta)
    const y = PLANET_RADIUS * Math.sin(phi) * Math.sin(theta)
    const z = PLANET_RADIUS * Math.cos(phi)
    
    const direction = new THREE.Vector3(x, y, z).normalize()
    const position = {
      x: direction.x * (PLANET_RADIUS + cubeSize/2),
      y: direction.y * (PLANET_RADIUS + cubeSize/2),
      z: direction.z * (PLANET_RADIUS + cubeSize/2)
    }
    
    const cubeRigidBodyDesc = RAPIER.RigidBodyDesc.fixed()
    cubeRigidBodyDesc.setTranslation(position.x, position.y, position.z)
    
    const upVector = new THREE.Vector3(0, 1, 0)
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      upVector, direction
    )
    
    cubeRigidBodyDesc.setRotation({
      x: quaternion.x,
      y: quaternion.y,
      z: quaternion.z,
      w: quaternion.w
    })
    
    const cubeBody = physicsWorld.createRigidBody(cubeRigidBodyDesc)
    
    const cubeColliderDesc = RAPIER.ColliderDesc.cuboid(
      cubeSize/2 + colliderBuffer,
      cubeSize/4 + colliderBuffer,
      cubeSize/2 + colliderBuffer
    )
    cubeColliderDesc.setFriction(PLANET_FRICTION)
    physicsWorld.createCollider(cubeColliderDesc, cubeBody)
    
    const geometry = new THREE.BoxGeometry(cubeSize, cubeSize/2, cubeSize)
    const material = new THREE.MeshStandardMaterial({ color: 0x8BC34A })
    const mesh = new THREE.Mesh(geometry, material)
    
    mesh.position.set(position.x, position.y, position.z)
    mesh.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
    
    scene.add(mesh)
    
    surfaceCubeBodies.push(cubeBody)
    surfaceCubeMeshes.push(mesh)
  }
}

function landPlayerOnSurface(playerIndex, surfaceBody, surfaceCollider, normal) {
  if (playerIndex < 0 || playerIndex >= playerBodies.length) return
  
  const playerBody = playerBodies[playerIndex]
  const surfacePos = surfaceBody.translation()
  
  let offsetDistance = 0
  
  if (surfaceCollider.shapeType() === RAPIER.ShapeType.Ball) {
    const radius = surfaceCollider.radius()
    offsetDistance = radius + PLAYER_RADIUS
  } 
  else if (surfaceCollider.shapeType() === RAPIER.ShapeType.Cuboid) {
    const halfExtents = surfaceCollider.halfExtents()
    const halfHeight = halfExtents.y
    offsetDistance = halfHeight + PLAYER_RADIUS
  }
  
  const newPosition = {
    x: surfacePos.x + normal.x * offsetDistance,
    y: surfacePos.y + normal.y * offsetDistance,
    z: surfacePos.z + normal.z * offsetDistance
  }
  
  playerBody.setTranslation(newPosition)
}

function alignPlayerWithNormal(playerIndex, normal) {
  if (playerIndex < 0 || playerIndex >= playerBodies.length) return
  
  const playerBody = playerBodies[playerIndex]
  
  const upVector = new THREE.Vector3(0, 1, 0)
  const quaternion = new THREE.Quaternion()
  quaternion.setFromUnitVectors(upVector, normal)
  
  playerBody.setRotation({
    x: quaternion.x,
    y: quaternion.y,
    z: quaternion.z,
    w: quaternion.w
  })
  
  playerVelocities[playerIndex].set(0, 0, 0)
}

function raycastHitsCube(from, direction, maxDistance) {
  const rayDir = direction.clone().normalize()
  const rayStart = new RAPIER.Vector3(from.x, from.y, from.z)
  const rayDirR = new RAPIER.Vector3(rayDir.x, rayDir.y, rayDir.z)
  
  const raycastResult = physicsWorld.castRay(
    new RAPIER.Ray(rayStart, rayDirR),
    maxDistance,
    true,
    (handle) => {
      const collider = physicsWorld.getCollider(handle)
      if (!collider) return false
      
      const bodyHandle = collider.parent()
      const body = physicsWorld.getRigidBody(bodyHandle)
      
      return body && body.isFixed()
    }
  )
  
  if (raycastResult !== null) return true
  
  const angles = [Math.PI/12, -Math.PI/12]
  for (const angle of angles) {
    const rotAxis = new THREE.Vector3().crossVectors(rayDir, new THREE.Vector3(0,1,0)).normalize()
    if (rotAxis.length() > 0.01) {
      const rotQuat = new THREE.Quaternion().setFromAxisAngle(rotAxis, angle)
      const altDir = rayDir.clone().applyQuaternion(rotQuat)
      
      const altRayResult = physicsWorld.castRay(
        new RAPIER.Ray(
          rayStart,
          new RAPIER.Vector3(altDir.x, altDir.y, altDir.z)
        ),
        maxDistance,
        true,
        (handle) => {
          const collider = physicsWorld.getCollider(handle)
          if (!collider) return false
          
          const bodyHandle = collider.parent()
          const body = physicsWorld.getRigidBody(bodyHandle)
          
          return body && body.isFixed()
        }
      )
      
      if (altRayResult !== null) return true
    }
  }
  
  return false
}

function isCollidingWithCube(position, excludeHandle, isCurrentPosition = false) {
  const bufferMultiplier = isCurrentPosition ? 1.0 : 1.2
  
  const halfHeight = PLAYER_HEIGHT / 2
  const radius = PLAYER_RADIUS * bufferMultiplier
  
  const shape = new RAPIER.Capsule(halfHeight, radius)
  const pos = new RAPIER.Vector3(position.x, position.y, position.z)
  
  const playerBody = playerBodies[0]
  const rot = playerBody ? playerBody.rotation() : new RAPIER.Quaternion(0, 0, 0, 1)
  
  const intersections = physicsWorld.intersectionsWithShape(
    pos, rot, shape, (handle) => {
      if (handle === excludeHandle) return false
      
      const collider = physicsWorld.getCollider(handle)
      if (!collider) return false
      
      const bodyHandle = collider.parent()
      const body = physicsWorld.getRigidBody(bodyHandle)
      
      return body && body.isFixed() && collider.shapeType() === RAPIER.ShapeType.Cuboid
    }
  )
  
  return Array.isArray(intersections) && intersections.length > 0
}

function testDirectionalCollision(position, direction, excludeHandle) {
  const rayLength = PLAYER_RADIUS * 2.5
  
  const ray = new RAPIER.Ray(
    new RAPIER.Vector3(position.x, position.y, position.z),
    new RAPIER.Vector3(direction.x, direction.y, direction.z)
  )
  
  const hit = physicsWorld.castRay(
    ray, 
    rayLength, 
    true, 
    (handle) => {
      if (handle === excludeHandle) return false
      
      const collider = physicsWorld.getCollider(handle)
      if (!collider) return false
      
      const bodyHandle = collider.parent()
      const body = physicsWorld.getRigidBody(bodyHandle)
      
      return body && body.isFixed()
    }
  )
  
  return hit ? hit.toi < rayLength : false
}

function detectCollisionsInDirection(playerPos, direction, playerHandle) {
  const testDistance = PLAYER_RADIUS * 1.2
  const testPos = {
    x: playerPos.x + direction.x * testDistance,
    y: playerPos.y + direction.y * testDistance,
    z: playerPos.z + direction.z * testDistance
  }
  
  const halfHeight = PLAYER_HEIGHT / 2
  const radius = PLAYER_RADIUS
  const shape = new RAPIER.Capsule(halfHeight, radius)
  const pos = new RAPIER.Vector3(testPos.x, testPos.y, testPos.z)
  
  const playerBody = playerBodies[0]
  const rot = playerBody ? playerBody.rotation() : new RAPIER.Quaternion(0, 0, 0, 1)
  
  const intersections = physicsWorld.intersectionsWithShape(
    pos, rot, shape, (handle) => {
      if (handle === playerHandle) return false
      
      const collider = physicsWorld.getCollider(handle)
      if (!collider) return false
      
      const bodyHandle = collider.parent()
      const body = physicsWorld.getRigidBody(bodyHandle)
      
      return body && body.isFixed()
    }
  )
  
  return Array.isArray(intersections) && intersections.length > 0
}

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

function applyPlanetGravity() {
  for (let i = 0; i < playerBodies.length; i++) {
    if (playerFallingStates[i] && playerBodies[i] && planetBody) {
      const playerPos = playerBodies[i].translation()
      const planetPos = planetBody.translation()
      
      const gravityDirection = new THREE.Vector3(
        planetPos.x - playerPos.x,
        planetPos.y - playerPos.y,
        planetPos.z - playerPos.z
      )
      
      const distance = gravityDirection.length()
      if (distance === 0) continue
      
      gravityDirection.normalize()
      const gravitationalAcceleration = GRAVITY_STRENGTH / (distance * distance) * 0.0005
      
      playerVelocities[i].x += gravityDirection.x * gravitationalAcceleration
      playerVelocities[i].y += gravityDirection.y * gravitationalAcceleration
      playerVelocities[i].z += gravityDirection.z * gravitationalAcceleration
      
      const speed = playerVelocities[i].length()
      const maxSpeed = 0.2
      if (speed > maxSpeed) {
        playerVelocities[i].multiplyScalar(maxSpeed / speed)
      }
      
      const newPosition = {
        x: playerPos.x + playerVelocities[i].x,
        y: playerPos.y + playerVelocities[i].y,
        z: playerPos.z + playerVelocities[i].z
      }
      
      playerBodies[i].setTranslation(newPosition)
    } else if (!playerFallingStates[i]) {
      stickToSphere(playerBodies[i], planetBody)
    }
  }
  
  for (const objectBody of objectBodies) {
    if (objectBody && planetBody) {
      applyGravityToObject(objectBody, planetBody)
    }
  }
}

function handleCollisions() {
  eventQueue.drainCollisionEvents((handle1, handle2, started) => {
    const collider1 = physicsWorld.getCollider(handle1)
    const collider2 = physicsWorld.getCollider(handle2)
    
    if (!collider1 || !collider2) return
    
    const playerIndex = playerColliderMap.get(handle1) !== undefined 
      ? playerColliderMap.get(handle1) 
      : playerColliderMap.get(handle2)
    
    if (playerIndex !== undefined && started) {
      if (playerFallingStates[playerIndex]) {
        const playerBody = playerBodies[playerIndex]
        if (!playerBody) return
        
        const otherCollider = playerColliderMap.get(handle1) !== undefined ? collider2 : collider1
        const otherBodyHandle = otherCollider.parent()
        const otherBody = physicsWorld.getRigidBody(otherBodyHandle)
        
        if (otherBody) {
          if (otherBody === planetBody) {
            const playerPos = playerBody.translation()
            const planetPos = planetBody.translation()
            const normal = new THREE.Vector3(
              playerPos.x - planetPos.x,
              playerPos.y - planetPos.y,
              playerPos.z - planetPos.z
            ).normalize()
            
            playerFallingStates[playerIndex] = false
            stickToSphere(playerBody, planetBody)
            alignPlayerWithNormal(playerIndex, normal)
          } 
          else if (otherBody.isFixed()) {
            const playerPos = playerBody.translation()
            const otherPos = otherBody.translation()
            const normal = new THREE.Vector3(
              playerPos.x - otherPos.x,
              playerPos.y - otherPos.y,
              playerPos.z - otherPos.z
            ).normalize()
            
            playerFallingStates[playerIndex] = false
            landPlayerOnSurface(playerIndex, otherBody, otherCollider, normal)
            alignPlayerWithNormal(playerIndex, normal)
          }
        }
      }
    }
  })
}

function animate() {
  animationFrameId = requestAnimationFrame(animate)
  
  applyPlanetGravity()
  
  physicsWorld.step(eventQueue)
  
  handleCollisions()
  
  movePlayer()
  
  controls.update()
  
  if (planetBody && planetMesh) {
    const position = planetBody.translation()
    planetMesh.position.set(position.x, position.y, position.z)
  }
  
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
  
  for (let i = 0; i < surfaceCubeBodies.length; i++) {
    const body = surfaceCubeBodies[i]
    const mesh = surfaceCubeMeshes[i]
    
    if (body && mesh) {
      const position = body.translation()
      const rotation = body.rotation()
      
      mesh.position.set(position.x, position.y, position.z)
      mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
    }
  }
  
  renderer.render(scene, camera)
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}

function getPlayerColliderHandle(playerIndex) {
  for (const [handle, index] of playerColliderMap.entries()) {
    if (index === playerIndex) {
      return handle
    }
  }
  return null
}

function movePlayer() {
  if (playerBodies.length === 0) return
  
  const playerBody = playerBodies[0]
  if (!playerBody) return
  
  const playerPos = playerBody.translation()
  if (!playerPos || typeof playerPos.x !== 'number') return
  
  const isFalling = playerFallingStates[0]
  
  const playerHandle = getPlayerColliderHandle(0)
  if (!playerHandle) return
  
  const moveDirection = new THREE.Vector3(0, 0, 0)
  
  if (keys.w) moveDirection.z -= 1
  if (keys.s) moveDirection.z += 1
  if (keys.a) moveDirection.x -= 1
  if (keys.d) moveDirection.x += 1
  
  if (moveDirection.length() === 0) return
  
  moveDirection.normalize()
  
  const MOVE_SPEED = 0.1
  
  if (isFalling) {
    const rotation = playerBody.rotation()
    const playerQuaternion = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w)
    
    moveDirection.applyQuaternion(playerQuaternion)
    
    const planetPos = planetBody.translation()
    const toPlanet = new THREE.Vector3(
      planetPos.x - playerPos.x, 
      planetPos.y - playerPos.y, 
      planetPos.z - playerPos.z
    ).normalize()
    
    const distance = new THREE.Vector3(
      planetPos.x - playerPos.x,
      planetPos.y - playerPos.y,
      planetPos.z - playerPos.z
    ).length()
    
    if (distance <= PLANET_RADIUS + PLAYER_RADIUS + 0.1) {
      playerFallingStates[0] = false
      const normal = stickToSphere(playerBody, planetBody)
      alignPlayerWithNormal(0, normal)
      return
    }
    
    const newPosition = {
      x: playerPos.x + moveDirection.x * MOVE_SPEED * 0.5,
      y: playerPos.y + moveDirection.y * MOVE_SPEED * 0.5,
      z: playerPos.z + moveDirection.z * MOVE_SPEED * 0.5
    }
    
    playerVelocities[0].add(toPlanet.multiplyScalar(0.005))
    
    newPosition.x += playerVelocities[0].x
    newPosition.y += playerVelocities[0].y
    newPosition.z += playerVelocities[0].z
    
    const wouldCollide = detectCollisionsInDirection(
      playerPos, 
      new THREE.Vector3(
        newPosition.x - playerPos.x,
        newPosition.y - playerPos.y,
        newPosition.z - playerPos.z
      ).normalize(), 
      playerHandle
    )
    
    if (!wouldCollide) {
      playerBody.setTranslation(newPosition)
    } else {
      playerFallingStates[0] = false
      
      const normal = stickToSphere(playerBody, planetBody)
      alignPlayerWithNormal(0, normal)
    }
  } else {
    const planetPos = planetBody.translation()
    
    const surfaceNormal = stickToSphere(playerBody, planetBody)
    
    const rotation = playerBody.rotation()
    const playerQuat = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w)
    const playerForward = new THREE.Vector3(0, 0, -1).applyQuaternion(playerQuat)
    
    const rightDir = new THREE.Vector3().crossVectors(playerForward, surfaceNormal).normalize()
    const adjustedForward = new THREE.Vector3().crossVectors(surfaceNormal, rightDir).normalize()
    
    const localMoveDir = new THREE.Vector3()
    if (keys.w) localMoveDir.add(adjustedForward)
    if (keys.s) localMoveDir.sub(adjustedForward)
    if (keys.a) localMoveDir.sub(rightDir)
    if (keys.d) localMoveDir.add(rightDir)
    
    if (localMoveDir.length() > 0) {
      localMoveDir.normalize()
      
      if (isCollidingWithCube(playerPos, playerHandle, true)) {
        stickToSphere(playerBody, planetBody)
        return
      }
      
      const collisionDetected = 
        detectCollisionsInDirection(playerPos, localMoveDir, playerHandle) ||
        raycastHitsCube(playerPos, localMoveDir, PLAYER_RADIUS * 2.0)
      
      if (!collisionDetected) {
        const newPosition = {
          x: playerPos.x + localMoveDir.x * MOVE_SPEED,
          y: playerPos.y + localMoveDir.y * MOVE_SPEED,
          z: playerPos.z + localMoveDir.z * MOVE_SPEED
        }
        
        const dirToSphere = new THREE.Vector3(
          newPosition.x - planetPos.x,
          newPosition.y - planetPos.y,
          newPosition.z - planetPos.z
        ).normalize()
        
        const surfacePosition = {
          x: planetPos.x + dirToSphere.x * (PLANET_RADIUS + PLAYER_RADIUS),
          y: planetPos.y + dirToSphere.y * (PLANET_RADIUS + PLAYER_RADIUS),
          z: planetPos.z + dirToSphere.z * (PLANET_RADIUS + PLAYER_RADIUS)
        }
        
        const collisionAtSurface = detectCollisionsInDirection(
          playerPos,
          new THREE.Vector3(
            surfacePosition.x - playerPos.x,
            surfacePosition.y - playerPos.y,
            surfacePosition.z - playerPos.z
          ).normalize(),
          playerHandle
        )
        
        if (!collisionAtSurface) {
          playerBody.setTranslation(surfacePosition)
          
          const upVector = new THREE.Vector3(0, 1, 0)
          const alignmentQuat = new THREE.Quaternion().setFromUnitVectors(upVector, dirToSphere)
          
          const stdForward = new THREE.Vector3(0, 0, -1)
          const localForward = stdForward.clone().applyQuaternion(alignmentQuat)
          
          const angle = Math.atan2(
            new THREE.Vector3().crossVectors(localForward, localMoveDir).dot(dirToSphere),
            localForward.dot(localMoveDir)
          )
          
          const rotateQuat = new THREE.Quaternion().setFromAxisAngle(dirToSphere, angle)
          const finalQuat = alignmentQuat.clone().premultiply(rotateQuat)
          
          playerBody.setRotation({
            x: finalQuat.x,
            y: finalQuat.y,
            z: finalQuat.z,
            w: finalQuat.w
          })
        }
      } else {
        const rayResults = []
        const numRays = 8
        
        for (let i = 0; i < numRays; i++) {
          const angle = (i / numRays) * Math.PI * 2
          const rayDir = new THREE.Vector3(
            Math.cos(angle), 
            0, 
            Math.sin(angle)
          )
          
          const dot = rayDir.dot(surfaceNormal)
          rayDir.sub(surfaceNormal.clone().multiplyScalar(dot))
          rayDir.normalize()
          
          const isBlocked = testDirectionalCollision(playerPos, rayDir, playerHandle)
          
          if (!isBlocked) {
            const directionMatch = rayDir.dot(localMoveDir)
            
            if (directionMatch > 0.1) {
              rayResults.push({
                direction: rayDir,
                match: directionMatch
              })
            }
          }
        }
        
        if (rayResults.length > 0) {
          rayResults.sort((a, b) => b.match - a.match)
          const bestDir = rayResults[0].direction
          
          const slidePosition = {
            x: playerPos.x + bestDir.x * MOVE_SPEED * 0.7,
            y: playerPos.y + bestDir.y * MOVE_SPEED * 0.7,
            z: playerPos.z + bestDir.z * MOVE_SPEED * 0.7
          }
          
          const dirToSphere = new THREE.Vector3(
            slidePosition.x - planetPos.x,
            slidePosition.y - planetPos.y,
            slidePosition.z - planetPos.z
          ).normalize()
          
          const slideSurfacePosition = {
            x: planetPos.x + dirToSphere.x * (PLANET_RADIUS + PLAYER_RADIUS),
            y: planetPos.y + dirToSphere.y * (PLANET_RADIUS + PLAYER_RADIUS),
            z: planetPos.z + dirToSphere.z * (PLANET_RADIUS + PLAYER_RADIUS)
          }
          
          playerBody.setTranslation(slideSurfacePosition)
        }
      }
    }
  }
}

function stickToSphere(playerBody, planetBody) {
  if (!playerBody || !planetBody) return null
  
  const playerPos = playerBody.translation()
  const planetPos = planetBody.translation()
  
  const toPlayer = new THREE.Vector3(
    playerPos.x - planetPos.x,
    playerPos.y - planetPos.y,
    playerPos.z - planetPos.z
  )
  
  const distance = toPlayer.length()
  if (distance === 0) return null
  
  toPlayer.normalize()
  
  const surfacePosition = {
    x: planetPos.x + toPlayer.x * (PLANET_RADIUS + PLAYER_RADIUS),
    y: planetPos.y + toPlayer.y * (PLANET_RADIUS + PLAYER_RADIUS),
    z: planetPos.z + toPlayer.z * (PLANET_RADIUS + PLAYER_RADIUS)
  }
  
  const offset = 0.1
  const isCloseEnough = Math.abs(surfacePosition.y - playerPos.y) < offset
  
  if (!isCloseEnough) {
    playerBody.setTranslation(surfacePosition)
  }
  
  return toPlayer
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
