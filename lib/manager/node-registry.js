/*!
 * Node Registry for WebSocket Manager - Performance Optimized
 * Manages node registrations, subscriptions, and state/object handling
 */

const { Logger } = require('../utils/logger');
const { PatternMatcher } = require('../utils/pattern-matcher');

class NodeRegistry {
    constructor(manager) {
        this.manager = manager;
        this.subscriptions = new Map();
        this.objectSubscriptions = new Map();
        this.callbacks = new Map();
        this.objectCallbacks = new Map();
        this.eventNodes = new Map();
        this.nodeRegistrations = new Map();
        this.recoveryCallbacks = new Map();
        this.pendingInitialValues = new Map();
        this.multipleStateSubscriptions = new Map();
        this.log = new Logger('NodeRegistry');
    }

    async subscribeMultiple(nodeId, serverId, stateIds, callback, config, isRecovery = false, manager) {
        try {
            this.registerNode(nodeId, serverId, 'subscribeMultiple');

            const client = await manager.getConnection(serverId, config);
            this.callbacks.set(nodeId, callback);

            const connectionStatus = manager.connectionManager.getConnectionStatus(serverId);
            const isClientReady = client && client.isClientReady && client.isClientReady();

            this.log.debug(`Node ${nodeId} multiple subscription - Connection ready: ${connectionStatus.ready}, Client ready: ${isClientReady}`);

            const successfulStates = [];
            const failedStates = [];

            if (connectionStatus.ready && isClientReady) {
                try {
                    const subscribePromises = stateIds.map(stateId => 
                        this.subscribeWithRetry(manager, serverId, stateId)
                    );

                    const batchSize = 10;
                    for (let i = 0; i < subscribePromises.length; i += batchSize) {
                        const batch = subscribePromises.slice(i, i + batchSize);
                        
                        const batchResults = await Promise.allSettled(batch);
                        
                        batchResults.forEach((result, index) => {
                            const stateId = stateIds[i + index];
                            if (result.status === 'fulfilled') {
                                successfulStates.push(stateId);
                            } else {
                                this.log.error(`Failed to subscribe to state ${stateId}: ${result.reason.message}`);
                                failedStates.push(stateId);
                            }
                        });

                        if (i + batchSize < subscribePromises.length) {
                            await new Promise(resolve => setTimeout(resolve, 10));
                        }
                    }

                    this.multipleStateSubscriptions.set(nodeId, {
                        subscribedStates: new Set(successfulStates),
                        originalStates: stateIds,
                        serverId: serverId
                    });

                    if (callback.onSubscribed) {
                        callback.onSubscribed();
                    }

                    if (callback.updateStatus) {
                        callback.updateStatus('ready');
                        this.log.debug(`Node ${nodeId} immediately set to ready status`);
                    }
                    this.log.info(`Node ${nodeId} successfully subscribed to ${serverId} (${successfulStates.length}/${stateIds.length} states)`);
                    this.log.debug(`Multiple subscription details: ${successfulStates.length} successful, ${failedStates.length} failed`);

                    if (callback.wantsInitialValue && successfulStates.length > 0) {
                        this.loadInitialValuesParallel(nodeId, serverId, successfulStates, callback, client);
                    }
                } catch (subscribeError) {
                    this.log.error(`Immediate multiple subscription failed for ${nodeId}: ${subscribeError.message}`);
                    throw subscribeError;
                }
            } else {
                if (callback.updateStatus) {
                    callback.updateStatus('connecting');
                    this.log.debug(`Node ${nodeId} set to connecting status - will get ready update later`);
                }

                if (callback.wantsInitialValue) {
                    this.registerPendingInitialValues(serverId, nodeId, stateIds);
                }

                successfulStates.push(...stateIds);
            }

            return successfulStates;

        } catch (error) {
            this.log.error(`Multiple subscribe failed for node ${nodeId}: ${error.message}`);

            if (callback.updateStatus) {
                if (error.message.includes('not possible in state: auth_failed') || error.message.includes('Authentication failed')) {
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

            if (!isRecovery && !error.message.includes('auth_failed') && !error.message.includes('Authentication failed')) {
                const recoveryCallback = () => {
                    this.log.debug(`Attempting recovery multiple subscription for node ${nodeId} to ${stateIds.length} states`);
                    this.subscribeMultiple(nodeId, serverId, stateIds, callback, config, true, manager)
                        .catch(retryError => {
                            this.log.error(`Recovery multiple subscription failed for node ${nodeId}: ${retryError.message}`);
                        });
                };

                this.registerRecoveryCallback(serverId, recoveryCallback);
            }
            throw error;
        }
    }

    async subscribeWithRetry(manager, serverId, stateId, maxRetries = 2) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await manager.operationManager.subscribe(serverId, stateId, (id, state) => this.handleStateChange(id, state));
                return;
            } catch (error) {
                lastError = error;
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 100 * attempt));
                }
            }
        }
        
        throw lastError;
    }

    async loadInitialValuesParallel(nodeId, serverId, stateIds, callback, client) {
        try {
            this.log.debug(`Loading initial values in parallel for ${stateIds.length} states`);

            const batchSize = 15;
            const batches = [];
            
            for (let i = 0; i < stateIds.length; i += batchSize) {
                batches.push(stateIds.slice(i, i + batchSize));
            }

            for (const batch of batches) {
                const batchPromises = batch.map(stateId => 
                    this.fetchInitialValueWithTimeout(nodeId, stateId, callback, client)
                );

                await Promise.allSettled(batchPromises);

                if (batch !== batches[batches.length - 1]) {
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
            }

            this.log.debug(`Initial values loading completed for node ${nodeId}`);

        } catch (error) {
            this.log.error(`Parallel initial value loading failed for node ${nodeId}: ${error.message}`);
        }
    }

    async fetchInitialValueWithTimeout(nodeId, stateId, callback, client) {
        try {
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Initial value timeout')), 2000);
            });

            const getStatePromise = client.getState(stateId);
            
            const state = await Promise.race([getStatePromise, timeoutPromise]);
            
            if (state && state.val !== undefined) {
                this.log.debug(`Initial value received for node ${nodeId}: ${stateId} = ${state.val}`);

                if (callback.onInitialValue) {
                    callback.onInitialValue(stateId, state);
                } else {
                    callback(stateId, state);
                }
            } else {
                this.log.debug(`No initial value available for node ${nodeId} state ${stateId}`);
            }
        } catch (error) {
            this.log.debug(`Initial value request failed for node ${nodeId} state ${stateId}: ${error.message}`);
        }
    }

    async resubscribeStates(serverId, client) {
        const statesToSubscribe = new Set();
        const nodeCallbacks = new Map();

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
            this.log.info(`Resubscribing to ${statesToSubscribe.size} state patterns for ${serverId}`);

            const patternArray = Array.from(statesToSubscribe);
            const subscribePromises = patternArray.map(pattern => 
                this.resubscribePatternWithRetry(pattern, serverId, nodeCallbacks)
            );

            await Promise.allSettled(subscribePromises);
        }

        const multipleStateNodes = new Map();
        this.multipleStateSubscriptions.forEach((stateInfo, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                multipleStateNodes.set(nodeId, stateInfo);
            }
        });

        if (multipleStateNodes.size > 0) {
            this.log.info(`Resubscribing to ${multipleStateNodes.size} multiple state nodes for ${serverId}`);

            const allStatesToResubscribe = new Set();
            const nodeToStatesMap = new Map();
            
            for (const [nodeId, stateInfo] of multipleStateNodes) {
                nodeToStatesMap.set(nodeId, stateInfo.originalStates);
                stateInfo.originalStates.forEach(stateId => allStatesToResubscribe.add(stateId));
            }

            const allStatesArray = Array.from(allStatesToResubscribe);
            const subscribePromises = allStatesArray.map(stateId => 
                this.subscribeWithRetry(this.manager, serverId, stateId)
            );

            const results = await Promise.allSettled(subscribePromises);
            const successfulResubscriptions = new Set();

            results.forEach((result, index) => {
                const stateId = allStatesArray[index];
                if (result.status === 'fulfilled') {
                    successfulResubscriptions.add(stateId);
                } else {
                    this.log.error(`Resubscribe failed for state ${stateId}: ${result.reason.message}`);
                }
            });

            for (const [nodeId, originalStates] of nodeToStatesMap) {
                const nodeSuccessfulStates = originalStates.filter(stateId => 
                    successfulResubscriptions.has(stateId)
                );

                const stateInfo = this.multipleStateSubscriptions.get(nodeId);
                if (stateInfo) {
                    stateInfo.subscribedStates = new Set(nodeSuccessfulStates);
                }

                const callback = this.callbacks.get(nodeId);
                if (callback && callback.onSubscribed) {
                    callback.onSubscribed();
                }

                this.log.debug(`Resubscribed multiple state node ${nodeId} to ${nodeSuccessfulStates.length}/${originalStates.length} states`);
            }
        }

        await this.processPendingInitialValues(serverId, client);
    }

    async resubscribePatternWithRetry(pattern, serverId, nodeCallbacks) {
        try {
            await this.manager.operationManager.subscribe(serverId, pattern, (id, state) => this.handleStateChange(id, state));

            const callbackInfos = nodeCallbacks.get(pattern);
            if (callbackInfos) {
                callbackInfos.forEach(info => {
                    if (info.callback.onSubscribed) {
                        info.callback.onSubscribed();
                    }
                });
            }

            this.log.debug(`Resubscribed to state pattern: ${pattern}`);
        } catch (error) {
            this.log.error(`Resubscribe failed for state pattern ${pattern}: ${error.message}`);
        }
    }

    registerRecoveryCallback(serverId, callback) {
        if (!this.recoveryCallbacks.has(serverId)) {
            this.recoveryCallbacks.set(serverId, new Set());
        }
        this.recoveryCallbacks.get(serverId).add(callback);
        this.log.debug(`Registered recovery callback for ${serverId} (total: ${this.recoveryCallbacks.get(serverId).size})`);
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
            this.log.info(`Executing ${callbacks.size} recovery callbacks for ${serverId}`);

            const callbacksToExecute = Array.from(callbacks);
            callbacks.clear();
            this.recoveryCallbacks.delete(serverId);

            callbacksToExecute.forEach(callback => {
                try {
                    callback();
                } catch (error) {
                    this.log.error(`Recovery callback error for ${serverId}: ${error.message}`);
                }
            });
        }
    }

    clearRecoveryCallbacks(serverId) {
        const callbacks = this.recoveryCallbacks.get(serverId);
        if (callbacks) {
            this.log.debug(`Clearing ${callbacks.size} recovery callbacks for ${serverId}`);
            callbacks.clear();
            this.recoveryCallbacks.delete(serverId);
        }
    }

    registerNode(nodeId, serverId, type) {
        this.nodeRegistrations.set(nodeId, {
            serverId: serverId,
            type: type,
            registeredAt: Date.now()
        });
        this.log.debug(`Registered node ${nodeId} for ${serverId} (type: ${type})`);
    }

    unregisterNode(nodeId) {
        const registration = this.nodeRegistrations.get(nodeId);
        if (registration) {
            this.nodeRegistrations.delete(nodeId);

            const pendingForServer = this.pendingInitialValues.get(registration.serverId);
            if (pendingForServer) {
                pendingForServer.delete(nodeId);
                if (pendingForServer.size === 0) {
                    this.pendingInitialValues.delete(registration.serverId);
                }
            }

            this.log.debug(`Unregistered node ${nodeId} from ${registration.serverId}`);
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
        this.log.debug(`Registered pending initial value for node ${nodeId} state ${stateId}`);
    }

    registerPendingInitialValues(serverId, nodeId, stateIds) {
        if (!this.pendingInitialValues.has(serverId)) {
            this.pendingInitialValues.set(serverId, new Map());
        }
        this.pendingInitialValues.get(serverId).set(nodeId, stateIds);
        this.log.debug(`Registered ${stateIds.length} pending initial values for node ${nodeId}`);
    }

    async processPendingInitialValues(serverId, client) {
        const pending = this.pendingInitialValues.get(serverId);
        if (!pending || pending.size === 0) {
            return;
        }

        this.log.info(`Processing ${pending.size} pending initial values for ${serverId}`);

        const pendingEntries = Array.from(pending.entries());
        pending.clear();

        const processingTasks = pendingEntries.map(async ([nodeId, stateData]) => {
            try {
                const callback = this.callbacks.get(nodeId);
                if (!callback || !callback.wantsInitialValue) {
                    return;
                }

                if (Array.isArray(stateData)) {
                    await this.loadInitialValuesParallel(nodeId, serverId, stateData, callback, client);
                } else {
                    await this.fetchAndDeliverInitialValue(nodeId, stateData, callback, client);
                }
            } catch (error) {
                this.log.error(`Initial value processing failed for node ${nodeId}: ${error.message}`);
            }
        });

        await Promise.allSettled(processingTasks);

        if (pending.size === 0) {
            this.pendingInitialValues.delete(serverId);
        }
    }

    async fetchAndDeliverInitialValue(nodeId, stateId, callback, client) {
        try {
            this.log.debug(`Fetching initial value for node ${nodeId} state ${stateId}`);

            const state = await client.getState(stateId);
            if (state && state.val !== undefined) {
                this.log.debug(`Initial value received for node ${nodeId}: ${stateId} = ${state.val}`);

                if (callback.onInitialValue) {
                    callback.onInitialValue(stateId, state);
                } else {
                    callback(stateId, state);
                }
            } else {
                this.log.debug(`No initial value available for node ${nodeId} state ${stateId}`);
            }
        } catch (error) {
            this.log.error(`Initial value request failed for node ${nodeId} state ${stateId}: ${error.message}`);
        }
    }

    updateNodeStatus(serverId, status) {
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

        this.objectCallbacks.forEach((callback, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                if (callback.updateStatus) {
                    try {
                        callback.updateStatus(status);
                    } catch (err) {
                        this.log.error(`Object status update error for node ${nodeId}: ${err.message}`);
                    }
                }
            }
        });

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
                        this.log.error(`Status update error for node ${nodeId}: ${err.message}`);
                    }
                }
            }
        });
    }

    handleStateChange(stateId, state) {
        const matchingNodeIds = new Set();

        this.subscriptions.forEach((nodeIds, pattern) => {
            if (PatternMatcher.matches(stateId, pattern)) {
                nodeIds.forEach(nodeId => matchingNodeIds.add(nodeId));
            }
        });

        this.multipleStateSubscriptions.forEach((stateInfo, nodeId) => {
            if (stateInfo.subscribedStates.has(stateId)) {
                matchingNodeIds.add(nodeId);
            }
        });

        if (matchingNodeIds.size === 0) return;

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

    handleObjectChange(objectId, objectData, operation = 'update') {
        const matchingNodeIds = new Set();

        this.objectSubscriptions.forEach((nodeIds, pattern) => {
            if (PatternMatcher.matches(objectId, pattern)) {
                nodeIds.forEach(nodeId => matchingNodeIds.add(nodeId));
            }
        });

        if (matchingNodeIds.size === 0) return;

        matchingNodeIds.forEach(nodeId => {
            const callback = this.objectCallbacks.get(nodeId);
            if (callback) {
                try {
                    callback(objectId, objectData, operation);
                } catch (err) {
                    this.log.error(`Object callback error for ${nodeId}: ${err.message}`);
                }
            }
        });
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

            const connectionStatus = manager.connectionManager.getConnectionStatus(serverId);
            const isClientReady = client && client.isClientReady && client.isClientReady();

            this.log.debug(`Node ${nodeId} registration - Connection ready: ${connectionStatus.ready}, Client ready: ${isClientReady}`);

            if (connectionStatus.ready && isClientReady) {
                try {
                    await manager.operationManager.subscribe(serverId, stateIdOrPattern, (id, state) => this.handleStateChange(id, state));

                    if (callback.onSubscribed) {
                        callback.onSubscribed();
                    }

                    if (callback.updateStatus) {
                        callback.updateStatus('ready');
                        this.log.debug(`Node ${nodeId} immediately set to ready status`);
                    }
                    this.log.info(`Node ${nodeId} successfully subscribed to ${serverId}`);

                    this.log.debug(`Subscription details: ${stateIdOrPattern.includes('*') ? 'wildcard pattern' : 'single state'}: ${stateIdOrPattern}`);

                    if (callback.wantsInitialValue && !stateIdOrPattern.includes('*')) {
                        await this.requestInitialValue(nodeId, serverId, stateIdOrPattern, callback, client);
                    }
                } catch (subscribeError) {
                    this.log.error(`Immediate subscription failed for ${nodeId}: ${subscribeError.message}`);
                    throw subscribeError;
                }
            } else {
                if (callback.updateStatus) {
                    callback.updateStatus('connecting');
                    this.log.debug(`Node ${nodeId} set to connecting status - will get ready update later`);
                }

                if (callback.wantsInitialValue && !stateIdOrPattern.includes('*')) {
                    this.registerPendingInitialValue(serverId, nodeId, stateIdOrPattern);
                }
            }

        } catch (error) {
            this.log.error(`Subscribe failed for node ${nodeId}: ${error.message}`);

            if (callback.updateStatus) {
                if (error.message.includes('not possible in state: auth_failed') || error.message.includes('Authentication failed')) {
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

            if (!isRecovery && !error.message.includes('auth_failed') && !error.message.includes('Authentication failed')) {
                const recoveryCallback = () => {
                    this.log.debug(`Attempting recovery subscription for node ${nodeId} to ${stateIdOrPattern}`);
                    this.subscribe(nodeId, serverId, stateIdOrPattern, callback, config, true, manager)
                        .catch(retryError => {
                            this.log.error(`Recovery subscription failed for node ${nodeId}: ${retryError.message}`);
                        });
                };

                this.registerRecoveryCallback(serverId, recoveryCallback);
            }
            throw error;
        }
    }

    async subscribeObjects(nodeId, serverId, objectIdOrPattern, callback, config, isRecovery = false, manager) {
        try {
            this.registerNode(nodeId, serverId, 'subscribeObjects');

            const client = await manager.getConnection(serverId, config);
            this.objectCallbacks.set(nodeId, callback);

            if (!this.objectSubscriptions.has(objectIdOrPattern)) {
                this.objectSubscriptions.set(objectIdOrPattern, new Set());
            }
            this.objectSubscriptions.get(objectIdOrPattern).add(nodeId);

            if (client.isClientReady()) {
                await manager.operationManager.subscribeObjects(serverId, objectIdOrPattern, (id, objectData, operation) => this.handleObjectChange(id, objectData, operation));

                if (callback.onSubscribed) {
                    callback.onSubscribed();
                }

                if (callback.updateStatus) {
                    callback.updateStatus('ready');
                }
                this.log.info(`Node ${nodeId} successfully subscribed to objects on ${serverId}`);
                this.log.debug(`Object subscription details: ${objectIdOrPattern.includes('*') ? 'wildcard pattern' : 'single object'}: ${objectIdOrPattern}`);
            }

        } catch (error) {
            this.log.error(`Object subscribe failed for node ${nodeId}: ${error.message}`);

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

            if (!isRecovery && !error.message.includes('auth_failed') && !error.message.includes('Authentication failed')) {
                const recoveryCallback = () => {
                    this.log.debug(`Attempting recovery object subscription for node ${nodeId} to ${objectIdOrPattern}`);
                    this.subscribeObjects(nodeId, serverId, objectIdOrPattern, callback, config, true, manager)
                        .catch(retryError => {
                            this.log.error(`Recovery object subscription failed for node ${nodeId}: ${retryError.message}`);
                        });
                };

                this.registerRecoveryCallback(serverId, recoveryCallback);
            }
            throw error;
        }
    }

    async requestInitialValue(nodeId, serverId, stateId, callback, client) {
        try {
            this.log.debug(`Requesting initial value for node ${nodeId} state ${stateId}`);

            const state = await client.getState(stateId);
            if (state && state.val !== undefined) {
                this.log.debug(`Initial value received for node ${nodeId}: ${stateId} = ${state.val}`);

                if (callback.onInitialValue) {
                    callback.onInitialValue(stateId, state);
                } else {
                    callback(stateId, state);
                }
            } else {
                this.log.debug(`No initial value available for node ${nodeId} state ${stateId}`);
            }
        } catch (error) {
            this.log.error(`Initial value request failed for node ${nodeId} state ${stateId}: ${error.message}`);
        }
    }

    async registerForEvents(nodeId, serverId, callback, config, isRecovery = false, manager) {
        try {
            this.registerNode(nodeId, serverId, 'events');
            this.eventNodes.set(nodeId, callback);

            const connectionState = manager.connectionManager.getConnectionState(serverId);

            if (connectionState === 'connected') {
                if (callback.updateStatus) {
                    callback.updateStatus('ready');
                }

                this.log.info(`Node ${nodeId} successfully registered for events on ${serverId}`);
            } else if (connectionState === 'connecting') {
                if (callback.updateStatus) {
                    callback.updateStatus('connecting');
                }
            } else {
                try {
                    await manager.getConnection(serverId, config);
                } catch (error) {
                    this.log.debug(`Event node ${nodeId} registered - will receive updates when connection is ready`);

                    if (callback.updateStatus) {
                        if (error.message.includes('not possible in state: auth_failed')) {
                            callback.updateStatus('failed_permanently');
                        } else {
                            callback.updateStatus('connecting');
                        }
                    }
                }
            }

        } catch (error) {
            this.log.error(`Event registration failed for node ${nodeId}: ${error.message}`);

            if (!isRecovery) {
                const recoveryCallback = () => {
                    this.log.debug(`Attempting recovery event registration for node ${nodeId}`);
                    this.registerForEvents(nodeId, serverId, callback, config, true, manager)
                        .catch(retryError => {
                            this.log.error(`Recovery event registration failed for node ${nodeId}: ${retryError.message}`);
                        });
                };

                this.registerRecoveryCallback(serverId, recoveryCallback);
            }
            throw error;
        }
    }

    syncAllNodeStatuses(serverId) {
        const connectionStatus = this.manager.connectionManager.getConnectionStatus(serverId);
        const nodeStatus = this.manager.connectionManager.mapStateToNodeStatus(connectionStatus.status);

        this.log.debug(`Force-syncing all node statuses for ${serverId} to: ${nodeStatus}`);

        let updatedCount = 0;

        this.callbacks.forEach((callback, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                if (callback.updateStatus) {
                    try {
                        callback.updateStatus(nodeStatus);
                        updatedCount++;
                    } catch (err) {
                        this.log.error(`Force sync error for node ${nodeId}: ${err.message}`);
                    }
                }
            }
        });

        this.objectCallbacks.forEach((callback, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                if (callback.updateStatus) {
                    try {
                        callback.updateStatus(nodeStatus);
                        updatedCount++;
                    } catch (err) {
                        this.log.error(`Force sync error for object node ${nodeId}: ${err.message}`);
                    }
                }
            }
        });

        this.eventNodes.forEach((callback, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                if (callback.updateStatus) {
                    try {
                        callback.updateStatus(nodeStatus);
                        updatedCount++;
                    } catch (err) {
                        this.log.error(`Force sync error for event node ${nodeId}: ${err.message}`);
                    }
                }
            }
        });

        this.log.debug(`Force-synced ${updatedCount} nodes for ${serverId}`);
        return updatedCount;
    }

    async unsubscribe(nodeId, serverId, stateIdOrPattern, manager) {
        try {
            const nodeIds = this.subscriptions.get(stateIdOrPattern);
            if (!nodeIds) return;

            nodeIds.delete(nodeId);

            if (nodeIds.size === 0) {
                this.subscriptions.delete(stateIdOrPattern);

                const client = manager.connectionManager.connections.get(serverId);
                if (client && client.connected) {
                    client.emit('unsubscribe', stateIdOrPattern, () => { });
                    this.log.debug(`Unsubscribed from WebSocket pattern: ${stateIdOrPattern}`);
                }
            }

            this.callbacks.delete(nodeId);
            this.unregisterNode(nodeId);

            this.log.debug(`Unsubscribed node ${nodeId} from ${stateIdOrPattern}`);

        } catch (error) {
            this.log.error(`Unsubscribe error for node ${nodeId}: ${error.message}`);
        }
    }

    async unsubscribeMultiple(nodeId, serverId, stateIds, manager) {
        try {
            const multipleStateInfo = this.multipleStateSubscriptions.get(nodeId);
            if (!multipleStateInfo) {
                this.log.debug(`No multiple state subscription found for node ${nodeId}`);
                return;
            }

            const subscribedStates = Array.from(multipleStateInfo.subscribedStates);

            for (const stateId of subscribedStates) {
                try {
                    const client = manager.connectionManager.connections.get(serverId);
                    if (client && client.connected) {
                        client.emit('unsubscribe', stateId, () => { });
                        this.log.debug(`Unsubscribed from WebSocket state: ${stateId}`);
                    }
                } catch (error) {
                    this.log.error(`Error unsubscribing from state ${stateId}: ${error.message}`);
                }
            }

            this.multipleStateSubscriptions.delete(nodeId);
            this.callbacks.delete(nodeId);
            this.unregisterNode(nodeId);

            this.log.debug(`Unsubscribed node ${nodeId} from ${subscribedStates.length} multiple states`);

        } catch (error) {
            this.log.error(`Multiple unsubscribe error for node ${nodeId}: ${error.message}`);
        }
    }

    async unsubscribeObjects(nodeId, serverId, objectIdOrPattern, manager) {
        try {
            const nodeIds = this.objectSubscriptions.get(objectIdOrPattern);
            if (!nodeIds) return;

            nodeIds.delete(nodeId);

            if (nodeIds.size === 0) {
                this.objectSubscriptions.delete(objectIdOrPattern);

                const client = manager.connectionManager.connections.get(serverId);
                if (client && client.connected) {
                    client.emit('unsubscribeObjects', objectIdOrPattern, () => { });
                    this.log.debug(`Unsubscribed from WebSocket object pattern: ${objectIdOrPattern}`);
                }
            }

            this.objectCallbacks.delete(nodeId);
            this.unregisterNode(nodeId);

            this.log.debug(`Unsubscribed node ${nodeId} from object pattern ${objectIdOrPattern}`);

        } catch (error) {
            this.log.error(`Object unsubscribe error for node ${nodeId}: ${error.message}`);
        }
    }

    unregisterFromEvents(nodeId) {
        try {
            this.eventNodes.delete(nodeId);
            const serverId = this.unregisterNode(nodeId);
            return serverId;
        } catch (error) {
            this.log.error(`Unregister events error for node ${nodeId}: ${error.message}`);
            return null;
        }
    }

    async subscribeToLogs(nodeId, serverId, callback, config, logLevel = 'info', isRecovery = false, manager) {
        try {
            this.registerNode(nodeId, serverId, 'subscribeToLogs');

            const client = await manager.getConnection(serverId, config);
            this.callbacks.set(nodeId, callback);

            if (client.isClientReady()) {
                await manager.operationManager.subscribeToLogs(serverId, logLevel, (logData) => this.handleLogMessage(logData));

                if (callback.onSubscribed) {
                    callback.onSubscribed();
                }

                if (callback.updateStatus) {
                    callback.updateStatus('ready');
                }

                this.log.info(`Node ${nodeId} successfully subscribed to live logs on ${serverId} (level: ${logLevel})`);
            }

        } catch (error) {
            this.log.error(`Log subscribe failed for node ${nodeId}: ${error.message}`);

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

            if (!isRecovery && !error.message.includes('auth_failed') && !error.message.includes('Authentication failed')) {
                const recoveryCallback = () => {
                    this.log.debug(`Attempting recovery log subscription for node ${nodeId}`);
                    this.subscribeToLogs(nodeId, serverId, callback, config, logLevel, true, manager)
                        .catch(retryError => {
                            this.log.error(`Recovery log subscription failed for node ${nodeId}: ${retryError.message}`);
                        });
                };

                this.registerRecoveryCallback(serverId, recoveryCallback);
            }
            throw error;
        }
    }

    async unsubscribeFromLogs(nodeId, serverId, manager) {
        try {
            if (manager && (manager.destroyed || manager.connectionManager.destroyed)) {
                this.log.debug(`Skipping log unsubscribe for node ${nodeId} - manager is being destroyed`);
                this.callbacks.delete(nodeId);
                this.unregisterNode(nodeId);
                return;
            }

            const remainingLogNodes = this.getRemainingLogNodesForServer(serverId);

            if (remainingLogNodes <= 1) {
                const client = manager.connectionManager.connections.get(serverId);
                if (client && client.connected && !client.destroyed) {
                    try {
                        await manager.operationManager.unsubscribeFromLogs(serverId);
                        this.log.debug(`Unsubscribed from WebSocket logs for ${serverId}`);
                    } catch (error) {
                        if (error.message && error.message.includes('timeout')) {
                            this.log.debug(`Log unsubscribe timeout during shutdown for ${serverId}, ignoring.`);
                        } else {
                            this.log.error(`Log unsubscribe error: ${error.message}`);
                        }
                    }
                } else {
                    this.log.debug(`Skipping log unsubscribe for ${serverId} - client not available or destroyed`);
                }
            }

            this.callbacks.delete(nodeId);
            this.unregisterNode(nodeId);

            this.log.debug(`Unsubscribed node ${nodeId} from live logs`);

        } catch (error) {
            this.log.error(`Log unsubscribe error for node ${nodeId}: ${error.message}`);
        }
    }

    handleLogMessage(logData) {
        this.callbacks.forEach((callback, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.type === 'subscribeToLogs') {
                try {
                    callback(logData);
                } catch (err) {
                    this.log.error(`Log callback error for ${nodeId}: ${err.message}`);
                }
            }
        });
    }

    getRemainingLogNodesForServer(serverId) {
        let count = 0;
        this.nodeRegistrations.forEach((registration) => {
            if (registration.serverId === serverId && registration.type === 'subscribeToLogs') {
                count++;
            }
        });
        return count;
    }

    async resubscribeObjects(serverId, client) {
        const objectsToSubscribe = new Set();
        const nodeCallbacks = new Map();

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
            this.log.info(`Resubscribing to ${objectsToSubscribe.size} object patterns for ${serverId}`);

            for (const pattern of objectsToSubscribe) {
                try {
                    await this.manager.operationManager.subscribeObjects(serverId, pattern, (id, objectData, operation) => this.handleObjectChange(id, objectData, operation));

                    const callbackInfos = nodeCallbacks.get(pattern);
                    if (callbackInfos) {
                        callbackInfos.forEach(info => {
                            if (info.callback.onSubscribed) {
                                info.callback.onSubscribed();
                            }
                        });
                    }

                    this.log.debug(`Resubscribed to object pattern: ${pattern}`);

                    await new Promise(r => setTimeout(r, 50));
                } catch (error) {
                    this.log.error(`Resubscribe failed for object pattern ${pattern}: ${error.message}`);
                }
            }
        }
    }

    async resubscribeLogs(serverId, client) {
        const logNodesToResubscribe = new Map();

        this.nodeRegistrations.forEach((registration, nodeId) => {
            if (registration.serverId === serverId && registration.type === 'subscribeToLogs') {
                const callback = this.callbacks.get(nodeId);
                if (callback) {
                    logNodesToResubscribe.set(nodeId, callback);
                }
            }
        });

        if (logNodesToResubscribe.size > 0) {
            this.log.info(`Resubscribing to logs for ${logNodesToResubscribe.size} nodes on ${serverId}`);

            try {
                await this.manager.operationManager.subscribeToLogs(serverId, 'info', (logData) => this.handleLogMessage(logData));

                logNodesToResubscribe.forEach((callback, nodeId) => {
                    if (callback.onSubscribed) {
                        callback.onSubscribed();
                    }
                });

                this.log.debug(`Resubscribed to logs successfully`);

            } catch (error) {
                this.log.error(`Resubscribe to logs failed: ${error.message}`);
            }
        }
    }

    cleanup() {
        this.log.info('Cleaning up node registry');

        this.subscriptions.clear();
        this.objectSubscriptions.clear();
        this.callbacks.clear();
        this.objectCallbacks.clear();
        this.eventNodes.clear();
        this.nodeRegistrations.clear();
        this.recoveryCallbacks.clear();
        this.pendingInitialValues.clear();
        this.multipleStateSubscriptions.clear();

        this.log.info('Node registry cleanup completed');
    }

    destroy() {
        this.destroyed = true;

        this.cleanup();
        this.clearAllTimers();
        this.removeAllEventListeners();
        this.nullifyReferences();
    }

    clearAllTimers() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    removeAllEventListeners() {
        this.callbacks.forEach((callback, nodeId) => {
            if (callback && typeof callback === 'function') {
                Object.keys(callback).forEach(key => {
                    if (typeof callback[key] === 'function') {
                        callback[key] = null;
                    }
                });
            }
        });

        this.objectCallbacks.forEach((callback, nodeId) => {
            if (callback && typeof callback === 'function') {
                Object.keys(callback).forEach(key => {
                    if (typeof callback[key] === 'function') {
                        callback[key] = null;
                    }
                });
            }
        });
    }

    nullifyReferences() {
        this.manager = null;
        this.subscriptions = null;
        this.objectSubscriptions = null;
        this.callbacks = null;
        this.objectCallbacks = null;
        this.eventNodes = null;
        this.nodeRegistrations = null;
        this.recoveryCallbacks = null;
        this.pendingInitialValues = null;
        this.multipleStateSubscriptions = null;
    }
}

module.exports = NodeRegistry;