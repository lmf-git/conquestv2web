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
    const NUM_DYNAMIC_OBJECTS = 0; // Set to 0 initially for debugging
    const MOVE_SPEED = 0.1;
    const NORMAL_ARROW_LENGTH = 1;
    const NORMAL_ARROW_COLOR = 0xff0000;
    const COLLISION_ARROW_COLOR = 0x00ff00;
    const JUMP_FORCE = 0.2;
    // Sphere terrain constants
    const PLANET_RADIUS = 10;
    const TERRAIN_HEIGHT = 1.5; // Max height of terrain features
    const TERRAIN_ROUGHNESS = 1.0; // How rough the terrain is
    const SPHERE_SEGMENTS = 64; // Resolution of the sphere
    const TERRAIN_CENTER = new THREE.Vector3(0, 0, 0);
    
    const canvas = ref(null);
    let renderer, scene, camera, physicsWorld, animationFrameId;
    let controls;

    let player = null;
    let objects = [];
    let normalArrows = [];
    let collisionNormalArrow = null;
    let eventQueue;
    let terrain = null;

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
      camera.position.set(0, 20, 30);
      
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
      scene.add(new THREE.AmbientLight(0x606060));
      const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
      directionalLight.position.set(10, 20, 10);
      scene.add(directionalLight);
      
      // Add hemisphere light for more natural terrain lighting
      const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
      hemiLight.position.set(0, 50, 0);
      scene.add(hemiLight);
      
      // Physics setup - no global gravity
      physicsWorld = new RAPIER.World({ x: 0.0, y: 0.0, z: 0.0 });
      eventQueue = new RAPIER.EventQueue(true);
      
      // Create terrain first
      createTerrain();
      createRandomObjects(NUM_RANDOM_OBJECTS);
      createSurfaceObjects();
      
      // Create player after terrain
      createPlayer();
      
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);
      window.addEventListener('resize', onWindowResize);
      
      scene.add(new THREE.AxesHelper(5));
      
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

    function createTerrain() {
      // Create a sphere geometry as the base for our terrain
      const geometry = new THREE.SphereGeometry(
        PLANET_RADIUS,
        SPHERE_SEGMENTS,
        SPHERE_SEGMENTS
      );
      
      // Apply height variation to vertices to create terrain
      const positions = geometry.attributes.position;
      const vertices = [];
      
      // Custom noise function using Math.sin/cos combinations
      function customNoise(x, y, z) {
        // Use multiple frequencies to create more natural-looking terrain
        const scale1 = 0.5, scale2 = 2.0, scale3 = 4.0;
        
        let noise = 0;
        // First octave
        noise += Math.sin(x * scale1) * Math.cos(y * scale1) * Math.sin(z * scale1) * 0.5;
        // Second octave (higher frequency, lower amplitude)
        noise += Math.sin(x * scale2) * Math.cos(z * scale2) * 0.25;
        // Third octave (even higher frequency, even lower amplitude)
        noise += Math.sin(x * scale3 + y * scale3) * Math.cos(z * scale3) * 0.125;
        
        // Add some ridges
        if (Math.abs(noise) > 0.7) {
          noise *= 1.3;
        }
        
        return noise;
      }
      
      // Apply the noise to each vertex
      for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i);
        const y = positions.getY(i);
        const z = positions.getZ(i);
        
        // Store original vertex for later use
        vertices.push(new THREE.Vector3(x, y, z));
        
        // Normalize the position to get direction from center
        const direction = new THREE.Vector3(x, y, z).normalize();
        
        // Apply noise-based displacement along the normal
        const noise = customNoise(x * 0.2, y * 0.2, z * 0.2);
        const displacement = noise * TERRAIN_HEIGHT * TERRAIN_ROUGHNESS;
        
        // Apply displacement along the normal direction
        const newPos = direction.multiplyScalar(PLANET_RADIUS + displacement);
        
        positions.setXYZ(i, newPos.x, newPos.y, newPos.z);
      }
      
      // Compute face normals for collision detection
      geometry.computeVertexNormals();
      
      // Create material with a blend of colors for a terrain look
      const terrainMaterial = new THREE.MeshStandardMaterial({
        color: 0x3d673c,
        flatShading: false,
        roughness: 0.8,
        metalness: 0.1,
        vertexColors: true
      });
      
      // Apply vertex colors based on height (distance from center)
      const colors = [];
      const color = new THREE.Color();
      
      for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i);
        const y = positions.getY(i);
        const z = positions.getZ(i);
        
        // Calculate height as distance from center
        const height = Math.sqrt(x*x + y*y + z*z) - PLANET_RADIUS;
        
        // Color gradient based on height
        if (height < -0.3) {
          color.setHex(0x0077be); // Deep blue for "water" areas
        } else if (height < 0.1) {
          color.setHex(0x3d673c); // Dark green for lower areas
        } else if (height < 0.5) {
          color.setHex(0x5d8a5a); // Medium green for mid-levels
        } else if (height < 1.0) {
          color.setHex(0x8b9d77); // Lighter green/brown for higher ground
        } else {
          color.setHex(0xc2b280); // Sandy/rocky color for peaks
        }
        
        colors.push(color.r, color.g, color.b);
      }
      
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      
      // Create the mesh
      const terrainMesh = new THREE.Mesh(geometry, terrainMaterial);
      scene.add(terrainMesh);
      
      // Create physics representation for the terrain
      const terrainBodyDesc = RAPIER.RigidBodyDesc.fixed();
      const terrainBody = physicsWorld.createRigidBody(terrainBodyDesc);
      
      // Use a more efficient collision approach: convex hull pieces
      // Divide the sphere into sections to better approximate the terrain
      const segments = 12; // Number of sections to divide the sphere into
      
      // Create triangulation of sphere for collision
      createSphereColliders(terrainMesh, terrainBody, segments);
      
      // Create normals visualization for terrain
      addTerrainNormals(terrainMesh, positions);
      
      // Store terrain object
      terrain = {
        body: terrainBody,
        mesh: terrainMesh,
        isFixed: true,
        type: 'terrain',
        radius: PLANET_RADIUS,
        mass: PLANET_RADIUS * 100, // Large mass for gravity calculations
        vertices: vertices
      };
      
      objects.push(terrain);
    }
    
    function createSphereColliders(terrainMesh, terrainBody, segments) {
      // Divide the sphere into sectors for better collision approximation
      const positions = terrainMesh.geometry.attributes.position;
      const phiSectors = segments;
      const thetaSectors = segments * 2;
      
      // Create a collider for each sector
      for (let phiIndex = 0; phiIndex < phiSectors; phiIndex++) {
        for (let thetaIndex = 0; thetaIndex < thetaSectors; thetaIndex++) {
          // Calculate the angles for this sector
          const phiStart = Math.PI * phiIndex / phiSectors;
          const phiEnd = Math.PI * (phiIndex + 1) / phiSectors;
          const thetaStart = 2 * Math.PI * thetaIndex / thetaSectors;
          const thetaEnd = 2 * Math.PI * (thetaIndex + 1) / thetaSectors;
          
          // Collect vertices in this sector
          const sectorVertices = [];
          
          for (let i = 0; i < positions.count; i++) {
            const x = positions.getX(i);
            const y = positions.getY(i);
            const z = positions.getZ(i);
            
            // Convert to spherical coordinates
            const r = Math.sqrt(x*x + y*y + z*z);
            const phi = Math.acos(y / r);  // Polar angle from y-axis [0, π]
            const theta = Math.atan2(z, x); // Azimuthal angle in x-z plane [0, 2π]
            
            // Check if the vertex belongs to this sector
            if (phi >= phiStart && phi <= phiEnd &&
                ((theta >= thetaStart && theta <= thetaEnd) || 
                 (thetaStart > thetaEnd && (theta >= thetaStart || theta <= thetaEnd)))) {
              
              sectorVertices.push({x, y, z});
            }
          }
          
          // If we have enough vertices, create a convex hull collider
          if (sectorVertices.length > 4) {
            const colliderDesc = RAPIER.ColliderDesc.convexHull(
              new Float32Array(sectorVertices.flatMap(v => [v.x, v.y, v.z]))
            );
            
            if (colliderDesc) {
              colliderDesc.setFriction(0.8);
              physicsWorld.createCollider(colliderDesc, terrainBody);
              
              // Optionally visualize the convex hull for debugging
              /*
              const hull = new THREE.Mesh(
                new THREE.ConvexGeometry(sectorVertices.map(v => new THREE.Vector3(v.x, v.y, v.z))),
                new THREE.MeshBasicMaterial({ 
                  color: 0xff0000, 
                  wireframe: true, 
                  transparent: true, 
                  opacity: 0.2 
                })
              );
              scene.add(hull);
              */
            }
          }
        }
      }
    }
    
    function addTerrainNormals(terrainMesh, positions) {
      // Add normals at regular intervals
      const normalCount = 30; // Number of normals to show
      const step = Math.floor(positions.count / normalCount);
      
      for (let i = 0; i < positions.count; i += step) {
        const x = positions.getX(i);
        const y = positions.getY(i);
        const z = positions.getZ(i);
        
        // Get the normal at this position
        const nx = terrainMesh.geometry.attributes.normal.getX(i);
        const ny = terrainMesh.geometry.attributes.normal.getY(i);
        const nz = terrainMesh.geometry.attributes.normal.getZ(i);
        
        const normal = new THREE.Vector3(nx, ny, nz).normalize();
        const position = new THREE.Vector3(x, y, z);
        
        // Create arrow helper
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

    function getTerrainHeightAt(x, y, z) {
      if (!terrain || !terrain.mesh) {
        return 0;
      }
      
      // Direction from center to position
      const direction = new THREE.Vector3(x, y, z).normalize();
      
      // Calculate a ray from the center through the position
      const raycaster = new THREE.Raycaster();
      const rayStart = new THREE.Vector3(0, 0, 0); // Start at center
      raycaster.set(rayStart, direction);
      
      const intersects = raycaster.intersectObject(terrain.mesh);
      
      if (intersects.length > 0) {
        // Return the distance from center to the intersection point
        return intersects[0].distance;
      }
      
      return PLANET_RADIUS; // Default to base radius if no intersection
    }
    
    function getTerrainNormalAt(x, y, z) {
      if (!terrain || !terrain.mesh) {
        return new THREE.Vector3(x, y, z).normalize(); // Default to direction from center
      }
      
      // Direction from center to position
      const direction = new THREE.Vector3(x, y, z).normalize();
      
      // Cast a ray from the center
      const raycaster = new THREE.Raycaster();
      const rayStart = new THREE.Vector3(0, 0, 0);
      raycaster.set(rayStart, direction);
      
      const intersects = raycaster.intersectObject(terrain.mesh);
      
      if (intersects.length > 0) {
        return intersects[0].face.normal.clone();
      }
      
      return direction; // Default to direction from center
    }

    function createPlayer() {
      // Spawn player further above terrain for a more visible fall
      const spawnDistance = PLANET_RADIUS + 10; // Increased from 5 to 10 for more dramatic fall
      
      // Choose a specific spawn direction for predictable testing
      const phi = Math.PI * 0.25; // 45 degrees from pole
      const theta = 0; // Along x-axis
      
      // Convert to Cartesian coordinates
      const spawnX = spawnDistance * Math.sin(phi) * Math.cos(theta);
      const spawnY = spawnDistance * Math.cos(phi);
      const spawnZ = spawnDistance * Math.sin(phi) * Math.sin(theta);
      
      // Use kinematic body
      const playerRigidBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
      playerRigidBodyDesc.setTranslation(spawnX, spawnY, spawnZ);
      
      const playerBody = physicsWorld.createRigidBody(playerRigidBodyDesc);
      
      // Align player with surface
      const upDirection = new THREE.Vector3(spawnX, spawnY, spawnZ).normalize();
      const worldUp = new THREE.Vector3(0, 1, 0);
      const alignmentQuat = new THREE.Quaternion().setFromUnitVectors(worldUp, upDirection);
      
      playerBody.setRotation({
        x: alignmentQuat.x,
        y: alignmentQuat.y,
        z: alignmentQuat.z,
        w: alignmentQuat.w
      });
      
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

    function createRandomObjects(count) {
      const shapes = ['box', 'sphere'];
      const colors = [0x7C4DFF, 0x00BFA5, 0xFFD600, 0x64DD17];
      
      for (let i = 0; i < count; i++) {
        // Place objects on terrain surface
        // Choose a random direction from center
        const phi = Math.random() * Math.PI;
        const theta = Math.random() * Math.PI * 2;
        
        // Base distance from center (we'll adjust by terrain height)
        const distance = PLANET_RADIUS + 0.5;
        
        // Convert spherical to Cartesian
        const dirX = Math.sin(phi) * Math.cos(theta);
        const dirY = Math.cos(phi); 
        const dirZ = Math.sin(phi) * Math.sin(theta);
        
        // Get actual terrain height in this direction
        const actualDistance = getTerrainHeightAt(dirX, dirY, dirZ);
        const terrainHeight = actualDistance || PLANET_RADIUS;
        
        // Position slightly above terrain
        const randomX = dirX * (terrainHeight + 0.5);
        const randomY = dirY * (terrainHeight + 0.5);
        const randomZ = dirZ * (terrainHeight + 0.5);
        
        const size = 0.8 + Math.random() * 1.5;
        
        const shapeType = shapes[Math.floor(Math.random() * shapes.length)];
        const color = colors[Math.floor(Math.random() * colors.length)];
        
        // Get terrain normal for alignment
        const normal = getTerrainNormalAt(dirX, dirY, dirZ);
        
        // Create rotation aligned with terrain
        const worldUp = new THREE.Vector3(0, 1, 0);
        const alignmentQuat = new THREE.Quaternion().setFromUnitVectors(worldUp, normal);
        
        // Add some random rotation around the normal
        const randomAngle = Math.random() * Math.PI * 2;
        const normalAxis = normal.clone();
        const randomRot = new THREE.Quaternion().setFromAxisAngle(normalAxis, randomAngle);
        alignmentQuat.multiply(randomRot);
        
        const bodyDesc = RAPIER.RigidBodyDesc.fixed();
        bodyDesc.setTranslation(randomX, randomY, randomZ);
        bodyDesc.setRotation({
          x: alignmentQuat.x,
          y: alignmentQuat.y,
          z: alignmentQuat.z,
          w: alignmentQuat.w
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
        
        // Add surface normal arrows
        addSurfaceNormals(obj);
      }
    }

    function createSurfaceObjects() {
      // Create objects aligned to the terrain surface
      const count = 8;
      
      for (let i = 0; i < count; i++) {
        // Distribute points evenly around the sphere
        const phi = Math.acos(2 * (i / count) - 1);
        const theta = i * Math.PI * (3 - Math.sqrt(5));
        
        // Direction from center
        const dirX = Math.sin(phi) * Math.cos(theta);
        const dirY = Math.cos(phi);
        const dirZ = Math.sin(phi) * Math.sin(theta);
        
        // Get actual terrain height in this direction
        const normal = new THREE.Vector3(dirX, dirY, dirZ).normalize();
        const terrainHeight = getTerrainHeightAt(dirX, dirY, dirZ);
        
        // Position on terrain
        const x = dirX * terrainHeight;
        const y = dirY * terrainHeight;
        const z = dirZ * terrainHeight;
        
        // Create object
        const size = 1.0 + Math.random() * 0.5;
        const color = new THREE.Color().setHSL(Math.random(), 0.7, 0.5);
        
        // Get surface normal
        const surfaceNormal = getTerrainNormalAt(dirX, dirY, dirZ);
        
        // Create rotation aligned to surface
        const worldUp = new THREE.Vector3(0, 1, 0);
        const rotationQuat = new THREE.Quaternion().setFromUnitVectors(worldUp, surfaceNormal);
        
        // Create body
        const bodyDesc = RAPIER.RigidBodyDesc.fixed();
        bodyDesc.setTranslation(x, y, z);
        bodyDesc.setRotation({
          x: rotationQuat.x,
          y: rotationQuat.y,
          z: rotationQuat.z,
          w: rotationQuat.w
        });
        
        const body = physicsWorld.createRigidBody(bodyDesc);
        
        // Create box - make it flatter for a platform
        const collider = RAPIER.ColliderDesc.cuboid(size/2, size/4, size/2);
        collider.setFriction(0.8);
        physicsWorld.createCollider(collider, body);
        
        // Create mesh
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(size, size/2, size),
          new THREE.MeshStandardMaterial({ color: color.getHex() })
        );
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
        
        // Add normal arrow
        const arrow = new THREE.ArrowHelper(
          surfaceNormal,
          new THREE.Vector3(x, y, z).addScaledVector(surfaceNormal, 0.3),
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
        // For spheres, create arrows in principal directions
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
        // For boxes, add a normal on the top face
        const topNormal = new THREE.Vector3(0, 1, 0);
        const worldNormal = topNormal.clone().applyQuaternion(quaternion);
        
        // Calculate position on the top face
        const halfSize = obj.size / 2;
        const localPos = new THREE.Vector3(0, halfSize, 0);
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

    function applyPointGravity() {
      if (!player || !player.body) return;
      
      const playerPos = player.body.translation();
      const playerPosition = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z);
      
      // For spherical terrain, gravity points toward the center
      let gravityDir = new THREE.Vector3().subVectors(TERRAIN_CENTER, playerPosition).normalize();
      
      // Apply gravity based on player state
      if (player.grounded) {
        // When grounded, apply a small force to keep player on ground
        if (player.lastContactNormal) {
          const stickForce = gravityDir.clone().negate().dot(player.lastContactNormal);
          
          if (stickForce > 0) {
            player.body.applyImpulse(
              { 
                x: player.lastContactNormal.x * stickForce * 0.01,
                y: player.lastContactNormal.y * stickForce * 0.01, 
                z: player.lastContactNormal.z * stickForce * 0.01
              }, 
              true
            );
          }
        }
      } else {
        // When in air, apply regular gravity
        if (player.isJumping) {
          // Less gravity during jump
          player.fallSpeed = Math.min(player.fallSpeed + 0.005, player.maxFallSpeed);
        } else {
          // Full gravity when falling
          player.fallSpeed = Math.min(player.fallSpeed + 0.01, player.maxFallSpeed);
        }
        
        // Apply movement in gravity direction
        player.body.setTranslation({
          x: playerPos.x + gravityDir.x * player.fallSpeed,
          y: playerPos.y + gravityDir.y * player.fallSpeed,
          z: playerPos.z + gravityDir.z * player.fallSpeed
        });
      }
    }

    function checkCollisions() {
      if (!player || !player.body || !player.mesh) return;
      
      // Reset collision state if needed
      if (player.jumpCooldown > 0) {
        player.jumpCooldown--;
      } else {
        player.grounded = false;
        player.lastContactNormal = null;
      }
      
      // Remove previous collision normal arrow
      if (collisionNormalArrow) {
        scene.remove(collisionNormalArrow);
        collisionNormalArrow = null;
      }
      
      // Get player position
      const playerPos = player.body.translation();
      const playerPosition = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z);
      
      // First check terrain collision
      if (terrain && terrain.mesh) {
        // For a sphere terrain, cast a ray from center through the player
        const playerDir = playerPosition.clone().normalize();
        const raycaster = new THREE.Raycaster();
        
        // Cast from a bit inside the center to avoid self-intersection
        const rayStart = playerDir.clone().multiplyScalar(-0.1);
        raycaster.set(rayStart, playerDir);
        
        const intersects = raycaster.intersectObject(terrain.mesh);
        
        if (intersects.length > 0) {
          // Calculate distance from player to terrain surface
          const hitPoint = intersects[0].point;
          const distanceToGround = playerPosition.distanceTo(hitPoint) - PLAYER_RADIUS;
          
          if (distanceToGround <= 0.1) {
            // We're on the ground
            player.grounded = true;
            player.falling = false;
            player.lastContactNormal = intersects[0].face.normal.clone();
            
            // Visualize normal
            collisionNormalArrow = new THREE.ArrowHelper(
              player.lastContactNormal,
              hitPoint,
              NORMAL_ARROW_LENGTH * 1.5,
              COLLISION_ARROW_COLOR,
              0.3,
              0.15
            );
            scene.add(collisionNormalArrow);
            
            // Align player with surface normal
            alignPlayerWithSurface(player.lastContactNormal);
            
            return;
          }
        }
      }
      
      // Then check other objects as before
      for (const obj of objects) {
        if (obj === terrain) continue; // Already checked terrain
        
        const objPos = obj.body.translation();
        const objPosition = new THREE.Vector3(objPos.x, objPos.y, objPos.z);
        
        let collisionNormal = null;
        let distance = 0;
        
        if (obj.type === 'sphere') {
          // Sphere collision
          const direction = new THREE.Vector3().subVectors(playerPosition, objPosition);
          distance = direction.length() - (obj.size/2 + PLAYER_RADIUS);
          
          if (distance <= 0.05) {
            collisionNormal = direction.normalize();
          }
        } else if (obj.type === 'box') {
          // Box collision
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
            // Find which face we hit
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
          
          // Align player with surface normal
          alignPlayerWithSurface(collisionNormal);
          
          break;
        }
      }
      
      // If not grounded and not jumping, start falling
      if (!player.grounded && player.jumpCooldown <= 0) {
        player.falling = true;
      }
    }
    
    function alignPlayerWithSurface(normal) {
      if (!player || !normal) return;
      
      // Align player with the surface normal
      const worldUp = new THREE.Vector3(0, 1, 0);
      const alignmentQuat = new THREE.Quaternion().setFromUnitVectors(worldUp, normal);
      
      player.body.setRotation({
        x: alignmentQuat.x,
        y: alignmentQuat.y,
        z: alignmentQuat.z,
        w: alignmentQuat.w
      });
    }

    function handlePlayerMovement() {
      if (!player || !player.body) return;
      
      const playerPos = player.body.translation();
      const playerRot = player.body.rotation();
      const playerQuat = new THREE.Quaternion(playerRot.x, playerRot.y, playerRot.z, playerRot.w);
      
      // Create movement direction from key input
      const moveDirection = new THREE.Vector3(0, 0, 0);
      if (keys.w) moveDirection.z -= 1;
      if (keys.s) moveDirection.z += 1;
      if (keys.a) moveDirection.x -= 1;
      if (keys.d) moveDirection.x += 1;
      
      if (moveDirection.length() > 0) {
        moveDirection.normalize();
      }
      
      // Convert local movement to world space based on player orientation
      const worldMoveDir = moveDirection.clone().applyQuaternion(playerQuat);
      
      // Calculate new position
      let newPosition = new THREE.Vector3(
        playerPos.x,
        playerPos.y,
        playerPos.z
      );
      
      // If grounded, move along the surface
      if (player.grounded && player.lastContactNormal) {
        // Project movement onto the surface plane
        const normal = player.lastContactNormal;
        const proj = worldMoveDir.dot(normal);
        const tangent = new THREE.Vector3()
          .copy(worldMoveDir)
          .sub(normal.clone().multiplyScalar(proj))
          .normalize();
        
        // Move along surface
        if (moveDirection.length() > 0) {
          newPosition.add(tangent.multiplyScalar(MOVE_SPEED));
        }
      } 
      // If in air, allow limited movement
      else if (player.isJumping || player.falling) {
        if (moveDirection.length() > 0) {
          newPosition.add(worldMoveDir.multiplyScalar(MOVE_SPEED * 0.3));
        }
        
        if (player.isJumping && player.jumpDirection) {
          // Continue jump movement
          newPosition.add(player.jumpDirection.clone().multiplyScalar(-player.fallSpeed));
          
          // Transition to falling if speed becomes positive
          if (player.fallSpeed > 0) {
            player.isJumping = false;
          }
        }
      }
      
      player.body.setTranslation(newPosition);
      
      // Check for collisions after movement
      checkCollisions();
    }

    function handlePlayerJump() {
      if (!player || !player.grounded || player.jumpCooldown > 0) return;
      
      if (keys.space) {
        // Use the surface normal as jump direction
        const jumpDirection = player.lastContactNormal.clone().normalize();
        
        player.jumpDirection = jumpDirection;
        player.isJumping = true;
        player.grounded = false;
        player.falling = false;
        player.jumpCooldown = 15;
        player.fallSpeed = -0.2; // Initial upward movement
        
        // Apply jump impulse
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
      
      // Handle jump input
      handlePlayerJump();
      
      // Apply gravity
      applyPointGravity();
      
      // Handle player movement
      handlePlayerMovement();
      
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
