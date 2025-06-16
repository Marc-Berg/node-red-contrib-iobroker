// websocket-manager.js with authentication support
const { SocketClient } = require('./iobroker-ws-client-nodejs');

class AuthenticatedWebSocketManager {
    constructor() {
        this.client = null;
        this.connected = false;
        this.connecting = false;
        this.serverId = null;
        this.config = null;
        
        // State management
        this.subscriptions = new Map(); // stateId -> Set(nodeIds)
        this.callbacks = new Map(); // nodeId -> callback
        this.eventNodes = new Map(); // nodeId -> callback (event-only)
        
        // Object management
        this.objectSubscriptions = new Map(); // pattern -> Set(nodeIds)
        this.objectCallbacks = new Map(); // nodeId -> callback
        this.objectCache = new Map(); // objectId -> object data
        
        this.reconnectAttempts = 0;
    }

    log(msg) {
        // Node-RED compatible timestamp format
        const now = new Date();
        const day = now.getDate().toString().padStart(2, '0');
        const month = now.toLocaleDateString('en', { month: 'short' });
        const time = now.toTimeString().slice(0, 8);
        console.log(`${day} ${month} ${time} - [info] [Auth WebSocket Manager] ${msg}`);
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
            this.log(`Reusing authenticated connection to ${serverId}`);
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
     * Create connection with authentication
     */
    async connect(serverId, config) {
        if (this.connecting) return this.client;
        
        this.connecting = true;
        this.serverId = serverId;
        this.config = config;
        
        try {
            this.log(`Connecting to ${serverId} (auth: ${config.user ? 'enabled' : 'disabled'})`);
            this.updateStatus('connecting');

            const client = new SocketClient();
            this.client = client;

            // Setup handlers
            client.on('connect', () => {
                this.log('Connected and authenticated');
                this.connected = true;
                this.reconnectAttempts = 0;
                this.updateStatus('connected');
                this.resubscribe();
                this.resubscribeObjects();
            });

            client.on('disconnect', () => {
                this.log('Disconnected');
                this.connected = false;
                this.updateStatus('disconnected');
                this.notifyEvent('disconnect');
                this.handleReconnect();
            });

            client.on('reconnect', () => {
                this.log('Reconnected and re-authenticated');
                this.connected = true;
                this.reconnectAttempts = 0;
                this.updateStatus('connected');
                this.notifyEvent('reconnect');
                this.resubscribe();
                this.resubscribeObjects();
            });

            client.on('stateChange', (id, state) => {
                this.handleStateChange(id, state);
            });

            client.on('objectChange', (id, obj) => {
                this.handleObjectChange(id, obj);
            });

            client.on('error', (err) => {
                this.log(`Connection error: ${err}`);
                this.connected = false;
                this.updateStatus('disconnected');
                this.handleReconnect();
            });

            // Connection options with authentication
            const connectOptions = {
                name: 'NodeRED-ioBroker-Enhanced',
                connectMaxAttempt: 3,
                connectTimeout: 15000,
                authTimeout: 8000,
                host: config.iobhost,
                port: config.iobport
            };

            // OAuth2 authentication process
            if (config.user && config.password) {
                connectOptions.username = config.user;
                connectOptions.password = config.password;
                this.log(`Using OAuth2 authentication for user: ${config.user}`);
            } else {
                this.log(`Connecting without authentication (no-auth mode)`);
            }

            // Establish connection
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Connection timeout - authentication may have failed'));
                }, connectOptions.connectTimeout);
                
                client.on('connect', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                
                client.on('error', (err) => {
                    clearTimeout(timeout);
                    reject(new Error(`Connection failed: ${err}`));
                });

                client.connect(`ws://${config.iobhost}:${config.iobport}`, connectOptions);
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
     * Force server switch
     */
    async forceServerSwitch(oldServerId, newServerId, newConfig) {
        this.log(`Forcing server switch from ${oldServerId} to ${newServerId}`);
        this.close();
        await new Promise(r => setTimeout(r, 1000)); // Short pause
        return this.connect(newServerId, newConfig);
    }

    /**
     * Reset connection
     */
    async resetConnection(serverId, config) {
        this.log(`Resetting connection to ${serverId}`);
        this.close();
        await new Promise(r => setTimeout(r, 500));
        return this.connect(serverId, config);
    }

    // ========== STATE MANAGEMENT ==========

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
        this.log(`Node ${nodeId} subscribed to state ${stateId}`);
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
            const timeout = setTimeout(() => reject(new Error('Subscribe timeout')), 8000);
            client.emit('subscribe', stateId, (err) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else {
                    this.log(`Subscribed to state ${stateId}`);
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
                    this.log(`Set state ${stateId} = ${value} (ack: ${ack})`);
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
            const timeout = setTimeout(() => reject(new Error('Get states timeout')), 15000);
            client.emit('getStates', '*', (err, states) => {
                clearTimeout(timeout);
                err ? reject(err) : resolve(states);
            });
        });
    }

    // ========== OBJECT MANAGEMENT ==========

    /**
     * Subscribe to object changes
     */
    async subscribeToObjects(nodeId, serverId, pattern, callback, config) {
        const client = await this.getConnection(serverId, config);
        
        this.objectCallbacks.set(nodeId, callback);
        
        if (!this.objectSubscriptions.has(pattern)) {
            this.objectSubscriptions.set(pattern, new Set());
            await this.subscribeObjects(client, pattern);
        }
        
        this.objectSubscriptions.get(pattern).add(nodeId);
        this.log(`Node ${nodeId} subscribed to objects pattern ${pattern}`);
    }

    /**
     * Subscribe to ioBroker objects
     */
    async subscribeObjects(client, pattern) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Subscribe objects timeout')), 8000);
            client.emit('subscribeObjects', pattern, (err) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else {
                    this.log(`Subscribed to objects pattern ${pattern}`);
                    resolve();
                }
            });
        });
    }

    /**
     * Get object
     */
    async getObject(serverId, objectId) {
        const client = await this.getConnection(serverId, this.config);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Get object timeout')), 10000);
            client.emit('getObject', objectId, (err, obj) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else {
                    if (obj) this.objectCache.set(objectId, obj);
                    resolve(obj);
                }
            });
        });
    }

    /**
     * Set object
     */
    async setObject(serverId, objectId, obj) {
        const client = await this.getConnection(serverId, this.config);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Set object timeout')), 8000);
            client.emit('setObject', objectId, obj, (err) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else {
                    this.log(`Set object ${objectId}`);
                    this.objectCache.set(objectId, obj);
                    resolve();
                }
            });
        });
    }

    /**
     * Get objects
     */
    async getObjects(serverId, pattern = '*') {
        const client = await this.getConnection(serverId, this.config);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Get objects timeout')), 20000);
            client.emit('getObjects', pattern, (err, objects) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else {
                    // Update cache with received objects
                    if (objects && typeof objects === 'object') {
                        Object.entries(objects).forEach(([id, obj]) => {
                            if (obj) this.objectCache.set(id, obj);
                        });
                    }
                    resolve(objects);
                }
            });
        });
    }

    /**
     * Delete object
     */
    async delObject(serverId, objectId) {
        const client = await this.getConnection(serverId, this.config);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Delete object timeout')), 8000);
            client.emit('delObject', objectId, (err) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else {
                    this.log(`Deleted object ${objectId}`);
                    this.objectCache.delete(objectId);
                    resolve();
                }
            });
        });
    }

    // ========== EVENT HANDLERS ==========

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
                    this.log(`State callback error: ${err.message}`);
                }
            }
        });
    }

    /**
     * Handle object change
     */
    handleObjectChange(objectId, obj) {
        // Update cache
        if (obj) {
            this.objectCache.set(objectId, obj);
        } else {
            this.objectCache.delete(objectId);
        }

        // Find matching patterns and notify subscribers
        this.objectSubscriptions.forEach((nodeIds, pattern) => {
            if (this.matchesPattern(objectId, pattern)) {
                this.log(`Object change: ${objectId} -> ${nodeIds.size} nodes (pattern: ${pattern})`);
                nodeIds.forEach(nodeId => {
                    const callback = this.objectCallbacks.get(nodeId);
                    if (callback) {
                        try {
                            callback(objectId, obj);
                        } catch (err) {
                            this.log(`Object callback error: ${err.message}`);
                        }
                    }
                });
            }
        });
    }

    /**
     * Check if object ID matches pattern
     */
    matchesPattern(objectId, pattern) {
        if (pattern === '*') return true;
        
        // Convert glob pattern to regex
        const regexPattern = pattern
            .replace(/\./g, '\\.')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        
        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(objectId);
    }

    /**
     * Update all node statuses
     */
    updateStatus(status) {
        this.log(`Status: ${status}`);
        
        // Update state subscription nodes
        this.callbacks.forEach(callback => {
            if (callback.updateStatus) {
                try {
                    callback.updateStatus(status);
                } catch (err) {
                    this.log(`Status update error: ${err.message}`);
                }
            }
        });

        // Update object subscription nodes
        this.objectCallbacks.forEach(callback => {
            if (callback.updateStatus) {
                try {
                    callback.updateStatus(status);
                } catch (err) {
                    this.log(`Object status update error: ${err.message}`);
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
        
        // Notify state subscription nodes
        this.callbacks.forEach(callback => {
            if (callback[`on${event.charAt(0).toUpperCase()}${event.slice(1)}`]) {
                try {
                    callback[`on${event.charAt(0).toUpperCase()}${event.slice(1)}`]();
                } catch (err) {
                    this.log(`Event notify error: ${err.message}`);
                }
            }
        });

        // Notify object subscription nodes
        this.objectCallbacks.forEach(callback => {
            if (callback[`on${event.charAt(0).toUpperCase()}${event.slice(1)}`]) {
                try {
                    callback[`on${event.charAt(0).toUpperCase()}${event.slice(1)}`]();
                } catch (err) {
                    this.log(`Object event notify error: ${err.message}`);
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
        if (this.reconnectAttempts > 10) {
            this.log('Max reconnect attempts reached');
            return;
        }

        this.updateStatus('reconnecting');
        const delay = Math.min(5000 * this.reconnectAttempts, 30000);
        
        setTimeout(() => {
            if (!this.connecting && !this.connected && this.config) {
                this.log(`Reconnect attempt ${this.reconnectAttempts}`);
                this.connect(this.serverId, this.config).catch((err) => {
                    this.log(`Reconnect failed: ${err.message}`);
                });
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
                this.log(`Resubscribe failed for state ${stateId}: ${err.message}`);
            }
        }
    }

    /**
     * Resubscribe to all objects
     */
    async resubscribeObjects() {
        if (!this.client || !this.connected) return;
        
        const patterns = Array.from(this.objectSubscriptions.keys());
        if (patterns.length === 0) return;
        
        this.log(`Resubscribing to ${patterns.length} object patterns`);
        for (const pattern of patterns) {
            try {
                await this.subscribeObjects(this.client, pattern);
                await new Promise(r => setTimeout(r, 100));
            } catch (err) {
                this.log(`Resubscribe failed for objects pattern ${pattern}: ${err.message}`);
            }
        }
    }

    // ========== CLEANUP METHODS ==========

    /**
     * Unsubscribe from state
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
        this.log(`Node ${nodeId} unsubscribed from state ${stateId}`);
    }

    /**
     * Unsubscribe from objects
     */
    async unsubscribeFromObjects(nodeId, serverId, pattern) {
        const nodeIds = this.objectSubscriptions.get(pattern);
        if (!nodeIds) return;

        nodeIds.delete(nodeId);
        if (nodeIds.size === 0) {
            this.objectSubscriptions.delete(pattern);
            if (this.client && this.connected) {
                this.client.emit('unsubscribeObjects', pattern, () => {});
            }
        }
        
        this.objectCallbacks.delete(nodeId);
        this.log(`Node ${nodeId} unsubscribed from objects pattern ${pattern}`);
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
            authenticated: this.client?.authenticated || false,
            subscriptions: this.subscriptions.size,
            objectSubscriptions: this.objectSubscriptions.size,
            eventNodes: this.eventNodes.size,
            objectCacheSize: this.objectCache.size,
            reconnectAttempts: this.reconnectAttempts,
            hasAuth: this.config?.user ? true : false
        };
    }

    /**
     * Close connection
     */
    close() {
        if (this.client) {
            try {
                this.client.destroy();
            } catch (err) {
                this.log(`Error closing connection: ${err.message}`);
            }
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
        this.log('Cleanup started');
        this.close();
        this.subscriptions.clear();
        this.callbacks.clear();
        this.eventNodes.clear();
        this.objectSubscriptions.clear();
        this.objectCallbacks.clear();
        this.objectCache.clear();
        this.log('Cleanup completed');
    }
}

// Singleton instance
const connectionManager = new AuthenticatedWebSocketManager();

// Cleanup on exit
process.on('SIGTERM', () => connectionManager.cleanup());
process.on('SIGINT', () => connectionManager.cleanup());

module.exports = connectionManager;