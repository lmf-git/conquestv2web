import { defineStore } from 'pinia';
import * as THREE from 'three';

export const useGameStore = defineStore('game', {
  state: () => ({
    players: new Map(),
    myId: null,
    planetRadius: 100,
    ws: null,
    lastServerState: null,
    previousServerState: null,
    keys: { w: false, a: false, s: false, d: false, ' ': false },
    isConnected: false,
    isInitialized: false
  }),
  
  actions: {
    connectToServer() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // Fix incorrect process.dev check and use the correct port
      const host = process.env.NODE_ENV === 'development' ? 'localhost:3001' : window.location.host;
      const wsUrl = `${protocol}//${host}`;
      
      this.ws = new WebSocket(wsUrl);
      
      this.ws.onopen = () => {
        console.log('Connected to server');
        this.isConnected = true;
      };
      
      this.ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        
        if (message.type === 'init') {
          this.myId = message.data.id;
          this.planetRadius = message.data.planetRadius;
          console.log('Initialized with ID:', this.myId);
        } 
        else if (message.type === 'state') {
          this.previousServerState = this.lastServerState;
          this.lastServerState = message.data;
        }
      };
      
      this.ws.onclose = () => {
        console.log('Disconnected from server');
        this.isConnected = false;
        setTimeout(() => this.connectToServer(), 3000);
      };
      
      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    },
    
    sendInput(rotation) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const direction = { x: 0, y: 0, z: 0 };
        
        if (this.keys.w) direction.z = -1;
        if (this.keys.s) direction.z = 1;
        if (this.keys.a) direction.x = -1;
        if (this.keys.d) direction.x = 1;
        
        // Include jump input
        const jump = this.keys[' '] || false;
        
        this.ws.send(JSON.stringify({
          type: 'input',
          data: {
            dir: direction,
            rot: rotation,
            jump: jump,
            timestamp: Date.now()
          }
        }));
      }
    },
    
    getMyPlayerData() {
      if (!this.lastServerState) return null;
      return this.lastServerState.players.find((p) => p.id === this.myId);
    },
    
    lerpVectors(a, b, t) {
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t
      };
    }
  }
});