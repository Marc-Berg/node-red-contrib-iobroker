// websocket-manager.js - Shared WebSocket connection manager for Node-RED nodes
const { SocketClient } = require('./iobroker-ws-client-nodejs');

class WebSocketConnectionManager {
    constructor() {
        this.connections = new Map(); // serverId -> connection info
        this.subscriptions = new Map(); // serverId -> Map(stateId -> Set(nodeIds))
        this.nodeCallbacks = new Map(); // nodeId -> callback function
    }

    /**
     * Check if server configuration has changed
     * @param {string} serverId - Server identifier
     * @param {object} newConfig - New server configuration
     * @returns {boolean} True if configuration changed
     */
    hasConfigChanged(serverId, newConfig) {
        const connection = this.connections.get(serverId);
        if (!connection) return true;
        
        const oldConfig = connection.config;
        return (
            oldConfig.iobhost !== newConfig.iobhost ||
            oldConfig.iobport !== newConfig.iobport
        );
    }

    /**
     * Force close connection and clear cached data
     * @param {string} serverId - Server identifier
     */
    async forceCloseConnection(serverId) {
        console.log(`[WebSocket Manager] Force closing connection for ${serverId}`);
        
        const connection = this.connections.get(serverId);
        if (connection && connection.client) {
            try {
                // Stop any automatic reconnection attempts
                connection.client.destroy();
            } catch (error) {
                console.error(`[WebSocket Manager] Error force closing connection:`, error);
            }
        }
        
        // Clear all cached data for this server
        this.connections.delete(serverId);
        
        // Don't clear subscriptions - we'll need them for the new connection
        console.log(`[WebSocket Manager] Force closed and cleared cache for ${serverId}`);
    }

    /**
     * Get or create a WebSocket connection for a server
     * @param {string} serverId - Unique server identifier
     * @param {object} serverConfig - Server configuration
     * @param {boolean} forceNew - Force creation of new connection
     * @returns {Promise<SocketClient>} WebSocket client instance
     */
    async getConnection(serverId, serverConfig, forceNew = false) {
        // Check if config has changed or force new connection requested
        if (forceNew || this.hasConfigChanged(serverId, serverConfig)) {
            console.log(`[WebSocket Manager] Configuration changed or force new requested for ${serverId}`);
            await this.forceCloseConnection(serverId);
        }
        
        if (this.connections.has(serverId)) {
            const connection = this.connections.get(serverId);
            if (connection.client && connection.client.connected) {
                return connection.client;
            }
        }

        // Create new connection
        const { iobhost, iobport } = serverConfig;
        const wsUrl = `ws://${iobhost}:${iobport}`;
        
        console.log(`[WebSocket Manager] Creating new connection to ${wsUrl}`);
        
        const options = {
            name: 'NodeRED-ioBroker-Client',
            pingInterval: 5000,
            pongTimeout: 30000,
            connectTimeout: 10000,
            authTimeout: 10000,
            connectInterval: 2000,
            connectMaxAttempt: 10
        };

        const client = new SocketClient();
        
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, options.connectTimeout);

            client.on('connect', () => {
                clearTimeout(timeoutId);
                console.log(`[WebSocket Manager] Connected to ${wsUrl}`);
                
                // Store connection info with current config
                this.connections.set(serverId, {
                    client,
                    config: { ...serverConfig }, // Create a copy of the config
                    connectedAt: Date.now()
                });

                // Set up message handling
                this.setupMessageHandling(serverId, client);
                
                // Resubscribe to existing subscriptions
                this.resubscribeAll(serverId);
                
                resolve(client);
            });

            client.on('error', (error) => {
                clearTimeout(timeoutId);
                console.error(`[WebSocket Manager] Connection error for ${wsUrl}:`, error);
                reject(error);
            });

            client.on('disconnect', () => {
                console.log(`[WebSocket Manager] Disconnected from ${wsUrl}`);
                this.handleDisconnection(serverId);
            });

            client.on('reconnect', () => {
                console.log(`[WebSocket Manager] Reconnected to ${wsUrl}`);
                
                // Sofortiges Status-Update für alle verbundenen Nodes
                this.updateNodeStatuses(serverId, 'connected');
                
                // Event-Handler neu einrichten
                this.setupMessageHandling(serverId, client);
                
                // Subscriptions erneuern
                this.resubscribeAll(serverId);
            });


            // Start connection
            client.connect(wsUrl, options);
        });
    }

    updateNodeStatuses(serverId, status) {
        const serverSubscriptions = this.subscriptions.get(serverId);
        if (serverSubscriptions) {
            serverSubscriptions.forEach((nodeIds, stateId) => {
                nodeIds.forEach(nodeId => {
                    const callback = this.nodeCallbacks.get(nodeId);
                    if (callback && callback.updateStatus) {
                        callback.updateStatus(status);
                    }
                });
            });
        }
    }

    /**
     * Set up message handling for ioBroker WebSocket events
     */
    setupMessageHandling(serverId, client) {

        // Handle state changes from ioBroker
        client.on('stateChange', (stateId, state) => {
            console.log(`[WebSocket Manager] State change received: ${stateId}`, state);
            this.handleStateChange(serverId, stateId, state);
        });

        // Handle object changes (optional)
        client.on('objectChange', (objId, obj) => {
            console.log(`[WebSocket Manager] Object change received: ${objId}`);
            // Could be extended for object subscriptions
        });

        // Handle log messages (optional)
        client.on('log', (message) => {
            console.log(`[WebSocket Manager] ioBroker log:`, message);
        });
    }

    /**
     * Handle incoming state changes
     */
    handleStateChange(serverId, stateId, state) {
        const serverSubscriptions = this.subscriptions.get(serverId);
        if (!serverSubscriptions || !serverSubscriptions.has(stateId)) {
            console.log(`[WebSocket Manager] No subscriptions found for state: ${stateId}`);
            return;
        }

        const nodeIds = serverSubscriptions.get(stateId);
        console.log(`[WebSocket Manager] Dispatching state change for ${stateId} to ${nodeIds.size} nodes`);
        
        nodeIds.forEach(nodeId => {
            const callback = this.nodeCallbacks.get(nodeId);
            if (callback) {
                try {
                    callback(stateId, state);
                } catch (error) {
                    console.error(`[WebSocket Manager] Callback error for node ${nodeId}:`, error);
                }
            }
        });
    }

    /**
     * Subscribe a node to state changes
     */
    async subscribe(nodeId, serverId, stateId, callback, serverConfig) {
        try {
            // Get or create connection (will detect config changes)
            const client = await this.getConnection(serverId, serverConfig);

            // Store callback
            this.nodeCallbacks.set(nodeId, callback);

            // Track subscription
            if (!this.subscriptions.has(serverId)) {
                this.subscriptions.set(serverId, new Map());
            }
            
            const serverSubscriptions = this.subscriptions.get(serverId);
            if (!serverSubscriptions.has(stateId)) {
                serverSubscriptions.set(stateId, new Set());
                
                // Subscribe to state on ioBroker
                await this.subscribeToState(client, stateId);
            }
            
            serverSubscriptions.get(stateId).add(nodeId);
            
            console.log(`[WebSocket Manager] Node ${nodeId} subscribed to ${stateId} on server ${serverId}`);
            
        } catch (error) {
            console.error(`[WebSocket Manager] Subscription failed for node ${nodeId}:`, error);
            throw error;
        }
    }

    /**
     * Subscribe to a specific state on ioBroker
     */
    async subscribeToState(client, stateId) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(`Subscribe timeout for ${stateId}`));
            }, 5000);          
            client.emit('subscribe', stateId, (error, result) => {
                clearTimeout(timeoutId);
                if (error) {
                    console.error(`[WebSocket Manager] Subscribe failed for ${stateId}:`, error);
                    reject(new Error(`Subscribe failed for ${stateId}: ${error}`));
                } else {
                    resolve(result);
                }
            });
        });
    }

    /**
     * Get all states from ioBroker
     */
    async getStates(serverId) {
        const connection = this.connections.get(serverId);
        if (!connection?.client) {
            throw new Error('No active connection');
        }
        
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Get states timeout'));
            }, 10000);

            connection.client.emit('getStates', '*', (error, states) => {
                clearTimeout(timeoutId);
                if (error) {
                    console.error(`[WebSocket Manager] Get states failed:`, error);
                    reject(error);
                } else {
                    resolve(states);
                }
            });
        });
    }

    /**
     * Unsubscribe a node from state changes
     */
    async unsubscribe(nodeId, serverId, stateId) {
        try {
            const serverSubscriptions = this.subscriptions.get(serverId);
            if (!serverSubscriptions || !serverSubscriptions.has(stateId)) {
                return;
            }

            const nodeIds = serverSubscriptions.get(stateId);
            nodeIds.delete(nodeId);

            // If no more nodes are subscribed to this state, unsubscribe from ioBroker
            if (nodeIds.size === 0) {
                serverSubscriptions.delete(stateId);
                
                const connection = this.connections.get(serverId);
                if (connection && connection.client && connection.client.connected) {
                    await this.unsubscribeFromState(connection.client, stateId);
                }
            }

            // Remove callback
            this.nodeCallbacks.delete(nodeId);
                        
        } catch (error) {
            console.error(`[WebSocket Manager] Unsubscribe failed for node ${nodeId}:`, error);
        }
    }

    /**
     * Unsubscribe from a specific state on ioBroker
     */
    async unsubscribeFromState(client, stateId) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                console.warn(`[WebSocket Manager] Unsubscribe timeout for ${stateId}`);
                resolve(); // Don't fail on timeout during cleanup
            }, 3000);
            
            client.emit('unsubscribe', stateId, (error, result) => {
                clearTimeout(timeoutId);
                if (error) {
                    console.warn(`[WebSocket Manager] Unsubscribe warning for ${stateId}: ${error}`);
                }
                resolve(result);
            });
        });
    }

    /**
     * Handle connection disconnection
     */
    handleDisconnection(serverId) {
        const connection = this.connections.get(serverId);
        if (connection) {
            connection.client = null;
        }
    }

    /**
     * Resubscribe to all states after reconnection
     */
    async resubscribeAll(serverId) {
        const serverSubscriptions = this.subscriptions.get(serverId);
        const connection = this.connections.get(serverId);
        
        if (!serverSubscriptions || !connection || !connection.client) {
            return;
        }
        
        for (const stateId of serverSubscriptions.keys()) {
            try {
                await this.subscribeToState(connection.client, stateId);
            } catch (error) {
                console.error(`[WebSocket Manager] Resubscribe failed for ${stateId}:`, error);
            }
        }
    }

    /**
     * Close connection for a server
     */
    async closeConnection(serverId) {
        const connection = this.connections.get(serverId);
        if (connection && connection.client) {
            try {
                connection.client.destroy();
            } catch (error) {
                console.error(`[WebSocket Manager] Error closing connection for ${serverId}:`, error);
            }
        }
        
        this.connections.delete(serverId);
        this.subscriptions.delete(serverId);
    }

    /**
     * Reset connection for a server (useful when config changes)
     * @param {string} serverId - Server identifier
     * @param {object} newConfig - New server configuration
     */
    async resetConnection(serverId, newConfig) {
        console.log(`[WebSocket Manager] Resetting connection for ${serverId}`);
        
        // Force close old connection
        await this.forceCloseConnection(serverId);
        
        // Create new connection with new config
        try {
            await this.getConnection(serverId, newConfig, true);
            console.log(`[WebSocket Manager] Connection reset successfully for ${serverId}`);
        } catch (error) {
            console.error(`[WebSocket Manager] Failed to reset connection for ${serverId}:`, error);
            throw error;
        }
    }

    /**
     * Get connection status
     */
    getConnectionStatus(serverId) {
        const connection = this.connections.get(serverId);
        if (!connection || !connection.client) {
            return { connected: false, status: 'disconnected' };
        }
        
        return {
            connected: connection.client.connected,
            status: connection.client.connected ? 'connected' : 'connecting',
            connectedAt: connection.connectedAt,
            subscriptions: this.subscriptions.get(serverId)?.size || 0,
            config: connection.config
        };
    }

    /**
     * Cleanup all connections (for shutdown)
     */
    async cleanup() {
        console.log('[WebSocket Manager] Cleaning up all connections...');
        
        const closePromises = Array.from(this.connections.keys()).map(serverId => 
            this.closeConnection(serverId)
        );
        
        await Promise.allSettled(closePromises);
        
        this.connections.clear();
        this.subscriptions.clear();
        this.nodeCallbacks.clear();
    }
}

// Singleton instance
const connectionManager = new WebSocketConnectionManager();

// Graceful shutdown handling
process.on('SIGTERM', () => connectionManager.cleanup());
process.on('SIGINT', () => connectionManager.cleanup());

module.exports = connectionManager;