/*!
 * Node Registry for WebSocket Manager
 * Manages node registrations, subscriptions, and state handling
 */

class NodeRegistry {
    constructor(manager) {
        this.manager = manager;
        this.subscriptions = new Map();
        this.callbacks = new Map();
        this.eventNodes = new Map();
        this.nodeRegistrations = new Map();
        this.recoveryCallbacks = new Map();
    }

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

    registerNode(nodeId, serverId, type) {
        this.nodeRegistrations.set(nodeId, {
            serverId: serverId,
            type: type,
            registeredAt: Date.now()
        });
    }

    unregisterNode(nodeId) {
        const registration = this.nodeRegistrations.get(nodeId);
        if (registration) {
            this.nodeRegistrations.delete(nodeId);
            return registration.serverId;
        }
        return null;
    }

    getRemainingNodesForServer(serverId) {
        return Array.from(this.nodeRegistrations.values())
            .filter(reg => reg.serverId === serverId).length;
    }

    updateNodeStatus(serverId, status) {
        // Update all callbacks for nodes using this server
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

        // Update all event nodes for this server
        this.eventNodes.forEach((callback, nodeId) => {
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
    }

    handleStateChange(stateId, state) {
        const matchingNodeIds = new Set();
        
        // Find all nodes that match this state
        this.subscriptions.forEach((nodeIds, pattern) => {
            if (this.matchesPattern(stateId, pattern)) {
                nodeIds.forEach(nodeId => matchingNodeIds.add(nodeId));
            }
        });

        if (matchingNodeIds.size === 0) return;

        // Call callbacks for matching nodes
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

    async subscribe(nodeId, serverId, stateIdOrPattern, callback, config, isRecovery = false, manager) {
        try {
            this.registerNode(nodeId, serverId, 'subscribe');
            
            const client = await manager.getConnection(serverId, config);
            this.callbacks.set(nodeId, callback);
            
            if (!this.subscriptions.has(stateIdOrPattern)) {
                this.subscriptions.set(stateIdOrPattern, new Set());
            }
            this.subscriptions.get(stateIdOrPattern).add(nodeId);
            
            // If client is ready, subscribe immediately
            if (client.isClientReady()) {
                await client.subscribe(stateIdOrPattern, (id, state) => this.handleStateChange(id, state));
                
                if (callback.onSubscribed) {
                    callback.onSubscribed();
                }
                
                // Request initial value IMMEDIATELY after successful subscription
                if (callback.wantsInitialValue && !stateIdOrPattern.includes('*')) {
                    this.manager.log(`Requesting initial value for node ${nodeId} state ${stateIdOrPattern}`);
                    
                    // Use setImmediate to ensure subscription is fully complete
                    setImmediate(async () => {
                        try {
                            const state = await client.requestInitialValue(stateIdOrPattern);
                            if (state && state.val !== undefined) {
                                this.manager.log(`Initial value received for node ${nodeId}: ${stateIdOrPattern} = ${state.val}`);
                                
                                // Call the callback directly - subscription is guaranteed to be active
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
                            // Don't fail the subscription because of initial value error
                        }
                    });
                }
            }
            
            this.manager.log(`Subscribed node ${nodeId} to ${stateIdOrPattern.includes('*') ? 'wildcard pattern' : 'single state'}: ${stateIdOrPattern}`);
            
        } catch (error) {
            this.manager.error(`Subscribe failed for node ${nodeId}: ${error.message}`);
            
            // Register recovery callback for retry when connection becomes available
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

    async registerForEvents(nodeId, serverId, callback, config, isRecovery = false, manager) {
        try {
            this.registerNode(nodeId, serverId, 'events');
            
            await manager.getConnection(serverId, config);
            this.eventNodes.set(nodeId, callback);
            
        } catch (error) {
            this.manager.error(`Event registration failed for node ${nodeId}: ${error.message}`);
            
            // Register recovery callback for retry when connection becomes available
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

    async unsubscribe(nodeId, serverId, stateIdOrPattern, manager) {
        try {
            const nodeIds = this.subscriptions.get(stateIdOrPattern);
            if (!nodeIds) return;

            nodeIds.delete(nodeId);
            if (nodeIds.size === 0) {
                this.subscriptions.delete(stateIdOrPattern);
                
                const client = manager.connections.get(serverId);
                if (client && client.connected) {
                    // Unsubscribe from client
                    client.emit('unsubscribe', stateIdOrPattern, () => {});
                }
            }
            
            this.callbacks.delete(nodeId);
            this.unregisterNode(nodeId);
            
        } catch (error) {
            this.manager.error(`Unsubscribe error for node ${nodeId}: ${error.message}`);
        }
    }

    unregisterFromEvents(nodeId) {
        try {
            this.eventNodes.delete(nodeId);
            this.unregisterNode(nodeId);
        } catch (error) {
            this.manager.error(`Unregister events error for node ${nodeId}: ${error.message}`);
        }
    }

    async resubscribeStates(serverId, client) {
        const statesToSubscribe = new Set();
        const nodeCallbacks = new Map();
        
        this.subscriptions.forEach((nodeIds, stateId) => {
            nodeIds.forEach(nodeId => {
                const registration = this.nodeRegistrations.get(nodeId);
                if (registration && registration.serverId === serverId) {
                    statesToSubscribe.add(stateId);
                    
                    const callback = this.callbacks.get(nodeId);
                    if (callback) {
                        if (!nodeCallbacks.has(stateId)) {
                            nodeCallbacks.set(stateId, new Set());
                        }
                        nodeCallbacks.get(stateId).add({
                            nodeId: nodeId,
                            callback: callback
                        });
                    }
                }
            });
        });

        if (statesToSubscribe.size > 0) {
            this.manager.log(`Resubscribing to ${statesToSubscribe.size} states for ${serverId}`);
            
            for (const stateId of statesToSubscribe) {
                try {
                    await client.subscribe(stateId, (id, state) => this.handleStateChange(id, state));
                    
                    // Notify nodes of successful subscription
                    const callbackInfos = nodeCallbacks.get(stateId);
                    if (callbackInfos) {
                        callbackInfos.forEach(info => {
                            if (info.callback.onSubscribed) {
                                info.callback.onSubscribed();
                            }
                            
                            // Request initial value immediately after resubscription
                            if (info.callback.wantsInitialValue && !stateId.includes('*')) {
                                setImmediate(async () => {
                                    try {
                                        const state = await client.requestInitialValue(stateId);
                                        if (state && state.val !== undefined) {
                                            this.manager.log(`Reconnect initial value for node ${info.nodeId}: ${stateId} = ${state.val}`);
                                            
                                            if (info.callback.onInitialValue) {
                                                info.callback.onInitialValue(stateId, state);
                                            } else {
                                                info.callback(stateId, state);
                                            }
                                        }
                                    } catch (error) {
                                        this.manager.error(`Reconnect initial value failed for node ${info.nodeId}: ${error.message}`);
                                    }
                                });
                            }
                        });
                    }
                    
                    await new Promise(r => setTimeout(r, 50));
                } catch (error) {
                    this.manager.error(`Resubscribe failed for ${stateId}: ${error.message}`);
                }
            }
        }
    }

    cleanup() {
        this.subscriptions.clear();
        this.callbacks.clear();
        this.eventNodes.clear();
        this.nodeRegistrations.clear();
        this.recoveryCallbacks.clear();
    }
}

module.exports = NodeRegistry;