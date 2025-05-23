<template>
  <div class="game-container">
    <canvas ref="canvas"></canvas>
    <div v-if="debug" class="debug-info">
      <p>Grounded: {{ isGrounded }}</p>
      <p>Position: {{ playerPosition.x.toFixed(2) }}, {{ playerPosition.y.toFixed(2) }}, {{ playerPosition.z.toFixed(2) }}</p>
    </div>
  </div>
</template>

<script>
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { onMounted, onBeforeUnmount, ref, reactive } from 'vue';

export default {
  setup() {
    // Refs and reactive state
    const canvas = ref(null);
    const debug = ref(true);
    const isGrounded = ref(false);
    const playerPosition = reactive({ x: 0, y: 0, z: 0 });
    
    // Game state
    let scene, camera, renderer;
    let physicsWorld;
    let player, playerBody;
    let leftFootRay, rightFootRay;
    let planets = [];
    let keys = {};
    let clock = new THREE.Clock();
    const moveSpeed = 5;
    const jumpForce = 10;
    const gravityConstant = 100;
    
    // Initialize game
    const initGame = async () => {
      // Initialize Rapier physics with the new object-based syntax
      await RAPIER.init({});
      
      // Set up scene
      setupScene();
      
      // Set up physics
      setupPhysics();
      
      // Create environment
      createEnvironment();
      
      // Create player
      createPlayer();
      
      // Set up input handlers
      setupInputHandlers();
      
      // Start game loop
      animate();
    };
    
    // Set up Three.js scene
    const setupScene = () => {
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
      
      renderer = new THREE.WebGLRenderer({ 
        canvas: canvas.value,
        antialias: true 
      });
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(window.devicePixelRatio);
      
      // Add lights
      const ambientLight = new THREE.AmbientLight(0x404040);
      scene.add(ambientLight);
      
      const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
      directionalLight.position.set(10, 10, 10);
      scene.add(directionalLight);
      
      // Handle window resize
      window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      });
    };
    
    // Set up Rapier physics
    const setupPhysics = () => {
      const gravity = { x: 0, y: 0, z: 0 }; // Point gravity will be applied manually
      physicsWorld = new RAPIER.World(gravity);
    };
    
    // Create environment (platform and planet)
    const createEnvironment = () => {
      // Create cube platform (spawn point) - moved closer to player spawn
      const platformSize = { x: 20, y: 1, z: 20 };
      const platformPos = { x: 0, y: 22, z: 0 }; // Moved up to be closer to player spawn at y=25
      
      // Visual mesh
      const platformGeo = new THREE.BoxGeometry(platformSize.x, platformSize.y, platformSize.z);
      const platformMat = new THREE.MeshStandardMaterial({ color: 0x8888ff });
      const platformMesh = new THREE.Mesh(platformGeo, platformMat);
      platformMesh.position.set(platformPos.x, platformPos.y, platformPos.z);
      scene.add(platformMesh);
      
      // Physics body
      const platformDesc = RAPIER.ColliderDesc.cuboid(
        platformSize.x / 2, platformSize.y / 2, platformSize.z / 2
      );
      const platformCollider = physicsWorld.createCollider(
        platformDesc,
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(platformPos.x, platformPos.y, platformPos.z)
      );
      
      // Create sphere planet
      const planetRadius = 50;
      const planetPos = { x: 0, y: -100, z: 0 };
      
      // Visual mesh
      const planetGeo = new THREE.SphereGeometry(planetRadius, 32, 32);
      const planetMat = new THREE.MeshStandardMaterial({ color: 0x88ff88 });
      const planetMesh = new THREE.Mesh(planetGeo, planetMat);
      planetMesh.position.set(planetPos.x, planetPos.y, planetPos.z);
      scene.add(planetMesh);
      
      // Physics body
      const planetDesc = RAPIER.ColliderDesc.ball(planetRadius);
      const planetCollider = physicsWorld.createCollider(
        planetDesc,
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(planetPos.x, planetPos.y, planetPos.z)
      );
      
      // Add to planets array for gravity calculation
      planets.push({
        position: new THREE.Vector3(planetPos.x, planetPos.y, planetPos.z),
        radius: planetRadius,
        mass: planetRadius * 100 // Mass for gravity calculation
      });
    };
    
    // Create player
    const createPlayer = () => {
      // Player size
      const playerHeight = 2;
      const playerRadius = 0.5;
      const startPos = { x: 0, y: 25, z: 0 }; // Above the platform
      
      // Create visual mesh
      const playerGeo = new THREE.CapsuleGeometry(playerRadius, playerHeight - playerRadius * 2, 8, 8);
      const playerMat = new THREE.MeshStandardMaterial({ color: 0xff8888 });
      player = new THREE.Mesh(playerGeo, playerMat);
      player.position.set(startPos.x, startPos.y, startPos.z);
      scene.add(player);
      
      // Create physics body with modified settings
      const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(startPos.x, startPos.y, startPos.z)
        .setLinearDamping(0.2)
        .setAngularDamping(2.0)  // Increased to reduce auto-rotation
        .setCcdEnabled(true);    // Enable continuous collision detection
      
      playerBody = physicsWorld.createRigidBody(playerBodyDesc);
      
      const playerColliderDesc = RAPIER.ColliderDesc.capsule(
        playerHeight / 2 - playerRadius, playerRadius
      );
      const playerCollider = physicsWorld.createCollider(
        playerColliderDesc, playerBody
      );
      
      // Set up camera
      camera.position.set(0, playerHeight / 2, 0);
      player.add(camera);
      
      // Create foot rays for ground detection
      const footOffset = 0.3; // Distance between feet
      leftFootRay = new THREE.Raycaster(
        new THREE.Vector3(-footOffset, -playerHeight / 2, 0),
        new THREE.Vector3(0, -1, 0),
        0,
        0.2 // Ray length
      );
      rightFootRay = new THREE.Raycaster(
        new THREE.Vector3(footOffset, -playerHeight / 2, 0),
        new THREE.Vector3(0, -1, 0),
        0,
        0.2 // Ray length
      );
    };
    
    // Set up input handlers
    const setupInputHandlers = () => {
      // Keyboard events
      window.addEventListener('keydown', (e) => {
        keys[e.code] = true;
      });
      
      window.addEventListener('keyup', (e) => {
        keys[e.code] = false;
      });
      
      // Mouse lock for FPS controls
      canvas.value.addEventListener('click', () => {
        canvas.value.requestPointerLock();
      });
      
      // Mouse movement
      const onMouseMove = (e) => {
        if (document.pointerLockElement === canvas.value) {
          // Always allow camera rotation regardless of grounded state
          // Horizontal rotation (left/right)
          player.rotation.y -= e.movementX * 0.002;
          
          // Vertical rotation (up/down) - camera only
          camera.rotation.x = Math.max(
            -Math.PI / 2,
            Math.min(Math.PI / 2, camera.rotation.x - e.movementY * 0.002)
          );
          
          // Update physics body rotation to match player's visual rotation
          const playerQuat = new THREE.Quaternion();
          playerQuat.setFromEuler(new THREE.Euler(0, player.rotation.y, 0));
          
          // Set the physics body rotation to match the player's visual rotation
          playerBody.setRotation({
            x: playerQuat.x,
            y: playerQuat.y,
            z: playerQuat.z,
            w: playerQuat.w
          }, true);
        }
      };
      
      document.addEventListener('mousemove', onMouseMove);
    };
    
    // Calculate point gravity
    const applyPointGravity = () => {
      if (!playerBody) return;
      
      const playerPos = playerBody.translation();
      const playerPosition3 = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z);
      
      let totalForce = new THREE.Vector3(0, 0, 0);
      
      // Calculate gravity from all planets
      planets.forEach(planet => {
        // Try completely reversed approach - from planet to player should pull player to planet
        const direction = new THREE.Vector3().subVectors(playerPosition3, planet.position);
        const distance = direction.length();
        
        // Skip if inside the planet
        if (distance <= planet.radius) return;
        
        // Calculate gravity force (F = G * m1 * m2 / r^2)
        const forceMagnitude = gravityConstant * planet.mass / (distance * distance);
        
        // Normalize direction and multiply by force magnitude
        // Gravity pulls toward the planet, so apply force in negative direction
        direction.normalize().multiplyScalar(-forceMagnitude);
        totalForce.add(direction);
        
        // Debug output to see the gravity force being applied
        if (debug.value) {
          console.log(
            "Gravity direction:", 
            direction.x.toFixed(2), 
            direction.y.toFixed(2), 
            direction.z.toFixed(2),
            "Distance:", distance.toFixed(2),
            "Force:", forceMagnitude.toFixed(2)
          );
        }
      });
      
      // Apply gravity force
      try {
        playerBody.addForce({ 
          x: totalForce.x, 
          y: totalForce.y, 
          z: totalForce.z 
        }, true);
      } catch (e) {
        console.error("Error applying force:", e);
        
        // Fallback: try older API if needed
        try {
          playerBody.applyForce(
            { x: totalForce.x, y: totalForce.y, z: totalForce.z }, 
            { x: 0, y: 0, z: 0 }, // Apply at center of mass
            false
          );
        } catch (e2) {
          console.error("Both force application methods failed:", e2);
        }
      }
    };
    
    // Check if player is grounded and handle foot alignment
    const checkGrounded = () => {
      if (!player || !physicsWorld) return false;
      
      // Update ray positions and directions based on player orientation
      const playerPos = player.position;
      const playerUp = new THREE.Vector3(0, 1, 0).applyQuaternion(player.quaternion);
      const playerDown = playerUp.clone().negate();
      
      // Ensure the direction is normalized
      playerDown.normalize();
      
      // Position rays at player's feet
      const leftFootPos = new THREE.Vector3(-0.3, -1, 0)
        .applyQuaternion(player.quaternion)
        .add(playerPos);
      
      const rightFootPos = new THREE.Vector3(0.3, -1, 0)
        .applyQuaternion(player.quaternion)
        .add(playerPos);
      
      // Use the simple foot rays for ground detection
      let isGroundedCheck = false;
      
      try {
        // Cast simple rays directly from Three.js (not using Rapier)
        // Create rays for each foot
        leftFootRay.set(leftFootPos, playerDown);
        rightFootRay.set(rightFootPos, playerDown);
        
        // Create simple meshes array for intersection testing
        const meshesForRaycast = [];
        
        // Add platform and planet meshes to the array
        scene.traverse(object => {
          if (object instanceof THREE.Mesh && object !== player) {
            meshesForRaycast.push(object);
          }
        });
        
        // Do the raycast tests
        const leftIntersections = leftFootRay.intersectObjects(meshesForRaycast);
        const rightIntersections = rightFootRay.intersectObjects(meshesForRaycast);
        
        // Check if we hit the ground with either ray
        const leftHit = leftIntersections.length > 0 && leftIntersections[0].distance < 1.2;
        const rightHit = rightIntersections.length > 0 && rightIntersections[0].distance < 1.2;
        
        isGroundedCheck = leftHit || rightHit;
        
        if (debug.value) {
          console.log(
            "Ray ground detection:", 
            "Left ray hits:", leftIntersections.length > 0 ? leftIntersections[0].distance.toFixed(2) : "none",
            "Right ray hits:", rightIntersections.length > 0 ? rightIntersections[0].distance.toFixed(2) : "none",
            "Grounded:", isGroundedCheck
          );
        }
      } catch (e) {
        console.error("Ray-based ground detection failed:", e);
        
        // Fallback to simple distance check if raycasting fails
        const platformY = 22.5; // platform y (22) + half height (0.5)
        const distToPlatform = Math.abs(playerPos.y - platformY);
        
        if (distToPlatform < 1.6) {
          isGroundedCheck = true;
        }
        
        // Check distance to planet surface
        planets.forEach(planet => {
          const distToPlanet = player.position.distanceTo(planet.position) - planet.radius;
          if (distToPlanet < 1.6) {
            isGroundedCheck = true;
          }
        });
      }
      
      // If grounded, align feet to ground
      if (isGroundedCheck) {
        // Get world up vector as default
        const worldUp = new THREE.Vector3(0, 1, 0);
        
        // Use the planet direction for alignment if we're near the planet
        planets.forEach(planet => {
          const dirToPlanet = new THREE.Vector3()
            .subVectors(planet.position, player.position);
          const distToPlanet = dirToPlanet.length();
          
          // If we're near the planet, align to it
          if (distToPlanet < planet.radius * 1.5) {
            // Direction to planet center is our "down", so negate for "up"
            worldUp.copy(dirToPlanet).normalize().negate();
          }
        });
        
        // Align player to the ground normal (using planet direction as approximation)
        const targetUp = worldUp;
        const currentUp = new THREE.Vector3(0, 1, 0).applyQuaternion(player.quaternion);
        
        // Only adjust alignment if ground is not too steep (wall detection)
        const slopeAngle = targetUp.angleTo(currentUp);
        const maxSlopeAngle = Math.PI / 4; // 45 degrees
        
        if (slopeAngle < maxSlopeAngle) {
          // Create rotation to align player with ground
          const rotationAxis = new THREE.Vector3().crossVectors(currentUp, targetUp).normalize();
          if (rotationAxis.lengthSq() > 0.001) {
            const rotationAngle = currentUp.angleTo(targetUp);
            const rotationQuaternion = new THREE.Quaternion().setFromAxisAngle(
              rotationAxis, rotationAngle
            );
            
            // Apply rotation but keep y-rotation (heading) the same
            const currentYRotation = new THREE.Euler().setFromQuaternion(player.quaternion).y;
            
            // Apply ground alignment rotation
            player.quaternion.premultiply(rotationQuaternion);
            
            // Restore original y-rotation
            const newEuler = new THREE.Euler().setFromQuaternion(player.quaternion);
            newEuler.y = currentYRotation;
            player.quaternion.setFromEuler(newEuler);
          }
        }
      }
      
      return isGroundedCheck;
    };
    
    // Handle player movement
    const handlePlayerMovement = (delta) => {
      if (!playerBody) return;
      
      const playerTranslation = playerBody.translation();
      const linearVelocity = playerBody.linvel();
      
      // Update reactive position for debugging
      playerPosition.x = playerTranslation.x;
      playerPosition.y = playerTranslation.y;
      playerPosition.z = playerTranslation.z;
      
      // Check if player is grounded
      isGrounded.value = checkGrounded();
      
      // Calculate movement direction based on camera orientation
      const moveDirection = new THREE.Vector3(0, 0, 0);
      
      if (keys['KeyW']) moveDirection.z -= 1;
      if (keys['KeyS']) moveDirection.z += 1;
      if (keys['KeyA']) moveDirection.x -= 1;
      if (keys['KeyD']) moveDirection.x += 1;
      
      if (moveDirection.length() > 0) {
        moveDirection.normalize();
        
        // Transform direction based on player's rotation
        moveDirection.applyAxisAngle(new THREE.Vector3(0, 1, 0), player.rotation.y);
        
        // Different movement behavior based on grounded state
        if (isGrounded.value) {
          // Grounded movement
          playerBody.setLinvel({
            x: moveDirection.x * moveSpeed,
            y: linearVelocity.y,
            z: moveDirection.z * moveSpeed
          }, true);
        } else {
          // In-air movement (reduced control)
          try {
            playerBody.applyImpulse({
              x: moveDirection.x * moveSpeed * 0.1,
              y: 0,
              z: moveDirection.z * moveSpeed * 0.1
            }, true);
          } catch (e) {
            console.error("Error applying impulse:", e);
            // Fallback: try alternate API
            try {
              playerBody.addImpulse(
                { x: moveDirection.x * moveSpeed * 0.1, y: 0, z: moveDirection.z * moveSpeed * 0.1 },
                { x: 0, y: 0, z: 0 },
                false
              );
            } catch (e2) {
              console.error("Both impulse methods failed:", e2);
            }
          }
        }
      }
      
      // Handle jumping
      if (keys['Space'] && isGrounded.value) {
        // Get current up direction (aligned with gravity)
        const playerUp = new THREE.Vector3(0, 1, 0).applyQuaternion(player.quaternion);
        
        // Apply jump force in the up direction
        try {
          playerBody.applyImpulse({
            x: playerUp.x * jumpForce,
            y: playerUp.y * jumpForce,
            z: playerUp.z * jumpForce
          }, true);
        } catch (e) {
          console.error("Error applying jump force:", e);
          // Fallback: try alternate API
          try {
            playerBody.addImpulse(
              { x: playerUp.x * jumpForce, y: playerUp.y * jumpForce, z: playerUp.z * jumpForce },
              { x: 0, y: 0, z: 0 },
              false
            );
          } catch (e2) {
            console.error("Both jump methods failed:", e2);
          }
        }
      }
    };
    
    // Update physics and visuals
    const updatePhysics = () => {
      if (!physicsWorld || !player || !playerBody) return;
      
      // Apply point gravity
      applyPointGravity();
      
      // Step physics world
      physicsWorld.step();
      
      // Update player mesh position from physics body
      const position = playerBody.translation();
      player.position.set(position.x, position.y, position.z);
      
      // Only sync physics rotation to visual when grounded
      // This allows free camera control in air without physics interference
      if (isGrounded.value) {
        // When grounded, we may want physics to help with ground alignment
        // but we'll preserve horizontal rotation (y-axis) which is controlled by player
        const currentYRotation = player.rotation.y;
        
        // Get physics body rotation
        const rotation = playerBody.rotation();
        player.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
        
        // Restore the y-rotation that was set by player input
        player.rotation.y = currentYRotation;
      }
    };
    
    // Animation loop
    const animate = () => {
      const delta = clock.getDelta();
      
      // Handle player movement
      handlePlayerMovement(delta);
      
      // Update physics
      updatePhysics();
      
      // Render scene
      renderer.render(scene, camera);
      
      // Continue animation loop
      requestAnimationFrame(animate);
    };
    
    // Lifecycle hooks
    onMounted(() => {
      // Initialize game on component mount
      initGame();
    });
    
    onBeforeUnmount(() => {
      // Clean up resources
      if (renderer) renderer.dispose();
      if (physicsWorld) physicsWorld.free();
      
      // Remove event listeners
      window.removeEventListener('resize', null);
      window.removeEventListener('keydown', null);
      window.removeEventListener('keyup', null);
      document.removeEventListener('mousemove', null);
    });
    
    return {
      canvas,
      debug,
      isGrounded,
      playerPosition
    };
  }
};
</script>

<style scoped>
.game-container {
  width: 100%;
  height: 100vh;
  margin: 0;
  padding: 0;
  overflow: hidden;
}

canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.debug-info {
  position: absolute;
  top: 10px;
  left: 10px;
  background-color: rgba(0, 0, 0, 0.5);
  color: white;
  padding: 10px;
  border-radius: 5px;
  font-family: monospace;
}
</style>
