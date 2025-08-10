/*!
 * Node Registry for WebSocket Manager
 * Delayed subscription with intelligent pattern consolidation
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
    // Track actually active WS subscriptions to avoid duplicate subscribe emits
    this.activeWsSubscriptions = new Map(); // serverId -> Set(pattern)
        
        // Delayed subscription system
        this.subscriptionQueue = new Map(); // serverId -> Array of subscription requests
        this.consolidationTimers = new Map(); // serverId -> timeout handle
        this.CONSOLIDATION_DELAY = 100; // ms - wait for more subscriptions
        
        // Pattern consolidation tracking
        this.consolidatedPatterns = new Map(); // serverId -> Set of actually subscribed patterns
        this.patternMapping = new Map(); // serverId -> Map(requestedPattern -> actualSubscribedPattern)
        
        this.log = new Logger('NodeRegistry');
    }

    // Reset per-server subscription tracking so a fresh connection rebuilds WS subscriptions
    resetServerSubscriptions(serverId) {
        const active = this.activeWsSubscriptions.get(serverId);
        if (active) active.clear();
        this.consolidatedPatterns.delete(serverId);
        this.patternMapping.delete(serverId);
        this.log.debug(`Reset subscription tracking for ${serverId} (active, consolidated, mapping cleared)`);
    }

    // Ensure a Set exists for tracking active WebSocket subscriptions per server
    getActiveSet(serverId) {
        if (!this.activeWsSubscriptions.has(serverId)) {
            this.activeWsSubscriptions.set(serverId, new Set());
        }
        return this.activeWsSubscriptions.get(serverId);
    }

    // Check if a pattern is covered by any existing pattern
    isPatternCovered(newPattern, existingPatterns) {
        for (const existingPattern of existingPatterns) {
            if (this.patternCovers(existingPattern, newPattern)) {
                this.log.debug(`Pattern ${newPattern} is covered by existing pattern ${existingPattern}`);
                return { covered: true, coveringPattern: existingPattern };
            }
        }
        return { covered: false };
    }

    // Check if pattern A covers pattern B
    patternCovers(patternA, patternB) {
        // Exact match
        if (patternA === patternB) {
            return true;
        }

        // If patternA doesn't contain wildcards, it can't cover anything else
        if (!patternA.includes('*')) {
            return false;
        }

        // If patternB doesn't contain wildcards, check if it matches patternA
        if (!patternB.includes('*')) {
            return PatternMatcher.matches(patternB, patternA);
        }

        // Heuristic for wildcard-vs-wildcard coverage:
        // treat trailing-/prefix-based wildcards as prefixes and compare.
        const prefixA = patternA.split('*')[0];
        const prefixB = patternB.split('*')[0];
        if (prefixB.startsWith(prefixA)) {
            return true;
        }

        // Fallback to non-coverage for complex cases
        return false;
    }

    // Consolidate patterns to minimize WebSocket subscriptions
    consolidatePatterns(serverId, newPatterns) {
        if (!this.consolidatedPatterns.has(serverId)) {
            this.consolidatedPatterns.set(serverId, new Set());
            this.patternMapping.set(serverId, new Map());
        }

        const consolidatedPatterns = this.consolidatedPatterns.get(serverId);
        const patternMapping = this.patternMapping.get(serverId);
        
        const patternsToSubscribe = new Set(consolidatedPatterns);
        const newMappings = new Map();

        this.log.info(`Consolidating ${newPatterns.length} patterns for ${serverId}`);
        this.log.debug(`New patterns: ${newPatterns.join(', ')}`);
        this.log.debug(`Existing consolidated patterns: ${Array.from(consolidatedPatterns).join(', ')}`);

        for (const newPattern of newPatterns) {
            // Check if this pattern is covered by existing patterns
            const coverageCheck = this.isPatternCovered(newPattern, patternsToSubscribe);
            
            if (coverageCheck.covered) {
                // Pattern is covered, map it to the covering pattern
                newMappings.set(newPattern, coverageCheck.coveringPattern);
                this.log.info(`Pattern ${newPattern} covered by ${coverageCheck.coveringPattern}, no WebSocket subscription needed`);
            } else {
                // Pattern needs its own subscription
                patternsToSubscribe.add(newPattern);
                newMappings.set(newPattern, newPattern);
                
                // Check if this new pattern makes any existing patterns redundant
                const redundantPatterns = [];
                for (const existingPattern of patternsToSubscribe) {
                    if (existingPattern !== newPattern && this.patternCovers(newPattern, existingPattern)) {
                        redundantPatterns.push(existingPattern);
                    }
                }
                
                // Remove redundant patterns and update mappings
                for (const redundantPattern of redundantPatterns) {
                    patternsToSubscribe.delete(redundantPattern);
                    
                    // Update all mappings that pointed to the redundant pattern
                    for (const [mappedPattern, targetPattern] of newMappings) {
                        if (targetPattern === redundantPattern) {
                            newMappings.set(mappedPattern, newPattern);
                        }
                    }
                    for (const [mappedPattern, targetPattern] of patternMapping) {
                        if (targetPattern === redundantPattern) {
                            patternMapping.set(mappedPattern, newPattern);
                        }
                    }
                    
                    this.log.info(`Pattern ${newPattern} makes ${redundantPattern} redundant`);
                }
                
                this.log.info(`Pattern ${newPattern} needs WebSocket subscription`);
            }
        }

        // Update mappings
        for (const [pattern, target] of newMappings) {
            patternMapping.set(pattern, target);
        }

        // Update consolidated patterns
        this.consolidatedPatterns.set(serverId, patternsToSubscribe);

        const result = {
            patternsToSubscribe: Array.from(patternsToSubscribe),
            patternMapping: new Map(patternMapping)
        };

        this.log.info(`Pattern consolidation result for ${serverId}:`);
        this.log.info(`- Patterns to subscribe: ${result.patternsToSubscribe.join(', ')}`);
        this.log.debug(`- Pattern mappings: ${Array.from(result.patternMapping.entries()).map(([k,v]) => `${k}->${v}`).join(', ')}`);

        return result;
    }

    // Queue a subscription request for delayed processing
    queueSubscription(serverId, request) {
        if (!this.subscriptionQueue.has(serverId)) {
            this.subscriptionQueue.set(serverId, []);
        }
        this.subscriptionQueue.get(serverId).push(request);
        
        this.log.debug(`Queued subscription for ${serverId}: ${request.pattern} (${request.type})`);
    }

    // Schedule or reschedule consolidation for a server
    scheduleConsolidation(serverId, manager) {
        // Clear existing timer
        if (this.consolidationTimers.has(serverId)) {
            clearTimeout(this.consolidationTimers.get(serverId));
        }

        // Schedule new consolidation
        const timer = setTimeout(() => {
            this.executeConsolidatedSubscription(serverId, manager)
                .catch(error => {
                    this.log.error(`Consolidated subscription failed for ${serverId}: ${error.message}`);
                });
        }, this.CONSOLIDATION_DELAY);
        
        this.consolidationTimers.set(serverId, timer);
        this.log.debug(`Scheduled consolidation for ${serverId} in ${this.CONSOLIDATION_DELAY}ms`);
    }

    // Execute consolidated subscription after delay
    async executeConsolidatedSubscription(serverId, manager) {
        const queue = this.subscriptionQueue.get(serverId);
        if (!queue || queue.length === 0) {
            this.log.debug(`No queued subscriptions for ${serverId}`);
            return;
        }

        this.log.info(`Executing consolidated subscription for ${serverId} with ${queue.length} queued requests`);

        try {
            // Extract all patterns from queue
            const allPatterns = queue.map(req => req.pattern);
            
            // Consolidate patterns
            const consolidationResult = this.consolidatePatterns(serverId, allPatterns);
            
            // Subscribe to consolidated patterns only, skipping ones already active
            const active = this.getActiveSet(serverId);
            const desired = new Set(consolidationResult.patternsToSubscribe);

            // Unsubscribe patterns that are no longer needed
            for (const patt of Array.from(active)) {
                if (!desired.has(patt)) {
                    const ready = manager.connectionManager.isConnectionReady(serverId);
                    if (ready) {
                        try {
                            await manager.operationManager.unsubscribe(serverId, patt);
                            this.log.debug(`Unsubscribed obsolete consolidated pattern: ${patt}`);
                        } catch (e) {
                            const msg = e && e.message ? e.message : String(e);
                            if (/timeout|manager destroyed|client not available/i.test(msg)) {
                                this.log.debug(`Unsubscribe obsolete pattern skipped: ${patt} (${msg})`);
                            } else {
                                this.log.error(`Failed to unsubscribe obsolete pattern ${patt}: ${msg}`);
                            }
                        }
                    } else {
                        this.log.debug(`Skipping WS unsubscribe for obsolete pattern (not ready): ${patt}`);
                    }
                    // Update bookkeeping regardless
                    active.delete(patt);
                    const consolidated = this.consolidatedPatterns.get(serverId) || new Set();
                    consolidated.delete(patt);
                    this.consolidatedPatterns.set(serverId, consolidated);
                }
            }

            // Ensure subscriptions for desired consolidated patterns
            for (const pattern of consolidationResult.patternsToSubscribe) {
                try {
                    if (active.has(pattern)) {
                        this.log.debug(`Consolidated pattern already active, skipping subscribe: ${pattern}`);
                        continue;
                    }
                    await manager.operationManager.subscribe(serverId, pattern,
                        (id, state) => this.handleStateChange(id, state));
                    active.add(pattern);
                    this.log.debug(`Successfully subscribed to consolidated pattern: ${pattern}`);
                } catch (error) {
                    this.log.error(`Failed to subscribe to pattern ${pattern}: ${error.message}`);
                }
            }

            // Process all queued nodes
            this.processQueuedNodes(serverId, queue, consolidationResult);
            
        } catch (error) {
            this.log.error(`Consolidated subscription execution failed for ${serverId}: ${error.message}`);
            
            // On error, try individual subscriptions as fallback
            this.fallbackToIndividualSubscriptions(serverId, queue, manager);
        } finally {
            // Clean up
            this.subscriptionQueue.delete(serverId);
            this.consolidationTimers.delete(serverId);
        }
    }

    // Process all queued nodes after successful consolidation
    processQueuedNodes(serverId, queue, consolidationResult) {
        for (const request of queue) {
            try {
                // Register node and callback
                this.registerNode(request.nodeId, serverId, request.type);
                this.callbacks.set(request.nodeId, request.callback);

                // Add to appropriate subscription tracking
                if (request.type === 'single') {
                    if (!this.subscriptions.has(request.pattern)) {
                        this.subscriptions.set(request.pattern, new Set());
                    }
                    this.subscriptions.get(request.pattern).add(request.nodeId);
                } else if (request.type === 'multiple') {
                    // Group by node for multiple states
                    let multipleInfo = this.multipleStateSubscriptions.get(request.nodeId);
                    if (!multipleInfo) {
                        multipleInfo = {
                            subscribedStates: new Set(),
                            originalStates: [],
                            serverId: serverId
                        };
                        this.multipleStateSubscriptions.set(request.nodeId, multipleInfo);
                    }
                    multipleInfo.subscribedStates.add(request.pattern);
                    multipleInfo.originalStates.push(request.pattern);
                }

                // Update node status and call callbacks
                if (request.callback.updateStatus) {
                    request.callback.updateStatus('ready');
                }
                if (request.callback.onSubscribed) {
                    request.callback.onSubscribed();
                }

                this.log.debug(`Processed queued node ${request.nodeId} for pattern ${request.pattern}`);

            } catch (error) {
                this.log.error(`Failed to process queued node ${request.nodeId}: ${error.message}`);
            }
        }
    }

    // Fallback to individual subscriptions if consolidation fails
    async fallbackToIndividualSubscriptions(serverId, queue, manager) {
        this.log.warn(`Falling back to individual subscriptions for ${serverId}`);
        
        for (const request of queue) {
            try {
                await manager.operationManager.subscribe(serverId, request.pattern, 
                    (id, state) => this.handleStateChange(id, state));
                
                // Process node normally
                this.registerNode(request.nodeId, serverId, request.type);
                this.callbacks.set(request.nodeId, request.callback);
                
                if (request.callback.updateStatus) {
                    request.callback.updateStatus('ready');
                }
                if (request.callback.onSubscribed) {
                    request.callback.onSubscribed();
                }
                
            } catch (error) {
                this.log.error(`Fallback subscription failed for ${request.nodeId}: ${error.message}`);
            }
        }
    }

    async subscribeMultiple(nodeId, serverId, stateIds, callback, config, isRecovery = false, manager) {
        try {
            const client = await manager.getConnection(serverId, config);
            
            const connectionStatus = manager.connectionManager.getConnectionStatus(serverId);
            const isClientReady = client && client.isClientReady && client.isClientReady();

            this.log.debug(`Node ${nodeId} multiple subscription - Connection ready: ${connectionStatus.ready}, Client ready: ${isClientReady}`);

            if (connectionStatus.ready && isClientReady) {
                // Queue each state for consolidation instead of immediate subscription
                stateIds.forEach(stateId => {
                    this.queueSubscription(serverId, {
                        nodeId: nodeId,
                        pattern: stateId,
                        callback: callback,
                        type: 'multiple'
                    });
                });

                // Schedule consolidation
                this.scheduleConsolidation(serverId, manager);

                this.log.info(`Node ${nodeId} queued for multiple state subscription to ${serverId} (${stateIds.length} states - will be consolidated)`);

                // Load initial values if needed
                if (callback.wantsInitialValue && stateIds.length > 0) {
                    this.loadInitialValuesParallel(nodeId, serverId, stateIds, callback, client);
                }
            } else {
                // Connection not ready - register for later processing
                this.multipleStateSubscriptions.set(nodeId, {
                    subscribedStates: new Set(stateIds),
                    originalStates: stateIds,
                    serverId: serverId
                });

                this.registerNode(nodeId, serverId, 'subscribeMultiple');
                this.callbacks.set(nodeId, callback);

                if (callback.updateStatus) {
                    callback.updateStatus('connecting');
                    this.log.debug(`Node ${nodeId} set to connecting status - will get ready update later`);
                }

                if (callback.wantsInitialValue) {
                    this.registerPendingInitialValues(serverId, nodeId, stateIds);
                }
            }

            return stateIds; // Return all as "successful"

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

    async subscribe(nodeId, serverId, stateIdOrPattern, callback, config, isRecovery = false, manager) {
        try {
            const client = await manager.getConnection(serverId, config);
            
            const connectionStatus = manager.connectionManager.getConnectionStatus(serverId);
            const isClientReady = client && client.isClientReady && client.isClientReady();

            this.log.debug(`Node ${nodeId} registration - Connection ready: ${connectionStatus.ready}, Client ready: ${isClientReady}`);

            if (connectionStatus.ready && isClientReady) {
                // Queue for consolidation instead of immediate subscription
                this.queueSubscription(serverId, {
                    nodeId: nodeId,
                    pattern: stateIdOrPattern,
                    callback: callback,
                    type: 'single'
                });

                // Schedule consolidation
                this.scheduleConsolidation(serverId, manager);

                this.log.info(`Node ${nodeId} queued for subscription to ${serverId} (pattern: ${stateIdOrPattern})`);

                // Load initial value if needed
                if (callback.wantsInitialValue && !stateIdOrPattern.includes('*')) {
                    await this.requestInitialValue(nodeId, serverId, stateIdOrPattern, callback, client);
                }
            } else {
                // Connection not ready - register normally for later processing
                this.registerNode(nodeId, serverId, 'subscribe');
                this.callbacks.set(nodeId, callback);

                if (!this.subscriptions.has(stateIdOrPattern)) {
                    this.subscriptions.set(stateIdOrPattern, new Set());
                }
                this.subscriptions.get(stateIdOrPattern).add(nodeId);

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
        // Collect all patterns that need to be subscribed
        const allPatterns = new Set();
        const nodeCallbacks = new Map();

        // Collect single patterns
        this.subscriptions.forEach((nodeIds, pattern) => {
            nodeIds.forEach(nodeId => {
                const registration = this.nodeRegistrations.get(nodeId);
                if (registration && registration.serverId === serverId) {
                    allPatterns.add(pattern);

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

        // Collect multiple state patterns
        this.multipleStateSubscriptions.forEach((stateInfo, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                stateInfo.originalStates.forEach(stateId => {
                    allPatterns.add(stateId);
                    
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
                });
            }
        });

        if (allPatterns.size > 0) {
            // Consolidate ALL patterns (single + multiple) together
            const consolidationResult = this.consolidatePatterns(serverId, Array.from(allPatterns));
            
            this.log.info(`Resubscribing with ${consolidationResult.patternsToSubscribe.length} consolidated patterns (from ${allPatterns.size} requested patterns) for ${serverId}`);

            // Subscribe only to consolidated patterns
            const subscribePromises = consolidationResult.patternsToSubscribe.map(pattern => 
                this.resubscribePatternWithRetry(pattern, serverId, nodeCallbacks)
            );

            await Promise.allSettled(subscribePromises);

            // Update multiple state subscriptions with actual subscribed patterns
            this.multipleStateSubscriptions.forEach((stateInfo, nodeId) => {
                const registration = this.nodeRegistrations.get(nodeId);
                if (registration && registration.serverId === serverId) {
                    const actuallySubscribed = new Set();
                    stateInfo.originalStates.forEach(stateId => {
                        const mapping = consolidationResult.patternMapping.get(stateId);
                        if (mapping && consolidationResult.patternsToSubscribe.includes(mapping)) {
                            actuallySubscribed.add(stateId);
                        }
                    });
                    stateInfo.subscribedStates = actuallySubscribed;
                    
                    this.log.debug(`Updated multiple state node ${nodeId}: ${actuallySubscribed.size}/${stateInfo.originalStates.length} states covered by consolidated patterns`);
                }
            });
        }

        await this.processPendingInitialValues(serverId, client);
    }

    async resubscribePatternWithRetry(pattern, serverId, nodeCallbacks) {
        try {
            // Avoid duplicate resubscribe if already active
            const active = this.getActiveSet(serverId);
            if (!active.has(pattern)) {
                await this.manager.operationManager.subscribe(serverId, pattern, (id, state) => this.handleStateChange(id, state));
                // After successful resubscribe, mark as active
                active.add(pattern);
            } else {
                this.log.debug(`Resubscribe skipped, pattern already active: ${pattern}`);
            }

            // Notify callbacks for all patterns that map to this consolidated pattern
            const patternMapping = this.patternMapping.get(serverId);
            if (patternMapping) {
                for (const [requestedPattern, consolidatedPattern] of patternMapping) {
                    if (consolidatedPattern === pattern) {
                        const callbackInfos = nodeCallbacks.get(requestedPattern);
                        if (callbackInfos) {
                            callbackInfos.forEach(info => {
                                if (info.callback.onSubscribed) {
                                    info.callback.onSubscribed();
                                }
                            });
                        }
                    }
                }
            }

            this.log.debug(`Resubscribed to consolidated pattern: ${pattern}`);
        } catch (error) {
            this.log.error(`Resubscribe failed for consolidated pattern ${pattern}: ${error.message}`);
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
        const registration = (this.nodeRegistrations && this.nodeRegistrations.get)
            ? this.nodeRegistrations.get(nodeId)
            : null;
        if (registration) {
            if (this.nodeRegistrations && this.nodeRegistrations.delete) {
                this.nodeRegistrations.delete(nodeId);
            }

            const pendingForServer = (this.pendingInitialValues && this.pendingInitialValues.get)
                ? this.pendingInitialValues.get(registration.serverId)
                : null;
            if (pendingForServer) {
                pendingForServer.delete(nodeId);
                if (pendingForServer.size === 0 && this.pendingInitialValues && this.pendingInitialValues.delete) {
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

    // Helper to get mapping container per server (defensive during shutdown)
    getPatternMapping(serverId) {
        if (!this.patternMapping || typeof this.patternMapping.has !== 'function') {
            return new Map();
        }
        if (!this.patternMapping.has(serverId)) {
            this.patternMapping.set(serverId, new Map());
        }
        return this.patternMapping.get(serverId);
    }

    // Count how many requested patterns still map to a consolidated target
    countRequestsForConsolidated(serverId, consolidatedTarget) {
        const mapping = this.getPatternMapping(serverId);
        let count = 0;
        mapping.forEach((target) => {
            if (target === consolidatedTarget) count++;
        });
        return count;
    }

    async unsubscribe(nodeId, serverId, stateIdOrPattern, manager) {
        try {
            const nodeIds = this.subscriptions.get(stateIdOrPattern);
            if (!nodeIds) return;

            nodeIds.delete(nodeId);

            if (nodeIds.size === 0) {
                this.subscriptions.delete(stateIdOrPattern);

                // Determine consolidated target for this request
                const mapping = this.getPatternMapping(serverId);
                const consolidatedTarget = mapping.get(stateIdOrPattern) || stateIdOrPattern;

                // Remove mapping for this requested pattern
                mapping.delete(stateIdOrPattern);

                // If no other requested patterns map to this consolidated target, drop WS subscription
                const remaining = this.countRequestsForConsolidated(serverId, consolidatedTarget);
                if (remaining === 0) {
                    const ready = manager.connectionManager.isConnectionReady(serverId);
                    if (ready) {
                        try {
                            await manager.operationManager.unsubscribe(serverId, consolidatedTarget);
                            this.log.debug(`Unsubscribed from WebSocket consolidated pattern: ${consolidatedTarget}`);
                        } catch (e) {
                            const msg = e && e.message ? e.message : String(e);
                            if (/timeout|manager destroyed|client not available/i.test(msg)) {
                                this.log.debug(`Unsubscribe consolidated skipped: ${consolidatedTarget} (${msg})`);
                            } else {
                                this.log.error(`Unsubscribe error for consolidated ${consolidatedTarget}: ${msg}`);
                            }
                        }
                    } else {
                        this.log.debug(`Skipping WS unsubscribe for consolidated pattern (not ready): ${consolidatedTarget}`);
                    }
                    const active = this.getActiveSet(serverId);
                    active.delete(consolidatedTarget);
                    const consolidated = this.consolidatedPatterns.get(serverId) || new Set();
                    consolidated.delete(consolidatedTarget);
                    this.consolidatedPatterns.set(serverId, consolidated);
                } else {
                    this.log.debug(`Keeping consolidated subscription ${consolidatedTarget} (still referenced ${remaining} time(s))`);
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

            // Resolve consolidated targets and update mappings
            const mapping = this.getPatternMapping(serverId);
            if (!mapping || typeof mapping.get !== 'function') {
                // mapping container unavailable; proceed with defaults
            }
            const targetsToCheck = new Map(); // consolidatedTarget -> count to decrement

            for (const stateId of subscribedStates) {
                let consolidatedTarget = stateId;
                try {
                    if (mapping && typeof mapping.get === 'function') {
                        consolidatedTarget = mapping.get(stateId) || stateId;
                    }
                } catch (e) {
                    // ignore
                }
                // Remove the mapping for this requested state
                try {
                    if (mapping && typeof mapping.delete === 'function') {
                        mapping.delete(stateId);
                    }
                } catch (e) {
                    // ignore
                }
                targetsToCheck.set(consolidatedTarget, (targetsToCheck.get(consolidatedTarget) || 0) + 1);
            }

            // For each consolidated target, unsubscribe only if no other requests remain
            for (const [target] of targetsToCheck) {
                const remaining = this.countRequestsForConsolidated(serverId, target);
                if (remaining === 0) {
                    const ready = manager.connectionManager.isConnectionReady(serverId);
                    if (ready) {
                        try {
                            await manager.operationManager.unsubscribe(serverId, target);
                            this.log.debug(`Unsubscribed from WebSocket consolidated pattern: ${target}`);
                        } catch (e) {
                            const msg = e && e.message ? e.message : String(e);
                            if (/timeout|manager destroyed|client not available/i.test(msg)) {
                                this.log.debug(`Unsubscribe consolidated skipped: ${target} (${msg})`);
                            } else {
                                this.log.error(`Error unsubscribing consolidated ${target}: ${msg}`);
                            }
                        }
                    } else {
                        this.log.debug(`Skipping WS unsubscribe for consolidated pattern (not ready): ${target}`);
                    }
                    // Guard local bookkeeping during shutdown/nullified maps
                    try {
                        if (this.activeWsSubscriptions) {
                            const active = this.getActiveSet(serverId);
                            active.delete(target);
                        }
                        if (this.consolidatedPatterns && this.consolidatedPatterns.get && this.consolidatedPatterns.set) {
                            const consolidated = this.consolidatedPatterns.get(serverId) || new Set();
                            consolidated.delete(target);
                            this.consolidatedPatterns.set(serverId, consolidated);
                        }
                    } catch (bkErr) {
                        // ignore
                    }
                } else {
                    this.log.debug(`Keeping consolidated subscription ${target} (still referenced ${remaining} time(s))`);
                }
            }

            // Final cleanup for node bookkeeping

            this.multipleStateSubscriptions.delete(nodeId);
            this.callbacks.delete(nodeId);
            try {
                this.unregisterNode(nodeId);
            } catch (e) {
                // ignore
            }

            this.log.debug(`Unsubscribed node ${nodeId} from ${subscribedStates.length} multiple states`);

        } catch (error) {
            // Always downgrade to debug to avoid noisy errors during flow stop; retain diagnostics above
            this.log.debug(`Multiple unsubscribe exception for node ${nodeId}: ${error && error.message}`);
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

        // Clear consolidation timers
        this.consolidationTimers.forEach((timer, serverId) => {
            clearTimeout(timer);
        });

        this.subscriptions.clear();
        this.objectSubscriptions.clear();
        this.callbacks.clear();
        this.objectCallbacks.clear();
        this.eventNodes.clear();
        this.nodeRegistrations.clear();
        this.recoveryCallbacks.clear();
        this.pendingInitialValues.clear();
        this.multipleStateSubscriptions.clear();
        this.consolidatedPatterns.clear();
        this.patternMapping.clear();
        this.subscriptionQueue.clear();
        this.consolidationTimers.clear();
    this.activeWsSubscriptions.clear();

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

        // Clear all consolidation timers
        this.consolidationTimers.forEach((timer, serverId) => {
            clearTimeout(timer);
        });
        this.consolidationTimers.clear();
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
        this.consolidatedPatterns = null;
        this.patternMapping = null;
        this.subscriptionQueue = null;
        this.consolidationTimers = null;
    }
}

module.exports = NodeRegistry;