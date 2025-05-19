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
    
    // New vars for performance control
    let showDebugNormals = false; // Set to false to improve performance
    let lastTime = 0;
    let frameCounter = 0;
    let frameTime = 0;
    let fps = 0;

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
      camera.position.set(0, PLANET_RADIUS + 30, 30);
      
      renderer = new THREE.WebGLRenderer({ 
        canvas: canvas.value,
        antialias: true 
      });
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Limit pixel ratio for performance
      
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
      
      // Physics setup - create with more precise solver
      physicsWorld = new RAPIER.World({ x: 0.0, y: 0.0, z: 0.0 });
      physicsWorld.maxVelocityIterations = 8; // Increase solver iterations
      physicsWorld.maxPositionIterations = 4;
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
      const segments = 8; // Reduced from 12 for better performance
      
      // Create triangulation of sphere for collision
      createSphereColliders(terrainMesh, terrainBody, segments);
      
      // Only add terrain normals in debug mode
      if (showDebugNormals) {
        addTerrainNormals(terrainMesh, positions);
      }
      
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
              // Remove problematic methods that don't exist in this Rapier version
              try {
                // Try to set active events, but don't error if the method doesn't exist
                if (typeof colliderDesc.setActiveEvents === 'function') {
                  colliderDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
                }
                // Don't try to use setMargin as it doesn't exist
              } catch (e) {
                console.log("Some collision features not available in this Rapier version");
              }
              physicsWorld.createCollider(colliderDesc, terrainBody);
            }
          }
        }
      }
      
      // Add additional safety collider at planet radius - this should help prevent falling through
      const safetyColliderDesc = RAPIER.ColliderDesc.ball(PLANET_RADIUS - 0.5);
      safetyColliderDesc.setFriction(0.8);
      physicsWorld.createCollider(safetyColliderDesc, terrainBody);
      
      // Add a second, slightly smaller safety collider for extra protection
      const innerSafetyColliderDesc = RAPIER.ColliderDesc.ball(PLANET_RADIUS - 1.0);
      innerSafetyColliderDesc.setFriction(0.8);
      physicsWorld.createCollider(innerSafetyColliderDesc, terrainBody);
      
      // Add a third, even smaller safety collider to create layered protection
      const coreColliderDesc = RAPIER.ColliderDesc.ball(PLANET_RADIUS - 2.0);
      coreColliderDesc.setFriction(0.8);
      physicsWorld.createCollider(coreColliderDesc, terrainBody);
      
      // Add a slightly larger collider to prevent tunneling at high speeds
      const outerColliderDesc = RAPIER.ColliderDesc.ball(PLANET_RADIUS + 0.1);
      outerColliderDesc.setFriction(0.2); // Lower friction for the outer shell
      physicsWorld.createCollider(outerColliderDesc, terrainBody);
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
      // Spawn player much higher above terrain for better visibility
      const spawnDistance = PLANET_RADIUS + 20;
      
      // Position directly above positive Y axis for easy visibility
      const phi = 0; // Place at north pole (straight up on Y-axis)
      const theta = 0; // Angle doesn't matter at poles
      
      // Convert to Cartesian coordinates
      const spawnX = 0; 
      const spawnY = spawnDistance;
      const spawnZ = 0;
      
      console.log(`Spawning player at: (${spawnX}, ${spawnY}, ${spawnZ})`);
      
      // Add a visual marker at spawn point for debugging
      const markerGeometry = new THREE.SphereGeometry(0.5, 16, 16);
      const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true });
      const spawnMarker = new THREE.Mesh(markerGeometry, markerMaterial);
      spawnMarker.position.set(spawnX, spawnY, spawnZ);
      scene.add(spawnMarker);
      
      // Use dynamic body instead of kinematic for better physics interaction
      const playerRigidBodyDesc = RAPIER.RigidBodyDesc.dynamic();
      playerRigidBodyDesc.setTranslation(spawnX, spawnY, spawnZ);
      
      // Add additional physics properties for stability
      playerRigidBodyDesc.lockRotations(); // Prevent tipping
      playerRigidBodyDesc.setLinearDamping(0.5); // Add damping to prevent bouncing
      playerRigidBodyDesc.setCcdEnabled(true); // Enable continuous collision detection if available
      
      const playerBody = physicsWorld.createRigidBody(playerRigidBodyDesc);
      
      // Align player with surface - looking outward from planet center
      const upDirection = new THREE.Vector3(spawnX, spawnY, spawnZ).normalize();
      const worldUp = new THREE.Vector3(0, 1, 0);
      const alignmentQuat = new THREE.Quaternion().setFromUnitVectors(worldUp, upDirection);
      
      playerBody.setRotation({
        x: alignmentQuat.x,
        y: alignmentQuat.y,
        z: alignmentQuat.z,
        w: alignmentQuat.w
      });
      
      // Create slightly larger collider than visual model to prevent slipping through gaps
      const playerColliderDesc = RAPIER.ColliderDesc.capsule(PLAYER_HEIGHT / 2 + 0.05, PLAYER_RADIUS + 0.05);
      playerColliderDesc.setFriction(0.7);
      playerColliderDesc.setRestitution(0.1); // Reduce bounciness
      playerColliderDesc.setDensity(2.0); // Higher density for more weight
      
      const collider = physicsWorld.createCollider(playerColliderDesc, playerBody);
      
      // Create a more visible player mesh with bright color
      const playerMesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT, 20, 20),
        new THREE.MeshStandardMaterial({ color: 0xff0000, emissive: 0x331111 })
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
        fallSpeed: 0.005, // Start with even lower fall speed
        maxFallSpeed: 0.08, // Reduce max fall speed further
        mass: 1,
        isJumping: false,
        jumpDirection: null,
        teleportSafetyEnabled: true, // New flag for safety teleport
        lastSafePosition: new THREE.Vector3(spawnX, spawnY, spawnZ) // Remember spawn as safe position
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

    // Completely rewrite the gravity function to use proper physics forces
    function applyPointGravity() {
      if (!player || !player.body) return;
      
      // Apply gravitational force toward the center of the terrain
      const playerPos = player.body.translation();
      const playerPosition = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z);
      
      // For spherical terrain, gravity points toward the center
      let gravityDir = new THREE.Vector3().subVectors(TERRAIN_CENTER, playerPosition).normalize();
      
      // Calculate distance for gravity scaling (stronger when closer)
      const distanceToCenter = playerPosition.distanceTo(TERRAIN_CENTER);
      
      // Increase gravity near the surface to better stick player to ground
      let gravityMultiplier = 1.0;
      const surfaceProximity = Math.abs(distanceToCenter - PLANET_RADIUS);
      
      if (surfaceProximity < 0.5) {
        // Apply stronger gravity near the surface (up to 2x)
        gravityMultiplier = 2.0 - surfaceProximity * 2.0;
      }
      
      const gravityStrength = GRAVITY_STRENGTH * gravityMultiplier * 
        (PLANET_RADIUS / Math.max(distanceToCenter, PLANET_RADIUS * 0.5));
      
      // Apply gravity as a force to the player's dynamic body
      player.body.addForce(
        { 
          x: gravityDir.x * gravityStrength,
          y: gravityDir.y * gravityStrength, 
          z: gravityDir.z * gravityStrength
        }, 
        true
      );
      
      // If the player's very close to terrain, add a damping force to prevent bouncing
      if (distanceToCenter < PLANET_RADIUS + 1.0) {
        const vel = player.body.linvel();
        
        // Apply damping proportional to speed
        const dampingFactor = 0.95;
        player.body.setLinvel(
          {
            x: vel.x * dampingFactor,
            y: vel.y * dampingFactor,
            z: vel.z * dampingFactor
          },
          true
        );
      }
      
      // Always align player with gravity direction
      alignPlayerWithDirection(gravityDir);
    }
    
    // New helper function to align player with any direction
    function alignPlayerWithDirection(direction) {
      if (!player || !player.body) return;
      
      // Create up direction opposite to gravity
      const upDirection = direction.clone().negate().normalize();
      
      // Create rotation that aligns player's up with this direction
      const worldUp = new THREE.Vector3(0, 1, 0);
      const alignmentQuat = new THREE.Quaternion().setFromUnitVectors(worldUp, upDirection);
      
      // Apply this orientation to player
      player.body.setRotation({
        x: alignmentQuat.x,
        y: alignmentQuat.y,
        z: alignmentQuat.z,
        w: alignmentQuat.w
      });
    }
    
    function handlePlayerMovement() {
      if (!player || !player.body) return;
      
      // Get player's current state
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
        
        // Convert local movement to world space based on player orientation
        const worldMoveDir = moveDirection.clone().applyQuaternion(playerQuat);
        
        // Apply impulse in movement direction
        const moveImpulse = 0.3 * MOVE_SPEED; // Scale force appropriately
        player.body.applyImpulse(
          {
            x: worldMoveDir.x * moveImpulse,
            y: worldMoveDir.y * moveImpulse,
            z: worldMoveDir.z * moveImpulse
          },
          true
        );
      }
      
      // Apply a horizontal velocity damping to prevent sliding too much
      const vel = player.body.linvel();
      const horizontalDamping = player.grounded ? 0.9 : 0.98; // More damping when grounded
      
      // Apply selective damping to horizontal movement only
      // This requires transforming velocity into player's local space
      const localVel = new THREE.Vector3(vel.x, vel.y, vel.z).applyQuaternion(playerQuat.clone().invert());
      
      // Apply damping to X and Z components (horizontal)
      localVel.x *= horizontalDamping;
      localVel.z *= horizontalDamping;
      
      // Transform back to world space
      const dampedVel = localVel.applyQuaternion(playerQuat);
      
      // Apply the damped velocity
      player.body.setLinvel(
        {
          x: dampedVel.x,
          y: dampedVel.y,
          z: dampedVel.z
        },
        true
      );
    }

    function handlePlayerJump() {
      if (!player || !player.jumpCooldown > 0) return;
      
      // Check if player is close enough to the ground to jump
      const playerPos = player.body.translation();
      const playerPosition = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z);
      const distanceToCenter = playerPosition.distanceTo(TERRAIN_CENTER);
      
      // Set grounded state based on proximity to terrain
      player.grounded = distanceToCenter < PLANET_RADIUS + PLAYER_HEIGHT + 0.2;
      
      if (player.grounded && keys.space) {
        // Calculate jump direction (away from planet center)
        const jumpDirection = playerPosition.clone().sub(TERRAIN_CENTER).normalize();
        
        // Apply jump impulse
        const jumpStrength = JUMP_FORCE * 10; // Adjust jump strength
        player.body.applyImpulse(
          {
            x: jumpDirection.x * jumpStrength,
            y: jumpDirection.y * jumpStrength,
            z: jumpDirection.z * jumpStrength
          },
          true
        );
        
        player.jumpCooldown = 20; // Prevent jumping again for a short time
      }
      
      // Decrement jump cooldown
      if (player.jumpCooldown > 0) {
        player.jumpCooldown--;
      }
    }

    // New function to detect and rescue player when falling through terrain
    function handlePlayerSafety() {
      if (!player || !player.body || !player.teleportSafetyEnabled) return;
      
      const playerPos = player.body.translation();
      const playerPosition = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z);
      const distanceToCenter = playerPosition.distanceTo(TERRAIN_CENTER);
      
      // If player is getting too close to center (inside planet core), teleport back to safety
      if (distanceToCenter < PLANET_RADIUS - 3.0) {
        console.warn("Safety triggered: Player detected inside planet, teleporting to safety");
        
        // Use the last known safe position, or a position above the terrain
        if (player.lastSafePosition) {
          player.body.setTranslation({
            x: player.lastSafePosition.x,
            y: player.lastSafePosition.y, 
            z: player.lastSafePosition.z
          });
          
          // Reset velocity to prevent continued falling
          player.body.setLinvel({x: 0, y: 0, z: 0}, true);
        } else {
          // Teleport to a safe position above the terrain
          const upVector = new THREE.Vector3(0, 1, 0);
          const safePosition = {
            x: 0,
            y: PLANET_RADIUS + 5,
            z: 0
          };
          player.body.setTranslation(safePosition);
        }
      } 
      // Store safe positions when player is definitely on the surface
      else if (distanceToCenter > PLANET_RADIUS && distanceToCenter < PLANET_RADIUS + 3) {
        player.lastSafePosition = playerPosition.clone();
      }
    }

    function animate(time) {
      animationFrameId = requestAnimationFrame(animate);
      
      // Calculate FPS for performance monitoring
      frameCounter++;
      const elapsed = time - lastTime;
      frameTime += elapsed;
      
      if (frameTime >= 1000) {
        fps = frameCounter;
        frameCounter = 0;
        frameTime = 0;
        console.log(`FPS: ${fps}`);
      }
      lastTime = time;
      
      // Handle player input
      handlePlayerJump();
      handlePlayerMovement();
      
      // Handle player safety before physics step
      handlePlayerSafety();
      
      // Apply gravity to player
      applyPointGravity();
      
      // Use multiple physics substeps for better stability
      const substeps = 3; // Increase substeps for better collision detection
      for (let i = 0; i < substeps; i++) {
        physicsWorld.step();
      }
      
      // Run player safety check again after physics
      handlePlayerSafety();
      
      // Ensure camera follows player
      if (player && player.mesh) {
        controls.target.copy(player.mesh.position);
      }
      
      // Update object transforms
      if (player) {
        updateObjectTransform(player);
      }
      
      for (const obj of objects) {
        updateObjectTransform(obj);
      }
      
      // Update controls and render
      controls.update();
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
