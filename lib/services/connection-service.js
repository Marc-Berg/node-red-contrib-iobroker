// lib/services/connection-service.js
const WebSocket = require('ws');
const eventBus = require('../events/event-bus');

/**
 * Manages the raw WebSocket connection lifecycle.
 * Waits for authentication to complete before connecting.
 */
class ConnectionService {
    constructor() {
        this.socket = null;
        this.connectionAttempt = null;

        // Connect when authentication is successful (token received)
        eventBus.on('auth:token_received', ({ config, token }) => this.connect(config, token));
        
        // Connect when no authentication is needed
        eventBus.on('auth:not_required', ({ config }) => this.connect(config, null));

        // Listen for send requests
        eventBus.on('websocket:send', (message) => this.send(message));
    }

    async connect(config, token) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            return;
        }

        if (this.connectionAttempt) {
            return this.connectionAttempt;
        }

        const url = this.buildUrl(config, token);
        this.connectionAttempt = new Promise((resolve, reject) => {
            // Use config from the event, which is the single source of truth
            this.socket = new WebSocket(url, { rejectUnauthorized: false });

            this.socket.on('open', () => {
                // The raw socket is open, but we are not "ready" yet.
                // The server will send a '___ready___' message.
            });

            this.socket.on('message', (data) => {
                // Pass all messages to the bus for other services to handle
                eventBus.emit('websocket:message', { serverId: config.serverId, data });
            });

            this.socket.on('close', () => {
                eventBus.emit('connection:disconnected', { serverId: config.serverId });
                this.socket = null;
            });

            this.socket.on('error', (error) => {
                eventBus.emit('connection:error', { serverId: config.serverId, error });
                reject(error);
            });
        }).finally(() => {
            this.connectionAttempt = null;
        });

        return this.connectionAttempt;
    }

    send(message) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(message));
        }
    }
    
    buildUrl({ iobhost, iobport, usessl }, token) {
        const protocol = usessl ? 'wss' : 'ws';
        let url = `${protocol}://${iobhost}:${iobport}?sid=${Date.now()}`;
        if (token) {
            url += `&token=${token}`;
        }
        return url;
    }
}

module.exports = ConnectionService;