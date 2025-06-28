/*!
 * Node Registry for WebSocket Manager
 * Manages node registrations, subscriptions, and state/object handling
 */

class NodeRegistry {
    constructor(manager) {
        this.manager = manager;
        this.subscriptions = new Map();         // pattern -> Set<nodeId> (for states)
        this.objectSubscriptions = new Map();   // pattern -> Set<nodeId> (for objects)
        this.callbacks = new Map();             // nodeId -> callback function
        this.objectCallbacks = new Map();       // nodeId -> callback function (for objects)
        this.eventNodes = new Map();            // nodeId -> event callback
        this.nodeRegistrations = new Map();     // nodeId -> { serverId, type, registeredAt }
        this.recoveryCallbacks = new Map();     // serverId -> Set<callback>
        this.pendingInitialValues = new Map();  // serverId -> Map<nodeId, stateId>
    }

    // Recovery callback management
    registerRecoveryCallback(serverId, callback) {
        if (!this.recoveryCallbacks.has(serverId)) {
            this.recoveryCallbacks.set(serverId, new Set());
        }
        this.recoveryCallbacks.get(serverId).add(callback);
        this.manager.log.info(`Registered recovery callback for ${serverId} (total: ${this.recoveryCallbacks.get(serverId).size})`);
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
            this.manager.log.info(`Executing ${callbacks.size} recovery callbacks for ${serverId}`);

            const callbacksToExecute = Array.from(callbacks);
            callbacks.clear();
            this.recoveryCallbacks.delete(serverId);

            callbacksToExecute.forEach(callback => {
                try {
                    callback();
                } catch (error) {
                    this.manager.log.error(`Recovery callback error for ${serverId}: ${error.message}`);
                }
            });
        }
    }

    clearRecoveryCallbacks(serverId) {
        const callbacks = this.recoveryCallbacks.get(serverId);
        if (callbacks) {
            this.manager.log.info(`Clearing ${callbacks.size} recovery callbacks for ${serverId}`);
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
        this.manager.log.info(`Registered node ${nodeId} for ${serverId} (type: ${type})`);
    }

    unregisterNode(nodeId) {
        const registration = this.nodeRegistrations.get(nodeId);
        if (registration) {
            this.nodeRegistrations.delete(nodeId);

            // Clean up pending initial values
            const pendingForServer = this.pendingInitialValues.get(registration.serverId);
            if (pendingForServer) {
                pendingForServer.delete(nodeId);
                if (pendingForServer.size === 0) {
                    this.pendingInitialValues.delete(registration.serverId);
                }
            }

            this.manager.log.info(`Unregistered node ${nodeId} from ${registration.serverId}`);
            return registration.serverId;
        }
        return null;
    }

    getRemainingNodesForServer(serverId) {
        return Array.from(this.nodeRegistrations.values())
            .filter(reg => reg.serverId === serverId).length;
    }

    registerPendingInitialValue(serverId, nodeId, stateId) {
        if (!this.pendingInitialValues.has(serverId)) {
            this.pendingInitialValues.set(serverId, new Map());
        }
        this.pendingInitialValues.get(serverId).set(nodeId, stateId);
        this.manager.log.info(`Registered pending initial value for node ${nodeId} state ${stateId}`);
    }

    async processPendingInitialValues(serverId, client) {
        const pending = this.pendingInitialValues.get(serverId);
        if (!pending || pending.size === 0) {
            return;
        }

        this.manager.log.info(`Processing ${pending.size} pending initial values for ${serverId}`);

        // Process each pending initial value
        const pendingEntries = Array.from(pending.entries());
        pending.clear(); // Clear immediately to prevent duplicates

        for (const [nodeId, stateId] of pendingEntries) {
            try {
                const callback = this.callbacks.get(nodeId);
                if (!callback || !callback.wantsInitialValue) {
                    continue;
                }

                this.manager.log.info(`Fetching initial value for node ${nodeId} state ${stateId}`);

                const state = await client.getState(stateId);
                if (state && state.val !== undefined) {
                    this.manager.log.info(`Initial value received for node ${nodeId}: ${stateId} = ${state.val}`);

                    if (callback.onInitialValue) {
                        callback.onInitialValue(stateId, state);
                    } else {
                        callback(stateId, state);
                    }
                } else {
                    this.manager.log.info(`No initial value available for node ${nodeId} state ${stateId}`);
                }

                // Small delay between requests to avoid overwhelming the server
                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (error) {
                this.manager.log.error(`Initial value request failed for node ${nodeId} state ${stateId}: ${error.message}`);
            }
        }

        // Clean up empty map
        if (pending.size === 0) {
            this.pendingInitialValues.delete(serverId);
        }
    }

    // Node status updates
    updateNodeStatus(serverId, status) {
        // Update subscription node callbacks (states)
        this.callbacks.forEach((callback, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                if (callback.updateStatus) {
                    try {
                        callback.updateStatus(status);
                    } catch (err) {
                        this.manager.log.error(`Status update error for node ${nodeId}: ${err.message}`);
                    }
                }
            }
        });

        // Update object subscription node callbacks
        this.objectCallbacks.forEach((callback, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                if (callback.updateStatus) {
                    try {
                        callback.updateStatus(status);
                    } catch (err) {
                        this.manager.log.error(`Object status update error for node ${nodeId}: ${err.message}`);
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

                        if (status === 'ready') {
                            if (callback.onReconnect) {
                                callback.onReconnect();
                            }
                        }
                    } catch (err) {
                        this.manager.log.error(`Status update error for node ${nodeId}: ${err.message}`);
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
                    this.manager.log.error(`State callback error for ${nodeId}: ${err.message}`);
                }
            }
        });
    }

    // Object change handling
    handleObjectChange(objectId, objectData, operation = 'update') {
        const matchingNodeIds = new Set();

        // Find all nodes that have object subscriptions matching this object
        this.objectSubscriptions.forEach((nodeIds, pattern) => {
            if (this.matchesPattern(objectId, pattern)) {
                nodeIds.forEach(nodeId => matchingNodeIds.add(nodeId));
            }
        });

        if (matchingNodeIds.size === 0) return;

        // Call the callbacks for matching nodes
        matchingNodeIds.forEach(nodeId => {
            const callback = this.objectCallbacks.get(nodeId);
            if (callback) {
                try {
                    callback(objectId, objectData, operation);
                } catch (err) {
                    this.manager.log.error(`Object callback error for ${nodeId}: ${err.message}`);
                }
            }
        });
    }

    matchesPattern(id, pattern) {
        if (id === pattern) return true;

        if (pattern.includes('*')) {
            const regexPattern = pattern
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*');

            const regex = new RegExp(`^${regexPattern}$`);
            return regex.test(id);
        }

        return false;
    }

    // State subscription management
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

                if (callback.updateStatus) {
                    callback.updateStatus('ready');
                }

                if (callback.wantsInitialValue && !stateIdOrPattern.includes('*')) {
                    await this.requestInitialValue(nodeId, serverId, stateIdOrPattern, callback, client);
                }
            } else {
                if (callback.wantsInitialValue && !stateIdOrPattern.includes('*')) {
                    this.registerPendingInitialValue(serverId, nodeId, stateIdOrPattern);
                }
            }

            this.manager.log.info(`Subscribed node ${nodeId} to ${stateIdOrPattern.includes('*') ? 'wildcard pattern' : 'single state'}: ${stateIdOrPattern}`);

        } catch (error) {
            this.manager.log.error(`Subscribe failed for node ${nodeId}: ${error.message}`);

            // Update node status based on error type
            if (callback.updateStatus) {
                if (error.message.includes('not possible in state: auth_failed')) {
                    callback.updateStatus('failed_permanently');
                } else if (error.message.includes('Authentication failed')) {
                    callback.updateStatus('failed_permanently');
                } else if (error.message.includes('not possible in state')) {
                    // Check the actual connection state to determine the proper status
                    const connectionState = manager.connectionManager.getConnectionState(serverId);
                    if (connectionState === 'auth_failed') {
                        callback.updateStatus('failed_permanently');
                    } else {
                        callback.updateStatus('retrying');
                    }
                } else {
                    callback.updateStatus('retrying');
                }
            }

            // Only schedule recovery if this is not already a recovery attempt and it's not a permanent auth failure
            if (!isRecovery && !error.message.includes('auth_failed') && !error.message.includes('Authentication failed')) {
                const recoveryCallback = () => {
                    this.manager.log.info(`Attempting recovery subscription for node ${nodeId} to ${stateIdOrPattern}`);
                    this.subscribe(nodeId, serverId, stateIdOrPattern, callback, config, true, manager)
                        .catch(retryError => {
                            this.manager.log.error(`Recovery subscription failed for node ${nodeId}: ${retryError.message}`);
                        });
                };

                this.registerRecoveryCallback(serverId, recoveryCallback);
            }
            throw error;
        }
    }

    // Object subscription management
    async subscribeObjects(nodeId, serverId, objectIdOrPattern, callback, config, isRecovery = false, manager) {
        try {
            this.registerNode(nodeId, serverId, 'subscribeObjects');

            // Get connection - this will respect the centralized state management
            const client = await manager.getConnection(serverId, config);
            this.objectCallbacks.set(nodeId, callback);

            // Track object subscription
            if (!this.objectSubscriptions.has(objectIdOrPattern)) {
                this.objectSubscriptions.set(objectIdOrPattern, new Set());
            }
            this.objectSubscriptions.get(objectIdOrPattern).add(nodeId);

            // Subscribe via WebSocket if client is ready
            if (client.isClientReady()) {
                await manager.operationManager.subscribeObjects(serverId, objectIdOrPattern, (id, objectData, operation) => this.handleObjectChange(id, objectData, operation));

                if (callback.onSubscribed) {
                    callback.onSubscribed();
                }

                if (callback.updateStatus) {
                    callback.updateStatus('ready');
                }
            }

            this.manager.log.info(`Subscribed node ${nodeId} to ${objectIdOrPattern.includes('*') ? 'wildcard pattern' : 'single object'}: ${objectIdOrPattern}`);

        } catch (error) {
            this.manager.log.error(`Object subscribe failed for node ${nodeId}: ${error.message}`);

            // Update node status based on error type
            if (callback.updateStatus) {
                if (error.message.includes('not possible in state: auth_failed')) {
                    callback.updateStatus('failed_permanently');
                } else if (error.message.includes('Authentication failed')) {
                    callback.updateStatus('failed_permanently');
                } else if (error.message.includes('not possible in state')) {
                    const connectionState = manager.connectionManager.getConnectionState(serverId);
                    if (connectionState === 'auth_failed') {
                        callback.updateStatus('failed_permanently');
                    } else {
                        callback.updateStatus('retrying');
                    }
                } else {
                    callback.updateStatus('retrying');
                }
            }

            // Only schedule recovery if this is not already a recovery attempt and it's not a permanent auth failure
            if (!isRecovery && !error.message.includes('auth_failed') && !error.message.includes('Authentication failed')) {
                const recoveryCallback = () => {
                    this.manager.log.info(`Attempting recovery object subscription for node ${nodeId} to ${objectIdOrPattern}`);
                    this.subscribeObjects(nodeId, serverId, objectIdOrPattern, callback, config, true, manager)
                        .catch(retryError => {
                            this.manager.log.error(`Recovery object subscription failed for node ${nodeId}: ${retryError.message}`);
                        });
                };

                this.registerRecoveryCallback(serverId, recoveryCallback);
            }
            throw error;
        }
    }

    async requestInitialValue(nodeId, serverId, stateId, callback, client) {
        try {
            this.manager.log.info(`Requesting initial value for node ${nodeId} state ${stateId}`);

            const state = await client.getState(stateId);
            if (state && state.val !== undefined) {
                this.manager.log.info(`Initial value received for node ${nodeId}: ${stateId} = ${state.val}`);

                if (callback.onInitialValue) {
                    callback.onInitialValue(stateId, state);
                } else {
                    callback(stateId, state);
                }
            } else {
                this.manager.log.info(`No initial value available for node ${nodeId} state ${stateId}`);
            }
        } catch (error) {
            this.manager.log.error(`Initial value request failed for node ${nodeId} state ${stateId}: ${error.message}`);
        }
    }

    // Event registration for nodes that don't subscribe to states
    async registerForEvents(nodeId, serverId, callback, config, isRecovery = false, manager) {
        try {
            this.registerNode(nodeId, serverId, 'events');
            this.eventNodes.set(nodeId, callback);

            // For event-only nodes, we don't need to wait for connection
            // We just register them and they'll get status updates when connection changes
            const connectionState = manager.connectionManager.getConnectionState(serverId);

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
                    this.manager.log.info(`Event node ${nodeId} registered - will receive updates when connection is ready`);

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

            this.manager.log.info(`Registered node ${nodeId} for events on ${serverId}`);

        } catch (error) {
            this.manager.log.error(`Event registration failed for node ${nodeId}: ${error.message}`);

            // Only schedule recovery if this is not already a recovery attempt
            if (!isRecovery) {
                const recoveryCallback = () => {
                    this.manager.log.info(`Attempting recovery event registration for node ${nodeId}`);
                    this.registerForEvents(nodeId, serverId, callback, config, true, manager)
                        .catch(retryError => {
                            this.manager.log.error(`Recovery event registration failed for node ${nodeId}: ${retryError.message}`);
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

                const client = manager.connectionManager.connections.get(serverId);
                if (client && client.connected) {
                    client.emit('unsubscribe', stateIdOrPattern, () => { });
                    this.manager.log.info(`Unsubscribed from WebSocket pattern: ${stateIdOrPattern}`);
                }
            }

            this.callbacks.delete(nodeId);
            this.unregisterNode(nodeId);

            this.manager.log.info(`Unsubscribed node ${nodeId} from ${stateIdOrPattern}`);

        } catch (error) {
            this.manager.log.error(`Unsubscribe error for node ${nodeId}: ${error.message}`);
        }
    }

    async unsubscribeObjects(nodeId, serverId, objectIdOrPattern, manager) {
        try {
            const nodeIds = this.objectSubscriptions.get(objectIdOrPattern);
            if (!nodeIds) return;

            nodeIds.delete(nodeId);

            // If this was the last node for this pattern, unsubscribe from WebSocket
            if (nodeIds.size === 0) {
                this.objectSubscriptions.delete(objectIdOrPattern);

                const client = manager.connectionManager.connections.get(serverId);
                if (client && client.connected) {
                    client.emit('unsubscribeObjects', objectIdOrPattern, () => { });
                    this.manager.log.info(`Unsubscribed from WebSocket object pattern: ${objectIdOrPattern}`);
                }
            }

            this.objectCallbacks.delete(nodeId);
            this.unregisterNode(nodeId);

            this.manager.log.info(`Unsubscribed node ${nodeId} from object pattern ${objectIdOrPattern}`);

        } catch (error) {
            this.manager.log.error(`Object unsubscribe error for node ${nodeId}: ${error.message}`);
        }
    }

    unregisterFromEvents(nodeId) {
        try {
            this.eventNodes.delete(nodeId);
            const serverId = this.unregisterNode(nodeId);
            this.manager.log.info(`Unregistered node ${nodeId} from events`);
            return serverId;
        } catch (error) {
            this.manager.log.error(`Unregister events error for node ${nodeId}: ${error.message}`);
            return null;
        }
    }

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
            this.manager.log.info(`Resubscribing to ${statesToSubscribe.size} state patterns for ${serverId}`);

            // Resubscribe to each pattern
            for (const pattern of statesToSubscribe) {
                try {
                    await this.manager.operationManager.subscribe(serverId, pattern, (id, state) => this.handleStateChange(id, state));

                    const callbackInfos = nodeCallbacks.get(pattern);
                    if (callbackInfos) {
                        callbackInfos.forEach(info => {
                            // Notify node that subscription is restored
                            if (info.callback.onSubscribed) {
                                info.callback.onSubscribed();
                            }
                        });
                    }

                    this.manager.log.info(`Resubscribed to state pattern: ${pattern}`);

                    // Small delay between subscriptions to avoid overwhelming the server
                    await new Promise(r => setTimeout(r, 50));
                } catch (error) {
                    this.manager.log.error(`Resubscribe failed for state pattern ${pattern}: ${error.message}`);
                }
            }
        }

        await this.processPendingInitialValues(serverId, client);
    }

    async resubscribeObjects(serverId, client) {
        const objectsToSubscribe = new Set();
        const nodeCallbacks = new Map();

        // Collect all object patterns that need resubscription for this server
        this.objectSubscriptions.forEach((nodeIds, pattern) => {
            nodeIds.forEach(nodeId => {
                const registration = this.nodeRegistrations.get(nodeId);
                if (registration && registration.serverId === serverId) {
                    objectsToSubscribe.add(pattern);

                    const callback = this.objectCallbacks.get(nodeId);
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

        if (objectsToSubscribe.size > 0) {
            this.manager.log.info(`Resubscribing to ${objectsToSubscribe.size} object patterns for ${serverId}`);

            // Resubscribe to each object pattern
            for (const pattern of objectsToSubscribe) {
                try {
                    await this.manager.operationManager.subscribeObjects(serverId, pattern, (id, objectData, operation) => this.handleObjectChange(id, objectData, operation));

                    const callbackInfos = nodeCallbacks.get(pattern);
                    if (callbackInfos) {
                        callbackInfos.forEach(info => {
                            // Notify node that subscription is restored
                            if (info.callback.onSubscribed) {
                                info.callback.onSubscribed();
                            }
                        });
                    }

                    this.manager.log.info(`Resubscribed to object pattern: ${pattern}`);

                    // Small delay between subscriptions to avoid overwhelming the server
                    await new Promise(r => setTimeout(r, 50));
                } catch (error) {
                    this.manager.log.error(`Resubscribe failed for object pattern ${pattern}: ${error.message}`);
                }
            }
        }
    }

    // Cleanup
    cleanup() {
        this.manager.log.info('Cleaning up node registry');

        this.subscriptions.clear();
        this.objectSubscriptions.clear();
        this.callbacks.clear();
        this.objectCallbacks.clear();
        this.eventNodes.clear();
        this.nodeRegistrations.clear();
        this.recoveryCallbacks.clear();
        this.pendingInitialValues.clear();

        this.manager.log.info('Node registry cleanup completed');
    }
}

module.exports = NodeRegistry;