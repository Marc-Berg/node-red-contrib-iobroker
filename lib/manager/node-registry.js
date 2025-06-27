/*!
 * Improved Node Registry for WebSocket Manager
 * Better integrated with centralized connection management
 */

class NodeRegistry {
    constructor(manager) {
        this.manager = manager;
        this.subscriptions = new Map();       // pattern -> Set<nodeId>
        this.callbacks = new Map();           // nodeId -> callback function
        this.eventNodes = new Map();          // nodeId -> event callback
        this.nodeRegistrations = new Map();   // nodeId -> { serverId, type, registeredAt }
        this.recoveryCallbacks = new Map();   // serverId -> Set<callback>
    }

    // Recovery callback management
    registerRecoveryCallback(serverId, callback) {
        if (!this.recoveryCallbacks.has(serverId)) {
            this.recoveryCallbacks.set(serverId, new Set());
        }
        this.recoveryCallbacks.get(serverId).add(callback);
        this.manager.log(`Registered recovery callback for ${serverId} (total: ${this.recoveryCallbacks.get(serverId).size})`);
    }

    removeRecoveryCallback(serverId, callback) {
        const callbacks = this.recoveryCallbacks.get(serverId);
        if (callbacks) {
            callbacks.delete(callback);
            if (callbacks.size === 0) {
                this.recoveryCallbacks.delete(serverId);
            }
        }
    }

    hasRecoveryCallbacks(serverId) {
        return this.recoveryCallbacks.has(serverId) && this.recoveryCallbacks.get(serverId).size > 0;
    }

    executeRecoveryCallbacks(serverId) {
        const callbacks = this.recoveryCallbacks.get(serverId);
        if (callbacks && callbacks.size > 0) {
            this.manager.log(`Executing ${callbacks.size} recovery callbacks for ${serverId}`);
            
            const callbacksToExecute = Array.from(callbacks);
            callbacks.clear();
            this.recoveryCallbacks.delete(serverId);
            
            callbacksToExecute.forEach(callback => {
                try {
                    callback();
                } catch (error) {
                    this.manager.error(`Recovery callback error for ${serverId}: ${error.message}`);
                }
            });
        }
    }

    clearRecoveryCallbacks(serverId) {
        const callbacks = this.recoveryCallbacks.get(serverId);
        if (callbacks) {
            this.manager.log(`Clearing ${callbacks.size} recovery callbacks for ${serverId}`);
            callbacks.clear();
            this.recoveryCallbacks.delete(serverId);
        }
    }

    // Node registration management
    registerNode(nodeId, serverId, type) {
        this.nodeRegistrations.set(nodeId, {
            serverId: serverId,
            type: type,
            registeredAt: Date.now()
        });
        this.manager.log(`Registered node ${nodeId} for ${serverId} (type: ${type})`);
    }

    unregisterNode(nodeId) {
        const registration = this.nodeRegistrations.get(nodeId);
        if (registration) {
            this.nodeRegistrations.delete(nodeId);
            this.manager.log(`Unregistered node ${nodeId} from ${registration.serverId}`);
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
                        this.manager.error(`Status update error for node ${nodeId}: ${err.message}`);
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
                        
                        // FIX 1: Für späte Verbindungen extra Callbacks ausführen
                        if (status === 'ready') {
                            // Simuliere Reconnect für Nodes die beim Start registriert wurden
                            if (callback.onReconnect) {
                                callback.onReconnect();
                            }
                        }
                    } catch (err) {
                        this.manager.error(`Status update error for node ${nodeId}: ${err.message}`);
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
                    this.manager.error(`State callback error for ${nodeId}: ${err.message}`);
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
                await client.subscribe(stateIdOrPattern, (id, state) => this.handleStateChange(id, state));
                
                if (callback.onSubscribed) {
                    callback.onSubscribed();
                }
                
                // FIX 2: Status auf ready setzen nach erfolgreicher Subscription
                if (callback.updateStatus) {
                    callback.updateStatus('ready');
                }
                
                // Handle initial value request for single states (not wildcards)
                if (callback.wantsInitialValue && !stateIdOrPattern.includes('*')) {
                    this.manager.log(`Requesting initial value for node ${nodeId} state ${stateIdOrPattern}`);
                    
                    setImmediate(async () => {
                        try {
                            const state = await client.getState(stateIdOrPattern);
                            if (state && state.val !== undefined) {
                                this.manager.log(`Initial value received for node ${nodeId}: ${stateIdOrPattern} = ${state.val}`);
                                
                                if (callback.onInitialValue) {
                                    callback.onInitialValue(stateIdOrPattern, state);
                                } else {
                                    callback(stateIdOrPattern, state);
                                }
                            } else {
                                this.manager.log(`No initial value available for node ${nodeId} state ${stateIdOrPattern}`);
                            }
                        } catch (error) {
                            this.manager.error(`Initial value request failed for node ${nodeId} state ${stateIdOrPattern}: ${error.message}`);
                        }
                    });
                }
            }
            
            this.manager.log(`Subscribed node ${nodeId} to ${stateIdOrPattern.includes('*') ? 'wildcard pattern' : 'single state'}: ${stateIdOrPattern}`);
            
        } catch (error) {
            this.manager.error(`Subscribe failed for node ${nodeId}: ${error.message}`);
            
            // Only schedule recovery if this is not already a recovery attempt
            if (!isRecovery) {
                const recoveryCallback = () => {
                    this.manager.log(`Attempting recovery subscription for node ${nodeId} to ${stateIdOrPattern}`);
                    this.subscribe(nodeId, serverId, stateIdOrPattern, callback, config, true, manager)
                        .catch(retryError => {
                            this.manager.error(`Recovery subscription failed for node ${nodeId}: ${retryError.message}`);
                        });
                };
                
                this.registerRecoveryCallback(serverId, recoveryCallback);
            }
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
                    this.manager.log(`Event node ${nodeId} registered - will receive updates when connection is ready`);
                    
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
            
            this.manager.log(`Registered node ${nodeId} for events on ${serverId}`);
            
        } catch (error) {
            this.manager.error(`Event registration failed for node ${nodeId}: ${error.message}`);
            
            // Only schedule recovery if this is not already a recovery attempt
            if (!isRecovery) {
                const recoveryCallback = () => {
                    this.manager.log(`Attempting recovery event registration for node ${nodeId}`);
                    this.registerForEvents(nodeId, serverId, callback, config, true, manager)
                        .catch(retryError => {
                            this.manager.error(`Recovery event registration failed for node ${nodeId}: ${retryError.message}`);
                        });
                };
                
                this.registerRecoveryCallback(serverId, recoveryCallback);
            }
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
                
                const client = manager.connections.get(serverId);
                if (client && client.connected) {
                    client.emit('unsubscribe', stateIdOrPattern, () => {});
                    this.manager.log(`Unsubscribed from WebSocket pattern: ${stateIdOrPattern}`);
                }
            }
            
            this.callbacks.delete(nodeId);
            this.unregisterNode(nodeId);
            
            this.manager.log(`Unsubscribed node ${nodeId} from ${stateIdOrPattern}`);
            
        } catch (error) {
            this.manager.error(`Unsubscribe error for node ${nodeId}: ${error.message}`);
        }
    }

    unregisterFromEvents(nodeId) {
        try {
            this.eventNodes.delete(nodeId);
            this.unregisterNode(nodeId);
            this.manager.log(`Unregistered node ${nodeId} from events`);
        } catch (error) {
            this.manager.error(`Unregister events error for node ${nodeId}: ${error.message}`);
        }
    }

    // Resubscription after reconnection - FIX 3: Keine doppelten Initial Values
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
            this.manager.log(`Resubscribing to ${statesToSubscribe.size} patterns for ${serverId}`);
            
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
                            
                            // REMOVED: Initial values bei Reconnection entfernt
                            // um doppelte Initial Values zu vermeiden
                        });
                    }
                    
                    this.manager.log(`Resubscribed to pattern: ${pattern}`);
                    
                    // Small delay between subscriptions to avoid overwhelming the server
                    await new Promise(r => setTimeout(r, 50));
                } catch (error) {
                    this.manager.error(`Resubscribe failed for ${pattern}: ${error.message}`);
                }
            }
        }
    }

    // Cleanup
    cleanup() {
        this.manager.log('Cleaning up node registry');
        
        this.subscriptions.clear();
        this.callbacks.clear();
        this.eventNodes.clear();
        this.nodeRegistrations.clear();
        this.recoveryCallbacks.clear();
        
        this.manager.log('Node registry cleanup completed');
    }
}

module.exports = NodeRegistry;