<template>
  <div @click="lockControls" style="width: 100vw; height: 100vh;">
    <canvas ref="canvas" style="width: 100vw; height: 100vh; display: block;"></canvas>
    <div v-if="!isPointerLocked" class="instructions">
      Click to play
    </div>
    <div v-if="isPointerLocked" class="crosshair">+</div>
    <div id="stats" class="stats"></div>
    <div id="instructions" class="game-instructions">
      WASD: Move, Space: Jump, Click: Shoot
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import Stats from 'three/addons/libs/stats.module.js'

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
  
  // Initialize stats
  const stats = new Stats()
  document.getElementById('stats').appendChild(stats.dom)
  
  const renderer = new THREE.WebGLRenderer({ 
    canvas: canvas.value,
    antialias: true
  })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x222233)
  
  // Improved lighting
  const dirLight = new THREE.DirectionalLight(0xffffff, 1)
  dirLight.position.set(10, 20, 10)
  dirLight.castShadow = true
  dirLight.shadow.camera.near = 0.1
  dirLight.shadow.camera.far = 200
  dirLight.shadow.camera.right = 50
  dirLight.shadow.camera.left = -50
  dirLight.shadow.camera.top = 50
  dirLight.shadow.camera.bottom = -50
  dirLight.shadow.mapSize.width = 1024
  dirLight.shadow.mapSize.height = 1024
  scene.add(dirLight)
  
  const ambientLight = new THREE.AmbientLight(0x888888)
  scene.add(ambientLight)
  
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000)
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 })

  // Window resize handler
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  const planetRadius = 30
  const planetMesh = new THREE.Mesh(
    new THREE.SphereGeometry(planetRadius, 64, 64), 
    new THREE.MeshStandardMaterial({ 
      color: 0x2266cc,
      roughness: 0.8,
      metalness: 0.2
    })
  )
  planetMesh.receiveShadow = true
  scene.add(planetMesh)
  
  const planetBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(
    RAPIER.ColliderDesc.ball(planetRadius)
      .setFriction(10.0)
      .setRestitution(0.2),
    planetBody
  )

  const playerHeight = 2, playerRadius = 0.5
  const playerMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(playerRadius, playerHeight - 2 * playerRadius, 16, 8),
    new THREE.MeshStandardMaterial({ color: 0xffaa00 })
  )
  playerMesh.castShadow = true
  scene.add(playerMesh)
  
  // Create player body as kinematic instead of dynamic
  const playerBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(0, planetRadius + 10, 0)
  )
  
  world.createCollider(
    RAPIER.ColliderDesc.capsule(playerHeight / 2 - playerRadius, playerRadius)
      .setRestitution(0.1)
      .setFriction(5.0),
    playerBody
  )
  
  // We won't need damping for kinematic bodies, but we'll set it for when we switch to dynamic
  const playerDynamicSettings = {
    linearDamping: 0.5,
    angularDamping: 0.99
  }

  // Create a head position for the camera
  const cameraOffset = new THREE.Vector3(0, playerHeight / 2 - playerRadius, 0)

  // Weapon mesh with improved appearance
  const weaponMesh = new THREE.Group()
  
  // Gun barrel
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8),
    new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.8 })
  )
  barrel.rotation.x = Math.PI / 2
  barrel.position.z = -0.4
  barrel.position.y = -0.15
  barrel.castShadow = true
  weaponMesh.add(barrel)
  
  // Gun handle
  const handle = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.2, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x222222 })
  )
  handle.position.y = -0.3
  handle.position.z = -0.25
  handle.castShadow = true
  weaponMesh.add(handle)
  
  weaponMesh.position.set(0.3, -0.25, -0.3)
  camera.add(weaponMesh)
  scene.add(camera)
  
  // Setup raycaster for shooting
  const raycaster = new THREE.Raycaster()
  const shootDirection = new THREE.Vector3()
  const shootOrigin = new THREE.Vector3()
  
  // Create objects array to store interactable objects
  const interactableObjects = []

  // Create a variety of physics objects
  const objectTypes = [
    { 
      geometry: new THREE.BoxGeometry(1, 1, 1),
      colliderFn: (size) => RAPIER.ColliderDesc.cuboid(size/2, size/2, size/2)
    },
    { 
      geometry: new THREE.SphereGeometry(0.6, 16, 16),
      colliderFn: (size) => RAPIER.ColliderDesc.ball(size)
    },
    { 
      geometry: new THREE.CylinderGeometry(0.5, 0.5, 1, 16),
      colliderFn: (size) => RAPIER.ColliderDesc.cylinder(size/2, size)
    },
    { 
      geometry: new THREE.TorusGeometry(0.5, 0.2, 16, 32),
      createMesh: () => {
        // For complex shapes, we'll use convex hull
        const torus = new THREE.Mesh(
          new THREE.TorusGeometry(0.5, 0.2, 16, 32),
          new THREE.MeshStandardMaterial({ 
            color: Math.random() * 0xffffff,
            roughness: 0.7,
            metalness: 0.3
          })
        )
        torus.castShadow = true
        return torus
      },
      createCollider: (body) => {
        const torusTemp = new THREE.TorusGeometry(0.5, 0.2, 8, 16)
        const vertices = new Float32Array(torusTemp.attributes.position.array)
        return world.createCollider(
          RAPIER.ColliderDesc.convexHull(vertices)
            .setRestitution(0.7)
            .setFriction(0.5),
          body
        )
      }
    }
  ]

  for (let i = 0; i < 15; i++) {
    // Select a random object type
    const typeIndex = Math.floor(Math.random() * objectTypes.length)
    const objectType = objectTypes[typeIndex]
    
    // Calculate a safe starting position
    let posX = Math.random() * 20 - 10
    let posY = planetRadius + 4 + i * 1.5
    let posZ = Math.random() * 20 - 10
    
    const size = 0.5 + Math.random() * 0.5
    
    // Ensure position is outside planet radius
    const distanceToCenter = Math.sqrt(posX*posX + posY*posY + posZ*posZ)
    if (distanceToCenter < planetRadius + size + 0.5) {
      const scale = (planetRadius + size + 0.5) / distanceToCenter
      posX *= scale
      posY *= scale
      posZ *= scale
    }
    
    // Create the Rapier rigid body
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(posX, posY, posZ)
      .setLinearDamping(0.2)
      .setAngularDamping(0.3)
      
    const body = world.createRigidBody(bodyDesc)
    
    // Create the mesh and collider
    let mesh
    if (objectType.createMesh) {
      mesh = objectType.createMesh()
      objectType.createCollider(body)
    } else {
      mesh = new THREE.Mesh(
        objectType.geometry,
        new THREE.MeshStandardMaterial({ 
          color: Math.random() * 0xffffff,
          roughness: 0.7,
          metalness: 0.3
        })
      )
      mesh.castShadow = true
      
      world.createCollider(
        objectType.colliderFn(size)
          .setRestitution(0.7)
          .setFriction(0.5),
        body
      )
    }
    
    mesh.scale.set(size, size, size)
    const pos = body.translation()
    mesh.position.set(pos.x, pos.y, pos.z)
    scene.add(mesh)
    
    interactableObjects.push({ mesh, body })
  }

  let falling = true, cameraPitch = 0, cameraYaw = 0, playerYaw = 0
  
  // Add velocity tracking for jumps and falls
  let playerVelocity = new THREE.Vector3(0, 0, 0)
  
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
  
  // Add shooting mechanic
  window.addEventListener('click', () => {
    if (!isPointerLocked.value) return
    
    // Get the shooting direction from the camera
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera)
    shootDirection.copy(raycaster.ray.direction)
    
    // Create bullet origin point at player's position plus offset
    shootOrigin.copy(camera.position)
    
    // Check for intersections with interactable objects
    const intersects = raycaster.intersectObjects(interactableObjects.map(obj => obj.mesh))
    
    if (intersects.length > 0) {
      // Find which object was hit
      const hitObject = interactableObjects.find(obj => obj.mesh === intersects[0].object)
      
      if (hitObject) {
        // Apply impulse in shooting direction
        const impulseStrength = 10.0
        const impulse = {
          x: shootDirection.x * impulseStrength,
          y: shootDirection.y * impulseStrength,
          z: shootDirection.z * impulseStrength
        }
        
        hitObject.body.applyImpulseAtPoint(
          impulse,
          {
            x: intersects[0].point.x,
            y: intersects[0].point.y,
            z: intersects[0].point.z
          },
          true
        )
      }
    }
    
    // Optionally, create a visual effect for shooting (muzzle flash or tracer)
    const muzzleFlash = new THREE.PointLight(0xff9933, 2, 5)
    muzzleFlash.position.copy(weaponMesh.position)
    muzzleFlash.position.z -= 0.5
    camera.add(muzzleFlash)
    
    // Remove the muzzle flash after a short time
    setTimeout(() => {
      camera.remove(muzzleFlash)
    }, 50)
  })

  function animate() {
    stats.begin()
    
    // Apply gravity to dynamic objects
    world.forEachRigidBody(body => {
      if (body.isDynamic() && body !== playerBody) {
        const pos = body.translation()
        const dir = new THREE.Vector3(-pos.x, -pos.y, -pos.z).normalize()
        
        body.addForce({ x: dir.x * 25, y: dir.y * 25, z: dir.z * 25 })
        
        // Add a small outward force if they're getting too close to center to prevent clipping
        const distToCenter = Math.sqrt(pos.x*pos.x + pos.y*pos.y + pos.z*pos.z)
        if (distToCenter < planetRadius + 0.5) {
          const pushFactor = 20 / Math.max(0.1, distToCenter - planetRadius);
          body.addForce({ 
            x: dir.x * -pushFactor, 
            y: dir.y * -pushFactor, 
            z: dir.z * -pushFactor 
          })
        }
      }
    })
    
    // Get player position
    const playerPos = playerBody.translation()
    const playerPosition = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z)
    
    // Calculate direction to planet center
    const toPlanetCenter = new THREE.Vector3(-playerPos.x, -playerPos.y, -playerPos.z)
    const distanceToPlanet = toPlanetCenter.length()
    const normalToPlanet = toPlanetCenter.clone().normalize()
    
    // Check if player should be grounded
    let onGround = false
    
    // When in falling state, check if we've hit the ground
    if (falling) {
      // Apply gravity
      playerVelocity.add(normalToPlanet.clone().multiplyScalar(0.2))
      
      // Check for collision with planet
      if (distanceToPlanet <= planetRadius + playerHeight/2 + 0.05) {
        // Land on planet
        onGround = true
        falling = false
        
        // Position exactly on surface
        const newPosition = normalToPlanet.clone().multiplyScalar(-(planetRadius + playerHeight/2))
        playerPosition.copy(newPosition)
        
        // Zero out velocity when landing
        playerVelocity.set(0, 0, 0)
        
        // Switch to kinematic body
        playerBody.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased)
        
        // When landing, align with the planet surface
        const alignQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normalToPlanet.clone().negate())
        const yawQuat = new THREE.Quaternion().setFromAxisAngle(normalToPlanet.clone().negate(), playerYaw)
        const finalQuat = new THREE.Quaternion().multiplyQuaternions(yawQuat, alignQuat)
        
        playerBody.setRotation({
          x: finalQuat.x,
          y: finalQuat.y,
          z: finalQuat.z,
          w: finalQuat.w
        })
      } else {
        // Check for collision with other objects using a query instead of contactsWith
        const playerBodyHandle = playerBody.handle
        const playerPos = playerBody.translation()
        
        // Get the player's collider - assuming it's the first (and only) one attached to the player body
        let playerCollider = null
        world.forEachCollider(collider => {
          if (collider.parent() === playerBodyHandle) {
            playerCollider = collider;
          }
        });
        
        if (playerCollider) {
          // Use the intersection test to check for contacts with other objects
          let contactFound = false;
          
          // Check for intersection with all other colliders in the world
          world.forEachCollider(otherCollider => {
            // Skip if it's the player's own collider
            if (otherCollider.handle === playerCollider.handle) return;
            
            // Check for intersection
            if (world.intersectionPair(playerCollider, otherCollider)) {
              contactFound = true;
            }
          });
          
          if (contactFound) {
            onGround = true;
            falling = false;
            playerVelocity.set(0, 0, 0);
            
            // Switch to kinematic body
            playerBody.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased);
          }
        }
      }
      
      // Update position with velocity
      if (falling) {
        playerPosition.add(playerVelocity)
        
        // Apply air control
        let moveDir = new THREE.Vector3(
          (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0),
          0,
          (keys['KeyS'] ? 1 : 0) - (keys['KeyW'] ? 1 : 0)
        )
        
        if (moveDir.length() > 0) {
          moveDir.normalize().applyEuler(new THREE.Euler(0, cameraYaw, 0))
          const airControl = 0.1
          playerVelocity.x += moveDir.x * airControl
          playerVelocity.z += moveDir.z * airControl
        }
        
        // Set position directly for kinematic body
        playerBody.setTranslation({
          x: playerPosition.x,
          y: playerPosition.y,
          z: playerPosition.z
        })
      }
    } else {
      // We're on the ground (kinematic movement)
      
      // Handle movement based on keys
      let moveDir = new THREE.Vector3(
        (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0),
        0,
        (keys['KeyS'] ? 1 : 0) - (keys['KeyW'] ? 1 : 0)
      )
      
      if (moveDir.length() > 0) {
        // Calculate move direction in player's local space
        moveDir.normalize().applyAxisAngle(normalToPlanet.clone().negate(), -playerYaw)
        
        // Project onto tangent plane of the sphere
        const tangent = moveDir.projectOnPlane(normalToPlanet)
        
        // Move along the surface
        const moveSpeed = 0.15 // Speed per frame
        const movement = tangent.multiplyScalar(moveSpeed)
        
        // Update position
        playerPosition.add(movement)
        
        // Project back onto the sphere's surface to ensure we stay exactly on it
        const newDistanceFromCenter = playerPosition.length()
        const correctDistance = planetRadius + playerHeight/2
        playerPosition.normalize().multiplyScalar(correctDistance)
        
        // Set the position directly
        playerBody.setTranslation({
          x: playerPosition.x,
          y: playerPosition.y,
          z: playerPosition.z
        })
      }
      
      // Handle jumping
      if (keys['Space']) {
        // Calculate the contact point (feet position)
        const contactPoint = playerPosition.clone().normalize().multiplyScalar(planetRadius)
        
        // Set to falling state
        falling = true
        
        // Cache the current camera orientation before switching to falling mode
        cameraYaw = playerYaw
        
        // Switch to dynamic body for physics-based movement
        playerBody.setBodyType(RAPIER.RigidBodyType.Dynamic)
        playerBody.setLinearDamping(playerDynamicSettings.linearDamping)
        playerBody.setAngularDamping(playerDynamicSettings.angularDamping)
        
        // Apply jump impulse directly away from contact point
        const jumpForce = 8.0
        const jumpDir = playerPosition.clone().sub(contactPoint).normalize()
        playerVelocity = jumpDir.multiplyScalar(jumpForce)
        
        // Apply the impulse to the body
        playerBody.setLinvel({
          x: playerVelocity.x,
          y: playerVelocity.y,
          z: playerVelocity.z
        }, true)
      }
    }

    // Update player mesh position
    const updatedPlayerPos = playerBody.translation()
    playerMesh.position.set(updatedPlayerPos.x, updatedPlayerPos.y, updatedPlayerPos.z)
    
    // Update rotation based on whether grounded or falling
    if (!falling) {
      // On ground: Align with surface and handle yaw
      const up = new THREE.Vector3(-updatedPlayerPos.x, -updatedPlayerPos.y, -updatedPlayerPos.z).normalize().negate()
      
      // Align with surface by rotating from world-up to surface normal
      const alignQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up)
      
      // Apply yaw rotation around the surface normal
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(up, -playerYaw)
      
      // Combine: first align with surface, then apply yaw
      const playerQuat = new THREE.Quaternion().multiplyQuaternions(yawQuat, alignQuat)
      
      // Apply the rotation to player mesh
      playerMesh.quaternion.copy(playerQuat)
      
      // Update physics body rotation
      playerBody.setRotation({
        x: playerQuat.x,
        y: playerQuat.y,
        z: playerQuat.z,
        w: playerQuat.w
      })
      
      // Calculate the exact player's feet position (contact point with planet)
      const feetPosition = playerMesh.position.clone().sub(
        up.clone().multiplyScalar(playerHeight/2)
      )
      
      // Find forward and right directions based on player orientation
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(playerQuat)
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(playerQuat)
      
      // Position camera relative to feet position, not the player's center
      // First position at feet
      camera.position.copy(feetPosition);
      // Then move up to head height
      camera.position.add(up.clone().multiplyScalar(playerHeight));
      // Then add the camera offset
      camera.position.add(cameraOffset.clone().applyQuaternion(playerQuat));
      
      // Set base camera orientation aligned with player
      camera.quaternion.copy(playerQuat);
      
      // Apply pitch rotation around the right axis
      camera.rotateOnAxis(right, -cameraPitch);
    } else {
      // In air - handle free orientation
      const freefallQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(cameraPitch, cameraYaw, 0, 'YXZ')
      )
      
      // Apply rotation to player mesh for visual representation
      playerMesh.quaternion.copy(new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, cameraYaw, 0, 'YXZ')
      ))
      
      // Position camera
      const headPos = playerMesh.position.clone().add(
        cameraOffset.clone().applyQuaternion(playerMesh.quaternion)
      )
      camera.position.copy(headPos)
      
      // Set camera orientation
      camera.quaternion.copy(freefallQuat)
    }
    
    // Update interactable objects positions and rotations
    interactableObjects.forEach(({ mesh, body }) => {
      const pos = body.translation()
      mesh.position.set(pos.x, pos.y, pos.z)
      const rot = body.rotation()
      mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w)
    })

    renderer.render(scene, camera)
    stats.end()
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
:global(html), :global(body) { 
    margin: 0; 
    padding: 0;
}

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

.crosshair {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: white;
  font-size: 24px;
  pointer-events: none;
}

.stats {
  position: absolute;
  top: 0;
  left: 0;
}

.game-instructions {
  position: absolute;
  left: 10px;
  top: 60px;
  color: white;
  font-family: monospace;
  font-size: 14px;
  background-color: rgba(0, 0, 0, 0.5);
  padding: 5px;
  border-radius: 3px;
  pointer-events: none;
}
</style>
