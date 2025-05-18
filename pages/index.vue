<template>
    <canvas ref="canvas"></canvas>
  </template>

  <script setup>
    import { ref, onMounted, onBeforeUnmount } from 'vue';
    import * as THREE from 'three';
    import * as RAPIER from '@dimforge/rapier3d-compat';
    import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

    // Constants
    const GRAVITY_STRENGTH = 10;
    const POINT_GRAVITY_STRENGTH = 50; // Strength of point-to-point gravity
    const PLAYER_RADIUS = 0.2;
    const PLAYER_HEIGHT = 0.8;
    const NUM_RANDOM_OBJECTS = 6;
    const OBJECT_FRICTION = 0.7;
    const NORMAL_ARROW_LENGTH = 1;
    const NORMAL_ARROW_COLOR = 0xff0000; // Red for surface normals
    const COLLISION_ARROW_COLOR = 0x00ff00; // Green for collision normals
    const JUMP_FORCE = 0.2; // Force applied when jumping
    const MOVE_SPEED = 0.1; // Speed for horizontal movement
    const PLANET_RADIUS = 8; // Radius of the planetary sphere
    const PLANET_MASS = 5000; // Mass of the planet for gravity calculations

    const canvas = ref(null);
    let renderer, scene, camera, physicsWorld, animationFrameId;
    let controls;

    let player = null;
    let objects = [];
    let normalArrows = [];
    let collisionNormalArrow = null;
    let eventQueue;

    const keys = { w: false, a: false, s: false, d: false, space: false };
    
    const handleKeyDown = ({key}) => {
      const k = key.toLowerCase();
      if (k in keys) keys[k] = true;
      if (k === ' ') keys.space = true;
    };

    const handleKeyUp = ({key}) => {
      const k = key.toLowerCase();
      if (k in keys) keys[k] = false;
      if (k === ' ') keys.space = false;
    };

    onMounted(async () => {
      await RAPIER.init();
      
      // Setup scene
      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x050510);
      
      camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
      camera.position.set(0, 5, 10);
      
      renderer = new THREE.WebGLRenderer({ 
        canvas: canvas.value,
        antialias: true 
      });
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(window.devicePixelRatio);
      
      controls = new OrbitControls(camera, canvas.value);
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      
      // Lighting
      scene.add(new THREE.AmbientLight(0x404040));
      const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
      directionalLight.position.set(10, 20, 10);
      scene.add(directionalLight);
      
      // Physics setup - no global gravity
      physicsWorld = new RAPIER.World({ x: 0.0, y: 0.0, z: 0.0 });
      eventQueue = new RAPIER.EventQueue(true);
      
      // Create planet first
      createPlanet();
      createRandomObjects(NUM_RANDOM_OBJECTS);
      
      // Create player after objects so we can position it above them
      createPlayer();
      
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);
      window.addEventListener('resize', onWindowResize);
      
      scene.add(new THREE.AxesHelper(3));
      
      animate();
    });

    onBeforeUnmount(() => {
      cancelAnimationFrame(animationFrameId);
      if (renderer) renderer.dispose();
      if (controls) controls.dispose();
      
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('resize', onWindowResize);
    });

    function updateObjectTransform(obj) {
      if (!obj.body || !obj.mesh) return;
      const pos = obj.body.translation();
      const rot = obj.body.rotation();
      obj.mesh.position.set(pos.x, pos.y, pos.z);
      obj.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    }

    function createPlayer() {
      // Find the highest object to spawn above
      let highestPoint = PLANET_RADIUS + 5; // Default height above planet
      let spawnX = 0;
      let spawnZ = 0;
      
      // Find a random object to spawn above
      if (objects.length > 1) { // Check for objects other than the planet
        // Pick a random object (excluding the planet)
        const planetObjIndex = objects.findIndex(obj => obj.type === 'planet');
        const validObjects = objects.filter((obj, index) => index !== planetObjIndex);
        
        if (validObjects.length > 0) {
          const randomObj = validObjects[Math.floor(Math.random() * validObjects.length)];
          const objPos = randomObj.body.translation();
          const objSize = randomObj.size;
          
          spawnX = objPos.x;
          spawnZ = objPos.z;
          
          // Calculate height based on object type and position
          if (randomObj.type === 'sphere') {
            highestPoint = objPos.y + objSize/2 + 5; // Spawn 5 units above the top of the sphere
          } else if (randomObj.type === 'box') {
            highestPoint = objPos.y + objSize/2 + 5; // Spawn 5 units above the top of the box
          }
        }
      }
      
      // Use kinematic body instead of dynamic for stability
      const playerRigidBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
      playerRigidBodyDesc.setTranslation(spawnX, highestPoint, spawnZ);
      
      const playerBody = physicsWorld.createRigidBody(playerRigidBodyDesc);
      
      const playerColliderDesc = RAPIER.ColliderDesc.capsule(PLAYER_HEIGHT / 2, PLAYER_RADIUS);
      playerColliderDesc.setFriction(0.7);
      playerColliderDesc.setSensor(true); // Make it a sensor to detect collisions but not respond physically
      const collider = physicsWorld.createCollider(playerColliderDesc, playerBody);
      
      const playerMesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT, 20, 20),
        new THREE.MeshStandardMaterial({ color: 0xe53935 })
      );
      scene.add(playerMesh);
      
      player = {
        body: playerBody,
        mesh: playerMesh,
        collider: collider,
        velocity: new THREE.Vector3(0, 0, 0),
        grounded: false,
        falling: true,
        lastContactNormal: null,
        jumpCooldown: 0,
        fallSpeed: 0.1, // Initial fall speed
        maxFallSpeed: 0.3, // Max fall speed
        manualControl: true,
        mass: 1, // Mass for gravity calculations
        nextPosition: null // For storing the next position to move to
      };
    }

    // Replace createGround with createPlanet
    function createPlanet() {
      const planetBodyDesc = RAPIER.RigidBodyDesc.fixed();
      planetBodyDesc.setTranslation(0, 0, 0);
      
      const planetBody = physicsWorld.createRigidBody(planetBodyDesc);
      
      const planetColliderDesc = RAPIER.ColliderDesc.ball(PLANET_RADIUS);
      planetColliderDesc.setFriction(0.7);
      physicsWorld.createCollider(planetColliderDesc, planetBody);
      
      // Create planet mesh with detailed geometry
      const planetMesh = new THREE.Mesh(
        new THREE.SphereGeometry(PLANET_RADIUS, 64, 48),
        new THREE.MeshStandardMaterial({ 
          color: 0x1565c0,
          roughness: 0.8,
          metalness: 0.2
        })
      );
      planetMesh.position.set(0, 0, 0);
      scene.add(planetMesh);
      
      const planet = {
        body: planetBody,
        mesh: planetMesh,
        isFixed: true,
        type: 'planet',
        size: PLANET_RADIUS * 2,
        mass: PLANET_MASS
      };
      
      objects.push(planet);
      
      // Add surface normal arrows for the planet
      addPlanetSurfaceNormals(planet);
    }

    // Add a new function to create normals for the planet
    function addPlanetSurfaceNormals(planet) {
      if (!planet || !planet.mesh) return;
      
      // Create normal arrows at evenly distributed points on the sphere
      const points = 12;
      
      for (let i = 0; i < points; i++) {
        // Use fibonacci sphere algorithm for even distribution
        const y = 1 - (i / (points - 1)) * 2;
        const radius = Math.sqrt(1 - y * y);
        const theta = ((Math.sqrt(5) + 1) / 2 - 1) * 2 * Math.PI * i;
        
        const x = Math.cos(theta) * radius;
        const z = Math.sin(theta) * radius;
        
        const normal = new THREE.Vector3(x, y, z).normalize();
        const position = normal.clone().multiplyScalar(PLANET_RADIUS);
        
        const arrow = new THREE.ArrowHelper(
          normal,
          position,
          NORMAL_ARROW_LENGTH,
          NORMAL_ARROW_COLOR,
          0.2,
          0.1
        );
        scene.add(arrow);
        normalArrows.push(arrow);
      }
    }

    function createRandomObjects(count) {
      const shapes = ['box', 'sphere'];
      const colors = [0x7C4DFF, 0x00BFA5, 0xFFD600, 0x64DD17];
      
      for (let i = 0; i < count; i++) {
        const randomX = (Math.random() - 0.5) * 10;
        const randomY = 1 + Math.random() * 8;
        const randomZ = (Math.random() - 0.5) * 10;
        
        const size = 0.8 + Math.random() * 1.5;
        
        const shapeType = shapes[Math.floor(Math.random() * shapes.length)];
        const color = colors[Math.floor(Math.random() * colors.length)];
        
        const randomRotation = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(
            Math.random() * Math.PI,
            Math.random() * Math.PI,
            Math.random() * Math.PI
          )
        );
        
        const bodyDesc = RAPIER.RigidBodyDesc.fixed();
        bodyDesc.setTranslation(randomX, randomY, randomZ);
        bodyDesc.setRotation({
          x: randomRotation.x,
          y: randomRotation.y,
          z: randomRotation.z,
          w: randomRotation.w
        });
        
        const body = physicsWorld.createRigidBody(bodyDesc);
        
        let collider, geometry;
        
        if (shapeType === 'box') {
          collider = RAPIER.ColliderDesc.cuboid(size/2, size/2, size/2);
          geometry = new THREE.BoxGeometry(size, size, size);
        } else {
          collider = RAPIER.ColliderDesc.ball(size/2);
          geometry = new THREE.SphereGeometry(size/2, 16, 16);
        }
        
        collider.setFriction(OBJECT_FRICTION);
        physicsWorld.createCollider(collider, body);
        
        const mesh = new THREE.Mesh(
          geometry, 
          new THREE.MeshStandardMaterial({ color })
        );
        scene.add(mesh);
        
        const obj = {
          body,
          mesh,
          isFixed: true,
          type: shapeType,
          size: size,
          mass: size * 2 // Mass proportional to size
        };
        
        objects.push(obj);
        
        // Add surface normal arrows
        addSurfaceNormals(obj);
      }
    }

    function addSurfaceNormals(obj) {
      if (!obj || !obj.mesh) return;
      
      const pos = obj.body.translation();
      const rot = obj.body.rotation();
      const position = new THREE.Vector3(pos.x, pos.y, pos.z);
      const quaternion = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
      
      if (obj.type === 'sphere') {
        // For spheres add normals in different directions
        const directions = [
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(-1, 0, 0),
          new THREE.Vector3(0, -1, 0),
          new THREE.Vector3(0, 0, -1)
        ];
        
        for (const dir of directions) {
          const normalizedDir = dir.clone().normalize();
          const origin = position.clone().add(normalizedDir.clone().multiplyScalar(obj.size / 2));
          
          const arrow = new THREE.ArrowHelper(
            normalizedDir,
            origin,
            NORMAL_ARROW_LENGTH,
            NORMAL_ARROW_COLOR,
            0.2,
            0.1
          );
          scene.add(arrow);
          normalArrows.push(arrow);
        }
      } else if (obj.type === 'box') {
        // For boxes add normals on each face
        const faceNormals = [
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(-1, 0, 0),
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, -1, 0),
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(0, 0, -1)
        ];
        
        for (const normal of faceNormals) {
          const worldNormal = normal.clone().applyQuaternion(quaternion);
          const halfSize = obj.size / 2;
          
          // Calculate position on the face
          const localPos = new THREE.Vector3(
            normal.x * halfSize,
            normal.y * halfSize,
            normal.z * halfSize
          );
          const worldPos = position.clone().add(localPos.applyQuaternion(quaternion));
          
          const arrow = new THREE.ArrowHelper(
            worldNormal,
            worldPos,
            NORMAL_ARROW_LENGTH,
            NORMAL_ARROW_COLOR,
            0.2,
            0.1
          );
          scene.add(arrow);
          normalArrows.push(arrow);
        }
      }
    }

    function checkCollisions() {
      if (!player || !player.body || !player.mesh) return;
      
      // Decrement jump cooldown if active
      if (player.jumpCooldown > 0) {
        player.jumpCooldown--;
      }
      
      // Only reset grounded state if we're not in a jump
      if (player.jumpCooldown <= 0) {
        player.grounded = false;
        player.lastContactNormal = null;
      }
      
      // Remove previous collision arrow if exists
      if (collisionNormalArrow) {
        scene.remove(collisionNormalArrow);
        collisionNormalArrow = null;
      }
      
      // Check for collisions with all objects
      const playerPos = player.body.translation();
      const playerPosition = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z);
      
      for (const obj of objects) {
        const objPos = obj.body.translation();
        const objPosition = new THREE.Vector3(objPos.x, objPos.y, objPos.z);
        
        let collisionNormal = null;
        let distance = 0;
        
        if (obj.type === 'planet') {
          // For planet, calculate spherical collision
          const direction = new THREE.Vector3().subVectors(playerPosition, objPosition);
          distance = direction.length() - (PLANET_RADIUS + PLAYER_RADIUS);
          
          if (distance <= 0.05) {
            collisionNormal = direction.normalize();
          }
        } else if (obj.type === 'sphere') {
          // For spheres, check distance from player center to sphere center
          const direction = new THREE.Vector3().subVectors(playerPosition, objPosition);
          distance = direction.length() - (obj.size/2 + PLAYER_RADIUS);
          
          if (distance <= 0.05) {
            collisionNormal = direction.normalize();
          }
        } else if (obj.type === 'box') {
          // For boxes, find closest point on box to player
          const objRot = obj.body.rotation();
          const objQuat = new THREE.Quaternion(objRot.x, objRot.y, objRot.z, objRot.w);
          const invQuat = objQuat.clone().invert();
          
          // Get player position in box local space
          const localPlayerPos = playerPosition.clone().sub(objPosition).applyQuaternion(invQuat);
          
          // Get closest point on box in local space
          const halfSize = obj.size / 2;
          const closestPoint = new THREE.Vector3(
            Math.max(-halfSize, Math.min(halfSize, localPlayerPos.x)),
            Math.max(-halfSize, Math.min(halfSize, localPlayerPos.y)),
            Math.max(-halfSize, Math.min(halfSize, localPlayerPos.z))
          );
          
          // Convert back to world space
          const worldClosestPoint = closestPoint.clone().applyQuaternion(objQuat).add(objPosition);
          
          // Calculate distance and direction
          const direction = new THREE.Vector3().subVectors(playerPosition, worldClosestPoint);
          distance = direction.length() - PLAYER_RADIUS;
          
          if (distance <= 0.05) {
            // Determine which face of the box we hit
            const relPos = closestPoint.clone();
            const absX = Math.abs(relPos.x);
            const absY = Math.abs(relPos.y);
            const absZ = Math.abs(relPos.z);
            
            let localNormal = new THREE.Vector3();
            
            if (absX >= halfSize - 0.01 && absX > absY && absX > absZ) {
              localNormal.x = Math.sign(relPos.x);
            } else if (absY >= halfSize - 0.01 && absY > absX && absY > absZ) {
              localNormal.y = Math.sign(relPos.y);
            } else if (absZ >= halfSize - 0.01) {
              localNormal.z = Math.sign(relPos.z);
            }
            
            // Transform normal to world space
            collisionNormal = localNormal.applyQuaternion(objQuat).normalize();
          }
        }
        
        // If collision found, update player state and visualize the normal
        if (collisionNormal && distance <= 0.05) {
          player.grounded = true;
          player.falling = false;
          player.lastContactNormal = collisionNormal;
          
          // Create collision normal arrow
          collisionNormalArrow = new THREE.ArrowHelper(
            collisionNormal,
            playerPosition,
            NORMAL_ARROW_LENGTH * 1.5,
            COLLISION_ARROW_COLOR,
            0.3,
            0.15
          );
          scene.add(collisionNormalArrow);
          
          // Align player with surface
          const upVector = new THREE.Vector3(0, 1, 0);
          const alignmentQuat = new THREE.Quaternion().setFromUnitVectors(upVector, collisionNormal);
          
          player.body.setRotation({
            x: alignmentQuat.x,
            y: alignmentQuat.y,
            z: alignmentQuat.z,
            w: alignmentQuat.w
          });
          
          break;
        }
      }
      
      // If not grounded and not actively jumping, player is falling
      if (!player.grounded && player.jumpCooldown <= 0) {
        player.falling = true;
      }
    }

    // Update the point gravity function to emphasize planet gravity
    function applyPointGravity() {
      if (!player || !player.body) return;
      
      const playerPos = player.body.translation();
      const playerPosition = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z);
      let netGravityForce = new THREE.Vector3(0, 0, 0);
      
      // Find the planet
      const planet = objects.find(obj => obj.type === 'planet');
      
      if (planet && planet.body) {
        // Calculate gravity from the planet (with higher priority)
        const planetPos = planet.body.translation();
        const planetPosition = new THREE.Vector3(planetPos.x, planetPos.y, planetPos.z);
        
        // Direction from player to planet
        const direction = new THREE.Vector3().subVectors(planetPosition, playerPosition);
        const distance = direction.length();
        
        // Skip if too close to prevent extreme forces
        if (distance >= 0.1) {
          // Calculate gravity force (F = G * m1 * m2 / r^2)
          const forceMagnitude = POINT_GRAVITY_STRENGTH * player.mass * planet.mass / (distance * distance);
          
          // Add to net force (normalized direction * force magnitude)
          netGravityForce.add(direction.normalize().multiplyScalar(forceMagnitude));
        }
      }
      
      // Calculate gravity from other objects (with lower influence)
      for (const obj of objects) {
        if (!obj.body || obj.type === 'planet') continue; // Skip the planet as we handled it separately
        
        const objPos = obj.body.translation();
        const objPosition = new THREE.Vector3(objPos.x, objPos.y, objPos.z);
        
        // Direction from player to object
        const direction = new THREE.Vector3().subVectors(objPosition, playerPosition);
        const distance = direction.length();
        
        // Skip if too close (prevent extreme forces)
        if (distance < 0.1) continue;
        
        // Calculate gravity force (F = G * m1 * m2 / r^2)
        const forceMagnitude = POINT_GRAVITY_STRENGTH * 0.1 * player.mass * obj.mass / (distance * distance);
        
        // Add to net force (normalized direction * force magnitude)
        netGravityForce.add(direction.normalize().multiplyScalar(forceMagnitude));
      }
      
      // Apply the gravity force to player's velocity
      if (player.falling && !player.grounded) {
        const currentVel = player.body.linvel();
        let newVelocity = new THREE.Vector3(currentVel.x, currentVel.y, currentVel.z);
        
        // Scale the force for gameplay purposes
        const scaleFactor = 0.001;
        newVelocity.add(netGravityForce.multiplyScalar(scaleFactor));
        
        // Apply velocity
        player.body.setLinvel({
          x: newVelocity.x,
          y: newVelocity.y,
          z: newVelocity.z
        }, true);
      }
    }

    // Completely rewrite the movement function for kinematic control
    function handlePlayerMovement() {
      if (!player || !player.body) return;
      
      const playerPos = player.body.translation();
      const playerRot = player.body.rotation();
      const playerQuat = new THREE.Quaternion(playerRot.x, playerRot.y, playerRot.z, playerRot.w);
      
      // Create a directional vector based on keys pressed
      const moveDirection = new THREE.Vector3(0, 0, 0);
      if (keys.w) moveDirection.z -= 1;
      if (keys.s) moveDirection.z += 1;
      if (keys.a) moveDirection.x -= 1;
      if (keys.d) moveDirection.x += 1;
      
      // Normalize movement vector if it has length
      if (moveDirection.length() > 0) {
        moveDirection.normalize();
      }
      
      // Apply movement in world space based on player's orientation
      const worldMoveDir = moveDirection.clone().applyQuaternion(playerQuat);
      
      // Calculate new position
      let newPosition = new THREE.Vector3(
        playerPos.x,
        playerPos.y,
        playerPos.z
      );
      
      // If grounded, move along the surface using the contact normal
      if (player.grounded && player.lastContactNormal) {
        const normal = player.lastContactNormal;
        
        if (moveDirection.length() > 0) {
          // Project movement onto the surface plane defined by the normal
          const proj = worldMoveDir.dot(normal);
          const tangent = new THREE.Vector3().copy(worldMoveDir).sub(
            normal.clone().multiplyScalar(proj)
          ).normalize();
          
          // Apply movement along the surface
          newPosition.add(tangent.multiplyScalar(MOVE_SPEED));
        }
      } 
      // If falling or jumping, allow limited air control
      else if (player.falling) {
        // Apply gravity toward the planet
        const planet = objects.find(obj => obj.type === 'planet');
        if (planet && planet.body) {
          const planetPos = planet.body.translation();
          const planetPosition = new THREE.Vector3(planetPos.x, planetPos.y, planetPos.z);
          
          // Direction from player to planet center
          const gravityDir = new THREE.Vector3().subVectors(planetPosition, newPosition).normalize();
          
          // Increase fall speed gradually
          player.fallSpeed = Math.min(player.fallSpeed + 0.005, player.maxFallSpeed);
          
          // Apply gravity movement
          newPosition.add(gravityDir.multiplyScalar(player.fallSpeed));
          
          // Apply air control (reduced movement in air)
          if (moveDirection.length() > 0) {
            // Make sure air movement doesn't counteract gravity too much
            const airMovement = worldMoveDir.clone();
            const projOnGravity = airMovement.dot(gravityDir);
            
            // Remove upward component against gravity
            if (projOnGravity < 0) {
              airMovement.sub(gravityDir.clone().multiplyScalar(projOnGravity));
            }
            
            // Apply reduced air control
            newPosition.add(airMovement.multiplyScalar(MOVE_SPEED * 0.3));
          }
        }
      }
      
      // Check for potential collisions before applying movement
      player.nextPosition = newPosition;
      checkCollisionsAndResolve();
      
      // Only update rotation when grounded and there's a contact normal
      if (player.grounded && player.lastContactNormal) {
        const upVector = new THREE.Vector3(0, 1, 0);
        const alignmentQuat = new THREE.Quaternion().setFromUnitVectors(upVector, player.lastContactNormal);
        
        player.body.setRotation({
          x: alignmentQuat.x,
          y: alignmentQuat.y,
          z: alignmentQuat.z,
          w: alignmentQuat.w
        });
      }
    }
    
    // Update collision function to handle kinematic movement
    function checkCollisionsAndResolve() {
      if (!player || !player.body || !player.mesh || !player.nextPosition) return;
      
      // Decrement jump cooldown if active
      if (player.jumpCooldown > 0) {
        player.jumpCooldown--;
      }
      
      // Only reset grounded state if we're not in a jump
      if (player.jumpCooldown <= 0) {
        player.grounded = false;
        player.lastContactNormal = null;
      }
      
      // Remove previous collision arrow if exists
      if (collisionNormalArrow) {
        scene.remove(collisionNormalArrow);
        collisionNormalArrow = null;
      }
      
      // Convert nextPosition to THREE.Vector3 if it's not already
      const nextPosition = new THREE.Vector3(
        player.nextPosition.x,
        player.nextPosition.y,
        player.nextPosition.z
      );
      
      // Check for collisions with all objects
      let closestHit = null;
      let closestDistance = Infinity;
      let closestNormal = null;
      let isGrounded = false;
      
      for (const obj of objects) {
        const objPos = obj.body.translation();
        const objPosition = new THREE.Vector3(objPos.x, objPos.y, objPos.z);
        
        let collisionNormal = null;
        let distance = 0;
        
        if (obj.type === 'planet') {
          // For planet, calculate spherical collision
          const direction = new THREE.Vector3().subVectors(nextPosition, objPosition);
          distance = direction.length() - (PLANET_RADIUS + PLAYER_RADIUS);
          
          if (distance <= 0.05) {
            collisionNormal = direction.normalize();
          }
        } else if (obj.type === 'sphere') {
          // For spheres, check distance from player center to sphere center
          const direction = new THREE.Vector3().subVectors(nextPosition, objPosition);
          distance = direction.length() - (obj.size/2 + PLAYER_RADIUS);
          
          if (distance <= 0.05) {
            collisionNormal = direction.normalize();
          }
        } else if (obj.type === 'box') {
          // For boxes, find closest point on box to player
          const objRot = obj.body.rotation();
          const objQuat = new THREE.Quaternion(objRot.x, objRot.y, objRot.z, objRot.w);
          const invQuat = objQuat.clone().invert();
          
          // Get player position in box local space
          const localPlayerPos = nextPosition.clone().sub(objPosition).applyQuaternion(invQuat);
          
          // Get closest point on box in local space
          const halfSize = obj.size / 2;
          const closestPoint = new THREE.Vector3(
            Math.max(-halfSize, Math.min(halfSize, localPlayerPos.x)),
            Math.max(-halfSize, Math.min(halfSize, localPlayerPos.y)),
            Math.max(-halfSize, Math.min(halfSize, localPlayerPos.z))
          );
          
          // Convert back to world space
          const worldClosestPoint = closestPoint.clone().applyQuaternion(objQuat).add(objPosition);
          
          // Calculate distance and direction
          const direction = new THREE.Vector3().subVectors(nextPosition, worldClosestPoint);
          distance = direction.length() - PLAYER_RADIUS;
          
          if (distance <= 0.05) {
            // Determine which face of the box we hit
            const relPos = closestPoint.clone();
            const absX = Math.abs(relPos.x);
            const absY = Math.abs(relPos.y);
            const absZ = Math.abs(relPos.z);
            
            let localNormal = new THREE.Vector3();
            
            if (absX >= halfSize - 0.01 && absX > absY && absX > absZ) {
              localNormal.x = Math.sign(relPos.x);
            } else if (absY >= halfSize - 0.01 && absY > absX && absY > absZ) {
              localNormal.y = Math.sign(relPos.y);
            } else if (absZ >= halfSize - 0.01) {
              localNormal.z = Math.sign(relPos.z);
            }
            
            // Transform normal to world space
            collisionNormal = localNormal.applyQuaternion(objQuat).normalize();
          }
        }
        
        // If collision found, store it if it's closer than previous collisions
        if (collisionNormal && distance < closestDistance) {
          closestDistance = distance;
          closestNormal = collisionNormal;
          closestHit = obj;
        }
      }
      
      // Handle the closest collision
      if (closestNormal) {
        // We have a collision, resolve it
        player.grounded = true;
        player.falling = false;
        player.lastContactNormal = closestNormal;
        player.fallSpeed = 0; // Reset fall speed when grounded
        
        // Create collision normal arrow
        collisionNormalArrow = new THREE.ArrowHelper(
          closestNormal,
          nextPosition,
          NORMAL_ARROW_LENGTH * 1.5,
          COLLISION_ARROW_COLOR,
          0.3,
          0.15
        );
        scene.add(collisionNormalArrow);
        
        // Resolve collision by moving the player along the normal
        // Push the player out along the collision normal to prevent sinking
        const pushDistance = Math.max(0, 0.05 - closestDistance);
        const resolvedPosition = nextPosition.clone().add(
          closestNormal.clone().multiplyScalar(pushDistance)
        );
        
        // Set the resolved position
        player.body.setTranslation({
          x: resolvedPosition.x,
          y: resolvedPosition.y,
          z: resolvedPosition.z
        });
      } else {
        // No collision, just move to the next position
        player.body.setTranslation({
          x: nextPosition.x,
          y: nextPosition.y,
          z: nextPosition.z
        });
        
        // If not grounded and not actively jumping, player is falling
        if (!player.grounded && player.jumpCooldown <= 0) {
          player.falling = true;
        }
      }
    }

    function handlePlayerJump() {
      if (!player || !player.grounded || player.jumpCooldown > 0) return;
      
      if (keys.space) {
        // Get the normal direction to jump along
        const jumpDirection = player.lastContactNormal || new THREE.Vector3(0, 1, 0);
        
        // Set initial jump velocity (for animation purposes)
        player.velocity = jumpDirection.clone().multiplyScalar(JUMP_FORCE);
        
        // Update player state
        player.grounded = false;
        player.falling = true;
        player.jumpCooldown = 15; // Prevent immediate re-landing
        player.fallSpeed = -0.2; // Initial upward movement (negative because we're moving away from gravity)
        
        // Remove collision arrow when jumping
        if (collisionNormalArrow) {
          scene.remove(collisionNormalArrow);
          collisionNormalArrow = null;
        }
      }
    }

    function animate() {
      animationFrameId = requestAnimationFrame(animate);
      
      // Handle jumping
      handlePlayerJump();
      
      // Handle player movement - now this also handles gravity for kinematic body
      handlePlayerMovement();
      
      physicsWorld.step(eventQueue);
      
      // Update collision arrow position if it exists
      if (collisionNormalArrow && player && player.body) {
        const playerPos = player.body.translation();
        collisionNormalArrow.position.set(playerPos.x, playerPos.y, playerPos.z);
      }
      
      controls.update();
      
      if (player) {
        updateObjectTransform(player);
      }
      
      for (const obj of objects) {
        updateObjectTransform(obj);
      }
      
      renderer.render(scene, camera);
    }

    function onWindowResize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
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
