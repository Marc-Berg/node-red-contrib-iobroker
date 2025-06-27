/*!
 * Node Registry for WebSocket Manager
 * Updated to work with the new manager architecture
 */

class NodeRegistry {
    constructor(manager) {
        this.manager = manager;
        this.subscriptions = new Map();       // pattern -> Set<nodeId>
        this.callbacks = new Map();           // nodeId -> callback function
        this.eventNodes = new Map();          // nodeId -> event callback
        this.nodeRegistrations = new Map();   // nodeId -> { serverId, type, registeredAt }
        
        this.log = this.createLogger('NodeRegistry');
    }

    createLogger(component) {
        return {
            info: (msg) => {
                const now = new Date();
                const day = now.getDate().toString().padStart(2, '0');
                const month = now.toLocaleDateString('en', { month: 'short' });
                const time = now.toTimeString().slice(0, 8);
                console.log(`${day} ${month} ${time} - [info] [${component}] ${msg}`);
            },
            error: (msg) => {
                const now = new Date();
                const day = now.getDate().toString().padStart(2, '0');
                const month = now.toLocaleDateString('en', { month: 'short' });
                const time = now.toTimeString().slice(0, 8);
                console.error(`${day} ${month} ${time} - [error] [${component}] ${msg}`);
            }
        };
    }

    // Node registration management
    registerNode(nodeId, serverId, type) {
        this.nodeRegistrations.set(nodeId, {
            serverId: serverId,
            type: type,
            registeredAt: Date.now()
        });
        this.log.info(`Registered node ${nodeId} for ${serverId} (type: ${type})`);
    }

    unregisterNode(nodeId) {
        const registration = this.nodeRegistrations.get(nodeId);
        if (registration) {
            this.nodeRegistrations.delete(nodeId);
            this.log.info(`Unregistered node ${nodeId} from ${registration.serverId}`);
            return registration.serverId;
        }
        return null;
    }

    getRemainingNodesForServer(serverId) {
        return Array.from(this.nodeRegistrations.values())
            .filter(reg => reg.serverId === serverId).length;
    }

    // Node status updates
    updateNodeStatus(serverId, status) {
        // Update subscription node callbacks
        this.callbacks.forEach((callback, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                if (callback.updateStatus) {
                    try {
                        callback.updateStatus(status);
                    } catch (err) {
                        this.log.error(`Status update error for node ${nodeId}: ${err.message}`);
                    }
                }
            }
        });

        // Update event node callbacks
        this.eventNodes.forEach((callback, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                if (callback.updateStatus) {
                    try {
                        callback.updateStatus(status);
                        
                        // For late connections, trigger reconnect callbacks
                        if (status === 'ready') {
                            if (callback.onReconnect) {
                                callback.onReconnect();
                            }
                        }
                    } catch (err) {
                        this.log.error(`Status update error for node ${nodeId}: ${err.message}`);
                    }
                }
            }
        });
    }

    // State change handling
    handleStateChange(stateId, state) {
        const matchingNodeIds = new Set();
        
        // Find all nodes that have subscriptions matching this state
        this.subscriptions.forEach((nodeIds, pattern) => {
            if (this.matchesPattern(stateId, pattern)) {
                nodeIds.forEach(nodeId => matchingNodeIds.add(nodeId));
            }
        });

        if (matchingNodeIds.size === 0) return;

        // Call the callbacks for matching nodes
        matchingNodeIds.forEach(nodeId => {
            const callback = this.callbacks.get(nodeId);
            if (callback) {
                try {
                    callback(stateId, state);
                } catch (err) {
                    this.log.error(`State callback error for ${nodeId}: ${err.message}`);
                }
            }
        });
    }

    matchesPattern(stateId, pattern) {
        if (stateId === pattern) return true;
        
        if (pattern.includes('*')) {
            const regexPattern = pattern
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*');
            
            const regex = new RegExp(`^${regexPattern}$`);
            return regex.test(stateId);
        }
        
        return false;
    }

    // Subscription management
    async subscribe(nodeId, serverId, stateIdOrPattern, callback, config, isRecovery = false, manager) {
        try {
            this.registerNode(nodeId, serverId, 'subscribe');
            
            // Get connection - this will respect the centralized state management
            const client = await manager.getConnection(serverId, config);
            this.callbacks.set(nodeId, callback);
            
            // Track subscription
            if (!this.subscriptions.has(stateIdOrPattern)) {
                this.subscriptions.set(stateIdOrPattern, new Set());
            }
            this.subscriptions.get(stateIdOrPattern).add(nodeId);
            
            // Subscribe via WebSocket if client is ready
            if (client.isClientReady()) {
                await manager.operationManager.subscribe(serverId, stateIdOrPattern, (id, state) => this.handleStateChange(id, state));
                
                if (callback.onSubscribed) {
                    callback.onSubscribed();
                }
                
                // Set status to ready after successful subscription
                if (callback.updateStatus) {
                    callback.updateStatus('ready');
                }
                
                // Handle initial value request for single states (not wildcards)
                if (callback.wantsInitialValue && !stateIdOrPattern.includes('*')) {
                    this.log.info(`Requesting initial value for node ${nodeId} state ${stateIdOrPattern}`);
                    
                    // Use longer delay to ensure connection is fully ready
                    setTimeout(async () => {
                        try {
                            // Double-check that client is still ready
                            const currentClient = manager.connectionManager.connections.get(serverId);
                            if (!currentClient || !currentClient.isClientReady()) {
                                this.log.info(`Connection not ready for initial value: ${stateIdOrPattern}`);
                                return;
                            }
                            
                            const state = await manager.operationManager.getState(serverId, stateIdOrPattern);
                            if (state && state.val !== undefined) {
                                this.log.info(`Initial value received for node ${nodeId}: ${stateIdOrPattern} = ${state.val}`);
                                
                                if (callback.onInitialValue) {
                                    callback.onInitialValue(stateIdOrPattern, state);
                                } else {
                                    callback(stateIdOrPattern, state);
                                }
                            } else {
                                this.log.info(`No initial value available for node ${nodeId} state ${stateIdOrPattern}`);
                            }
                        } catch (error) {
                            this.log.error(`Initial value request failed for node ${nodeId} state ${stateIdOrPattern}: ${error.message}`);
                        }
                    }, 200); // Longer delay to ensure everything is ready
                }
            }
            
            this.log.info(`Subscribed node ${nodeId} to ${stateIdOrPattern.includes('*') ? 'wildcard pattern' : 'single state'}: ${stateIdOrPattern}`);
            
        } catch (error) {
            this.log.error(`Subscribe failed for node ${nodeId}: ${error.message}`);
            throw error;
        }
    }

    // Event registration for nodes that don't subscribe to states
    async registerForEvents(nodeId, serverId, callback, config, isRecovery = false, manager) {
        try {
            this.registerNode(nodeId, serverId, 'events');
            this.eventNodes.set(nodeId, callback);
            
            // For event-only nodes, we don't need to wait for connection
            // We just register them and they'll get status updates when connection changes
            const connectionState = manager.getConnectionState(serverId);
            
            if (connectionState === 'connected') {
                // Connection is ready, notify node immediately
                if (callback.updateStatus) {
                    callback.updateStatus('ready');
                }
            } else if (connectionState === 'connecting') {
                // Connection is being established, notify node
                if (callback.updateStatus) {
                    callback.updateStatus('connecting');
                }
            } else {
                // Try to get/create connection, but don't fail if it's not ready
                try {
                    await manager.getConnection(serverId, config);
                } catch (error) {
                    // For event nodes, we don't fail - they'll get updates when connection is ready
                    this.log.info(`Event node ${nodeId} registered - will receive updates when connection is ready`);
                    
                    // Still notify node about current state
                    if (callback.updateStatus) {
                        if (error.message.includes('not possible in state: auth_failed')) {
                            callback.updateStatus('failed_permanently');
                        } else {
                            callback.updateStatus('connecting');
                        }
                    }
                }
            }
            
            this.log.info(`Registered node ${nodeId} for events on ${serverId}`);
            
        } catch (error) {
            this.log.error(`Event registration failed for node ${nodeId}: ${error.message}`);
            throw error;
        }
    }

    // Unsubscription
    async unsubscribe(nodeId, serverId, stateIdOrPattern, manager) {
        try {
            const nodeIds = this.subscriptions.get(stateIdOrPattern);
            if (!nodeIds) return;

            nodeIds.delete(nodeId);
            
            // If this was the last node for this pattern, unsubscribe from WebSocket
            if (nodeIds.size === 0) {
                this.subscriptions.delete(stateIdOrPattern);
                
                try {
                    await manager.operationManager.unsubscribe(serverId, stateIdOrPattern);
                    this.log.info(`Unsubscribed from WebSocket pattern: ${stateIdOrPattern}`);
                } catch (error) {
                    this.log.error(`Unsubscribe error for pattern ${stateIdOrPattern}: ${error.message}`);
                }
            }
            
            this.callbacks.delete(nodeId);
            this.unregisterNode(nodeId);
            
            this.log.info(`Unsubscribed node ${nodeId} from ${stateIdOrPattern}`);
            
        } catch (error) {
            this.log.error(`Unsubscribe error for node ${nodeId}: ${error.message}`);
        }
    }

    unregisterFromEvents(nodeId) {
        try {
            this.eventNodes.delete(nodeId);
            const serverId = this.unregisterNode(nodeId);
            this.log.info(`Unregistered node ${nodeId} from events`);
            return serverId;
        } catch (error) {
            this.log.error(`Unregister events error for node ${nodeId}: ${error.message}`);
            return null;
        }
    }

    // Resubscription after reconnection - no duplicate initial values
    async resubscribeStates(serverId, client) {
        const statesToSubscribe = new Set();
        const nodeCallbacks = new Map();
        
        // Collect all patterns that need resubscription for this server
        this.subscriptions.forEach((nodeIds, pattern) => {
            nodeIds.forEach(nodeId => {
                const registration = this.nodeRegistrations.get(nodeId);
                if (registration && registration.serverId === serverId) {
                    statesToSubscribe.add(pattern);
                    
                    const callback = this.callbacks.get(nodeId);
                    if (callback) {
                        if (!nodeCallbacks.has(pattern)) {
                            nodeCallbacks.set(pattern, new Set());
                        }
                        nodeCallbacks.get(pattern).add({
                            nodeId: nodeId,
                            callback: callback
                        });
                    }
                }
            });
        });

        if (statesToSubscribe.size > 0) {
            this.log.info(`Resubscribing to ${statesToSubscribe.size} patterns for ${serverId}`);
            
            // Resubscribe to each pattern
            for (const pattern of statesToSubscribe) {
                try {
                    await client.subscribe(pattern, (id, state) => this.handleStateChange(id, state));
                    
                    const callbackInfos = nodeCallbacks.get(pattern);
                    if (callbackInfos) {
                        callbackInfos.forEach(info => {
                            // Notify node that subscription is restored
                            if (info.callback.onSubscribed) {
                                info.callback.onSubscribed();
                            }
                            
                            // No initial values on reconnection to avoid duplicates
                        });
                    }
                    
                    this.log.info(`Resubscribed to pattern: ${pattern}`);
                    
                    // Small delay between subscriptions to avoid overwhelming the server
                    await new Promise(r => setTimeout(r, 50));
                } catch (error) {
                    this.log.error(`Resubscribe failed for ${pattern}: ${error.message}`);
                }
            }
        }
    }

    // Cleanup
    cleanup() {
        this.log.info('Cleaning up node registry');
        
        this.subscriptions.clear();
        this.callbacks.clear();
        this.eventNodes.clear();
        this.nodeRegistrations.clear();
        
        this.log.info('Node registry cleanup completed');
    }
}

module.exports = NodeRegistry;