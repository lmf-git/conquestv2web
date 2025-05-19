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
    const PLAYER_RADIUS = 0.2;
    const PLAYER_HEIGHT = 0.8;
    const NUM_RANDOM_OBJECTS = 6;
    const PLANET_RADIUS = 8;
    const PLANET_MASS = 5000;
    const MOVE_SPEED = 0.1;
    const NORMAL_ARROW_LENGTH = 1;
    const NORMAL_ARROW_COLOR = 0xff0000;
    const COLLISION_ARROW_COLOR = 0x00ff00;
    const JUMP_FORCE = 0.2;
    
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
      createPlatforms();
      
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
      // Find the highest point to spawn above
      let highestPoint = PLANET_RADIUS + 5; 
      let spawnX = 0;
      let spawnZ = 0;
      
      // Use kinematic body for player
      const playerRigidBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
      playerRigidBodyDesc.setTranslation(spawnX, highestPoint, spawnZ);
      
      const playerBody = physicsWorld.createRigidBody(playerRigidBodyDesc);
      
      const playerColliderDesc = RAPIER.ColliderDesc.capsule(PLAYER_HEIGHT / 2, PLAYER_RADIUS);
      playerColliderDesc.setFriction(0.7);
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
        fallSpeed: 0.1,
        maxFallSpeed: 0.3,
        mass: 1,
        isJumping: false,
        jumpDirection: null
      };
    }

    function createPlanet() {
      const planetBodyDesc = RAPIER.RigidBodyDesc.fixed();
      planetBodyDesc.setTranslation(0, 0, 0);
      
      const planetBody = physicsWorld.createRigidBody(planetBodyDesc);
      
      const planetColliderDesc = RAPIER.ColliderDesc.ball(PLANET_RADIUS);
      planetColliderDesc.setFriction(0.7);
      physicsWorld.createCollider(planetColliderDesc, planetBody);
      
      const planetMesh = new THREE.Mesh(
        new THREE.SphereGeometry(PLANET_RADIUS, 64, 48),
        new THREE.MeshStandardMaterial({ 
          color: 0x1565c0,
          roughness: 0.8,
          metalness: 0.2
        })
      );
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
      
      // Add surface normal visualizations
      addPlanetSurfaceNormals(planet);
    }

    function addPlanetSurfaceNormals(planet) {
      if (!planet || !planet.mesh) return;
      
      const points = 12;
      
      for (let i = 0; i < points; i++) {
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
        
        collider.setFriction(0.7);
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
          mass: size * 2
        };
        
        objects.push(obj);
        addSurfaceNormals(obj);
      }
    }

    function createPlatforms() {
      const platformPositions = [
        { x: 5, y: 5, z: 0 },
        { x: -5, y: 5, z: 2 },
        { x: 0, y: 5, z: 5 }
      ];
      
      const platformSizes = [1.5, 2, 1.8];
      const platformColors = [0xFF5733, 0x33FF57, 0x3357FF];
      
      for (let i = 0; i < platformPositions.length; i++) {
        const pos = platformPositions[i];
        const size = platformSizes[i];
        const color = platformColors[i];
        
        const bodyDesc = RAPIER.RigidBodyDesc.fixed();
        bodyDesc.setTranslation(pos.x, pos.y, pos.z);
        
        // Align platform to face planet center
        const planet = objects.find(obj => obj.type === 'planet');
        if (planet) {
          const planetPos = planet.body.translation();
          const platformPos = new THREE.Vector3(pos.x, pos.y, pos.z);
          
          const upDir = new THREE.Vector3().subVectors(platformPos, 
            new THREE.Vector3(planetPos.x, planetPos.y, planetPos.z)).normalize();
          
          const worldUp = new THREE.Vector3(0, 1, 0);
          const rotationQuat = new THREE.Quaternion().setFromUnitVectors(worldUp, upDir);
          
          bodyDesc.setRotation({
            x: rotationQuat.x,
            y: rotationQuat.y,
            z: rotationQuat.z,
            w: rotationQuat.w
          });
        }
        
        const body = physicsWorld.createRigidBody(bodyDesc);
        
        const height = size / 4;
        const collider = RAPIER.ColliderDesc.cuboid(size/2, height/2, size/2);
        collider.setFriction(0.7);
        physicsWorld.createCollider(collider, body);
        
        const geometry = new THREE.BoxGeometry(size, height, size);
        const material = new THREE.MeshStandardMaterial({ 
          color: color,
          roughness: 0.7,
          metalness: 0.2
        });
        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
        
        const obj = {
          body,
          mesh,
          isFixed: true,
          type: 'box',
          size: size,
          mass: size * 2
        };
        
        objects.push(obj);
        
        // Add normal for the top face
        const pos3 = body.translation();
        const rot = body.rotation();
        const position = new THREE.Vector3(pos3.x, pos3.y, pos3.z);
        const quaternion = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
        
        const topNormal = new THREE.Vector3(0, 1, 0);
        const worldNormal = topNormal.clone().applyQuaternion(quaternion);
        const localPos = new THREE.Vector3(0, height/2, 0);
        const worldPos = position.clone().add(localPos.applyQuaternion(quaternion));
        
        const arrow = new THREE.ArrowHelper(
          worldNormal,
          worldPos,
          NORMAL_ARROW_LENGTH,
          0x00FFFF,
          0.2,
          0.1
        );
        scene.add(arrow);
        normalArrows.push(arrow);
      }
    }

    function addSurfaceNormals(obj) {
      if (!obj || !obj.mesh) return;
      
      const pos = obj.body.translation();
      const rot = obj.body.rotation();
      const position = new THREE.Vector3(pos.x, pos.y, pos.z);
      const quaternion = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
      
      if (obj.type === 'sphere') {
        const directions = [
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, 0, 1)
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
        const faceNormals = [
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, -1, 0)
        ];
        
        for (const normal of faceNormals) {
          const worldNormal = normal.clone().applyQuaternion(quaternion);
          const halfSize = obj.size / 2;
          
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
      
      if (player.jumpCooldown > 0) {
        player.jumpCooldown--;
      }
      
      if (player.jumpCooldown <= 0) {
        player.grounded = false;
        player.lastContactNormal = null;
      }
      
      if (collisionNormalArrow) {
        scene.remove(collisionNormalArrow);
        collisionNormalArrow = null;
      }
      
      const playerPos = player.body.translation();
      const playerPosition = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z);
      
      for (const obj of objects) {
        const objPos = obj.body.translation();
        const objPosition = new THREE.Vector3(objPos.x, objPos.y, objPos.z);
        
        let collisionNormal = null;
        let distance = 0;
        
        if (obj.type === 'planet') {
          const direction = new THREE.Vector3().subVectors(playerPosition, objPosition);
          distance = direction.length() - (PLANET_RADIUS + PLAYER_RADIUS);
          
          if (distance <= 0.05) {
            collisionNormal = direction.normalize();
          }
        } else if (obj.type === 'sphere') {
          const direction = new THREE.Vector3().subVectors(playerPosition, objPosition);
          distance = direction.length() - (obj.size/2 + PLAYER_RADIUS);
          
          if (distance <= 0.05) {
            collisionNormal = direction.normalize();
          }
        } else if (obj.type === 'box') {
          const objRot = obj.body.rotation();
          const objQuat = new THREE.Quaternion(objRot.x, objRot.y, objRot.z, objRot.w);
          const invQuat = objQuat.clone().invert();
          
          const localPlayerPos = playerPosition.clone().sub(objPosition).applyQuaternion(invQuat);
          
          const halfSize = obj.size / 2;
          const closestPoint = new THREE.Vector3(
            Math.max(-halfSize, Math.min(halfSize, localPlayerPos.x)),
            Math.max(-halfSize, Math.min(halfSize, localPlayerPos.y)),
            Math.max(-halfSize, Math.min(halfSize, localPlayerPos.z))
          );
          
          const worldClosestPoint = closestPoint.clone().applyQuaternion(objQuat).add(objPosition);
          
          const direction = new THREE.Vector3().subVectors(playerPosition, worldClosestPoint);
          distance = direction.length() - PLAYER_RADIUS;
          
          if (distance <= 0.05) {
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
            
            collisionNormal = localNormal.applyQuaternion(objQuat).normalize();
          }
        }
        
        if (collisionNormal && distance <= 0.05) {
          player.grounded = true;
          player.falling = false;
          player.fallSpeed = 0;
          player.lastContactNormal = collisionNormal;
          
          // Visualize collision normal
          collisionNormalArrow = new THREE.ArrowHelper(
            collisionNormal,
            playerPosition,
            NORMAL_ARROW_LENGTH * 1.5,
            COLLISION_ARROW_COLOR,
            0.3,
            0.15
          );
          scene.add(collisionNormalArrow);
          
          // Resolve collision (push player out)
          const pushDistance = Math.max(0, 0.05 - distance);
          player.body.setTranslation({
            x: playerPos.x + collisionNormal.x * pushDistance,
            y: playerPos.y + collisionNormal.y * pushDistance,
            z: playerPos.z + collisionNormal.z * pushDistance
          });
          
          // Align player with the surface normal
          alignPlayerWithSurface(collisionNormal);
          
          break;
        }
      }
      
      if (!player.grounded && player.jumpCooldown <= 0) {
        player.falling = true;
      }
    }
    
    function alignPlayerWithSurface(normal) {
      // For planet alignment, prioritize planet gravity direction
      const planet = objects.find(obj => obj.type === 'planet');
      if (planet && player) {
        const planetPos = planet.body.translation();
        const playerPos = player.body.translation();
        
        const upDirection = new THREE.Vector3(
          playerPos.x - planetPos.x,
          playerPos.y - planetPos.y, 
          playerPos.z - planetPos.z
        ).normalize();
        
        // Use the collision normal for alignment only if it's significantly different
        if (normal && normal.dot(upDirection) < 0.9) {
          // Blend between planet up and surface normal
          upDirection.lerp(normal, 0.3).normalize();
        }
        
        // Align player with this up direction
        const worldUp = new THREE.Vector3(0, 1, 0);
        const alignmentQuat = new THREE.Quaternion().setFromUnitVectors(worldUp, upDirection);
        
        player.body.setRotation({
          x: alignmentQuat.x,
          y: alignmentQuat.y,
          z: alignmentQuat.z,
          w: alignmentQuat.w
        });
      }
    }

    function applyPointGravity() {
      if (!player || !player.body) return;
      
      const playerPos = player.body.translation();
      const playerPosition = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z);
      
      // Find the planet
      const planet = objects.find(obj => obj.type === 'planet');
      
      if (planet && planet.body) {
        const planetPos = planet.body.translation();
        const planetPosition = new THREE.Vector3(planetPos.x, planetPos.y, planetPos.z);
        
        // Direction from player to planet
        const direction = new THREE.Vector3().subVectors(planetPosition, playerPosition);
        const distance = direction.length();
        
        if (distance >= 0.1) {
          const forceMagnitude = GRAVITY_STRENGTH * player.mass * planet.mass / (distance * distance);
          const normalizedDir = direction.normalize();
          
          // Scale force by player state
          const gravityStrength = player.grounded ? 0.0005 : 0.001;
          
          if (player.grounded) {
            // When grounded, apply stick force to prevent bouncing off
            player.body.applyImpulse(
              { 
                x: normalizedDir.x * gravityStrength * forceMagnitude * 1.5,
                y: normalizedDir.y * gravityStrength * forceMagnitude * 1.5, 
                z: normalizedDir.z * gravityStrength * forceMagnitude * 1.5
              }, 
              true
            );
          } else {
            // In air, apply regular gravity
            player.fallSpeed = Math.min(player.fallSpeed + 0.005, player.maxFallSpeed);
            player.body.setTranslation({
              x: playerPos.x + normalizedDir.x * player.fallSpeed,
              y: playerPos.y + normalizedDir.y * player.fallSpeed,
              z: playerPos.z + normalizedDir.z * player.fallSpeed
            });
          }
        }
      }
    }

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
      
      if (moveDirection.length() > 0) {
        moveDirection.normalize();
      }
      
      // Convert local movement to world space
      const worldMoveDir = moveDirection.clone().applyQuaternion(playerQuat);
      
      // Apply movement
      if (player.grounded) {
        if (moveDirection.length() > 0 && player.lastContactNormal) {
          // Project movement onto the surface plane
          const normal = player.lastContactNormal;
          const proj = worldMoveDir.dot(normal);
          const tangent = new THREE.Vector3()
            .copy(worldMoveDir)
            .sub(normal.clone().multiplyScalar(proj))
            .normalize();
          
          // Move along surface
          player.body.setTranslation({
            x: playerPos.x + tangent.x * MOVE_SPEED,
            y: playerPos.y + tangent.y * MOVE_SPEED,
            z: playerPos.z + tangent.z * MOVE_SPEED
          });
        }
      } else if (player.falling) {
        // Apply reduced movement in air
        if (moveDirection.length() > 0) {
          player.body.setTranslation({
            x: playerPos.x + worldMoveDir.x * MOVE_SPEED * 0.3,
            y: playerPos.y + worldMoveDir.y * MOVE_SPEED * 0.3,
            z: playerPos.z + worldMoveDir.z * MOVE_SPEED * 0.3
          });
        }
      }
    }

    function handlePlayerJump() {
      if (!player || !player.grounded || player.jumpCooldown > 0) return;
      
      if (keys.space) {
        // Use the collision normal as jump direction
        const jumpDirection = player.lastContactNormal.clone().normalize();
        
        player.jumpDirection = jumpDirection;
        player.isJumping = true;
        player.grounded = false;
        player.falling = true;
        player.jumpCooldown = 15;
        player.fallSpeed = -0.2; // Initial upward movement
        
        // Apply initial jump impulse
        player.body.applyImpulse(
          { 
            x: jumpDirection.x * JUMP_FORCE,
            y: jumpDirection.y * JUMP_FORCE, 
            z: jumpDirection.z * JUMP_FORCE 
          }, 
          true
        );
        
        if (collisionNormalArrow) {
          scene.remove(collisionNormalArrow);
          collisionNormalArrow = null;
        }
      }
    }

    function animate() {
      animationFrameId = requestAnimationFrame(animate);
      
      // Handle player jumping
      handlePlayerJump();
      
      // Apply gravity
      applyPointGravity();
      
      // Handle player movement
      handlePlayerMovement();
      
      // Check collisions
      checkCollisions();
      
      // Step physics
      physicsWorld.step();
      
      // Update collision arrow position
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
