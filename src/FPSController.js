import * as THREE from 'three';

export default class FPSController {
  constructor(camera, player, scene) {
    this.camera = camera;
    this.player = player;
    this.scene = scene;
    
    // Camera settings
    this.cameraHeight = 1.6;
    this.cameraOffset = new THREE.Vector3(0, this.cameraHeight, 0);
    this.lookSensitivity = 0.002;
    this.maxPitchAngle = Math.PI * 0.45; // 45 degrees up/down
    
    // Aiming properties
    this.isAiming = false;
    this.aimRaycaster = new THREE.Raycaster();
    this.aimDirection = new THREE.Vector3(0, 0, -1);
    this.targetPoint = new THREE.Vector3();
    
    // Optional: Create aim indicator (crosshair or dot)
    // this.createAimIndicator();
    
    // Initialize camera position and rotation
    this.camera.position.copy(this.player.position).add(this.cameraOffset);
    this.camera.lookAt(this.player.position.clone().add(new THREE.Vector3(0, this.cameraHeight, 1)));
    this.camera.rotation.order = 'YXZ'; // Important for FPS camera to prevent gimbal lock
    
    // Bind methods
    this.onMouseMove = this.onMouseMove.bind(this);
    
    // Add event listeners
    document.addEventListener('mousemove', this.onMouseMove);
  }
  
  // Handle mouse movement for camera rotation
  onMouseMove(event) {
    if (document.pointerLockElement) { // Check if pointer is locked (optional)
      const deltaX = event.movementX;
      const deltaY = event.movementY;
      
      // Update player rotation (y-axis)
      this.player.rotation.y -= deltaX * this.lookSensitivity;
      
      // Update camera pitch (x-axis) with clamping
      this.camera.rotation.x -= deltaY * this.lookSensitivity;
      this.camera.rotation.x = Math.max(
        -this.maxPitchAngle, 
        Math.min(this.maxPitchAngle, this.camera.rotation.x)
      );
      
      // Update aim direction
      this.updateAimDirection();
    }
  }
  
  // Update camera position to follow player
  update() {
    // Calculate target position (with smoothing if desired)
    const targetPosition = this.player.position.clone().add(this.cameraOffset);
    
    // Update camera position
    this.camera.position.copy(targetPosition);
    
    // Sync camera's Y rotation with player's rotation
    this.camera.rotation.y = this.player.rotation.y;
    
    // Keep quaternion normalized
    this.camera.quaternion.normalize();
    
    // Update aiming
    this.updateAiming();
  }
  
  // Update aim direction based on camera orientation
  updateAimDirection() {
    this.aimDirection.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    
    // Cast ray for aiming
    this.aimRaycaster.set(this.camera.position, this.aimDirection);
    // You can filter what objects can be aimed at
    const intersects = this.aimRaycaster.intersectObjects(this.scene.children, true);
    
    if (intersects.length > 0) {
      this.targetPoint.copy(intersects[0].point);
    } else {
      // If no intersection, set a point at a reasonable distance
      this.targetPoint.copy(this.camera.position)
        .add(this.aimDirection.clone().multiplyScalar(100));
    }
  }
  
  // Handle aiming state and updates
  updateAiming() {
    this.updateAimDirection();
    
    // If using an aim indicator, update its position
    // if (this.aimIndicator) {
    //   this.aimIndicator.position.copy(this.targetPoint);
    // }
  }
  
  // Get current aim target point
  getAimTarget() {
    return this.targetPoint.clone();
  }
  
  // Clean up
  dispose() {
    document.removeEventListener('mousemove', this.onMouseMove);
  }
};