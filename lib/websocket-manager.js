// websocket-manager.js
const { SocketClient } = require('./iobroker-ws-client-nodejs');

class SimpleWebSocketManager {
    constructor() {
        this.client = null;
        this.connected = false;
        this.connecting = false;
        this.serverId = null;
        this.config = null;
        
        this.subscriptions = new Map(); // stateId -> Set(nodeIds)
        this.callbacks = new Map(); // nodeId -> callback
        this.eventNodes = new Map(); // nodeId -> callback (event-only)
        
        this.reconnectAttempts = 0;
    }

    log(msg) {
        // Use Node-RED compatible timestamp format
        const now = new Date();
        const day = now.getDate().toString().padStart(2, '0');
        const month = now.toLocaleDateString('en', { month: 'short' });
        const time = now.toTimeString().slice(0, 8);
        console.log(`${day} ${month} ${time} - [info] [WebSocket Manager] ${msg}`);
    }

    /**
     * Force server switch - NEW METHOD for configuration changes
     */
    async forceServerSwitch(oldServerId, newServerId, config) {
        this.log(`Forcing server switch from ${oldServerId} to ${newServerId}`);
        
        // Close existing connection immediately if it matches the old server
        if (this.client && this.serverId === oldServerId) {
            this.log('Closing connection to old server');
            this.close();
        }
        
        // Clear any cached state
        this.serverId = null;
        this.config = null;
        this.connected = false;
        this.connecting = false;
        this.reconnectAttempts = 0;
        
        // Wait briefly to ensure clean state
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Establish new connection
        this.log(`Establishing new connection to ${newServerId}`);
        await this.getConnection(newServerId, config);
    }

    /**
     * Get or create connection
     */
    async getConnection(serverId, config) {
        // Switch server if needed
        if (this.serverId && this.serverId !== serverId) {
            this.log(`Switching from ${this.serverId} to ${serverId}`);
            this.close();
        }

        // Return existing connection
        if (this.client && this.connected && this.serverId === serverId) {
            this.log(`Reusing connection to ${serverId}`);
            return this.client;
        }

        // Wait if connecting
        if (this.connecting) {
            this.log('Waiting for connection...');
            while (this.connecting) {
                await new Promise(r => setTimeout(r, 100));
            }
            return this.client;
        }

        // Create new connection
        return this.connect(serverId, config);
    }

    /**
     * Create connection
     */
    async connect(serverId, config) {
        if (this.connecting) return this.client;
        
        this.connecting = true;
        this.serverId = serverId;
        this.config = config;
        
        try {
            this.log(`Connecting to ${serverId}`);
            this.updateStatus('connecting');

            const client = new SocketClient();
            this.client = client;

            // Setup handlers
            client.on('connect', () => {
                this.log('Connected');
                this.connected = true;
                this.reconnectAttempts = 0;
                this.updateStatus('connected');
                this.resubscribe();
            });

            client.on('disconnect', () => {
                this.log('Disconnected');
                this.connected = false;
                this.updateStatus('disconnected');
                this.notifyEvent('disconnect');
                this.handleReconnect();
            });

            client.on('reconnect', () => {
                this.log('Reconnected');
                this.connected = true;
                this.reconnectAttempts = 0;
                this.updateStatus('connected');
                this.notifyEvent('reconnect');
                this.resubscribe();
            });

            client.on('stateChange', (id, state) => {
                this.handleStateChange(id, state);
            });

            client.on('error', (err) => {
                this.log(`Error: ${err.message}`);
                this.connected = false;
                this.updateStatus('disconnected');
            });

            // Connect
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Connection timeout')), 15000);
                
                client.on('connect', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                
                client.on('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });

                client.connect(`ws://${config.iobhost}:${config.iobport}`, {
                    name: 'NodeRED-ioBroker',
                    connectMaxAttempt: 3
                });
            });

            return client;

        } catch (error) {
            this.log(`Connection failed: ${error.message}`);
            this.client = null;
            this.connected = false;
            this.updateStatus('disconnected');
            throw error;
        } finally {
            this.connecting = false;
        }
    }

    /**
     * Subscribe to state
     */
    async subscribe(nodeId, serverId, stateId, callback, config) {
        const client = await this.getConnection(serverId, config);
        
        this.callbacks.set(nodeId, callback);
        
        if (!this.subscriptions.has(stateId)) {
            this.subscriptions.set(stateId, new Set());
            if (!stateId.startsWith('_dummy_')) {
                await this.subscribeState(client, stateId);
            }
        }
        
        this.subscriptions.get(stateId).add(nodeId);
        this.log(`Node ${nodeId} subscribed to ${stateId}`);
    }

    /**
     * Register for events only
     */
    async registerForEvents(nodeId, serverId, callback, config) {
        await this.getConnection(serverId, config);
        this.eventNodes.set(nodeId, callback);
        this.log(`Node ${nodeId} registered for events`);
    }

    /**
     * Subscribe to ioBroker state
     */
    async subscribeState(client, stateId) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Subscribe timeout')), 5000);
            client.emit('subscribe', stateId, (err) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else {
                    this.log(`Subscribed to ${stateId}`);
                    resolve();
                }
            });
        });
    }

    /**
     * Get state
     */
    async getState(serverId, stateId) {
        const client = await this.getConnection(serverId, this.config);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Get state timeout')), 10000);
            client.emit('getState', stateId, (err, state) => {
                clearTimeout(timeout);
                err ? reject(err) : resolve(state);
            });
        });
    }

    /**
     * Set state
     */
    async setState(serverId, stateId, value, ack = true) {
        const client = await this.getConnection(serverId, this.config);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Set state timeout')), 8000);
            const state = { val: value, ack, from: 'system.adapter.node-red', ts: Date.now() };
            client.emit('setState', stateId, state, (err) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else {
                    this.log(`Set ${stateId} = ${value} (ack: ${ack})`);
                    resolve();
                }
            });
        });
    }

    /**
     * Get states
     */
    async getStates(serverId) {
        const client = await this.getConnection(serverId, this.config);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Get states timeout')), 10000);
            client.emit('getStates', '*', (err, states) => {
                clearTimeout(timeout);
                err ? reject(err) : resolve(states);
            });
        });
    }

    /**
     * Handle state change
     */
    handleStateChange(stateId, state) {
        const nodeIds = this.subscriptions.get(stateId);
        if (!nodeIds) return;

        this.log(`State change: ${stateId} -> ${nodeIds.size} nodes`);
        nodeIds.forEach(nodeId => {
            const callback = this.callbacks.get(nodeId);
            if (callback) {
                try {
                    callback(stateId, state);
                } catch (err) {
                    this.log(`Callback error: ${err.message}`);
                }
            }
        });
    }

    /**
     * Update all node statuses
     */
    updateStatus(status) {
        this.log(`Status: ${status}`);
        
        // Update subscription nodes
        this.callbacks.forEach(callback => {
            if (callback.updateStatus) {
                try {
                    callback.updateStatus(status);
                } catch (err) {
                    this.log(`Status update error: ${err.message}`);
                }
            }
        });

        // Update event nodes
        this.eventNodes.forEach(callback => {
            if (callback.updateStatus) {
                try {
                    callback.updateStatus(status);
                } catch (err) {
                    this.log(`Event status update error: ${err.message}`);
                }
            }
        });
    }

    /**
     * Notify about events
     */
    notifyEvent(event) {
        this.log(`Event: ${event}`);
        
        // Notify subscription nodes
        this.callbacks.forEach(callback => {
            if (callback[`on${event.charAt(0).toUpperCase()}${event.slice(1)}`]) {
                try {
                    callback[`on${event.charAt(0).toUpperCase()}${event.slice(1)}`]();
                } catch (err) {
                    this.log(`Event notify error: ${err.message}`);
                }
            }
        });

        // Notify event nodes
        this.eventNodes.forEach(callback => {
            if (callback[`on${event.charAt(0).toUpperCase()}${event.slice(1)}`]) {
                try {
                    callback[`on${event.charAt(0).toUpperCase()}${event.slice(1)}`]();
                } catch (err) {
                    this.log(`Event node notify error: ${err.message}`);
                }
            }
        });
    }

    /**
     * Handle reconnection
     */
    handleReconnect() {
        this.reconnectAttempts++;
        if (this.reconnectAttempts > 10) return;

        this.updateStatus('reconnecting');
        const delay = Math.min(5000 * this.reconnectAttempts, 30000);
        
        setTimeout(() => {
            if (!this.connecting && !this.connected && this.config) {
                this.log(`Reconnect attempt ${this.reconnectAttempts}`);
                this.connect(this.serverId, this.config).catch(() => {});
            }
        }, delay);
    }

    /**
     * Resubscribe to all states
     */
    async resubscribe() {
        if (!this.client || !this.connected) return;
        
        const states = Array.from(this.subscriptions.keys()).filter(id => !id.startsWith('_dummy_'));
        if (states.length === 0) return;
        
        this.log(`Resubscribing to ${states.length} states`);
        for (const stateId of states) {
            try {
                await this.subscribeState(this.client, stateId);
                await new Promise(r => setTimeout(r, 100));
            } catch (err) {
                this.log(`Resubscribe failed for ${stateId}: ${err.message}`);
            }
        }
    }

    /**
     * Unsubscribe
     */
    async unsubscribe(nodeId, serverId, stateId) {
        const nodeIds = this.subscriptions.get(stateId);
        if (!nodeIds) return;

        nodeIds.delete(nodeId);
        if (nodeIds.size === 0) {
            this.subscriptions.delete(stateId);
            if (this.client && this.connected && !stateId.startsWith('_dummy_')) {
                this.client.emit('unsubscribe', stateId, () => {});
            }
        }
        
        this.callbacks.delete(nodeId);
        this.log(`Node ${nodeId} unsubscribed from ${stateId}`);
    }

    /**
     * Unregister from events
     */
    unregisterFromEvents(nodeId) {
        this.eventNodes.delete(nodeId);
        this.log(`Node ${nodeId} unregistered from events`);
    }

    /**
     * Get connection status
     */
    getConnectionStatus(serverId) {
        return {
            connected: this.connected,
            status: this.connected ? 'connected' : 'disconnected',
            serverId: this.serverId,
            subscriptions: this.subscriptions.size,
            eventNodes: this.eventNodes.size,
            reconnectAttempts: this.reconnectAttempts
        };
    }

    /**
     * Close connection
     */
    close() {
        if (this.client) {
            try {
                this.client.destroy();
            } catch (err) {}
        }
        this.client = null;
        this.connected = false;
        this.serverId = null;
        this.config = null;
    }

    /**
     * Cleanup
     */
    async cleanup() {
        this.log('Cleanup');
        this.close();
        this.subscriptions.clear();
        this.callbacks.clear();
        this.eventNodes.clear();
    }
}

// Singleton
const connectionManager = new SimpleWebSocketManager();

// Cleanup on exit
process.on('SIGTERM', () => connectionManager.cleanup());
process.on('SIGINT', () => connectionManager.cleanup());

module.exports = connectionManager;