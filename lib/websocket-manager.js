// websocket-manager.js - Ultra-einfache Version mit garantiertem Singleton
const { SocketClient } = require('./iobroker-ws-client-nodejs');

class UltraSimpleWebSocketManager {
    constructor() {
        this.singletonClient = null; // NUR EIN CLIENT für alle Nodes
        this.clientConnected = false;
        this.isCreatingClient = false;
        this.serverId = null;
        this.serverConfig = null;
        
        this.subscriptions = new Map(); // stateId -> Set(nodeIds)
        this.nodeCallbacks = new Map(); // nodeId -> callback function
        this.eventOnlyNodes = new Map(); // nodeId -> callback function
        
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
    }

    /**
     * Registriere eine Node nur für Connection-Events
     */
    async registerForEvents(nodeId, serverId, callback, serverConfig) {
        try {
            await this.ensureSingleConnection(serverId, serverConfig);
            this.eventOnlyNodes.set(nodeId, callback);
            console.log(`[Ultra Simple Manager] Node ${nodeId} registered for events only`);
        } catch (error) {
            console.error(`[Ultra Simple Manager] Event registration failed for node ${nodeId}:`, error);
            throw error;
        }
    }

    /**
     * Entferne Event-only Registrierung
     */
    unregisterFromEvents(nodeId) {
        this.eventOnlyNodes.delete(nodeId);
        console.log(`[Ultra Simple Manager] Node ${nodeId} unregistered from events`);
    }

    /**
     * Stelle sicher, dass nur EIN WebSocket-Client existiert
     */
    async ensureSingleConnection(serverId, serverConfig) {
        // Wenn bereits ein Client für einen anderen Server existiert, schließe ihn
        if (this.singletonClient && this.serverId !== serverId) {
            console.log(`[Ultra Simple Manager] Switching from ${this.serverId} to ${serverId}`);
            await this.forceCloseConnection();
        }

        // Wenn bereits verbunden und gleicher Server, verwende bestehende Verbindung
        if (this.singletonClient && this.clientConnected && this.serverId === serverId) {
            console.log(`[Ultra Simple Manager] Reusing existing connection to ${serverId}`);
            return this.singletonClient;
        }

        // Wenn gerade eine Verbindung erstellt wird, warte
        if (this.isCreatingClient) {
            console.log(`[Ultra Simple Manager] Waiting for connection creation to complete...`);
            while (this.isCreatingClient) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return this.singletonClient;
        }

        // Erstelle neue Verbindung
        return await this.createSingleConnection(serverId, serverConfig);
    }

    /**
     * Erstelle exakt eine WebSocket-Verbindung
     */
    async createSingleConnection(serverId, serverConfig) {
        if (this.isCreatingClient) {
            console.log(`[Ultra Simple Manager] Connection creation already in progress, waiting...`);
            // Warte bis die aktuelle Erstellung abgeschlossen ist
            while (this.isCreatingClient) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            // Prüfe ob inzwischen eine Verbindung erstellt wurde
            if (this.singletonClient && this.clientConnected) {
                console.log(`[Ultra Simple Manager] Connection was created while waiting`);
                return this.singletonClient;
            }
            // Falls nicht, versuche es erneut (sollte nicht passieren)
            throw new Error('Connection creation failed while waiting');
        }

        this.isCreatingClient = true;
        this.serverId = serverId;
        this.serverConfig = { ...serverConfig };

        try {
            console.log(`[Ultra Simple Manager] Creating single connection to ${serverId}`);
            
            // Alle Status auf "connecting" setzen
            this.updateAllNodeStatuses('connecting');

            const { iobhost, iobport } = serverConfig;
            const wsUrl = `ws://${iobhost}:${iobport}`;

            const client = new SocketClient();
            this.singletonClient = client;

            // Setup event handlers
            this.setupClientHandlers(client);

            // Start connection
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Connection timeout'));
                }, 15000);

                client.on('connect', () => {
                    clearTimeout(timeout);
                    console.log(`[Ultra Simple Manager] Connected to ${wsUrl}`);
                    this.clientConnected = true;
                    this.reconnectAttempts = 0;
                    this.updateAllNodeStatuses('connected');
                    this.resubscribeAll();
                    resolve(client);
                });

                client.on('error', (error) => {
                    clearTimeout(timeout);
                    console.error(`[Ultra Simple Manager] Connection error:`, error);
                    this.clientConnected = false;
                    this.updateAllNodeStatuses('disconnected');
                    reject(error);
                });

                client.connect(wsUrl, {
                    name: 'NodeRED-ioBroker-SingleClient',
                    pingInterval: 5000,
                    pongTimeout: 30000,
                    connectTimeout: 15000,
                    authTimeout: 10000,
                    connectInterval: 2000,
                    connectMaxAttempt: 3 // Allow a few attempts for initial connection
                });
            });

            return client;

        } catch (error) {
            this.singletonClient = null;
            this.clientConnected = false;
            this.updateAllNodeStatuses('disconnected');
            throw error;
        } finally {
            this.isCreatingClient = false;
        }
    }

    /**
     * Setup client event handlers
     */
    setupClientHandlers(client) {
        // Note: SocketClient doesn't have removeAllListeners, so we don't call it
        // The client will handle event management internally

        client.on('connect', () => {
            console.log(`[Ultra Simple Manager] Client connected`);
            this.clientConnected = true;
            this.reconnectAttempts = 0;
            this.updateAllNodeStatuses('connected');
        });

        client.on('disconnect', () => {
            console.log(`[Ultra Simple Manager] Client disconnected`);
            this.clientConnected = false;
            this.updateAllNodeStatuses('disconnected');
            this.notifyAllNodes('disconnect');
            this.handleDisconnection();
        });

        client.on('reconnect', () => {
            console.log(`[Ultra Simple Manager] Client internal reconnect detected - taking manual control`);
            // Wichtig: Den internen Reconnect übernehmen, aber keine neuen Clients erstellen
            if (!this.clientConnected) {
                console.log(`[Ultra Simple Manager] Manual reconnect triggered by client event`);
                this.clientConnected = true;
                this.reconnectAttempts = 0;
                
                // Wichtig: Erst Status updates, dann Events
                this.updateAllNodeStatuses('connected');
                this.notifyAllNodes('reconnect');
                this.resubscribeAll();
            }
        });

        client.on('stateChange', (stateId, state) => {
            this.handleStateChange(stateId, state);
        });

        client.on('error', (error) => {
            console.error(`[Ultra Simple Manager] Client error:`, error);
            this.clientConnected = false;
            this.updateAllNodeStatuses('disconnected');
        });
    }

    /**
     * Handle incoming state changes
     */
    handleStateChange(stateId, state) {
        if (!this.subscriptions.has(stateId)) {
            return; // Kein Interesse an diesem State
        }

        const nodeIds = this.subscriptions.get(stateId);
        console.log(`[Ultra Simple Manager] State change: ${stateId} -> dispatching to ${nodeIds.size} nodes`);
        console.log(`[Ultra Simple Manager] State value:`, state);
        
        nodeIds.forEach(nodeId => {
            const callback = this.nodeCallbacks.get(nodeId);
            if (callback) {
                try {
                    callback(stateId, state);
                } catch (error) {
                    console.error(`[Ultra Simple Manager] Callback error for node ${nodeId}:`, error);
                }
            }
        });
    }

    /**
     * Subscribe a node to state changes
     */
    async subscribe(nodeId, serverId, stateId, callback, serverConfig) {
        try {
            const client = await this.ensureSingleConnection(serverId, serverConfig);

            // Store callback
            this.nodeCallbacks.set(nodeId, callback);

            // Track subscription
            if (!this.subscriptions.has(stateId)) {
                this.subscriptions.set(stateId, new Set());
                
                // Subscribe to state on ioBroker (nur für echte States)
                if (!stateId.startsWith('_dummy_')) {
                    await this.subscribeToState(client, stateId);
                }
            }
            
            this.subscriptions.get(stateId).add(nodeId);
            
            console.log(`[Ultra Simple Manager] Node ${nodeId} subscribed to ${stateId}`);
            
        } catch (error) {
            console.error(`[Ultra Simple Manager] Subscription failed for node ${nodeId}:`, error);
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
                    console.error(`[Ultra Simple Manager] Subscribe failed for ${stateId}:`, error);
                    reject(new Error(`Subscribe failed for ${stateId}: ${error}`));
                } else {
                    console.log(`[Ultra Simple Manager] Successfully subscribed to ${stateId}`);
                    resolve(result);
                }
            });
        });
    }

    /**
     * Get all states from ioBroker
     */
    async getStates(serverId) {
        const client = await this.ensureSingleConnection(serverId, this.serverConfig);
        
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Get states timeout'));
            }, 10000);

            client.emit('getStates', '*', (error, states) => {
                clearTimeout(timeoutId);
                if (error) {
                    console.error(`[Ultra Simple Manager] Get states failed:`, error);
                    reject(error);
                } else {
                    resolve(states);
                }
            });
        });
    }

    /**
     * Get a single state
     */
    async getState(serverId, stateId) {
        const client = await this.ensureSingleConnection(serverId, this.serverConfig);
        
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(`Get state timeout for ${stateId}`));
            }, 10000);

            client.emit('getState', stateId, (error, state) => {
                clearTimeout(timeoutId);
                if (error) {
                    reject(new Error(`Failed to get state ${stateId}: ${error}`));
                } else {
                    resolve(state);
                }
            });
        });
    }

    /**
     * Set a state value
     */
    async setState(serverId, stateId, value, ack = true) {
        const client = await this.ensureSingleConnection(serverId, this.serverConfig);
        
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(`Set state timeout for ${stateId}`));
            }, 8000);

            const stateObject = {
                val: value,
                ack: ack,
                from: 'system.adapter.node-red',
                ts: Date.now()
            };

            client.emit('setState', stateId, stateObject, (error, result) => {
                clearTimeout(timeoutId);
                if (error) {
                    reject(new Error(`setState failed for ${stateId}: ${error}`));
                } else {
                    console.log(`[Ultra Simple Manager] Successfully set ${stateId} = ${value} (ack: ${ack})`);
                    resolve(result);
                }
            });
        });
    }

    /**
     * Unsubscribe a node from state changes
     */
    async unsubscribe(nodeId, serverId, stateId) {
        try {
            if (!this.subscriptions.has(stateId)) {
                return;
            }

            const nodeIds = this.subscriptions.get(stateId);
            nodeIds.delete(nodeId);

            // If no more nodes are subscribed to this state, unsubscribe from ioBroker
            if (nodeIds.size === 0) {
                this.subscriptions.delete(stateId);
                
                if (this.singletonClient && this.clientConnected && !stateId.startsWith('_dummy_')) {
                    await this.unsubscribeFromState(this.singletonClient, stateId);
                }
            }

            // Remove callback
            this.nodeCallbacks.delete(nodeId);
            
            console.log(`[Ultra Simple Manager] Node ${nodeId} unsubscribed from ${stateId}`);
                        
        } catch (error) {
            console.error(`[Ultra Simple Manager] Unsubscribe failed for node ${nodeId}:`, error);
        }
    }

    /**
     * Unsubscribe from a specific state on ioBroker
     */
    async unsubscribeFromState(client, stateId) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                console.warn(`[Ultra Simple Manager] Unsubscribe timeout for ${stateId}`);
                resolve(); // Don't fail on timeout during cleanup
            }, 3000);
            
            client.emit('unsubscribe', stateId, (error, result) => {
                clearTimeout(timeoutId);
                if (error) {
                    console.warn(`[Ultra Simple Manager] Unsubscribe warning for ${stateId}: ${error}`);
                } else {
                    console.log(`[Ultra Simple Manager] Successfully unsubscribed from ${stateId}`);
                }
                resolve(result);
            });
        });
    }

    /**
     * Update status for all nodes
     */
    updateAllNodeStatuses(status) {
        // Update subscription-based nodes
        this.subscriptions.forEach((nodeIds, stateId) => {
            nodeIds.forEach(nodeId => {
                const callback = this.nodeCallbacks.get(nodeId);
                if (callback && callback.updateStatus) {
                    try {
                        callback.updateStatus(status);
                    } catch (error) {
                        console.error(`[Ultra Simple Manager] Error updating status for node ${nodeId}:`, error);
                    }
                }
            });
        });

        // Update event-only nodes
        this.eventOnlyNodes.forEach((callback, nodeId) => {
            if (callback && callback.updateStatus) {
                try {
                    callback.updateStatus(status);
                } catch (error) {
                    console.error(`[Ultra Simple Manager] Error updating status for event-only node ${nodeId}:`, error);
                }
            }
        });
    }

    /**
     * Notify all nodes about connection events
     */
    notifyAllNodes(event) {
        // Notify subscription-based nodes
        this.subscriptions.forEach((nodeIds, stateId) => {
            nodeIds.forEach(nodeId => {
                const callback = this.nodeCallbacks.get(nodeId);
                if (callback) {
                    try {
                        if (event === 'reconnect' && callback.onReconnect) {
                            callback.onReconnect();
                        } else if (event === 'disconnect' && callback.onDisconnect) {
                            callback.onDisconnect();
                        }
                    } catch (error) {
                        console.error(`[Ultra Simple Manager] Error notifying node ${nodeId} about ${event}:`, error);
                    }
                }
            });
        });

        // Notify event-only nodes
        this.eventOnlyNodes.forEach((callback, nodeId) => {
            if (callback) {
                try {
                    if (event === 'reconnect' && callback.onReconnect) {
                        callback.onReconnect();
                    } else if (event === 'disconnect' && callback.onDisconnect) {
                        callback.onDisconnect();
                    }
                } catch (error) {
                    console.error(`[Ultra Simple Manager] Error notifying event-only node ${nodeId} about ${event}:`, error);
                }
            }
        });
    }

    /**
     * Handle disconnection
     */
    handleDisconnection() {
        this.reconnectAttempts++;
        
        if (this.reconnectAttempts <= this.maxReconnectAttempts) {
            this.updateAllNodeStatuses('reconnecting');
            
            // Manual reconnection with delay
            const delay = Math.min(5000 * this.reconnectAttempts, 30000);
            setTimeout(() => {
                if (!this.isCreatingClient && !this.clientConnected) {
                    this.attemptReconnection();
                }
            }, delay);
        } else {
            console.log(`[Ultra Simple Manager] Max reconnection attempts reached`);
        }
    }

    /**
     * Attempt manual reconnection
     */
    async attemptReconnection() {
        if (!this.serverConfig || !this.serverId) {
            return;
        }

        console.log(`[Ultra Simple Manager] Attempting manual reconnection (attempt ${this.reconnectAttempts})`);
        
        try {
            // Force close current connection
            await this.forceCloseConnection();
            
            // Create new connection
            await this.createSingleConnection(this.serverId, this.serverConfig);
            
            console.log(`[Ultra Simple Manager] Manual reconnection successful`);
            
            // Explicit status updates and notifications after manual reconnection
            this.updateAllNodeStatuses('connected');
            this.notifyAllNodes('reconnect');
            
        } catch (error) {
            console.error(`[Ultra Simple Manager] Manual reconnection failed:`, error);
            this.updateAllNodeStatuses('disconnected');
        }
    }

    /**
     * Resubscribe to all states after reconnection
     */
    async resubscribeAll() {
        if (!this.singletonClient || !this.clientConnected) {
            return;
        }
        
        const realStates = Array.from(this.subscriptions.keys()).filter(id => !id.startsWith('_dummy_'));
        
        if (realStates.length === 0) {
            console.log(`[Ultra Simple Manager] No real states to resubscribe`);
            return;
        }
        
        console.log(`[Ultra Simple Manager] Resubscribing to ${realStates.length} states`);
        
        for (const stateId of realStates) {
            try {
                await this.subscribeToState(this.singletonClient, stateId);
                // Small delay to prevent overload
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                console.error(`[Ultra Simple Manager] Resubscribe failed for ${stateId}:`, error);
            }
        }
        
        console.log(`[Ultra Simple Manager] Resubscription completed`);
    }

    /**
     * Force close the singleton connection
     */
    async forceCloseConnection() {
        console.log(`[Ultra Simple Manager] Force closing singleton connection`);
        
        if (this.singletonClient) {
            try {
                this.singletonClient.destroy();
            } catch (error) {
                console.error(`[Ultra Simple Manager] Error force closing connection:`, error);
            }
        }
        
        this.singletonClient = null;
        this.clientConnected = false;
        this.serverId = null;
        this.serverConfig = null;
        
        console.log(`[Ultra Simple Manager] Singleton connection closed`);
    }

    /**
     * Reset connection
     */
    async resetConnection(serverId, newConfig) {
        console.log(`[Ultra Simple Manager] Resetting connection for ${serverId}`);
        
        this.updateAllNodeStatuses('connecting');
        await this.forceCloseConnection();
        
        try {
            await this.ensureSingleConnection(serverId, newConfig);
            console.log(`[Ultra Simple Manager] Connection reset successfully`);
        } catch (error) {
            console.error(`[Ultra Simple Manager] Failed to reset connection:`, error);
            this.updateAllNodeStatuses('disconnected');
            throw error;
        }
    }

    /**
     * Get connection status
     */
    getConnectionStatus(serverId) {
        return {
            connected: this.clientConnected && !!this.singletonClient,
            status: this.clientConnected ? 'connected' : 'disconnected',
            serverId: this.serverId,
            subscriptions: this.subscriptions.size,
            eventOnlyNodes: this.eventOnlyNodes.size,
            reconnectAttempts: this.reconnectAttempts,
            isCreatingClient: this.isCreatingClient,
            hasSingletonClient: !!this.singletonClient
        };
    }

    /**
     * Cleanup all connections
     */
    async cleanup() {
        console.log('[Ultra Simple Manager] Cleaning up...');
        
        await this.forceCloseConnection();
        
        this.subscriptions.clear();
        this.nodeCallbacks.clear();
        this.eventOnlyNodes.clear();
        this.reconnectAttempts = 0;
        
        console.log('[Ultra Simple Manager] Cleanup completed');
    }
}

// Singleton instance
const connectionManager = new UltraSimpleWebSocketManager();

// Graceful shutdown handling
process.on('SIGTERM', () => connectionManager.cleanup());
process.on('SIGINT', () => connectionManager.cleanup());

module.exports = connectionManager;