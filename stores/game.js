import { defineStore } from 'pinia';

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
      const host = process.env.NODE_ENV === 'development' ? 'localhost:3001' : window.location.host;
      
      this.ws = new WebSocket(`${protocol}//${host}`);
      
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
      
      this.ws.onerror = error => console.error('WebSocket error:', error);
    },
    
    sendInput(rotation) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      
      // Build direction object directly
      const dir = { 
        x: (this.keys.a ? -1 : 0) + (this.keys.d ? 1 : 0),
        y: 0,
        z: (this.keys.w ? -1 : 0) + (this.keys.s ? 1 : 0)
      };
      
      // Only send if there's actual input
      this.ws.send(JSON.stringify({
        type: 'input',
        data: {
          dir,
          rot: rotation,
          jump: this.keys[' '] || false,
          timestamp: Date.now()
        }
      }));
    },
    
    getMyPlayerData() {
      return this.lastServerState?.players.find(p => p.id === this.myId) || null;
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