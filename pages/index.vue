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
  
  const playerBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, planetRadius + 10, 0)
  )
  
  world.createCollider(
    RAPIER.ColliderDesc.capsule(playerHeight / 2 - playerRadius, playerRadius)
      .setRestitution(0.1)
      .setFriction(5.0), // Increased friction from 2.0 to 5.0 to reduce sliding
    playerBody
  )
  
  // Set higher damping values to reduce sliding
  playerBody.setLinearDamping(0.5);
  playerBody.setAngularDamping(0.99);

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
    
    if (falling) {
      const pos = playerBody.translation()
      const dir = new THREE.Vector3(-pos.x, -pos.y, -pos.z).normalize()
      playerBody.addForce({ x: dir.x * 35, y: dir.y * 35, z: dir.z * 35 })
    } else {
      const pos = playerBody.translation()
      const dir = new THREE.Vector3(-pos.x, -pos.y, -pos.z).normalize()
      playerBody.addForce({ x: dir.x * 30, y: dir.y * 30, z: dir.z * 30 })
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
      
      // Get the direction from player to planet center for proper alignment on landing
      const playerPos = playerBody.translation()
      const toPlanet = new THREE.Vector3(-playerPos.x, -playerPos.y, -playerPos.z).normalize()
      
      // When landing, set the initial rotation to align with the planet surface
      // but preserve any yaw the player had before landing
      const alignQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), toPlanet);
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(toPlanet, playerYaw);
      const finalQuat = new THREE.Quaternion().multiplyQuaternions(yawQuat, alignQuat);
      
      // Set the rigid body rotation to match our calculated orientation
      playerBody.setRotation({
        x: finalQuat.x,
        y: finalQuat.y,
        z: finalQuat.z,
        w: finalQuat.w
      });
      
      // Apply angular damping to prevent rolling
      playerBody.setAngularDamping(0.99);
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
        // Apply a negative yaw to fix the inversion problem
        moveDir.normalize().applyAxisAngle(groundNormal, -playerYaw)
        const tangent = moveDir.clone().projectOnPlane(groundNormal)
        
        // Check if we're on the planet
        const playerPos = playerBody.translation()
        const toPlanetCenter = new THREE.Vector3(-playerPos.x, -playerPos.y, -playerPos.z)
        const distToPlanetCenter = toPlanetCenter.length()
        const onPlanet = Math.abs(distToPlanetCenter - (planetRadius + playerHeight/2)) < 0.2
        
        // Get current linear velocity
        const vel = playerBody.linvel();
        const currentVelocity = new THREE.Vector3(vel.x, vel.y, vel.z);
        
        if (onPlanet) {
          // Calculate target velocity for movement (faster than before for responsive feel)
          const moveSpeed = 5.0; // Units per second
          const targetVelocity = tangent.clone().multiplyScalar(moveSpeed);
          
          // Calculate the velocity change needed
          // This directly sets the velocity rather than just applying a force
          const velocityChange = new THREE.Vector3();
          velocityChange.subVectors(targetVelocity, currentVelocity.projectOnPlane(groundNormal));
          
          // Apply impulse to change velocity directly - much more responsive than forces
          playerBody.applyImpulse({
            x: velocityChange.x,
            y: velocityChange.y,
            z: velocityChange.z
          }, true);
          
          // Apply a strong force toward the planet to maintain contact
          const gravityStrength = 30; // Increased from 15
          const normalForce = toPlanetCenter.normalize().multiplyScalar(gravityStrength);
          playerBody.addForce({ 
            x: normalForce.x, 
            y: normalForce.y, 
            z: normalForce.z 
          });
          
          // Counter any velocity in the normal direction that would cause sliding off the surface
          const normalVelocity = currentVelocity.dot(toPlanetCenter.normalize());
          if (normalVelocity < 0) {
            // If moving away from surface, apply counteracting impulse
            const counterForce = toPlanetCenter.normalize().multiplyScalar(-normalVelocity * 0.8);
            playerBody.applyImpulse({
              x: counterForce.x,
              y: counterForce.y,
              z: counterForce.z
            }, true);
          }
        } else {
          // On other objects, use a similar approach but with different parameters
          const moveSpeed = 4.0;
          const targetVelocity = tangent.clone().multiplyScalar(moveSpeed);
          
          const velocityChange = new THREE.Vector3();
          velocityChange.subVectors(targetVelocity, currentVelocity.projectOnPlane(groundNormal));
          
          playerBody.applyImpulse({
            x: velocityChange.x,
            y: velocityChange.y,
            z: velocityChange.z
          }, true);
          
          // Apply stronger normal force to stay on other objects
          playerBody.addForce({
            x: groundNormal.x * 20,
            y: groundNormal.y * 20,
            z: groundNormal.z * 20
          });
        }
      } else {
        // When not actively moving, dampen horizontal velocity to prevent sliding
        const vel = playerBody.linvel();
        const velocity = new THREE.Vector3(vel.x, vel.y, vel.z);
        const playerPos = playerBody.translation();
        const toPlanetCenter = new THREE.Vector3(-playerPos.x, -playerPos.y, -playerPos.z).normalize();
        
        // Project velocity onto the surface tangent plane
        const tangentialVelocity = velocity.clone().projectOnPlane(toPlanetCenter);
        
        if (tangentialVelocity.length() > 0.1) {
          // Apply an impulse to counteract tangential velocity
          const dampingFactor = 0.8; // How much to dampen velocity per frame
          playerBody.applyImpulse({
            x: -tangentialVelocity.x * dampingFactor,
            y: -tangentialVelocity.y * dampingFactor, 
            z: -tangentialVelocity.z * dampingFactor
          }, true);
        }
        
        // Still maintain the normal force toward the planet
        playerBody.addForce({
          x: toPlanetCenter.x * 30,
          y: toPlanetCenter.y * 30,
          z: toPlanetCenter.z * 30
        });
      }
      
      if (keys['Space']) {
        // Jump force - directly set velocity in the normal direction
        const jumpSpeed = 10.0;
        const jumpVel = new THREE.Vector3(
          groundNormal.x * jumpSpeed,
          groundNormal.y * jumpSpeed,
          groundNormal.z * jumpSpeed
        );
        
        // Get current velocity
        const vel = playerBody.linvel();
        const currentVel = new THREE.Vector3(vel.x, vel.y, vel.z);
        
        // Add jump velocity to horizontal velocity
        const horizontalVel = currentVel.projectOnPlane(groundNormal);
        const newVel = horizontalVel.add(jumpVel);
        
        // Set the velocity directly
        playerBody.setLinvel({
          x: newVel.x,
          y: newVel.y,
          z: newVel.z
        }, true);
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
      // For grounded movement, we want:
      // 1. The player's feet aligned with the surface normal
      // 2. The entire player rotating with yaw (left/right input)
      // 3. The camera pitching up/down like a neck
      
      // STEP 1: Determine the up vector (surface normal or direction to planet center)
      let up = groundNormal.clone();
      
      // If we're on the planet, always use direction to center as up
      const toPlanetCenter = new THREE.Vector3(-playerPos.x, -playerPos.y, -playerPos.z);
      const onPlanet = toPlanetCenter.length() < planetRadius * 1.5;
      if (onPlanet) {
        up.copy(toPlanetCenter.normalize());
      }
      
      // STEP 2: Create the player's orientation
      // First align with surface by rotating from world-up to surface-normal
      const alignQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      
      // Then apply yaw rotation around the surface normal (up vector) with negative sign
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(up, -playerYaw);
      
      // Combine: first align with surface, then apply yaw rotation
      const playerQuat = new THREE.Quaternion().multiplyQuaternions(yawQuat, alignQuat);
      
      // STEP 3: Apply the rotation to both visual mesh and physics body
      playerMesh.quaternion.copy(playerQuat);
      
      // Apply the same rotation to the physics body to ensure consistent behavior
      playerBody.setRotation({
        x: playerQuat.x, 
        y: playerQuat.y, 
        z: playerQuat.z, 
        w: playerQuat.w
      });
      
      // STEP 4: Calculate player's local coordinate system for camera placement
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(playerQuat);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(playerQuat);
      
      // STEP 5: Position camera at player's head
      const headPos = playerMesh.position.clone().add(
        cameraOffset.clone().applyQuaternion(playerQuat)
      );
      camera.position.copy(headPos);
      
      // STEP 6: Set camera orientation
      // Start with the player's orientation (includes alignment to surface + yaw)
      camera.quaternion.copy(playerQuat);
      
      // Only add pitch rotation to the camera (not to the player)
      // This rotates around the local right axis, like a neck
      camera.rotateOnAxis(right, cameraPitch);
    } else {
      // When falling, handle differently
      
      // Create quaternion for the camera's orientation in free fall
      const freefallQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(cameraPitch, cameraYaw, 0, 'YXZ')
      );
      
      // Apply the rotation to the player mesh
      playerMesh.quaternion.copy(new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, cameraYaw, 0, 'YXZ')
      ));
      
      // Position camera at player's head using the same offset logic as on ground
      const headPos = playerMesh.position.clone().add(
        cameraOffset.clone().applyQuaternion(playerMesh.quaternion)
      );
      camera.position.copy(headPos);
      
      // Set camera orientation based on freefallQuat
      camera.quaternion.copy(freefallQuat);
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
