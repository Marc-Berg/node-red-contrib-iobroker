const eventBus = require('../events/event-bus');
const LoggingService = require('../logging');

class StateService {
    constructor() {
        this.logger = LoggingService.getLogger('StateService');
        this.serverSubscriptions = new Map(); // stateId -> Set of serverIds
        this.activeSubscriptions = new Map(); // serverId -> Set of stateIds (for re-subscription)
        this.messageId = 1; // Simple message ID counter
        this.pendingSubscriptions = new Map(); // Track pending subscribe requests by messageId
        this.logSubscriptions = new Map(); // serverId -> Set of nodeIds (for log subscriptions)
        this.activeLogSubscriptions = new Map(); // serverId -> Set of { nodeId, logLevel } (for re-subscription)
        this.objectSubscriptions = new Map(); // serverId -> Set of nodeIds (for object subscriptions)
        this.activeObjectSubscriptions = new Map(); // serverId -> Set of { nodeId, objectId } (for re-subscription)
        this.multipleDataCoordinator = new Map(); // For coordinating parallel requests
        
        eventBus.on('websocket:message', ({ serverId, data }) => this.handleWebSocketMessage(serverId, data));
        eventBus.on('state:subscribe_request', ({ serverId, stateId }) => this.addSubscription(serverId, stateId));
        eventBus.on('state:get_request', ({ serverId, stateId, nodeId }) => this.getState(serverId, stateId, nodeId));
        eventBus.on('state:set_request', ({ serverId, stateId, value, ack, nodeId }) => this.setState(serverId, stateId, value, ack, nodeId));
        eventBus.on('object:get_request', ({ serverId, objectId, nodeId }) => this.getObject(serverId, objectId, nodeId));
        eventBus.on('enums:get_request', ({ serverId, nodeId }) => this.getEnums(serverId, nodeId));
        eventBus.on('multiple_data:get_request', ({ serverId, nodeId, coordinatorKey, requests }) => {
            // Extract parameters from requests object
            const objectIdOrPattern = requests.objectId;
            const includeEnums = requests.needsEnums || false;
            const includeAliases = requests.needsAliases || false;
            const objectType = requests.objectType || null;
            
            this.getMultipleDataOptimized(serverId, nodeId, objectIdOrPattern, includeEnums, includeAliases, objectType, coordinatorKey);
        });
        eventBus.on('object:set_request', ({ serverId, objectId, objectDef, nodeId }) => this.setObject(serverId, objectId, objectDef, nodeId));
        eventBus.on('object:subscribe_request', ({ serverId, objectId, nodeId }) => this.subscribeToObjects(serverId, objectId, nodeId));
        eventBus.on('object:unsubscribe_request', ({ serverId, objectId, nodeId }) => this.unsubscribeFromObjects(serverId, objectId, nodeId));
        eventBus.on('log:subscribe_request', ({ serverId, logLevel, nodeId }) => this.subscribeToLogs(serverId, logLevel, nodeId));
        eventBus.on('log:unsubscribe_request', ({ serverId, nodeId }) => this.unsubscribeFromLogs(serverId, nodeId));
        eventBus.on('auth:success', ({ serverId }) => this.handleServerReady(serverId));
        
        this.logger.info('StateService constructed and listeners attached.');
    }

    addSubscription(serverId, stateId) {
        // Track active subscriptions per server for re-subscription
        if (!this.activeSubscriptions.has(serverId)) {
            this.activeSubscriptions.set(serverId, new Set());
        }
        
        // Check if we already have this subscription to avoid duplicates
        if (this.activeSubscriptions.get(serverId).has(stateId)) {
            this.logger.debug(`Subscription for "${stateId}" on server ${serverId} already exists, skipping.`);
            return;
        }
        
        this.activeSubscriptions.get(serverId).add(stateId);

        if (!this.serverSubscriptions.has(stateId)) {
            this.serverSubscriptions.set(stateId, new Set());
            this.logger.info(`First subscription for "${stateId}". Sending command to server ${serverId}.`);
            this.sendSubscribeCommand(serverId, stateId);
        }
        this.serverSubscriptions.get(stateId).add(serverId);
    }

    sendSubscribeCommand(serverId, stateId) {
        const msgId = this.messageId++;
        this.pendingSubscriptions.set(msgId, { serverId, stateId, timestamp: Date.now() });
        eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "subscribe", [stateId]] });
    }

    getState(serverId, stateId, nodeId) {
        const msgId = this.messageId++;
        this.logger.info(`Requesting initial value for "${stateId}" from server ${serverId} for node ${nodeId}`);
        
        // Store the request details for the response handler
        this.pendingSubscriptions.set(msgId, { 
            serverId, 
            stateId, 
            nodeId, 
            type: 'getState',
            timestamp: Date.now() 
        });
        
        eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "getState", [stateId]] });
    }

    setState(serverId, stateId, value, ack = true, nodeId) {
        const msgId = this.messageId++;
        this.logger.info(`Setting state "${stateId}" to value: ${value} (ack: ${ack}) from server ${serverId} for node ${nodeId}`);
        
        // Store the request details for the response handler
        this.pendingSubscriptions.set(msgId, { 
            serverId, 
            stateId, 
            nodeId, 
            type: 'setState',
            timestamp: Date.now() 
        });
        
        const state = { 
            val: value, 
            ack: ack, 
            from: 'system.adapter.node-red', 
            ts: Date.now() 
        };
        
        eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "setState", [stateId, state]] });
    }

    getObject(serverId, objectId, nodeId) {
        const msgId = this.messageId++;
        this.logger.info(`Requesting object "${objectId}" from server ${serverId} for node ${nodeId}`);
        
        // Store the request details for the response handler
        this.pendingSubscriptions.set(msgId, { 
            serverId, 
            objectId, 
            nodeId, 
            type: 'getObject',
            timestamp: Date.now() 
        });
        
        // Check if it's a wildcard pattern
        if (objectId.includes('*')) {
            // For wildcard patterns, we need to use getObjectView to get ALL object types
            // Store additional info to handle multiple requests
            this.pendingSubscriptions.set(msgId, { 
                serverId, 
                objectId, 
                nodeId, 
                type: 'getObjectsAllTypes',
                timestamp: Date.now(),
                objectTypes: ['state', 'channel', 'device', 'folder', 'adapter', 'instance', 'host', 'group', 'user', 'config', 'enum'],
                collectedResults: {},
                completedTypes: 0
            });
            
            // Request all object types using getObjectView
            const objectTypes = ['state', 'channel', 'device', 'folder', 'adapter', 'instance', 'host', 'group', 'user', 'config', 'enum'];
            objectTypes.forEach((objectType, index) => {
                const typeRequestId = msgId + index + 1; // Unique ID for each type request
                this.pendingSubscriptions.set(typeRequestId, { 
                    serverId, 
                    objectId, 
                    nodeId, 
                    type: 'getObjectView',
                    objectType: objectType,
                    parentRequestId: msgId,
                    timestamp: Date.now() 
                });
                
                eventBus.emit('websocket:send', { serverId, payload: [3, typeRequestId, "getObjectView", ["system", objectType, {}]] });
            });
            
            // Increment messageId to account for multiple requests
            this.messageId += objectTypes.length;
            
        } else {
            // Use getObject for single objects
            eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "getObject", [objectId]] });
        }
    }

    getEnums(serverId, nodeId) {
        const msgId = this.messageId++;
        this.logger.info(`Requesting enums from server ${serverId} for node ${nodeId}`);
        
        // Store the request details for the response handler
        this.pendingSubscriptions.set(msgId, { 
            serverId, 
            nodeId, 
            type: 'getEnums',
            timestamp: Date.now() 
        });
        
        // Use getObjectView to get all enum objects
        eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "getObjectView", ["system", "enum", {}]] });
    }

    getAliases(serverId, nodeId) {
        const msgId = this.messageId++;
        this.logger.info(`Requesting aliases from server ${serverId} for node ${nodeId}`);
        
        // Store the request details for the response handler
        this.pendingSubscriptions.set(msgId, { 
            serverId, 
            nodeId, 
            type: 'getAliases',
            timestamp: Date.now() 
        });
        
        // Use getObjects to get all alias.* objects directly
        eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "getObjects", ["alias.*"]] });
    }

    // Optimized method for parallel requests (like v0.14.0 loadAllDataOptimized)
    getMultipleDataOptimized(serverId, nodeId, objectIdOrPattern, includeEnums = false, includeAliases = false, objectType = null, coordinatorKey = null) {
        this.logger.info(`Starting optimized multiple data request for node ${nodeId} on server ${serverId}`);
        
        const requests = new Map();
        const startTime = Date.now();
        
        // Use provided coordinator key or create one
        const coordKey = coordinatorKey || `${serverId}:${nodeId}:${startTime}`;

        // Object request
        const objectMsgId = this.messageId++;
        const objectRequest = {
            type: 'objects',
            serverId, 
            nodeId, 
            objectIdOrPattern,
            objectType,
            timestamp: startTime,
            coordinatorKey: coordKey
        };
        requests.set(objectMsgId, objectRequest);
        this.pendingSubscriptions.set(objectMsgId, objectRequest);

        // Send object request
        if (objectIdOrPattern.includes('*')) {
            if (objectType && objectType.trim() !== "") {
                // Wildcard with specific type - use getObjectView
                eventBus.emit('websocket:send', { serverId, payload: [3, objectMsgId, "getObjectView", ["system", objectType, {}]] });
            } else {
                // Wildcard without type - use getObjects to get ALL objects (not just states)
                eventBus.emit('websocket:send', { serverId, payload: [3, objectMsgId, "getObjects", [objectIdOrPattern]] });
            }
        } else {
            // Single object - use getObject
            eventBus.emit('websocket:send', { serverId, payload: [3, objectMsgId, "getObject", [objectIdOrPattern]] });
        }

        // Enum request (parallel)
        let enumMsgId = null;
        if (includeEnums) {
            enumMsgId = this.messageId++;
            const enumRequest = {
                type: 'enums',
                serverId, 
                nodeId, 
                timestamp: startTime,
                coordinatorKey: coordKey
            };
            requests.set(enumMsgId, enumRequest);
            this.pendingSubscriptions.set(enumMsgId, enumRequest);
            eventBus.emit('websocket:send', { serverId, payload: [3, enumMsgId, "getObjectView", ["system", "enum", {}]] });
        }

        // Alias request (parallel)
        let aliasMsgId = null;
        if (includeAliases) {
            aliasMsgId = this.messageId++;
            const aliasRequest = {
                type: 'aliases',
                serverId, 
                nodeId, 
                timestamp: startTime,
                coordinatorKey: coordKey
            };
            requests.set(aliasMsgId, aliasRequest);
            this.pendingSubscriptions.set(aliasMsgId, aliasRequest);
            eventBus.emit('websocket:send', { serverId, payload: [3, aliasMsgId, "getObjects", ["alias.*"]] });
        }

        // Store coordination info for result collection
        this.multipleDataCoordinator.set(coordKey, {
            serverId,
            nodeId,
            expectedResults: requests.size,
            receivedResults: 0,
            results: new Map(),
            objectMsgId,
            enumMsgId,
            aliasMsgId,
            startTime,
            coordinatorKey: coordKey
        });

        this.logger.info(`Sent ${requests.size} parallel requests for optimized data loading: messageIds ${Array.from(requests.keys()).join(', ')}`);
    }

    handleCoordinatedResponse(messageId, command, result, pending) {
        this.pendingSubscriptions.delete(messageId);
        
        const coordinator = this.multipleDataCoordinator.get(pending.coordinatorKey);
        if (!coordinator) {
            this.logger.warn(`Coordinator not found for key: ${pending.coordinatorKey}`);
            return;
        }

        // Process the result based on type
        let processedResult = null;
        let success = true;
        let error = null;

        if (result && result[0] !== null) {
            success = false;
            error = result[0];
            this.logger.error(`Request failed for ${pending.type} on ${pending.serverId}: ${error}`);
        } else {
            this.logger.debug(`Request successful for ${pending.type} on ${pending.serverId}`);
            
            if (pending.type === 'objects') {
                if (command === 'getObjects') {
                    processedResult = result && result[1];
                } else if (command === 'getObjectView') {
                    processedResult = result && result[1];
                } else if (command === 'getObject') {
                    processedResult = result && result[1];
                }
            } else if (pending.type === 'enums') {
                processedResult = result && result[1];
            } else if (pending.type === 'aliases') {
                processedResult = result && result[1];
            }
        }

        // Store the result
        coordinator.results.set(pending.type, {
            success,
            data: processedResult,
            error
        });

        coordinator.receivedResults++;

        // Check if all results are received
        if (coordinator.receivedResults >= coordinator.expectedResults) {
            // All results received, emit combined result
            this.multipleDataCoordinator.delete(pending.coordinatorKey);
            
            const duration = Date.now() - coordinator.startTime;
            this.logger.info(`All parallel requests completed for node ${coordinator.nodeId} in ${duration}ms`);

            const combinedResult = {
                serverId: coordinator.serverId,
                nodeId: coordinator.nodeId,
                coordinatorKey: coordinator.coordinatorKey,
                success: true,
                duration
            };

            // Add individual results
            for (const [type, result] of coordinator.results) {
                if (result.success) {
                    combinedResult[type] = result.data;
                } else {
                    this.logger.warn(`${type} request failed: ${result.error}`);
                    combinedResult[type] = null;
                    combinedResult[`${type}Error`] = result.error;
                }
            }

            eventBus.emit('multiple_data:get_result', combinedResult);
        }
    }

    setObject(serverId, objectId, objectDef, nodeId) {
        const msgId = this.messageId++;
        this.logger.info(`Setting object "${objectId}" from server ${serverId} for node ${nodeId}`);
        
        // Store the request details for the response handler
        this.pendingSubscriptions.set(msgId, { 
            serverId, 
            objectId, 
            nodeId, 
            type: 'setObject',
            timestamp: Date.now() 
        });
        
        eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "setObject", [objectId, objectDef]] });
    }

    subscribeToLogs(serverId, logLevel = 'info', nodeId) {
        this.logger.info(`Subscribing to logs for node ${nodeId} on server ${serverId} (level: ${logLevel})`);
        
        // Track active log subscriptions per server for re-subscription
        if (!this.activeLogSubscriptions.has(serverId)) {
            this.activeLogSubscriptions.set(serverId, new Set());
        }
        
        // Check if we already have a log subscription for this server
        const existingSubscription = Array.from(this.activeLogSubscriptions.get(serverId))
            .find(sub => sub.nodeId === nodeId);
        
        if (existingSubscription) {
            this.logger.debug(`Log subscription for node ${nodeId} on server ${serverId} already exists, skipping.`);
            return;
        }
        
        this.activeLogSubscriptions.get(serverId).add({ nodeId, logLevel });

        // Check if we need to subscribe to logs for this server
        if (!this.logSubscriptions.has(serverId)) {
            this.logSubscriptions.set(serverId, new Set());
            this.logger.info(`First log subscription for server ${serverId}. Sending command.`);
            this.sendLogSubscribeCommand(serverId, logLevel);
        }
        this.logSubscriptions.get(serverId).add(nodeId);
    }

    sendLogSubscribeCommand(serverId, logLevel) {
        const msgId = this.messageId++;
        this.logger.info(`Sending subscribeToLogs command to server ${serverId} with level ${logLevel}, messageId: ${msgId}`);
        this.pendingSubscriptions.set(msgId, { serverId, logLevel, type: 'subscribeToLogs', timestamp: Date.now() });
        eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "subscribeToLogs", [logLevel || 'info']] });
    }

    unsubscribeFromLogs(serverId, nodeId) {
        this.logger.info(`Unsubscribing from logs for node ${nodeId} on server ${serverId}`);
        
        // Remove from active subscriptions
        const activeSubscriptions = this.activeLogSubscriptions.get(serverId);
        if (activeSubscriptions) {
            const toRemove = Array.from(activeSubscriptions).find(sub => sub.nodeId === nodeId);
            if (toRemove) {
                activeSubscriptions.delete(toRemove);
            }
        }
        
        // Remove from log subscriptions
        const logSubscriptions = this.logSubscriptions.get(serverId);
        if (logSubscriptions) {
            logSubscriptions.delete(nodeId);
            
            // If no more nodes are subscribed to logs, unsubscribe from server
            if (logSubscriptions.size === 0) {
                this.logger.info(`No more nodes subscribed to logs for server ${serverId}. Unsubscribing.`);
                this.sendLogUnsubscribeCommand(serverId);
                this.logSubscriptions.delete(serverId);
            }
        }
    }

    sendLogUnsubscribeCommand(serverId) {
        const msgId = this.messageId++;
        this.pendingSubscriptions.set(msgId, { serverId, type: 'unsubscribeFromLogs', timestamp: Date.now() });
        eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "unsubscribeFromLogs", []] });
    }

    subscribeToObjects(serverId, objectId, nodeId) {
        this.logger.info(`Subscribing to objects for node ${nodeId} on server ${serverId} (objectId: ${objectId})`);
        
        // Track active object subscriptions per server for re-subscription
        if (!this.activeObjectSubscriptions.has(serverId)) {
            this.activeObjectSubscriptions.set(serverId, new Set());
        }
        
        // Check if we already have an object subscription for this node
        const existingSubscription = Array.from(this.activeObjectSubscriptions.get(serverId))
            .find(sub => sub.nodeId === nodeId && sub.objectId === objectId);
        
        if (existingSubscription) {
            this.logger.debug(`Object subscription for node ${nodeId} on server ${serverId} already exists, skipping.`);
            return;
        }
        
        this.activeObjectSubscriptions.get(serverId).add({ nodeId, objectId });

        // Check if we need to subscribe to objects for this server
        if (!this.objectSubscriptions.has(serverId)) {
            this.objectSubscriptions.set(serverId, new Set());
            this.logger.info(`First object subscription for server ${serverId}. Sending command.`);
            this.sendObjectSubscribeCommand(serverId, objectId);
        }
        this.objectSubscriptions.get(serverId).add(nodeId);
    }

    sendObjectSubscribeCommand(serverId, objectId) {
        const msgId = this.messageId++;
        this.logger.info(`Sending subscribeObjects command to server ${serverId} with objectId ${objectId}, messageId: ${msgId}`);
        this.pendingSubscriptions.set(msgId, { serverId, objectId, type: 'subscribeObjects', timestamp: Date.now() });
        eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "subscribeObjects", [objectId]] });
    }

    unsubscribeFromObjects(serverId, objectId, nodeId) {
        this.logger.info(`Unsubscribing from objects for node ${nodeId} on server ${serverId} (objectId: ${objectId})`);
        
        // Remove from active subscriptions
        const activeSubscriptions = this.activeObjectSubscriptions.get(serverId);
        if (activeSubscriptions) {
            const toRemove = Array.from(activeSubscriptions).find(sub => sub.nodeId === nodeId && sub.objectId === objectId);
            if (toRemove) {
                activeSubscriptions.delete(toRemove);
            }
        }
        
        // Remove from object subscriptions
        const objectSubscriptions = this.objectSubscriptions.get(serverId);
        if (objectSubscriptions) {
            objectSubscriptions.delete(nodeId);
            
            // If no more nodes are subscribed to objects, unsubscribe from server
            if (objectSubscriptions.size === 0) {
                this.logger.info(`No more nodes subscribed to objects for server ${serverId}. Unsubscribing.`);
                this.sendObjectUnsubscribeCommand(serverId, objectId);
                this.objectSubscriptions.delete(serverId);
            }
        }
    }

    sendObjectUnsubscribeCommand(serverId, objectId) {
        const msgId = this.messageId++;
        this.pendingSubscriptions.set(msgId, { serverId, objectId, type: 'unsubscribeObjects', timestamp: Date.now() });
        eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "unsubscribeObjects", [objectId]] });
    }

    handleServerReady(serverId) {
        // Re-subscribe to all states for this server after reconnection
        const subscriptions = this.activeSubscriptions.get(serverId);
        if (subscriptions && subscriptions.size > 0) {
            this.logger.info(`Re-subscribing to ${subscriptions.size} states after reconnection for server ${serverId}`);
            
            // Clear existing server subscriptions for this server to avoid duplicates
            this.serverSubscriptions.forEach((servers, stateId) => {
                if (servers.has(serverId)) {
                    servers.delete(serverId);
                    if (servers.size === 0) {
                        this.serverSubscriptions.delete(stateId);
                    }
                }
            });
            
            // Re-subscribe to all states
            subscriptions.forEach(stateId => {
                if (!this.serverSubscriptions.has(stateId)) {
                    this.serverSubscriptions.set(stateId, new Set());
                }
                this.serverSubscriptions.get(stateId).add(serverId);
                this.sendSubscribeCommand(serverId, stateId);
            });
        }
        
        // Re-subscribe to logs for this server after reconnection
        const logSubscriptions = this.activeLogSubscriptions.get(serverId);
        if (logSubscriptions && logSubscriptions.size > 0) {
            this.logger.info(`Re-subscribing to logs after reconnection for server ${serverId}`);
            
            // Clear existing log subscriptions for this server to avoid duplicates
            this.logSubscriptions.delete(serverId);
            
            // Re-subscribe to logs (use the first logLevel found)
            const firstSubscription = Array.from(logSubscriptions)[0];
            if (firstSubscription) {
                this.logSubscriptions.set(serverId, new Set());
                logSubscriptions.forEach(sub => {
                    this.logSubscriptions.get(serverId).add(sub.nodeId);
                });
                this.sendLogSubscribeCommand(serverId, firstSubscription.logLevel);
            }
        }

        // Re-subscribe to objects for this server after reconnection
        const objectSubscriptions = this.activeObjectSubscriptions.get(serverId);
        if (objectSubscriptions && objectSubscriptions.size > 0) {
            this.logger.info(`Re-subscribing to objects after reconnection for server ${serverId}`);
            
            // Clear existing object subscriptions for this server to avoid duplicates
            this.objectSubscriptions.delete(serverId);
            
            // Re-subscribe to objects (use the first objectId found)
            const firstSubscription = Array.from(objectSubscriptions)[0];
            if (firstSubscription) {
                this.objectSubscriptions.set(serverId, new Set());
                objectSubscriptions.forEach(sub => {
                    this.objectSubscriptions.get(serverId).add(sub.nodeId);
                });
                this.sendObjectSubscribeCommand(serverId, firstSubscription.objectId);
            }
        }
    }

    handleWebSocketMessage(serverId, data) {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch (e) {
            return;
        }

        this.logger.trace(`Received WebSocket message for server ${serverId}:`, JSON.stringify(message));

        if (Array.isArray(message) && message[2] === '___ready___') {
            this.logger.info(`'___ready___' signal received for ${serverId}. Emitting 'auth:success'.`);
            eventBus.emit('auth:success', { serverId });
            return;
        }
        
        // Handle callback responses (subscribe confirmations and getStates)
        if (Array.isArray(message) && message[0] === 3 && message.length >= 4) {
            const [messageType, messageId, command, result] = message;
            
            // Handle subscribe confirmations
            const pending = this.pendingSubscriptions.get(messageId);
            if (pending && command === 'subscribe') {
                this.pendingSubscriptions.delete(messageId);
                // result[0] is null for success, string for error
                if (result && result[0] !== null) {
                    this.logger.error(`Subscribe failed for ${pending.stateId} on ${serverId}: ${result[0]}`);
                } else {
                    this.logger.info(`Subscribe successful for ${pending.stateId} on ${serverId}`);
                    // Emit a subscription success event that the node can react to
                    eventBus.emit('state:subscription_confirmed', { 
                        serverId: pending.serverId, 
                        stateId: pending.stateId 
                    });
                }
                return;
            }
            
            // Handle getState responses (for initial values)
            if (pending && command === 'getState' && pending.type === 'getState') {
                this.pendingSubscriptions.delete(messageId);
                // result[0] is null for success, string for error
                if (result && result[0] !== null) {
                    this.logger.error(`GetState failed for ${pending.stateId} on ${serverId}: ${result[0]}`);
                } else {
                    this.logger.info(`GetState successful for ${pending.stateId} on ${serverId}`);
                    // result[1] contains the state object
                    const state = result && result[1];
                    this.logger.info(`GetState result for ${pending.stateId}: state value=${state ? state.val : 'null'}, nodeId=${pending.nodeId}`);
                    eventBus.emit('state:initial_value', { 
                        serverId: pending.serverId, 
                        stateId: pending.stateId,
                        nodeId: pending.nodeId,
                        state: state 
                    });
                }
                return;
            }
            
            // Handle setState responses
            if (pending && command === 'setState' && pending.type === 'setState') {
                this.pendingSubscriptions.delete(messageId);
                // result[0] is null for success, string for error
                if (result && result[0] !== null) {
                    this.logger.error(`SetState failed for ${pending.stateId} on ${serverId}: ${result[0]}`);
                    eventBus.emit('state:set_result', { 
                        serverId: pending.serverId, 
                        stateId: pending.stateId,
                        nodeId: pending.nodeId,
                        success: false,
                        error: result[0]
                    });
                } else {
                    this.logger.info(`SetState successful for ${pending.stateId} on ${serverId}`);
                    eventBus.emit('state:set_result', { 
                        serverId: pending.serverId, 
                        stateId: pending.stateId,
                        nodeId: pending.nodeId,
                        success: true 
                    });
                }
                return;
            }
            
            // Handle coordinated multiple data requests
            if (pending && pending.coordinatorKey) {
                this.handleCoordinatedResponse(messageId, command, result, pending);
                return;
            }

            // Handle getObject responses (single objects and old getObjects)
            if (pending && (command === 'getObject' || command === 'getObjects') && pending.type === 'getObject') {
                this.pendingSubscriptions.delete(messageId);
                // result[0] is null for success, string for error
                if (result && result[0] !== null) {
                    this.logger.error(`GetObject failed for ${pending.objectId} on ${serverId}: ${result[0]}`);
                    eventBus.emit('object:get_result', { 
                        serverId: pending.serverId, 
                        objectId: pending.objectId,
                        nodeId: pending.nodeId,
                        success: false,
                        error: result[0]
                    });
                } else {
                    this.logger.info(`GetObject successful for ${pending.objectId} on ${serverId}`);
                    // result[1] contains the object or objects
                    const object = result && result[1];
                    eventBus.emit('object:get_result', { 
                        serverId: pending.serverId, 
                        objectId: pending.objectId,
                        nodeId: pending.nodeId,
                        success: true,
                        object: object 
                    });
                }
                return;
            }

            // Handle getObjectView responses (for individual object types)
            if (pending && command === 'getObjectView' && pending.type === 'getObjectView') {
                this.pendingSubscriptions.delete(messageId);
                
                // Get the parent request (the original getObjectsAllTypes request)
                const parentRequest = this.pendingSubscriptions.get(pending.parentRequestId);
                if (!parentRequest || parentRequest.type !== 'getObjectsAllTypes') {
                    this.logger.warn(`Parent request not found for getObjectView response: ${pending.parentRequestId}`);
                    return;
                }

                // Process the result for this object type
                if (result && result[0] !== null) {
                    this.logger.warn(`GetObjectView failed for type ${pending.objectType} on ${serverId}: ${result[0]}`);
                    parentRequest.collectedResults[pending.objectType] = [];
                } else {
                    this.logger.debug(`GetObjectView successful for type ${pending.objectType} on ${serverId}`);
                    const objects = this.processObjectViewResult(result && result[1], pending.objectId, pending.objectType);
                    parentRequest.collectedResults[pending.objectType] = objects || [];
                }

                // Increment completed types counter
                parentRequest.completedTypes++;
                
                // Check if all object types have been processed
                if (parentRequest.completedTypes >= parentRequest.objectTypes.length) {
                    // All types completed, combine results
                    this.pendingSubscriptions.delete(pending.parentRequestId);
                    
                    const allObjects = {};
                    parentRequest.objectTypes.forEach(objectType => {
                        const typeObjects = parentRequest.collectedResults[objectType] || [];
                        typeObjects.forEach(obj => {
                            if (obj && obj._id) {
                                allObjects[obj._id] = obj;
                            }
                        });
                    });

                    this.logger.info(`GetObjectsAllTypes completed for ${parentRequest.objectId} on ${serverId}: ${Object.keys(allObjects).length} objects`);
                    
                    eventBus.emit('object:get_result', { 
                        serverId: parentRequest.serverId, 
                        objectId: parentRequest.objectId,
                        nodeId: parentRequest.nodeId,
                        success: true,
                        object: allObjects
                    });
                }
                return;
            }

            // Handle getEnums responses (now using getObjectView)
            if (pending && command === 'getObjectView' && (pending.type === 'getEnums' || pending.type === 'enums')) {
                this.pendingSubscriptions.delete(messageId);
                // result[0] is null for success, string for error
                if (result && result[0] !== null) {
                    this.logger.error(`GetEnums failed on ${serverId}: ${result[0]}`);
                    eventBus.emit('enums:get_result', { 
                        serverId: pending.serverId, 
                        nodeId: pending.nodeId,
                        success: false,
                        error: result[0]
                    });
                } else {
                    this.logger.info(`GetEnums successful on ${serverId}`);
                    // result[1] contains the enums in getObjectView format
                    const enums = result && result[1];
                    eventBus.emit('enums:get_result', { 
                        serverId: pending.serverId, 
                        nodeId: pending.nodeId,
                        success: true,
                        enums: enums 
                    });
                }
                return;
            }

            // Handle getAliases responses (now using getObjects for alias.*)
            if (pending && command === 'getObjects' && (pending.type === 'getAliases' || pending.type === 'aliases')) {
                this.pendingSubscriptions.delete(messageId);
                // result[0] is null for success, string for error
                if (result && result[0] !== null) {
                    this.logger.error(`GetAliases failed on ${serverId}: ${result[0]}`);
                    eventBus.emit('aliases:get_result', { 
                        serverId: pending.serverId, 
                        nodeId: pending.nodeId,
                        success: false,
                        error: result[0]
                    });
                } else {
                    this.logger.info(`GetAliases successful on ${serverId}`);
                    // result[1] contains the aliases as object map
                    const aliases = result && result[1];
                    this.logger.debug(`[DEBUG] GetAliases raw result structure: ${JSON.stringify(aliases ? {objectCount: Object.keys(aliases).length} : 'null')}`);
                    
                    eventBus.emit('aliases:get_result', { 
                        serverId: pending.serverId, 
                        nodeId: pending.nodeId,
                        success: true,
                        aliases: aliases 
                    });
                }
                return;
            }
            
            // Handle setObject responses
            if (pending && command === 'setObject' && pending.type === 'setObject') {
                this.pendingSubscriptions.delete(messageId);
                // result[0] is null for success, string for error
                if (result && result[0] !== null) {
                    this.logger.error(`SetObject failed for ${pending.objectId} on ${serverId}: ${result[0]}`);
                    eventBus.emit('object:set_result', { 
                        serverId: pending.serverId, 
                        objectId: pending.objectId,
                        nodeId: pending.nodeId,
                        success: false,
                        error: result[0]
                    });
                } else {
                    this.logger.info(`SetObject successful for ${pending.objectId} on ${serverId}`);
                    eventBus.emit('object:set_result', { 
                        serverId: pending.serverId, 
                        objectId: pending.objectId,
                        nodeId: pending.nodeId,
                        success: true 
                    });
                }
                return;
            }
            
            // Handle getStates responses (for TreeView API)
            if (command === 'getStates') {
                this.logger.debug(`getStates response received for ${serverId}, messageId: ${messageId}`);
                if (result && result[0] === null && result[1]) {
                    // result[1] contains the states object
                    eventBus.emit('api:states_response', {
                        serverId,
                        requestId: messageId,
                        states: result[1]
                    });
                } else {
                    this.logger.error(`getStates failed for ${serverId}: ${result ? result[0] : 'Unknown error'}`);
                    eventBus.emit('api:states_response', {
                        serverId,
                        requestId: messageId,
                        error: result ? result[0] : 'Unknown error'
                    });
                }
                return;
            }
            
            // Handle subscribeToLogs responses
            if (pending && command === 'subscribeToLogs' && pending.type === 'subscribeToLogs') {
                this.logger.info(`Received subscribeToLogs response for server ${serverId}, messageId: ${messageId}`);
                this.pendingSubscriptions.delete(messageId);
                // result[0] is null for success, string for error
                if (result && result[0] !== null) {
                    this.logger.error(`SubscribeToLogs failed for server ${serverId}: ${result[0]}`);
                } else {
                    this.logger.info(`SubscribeToLogs successful for server ${serverId}`);
                    // Notify all nodes that log subscription is confirmed
                    const logSubscriptions = this.logSubscriptions.get(serverId);
                    if (logSubscriptions) {
                        this.logger.info(`Emitting log:subscription_confirmed for ${logSubscriptions.size} nodes`);
                        logSubscriptions.forEach(nodeId => {
                            this.logger.info(`Emitting log:subscription_confirmed for node ${nodeId}`);
                            eventBus.emit('log:subscription_confirmed', { 
                                serverId, 
                                nodeId 
                            });
                        });
                    }
                }
                return;
            }
            
            // Handle unsubscribeFromLogs responses
            if (pending && command === 'unsubscribeFromLogs' && pending.type === 'unsubscribeFromLogs') {
                this.pendingSubscriptions.delete(messageId);
                // result[0] is null for success, string for error
                if (result && result[0] !== null) {
                    this.logger.error(`UnsubscribeFromLogs failed for server ${serverId}: ${result[0]}`);
                } else {
                    this.logger.info(`UnsubscribeFromLogs successful for server ${serverId}`);
                }
                return;
            }

            // Handle subscribeObjects responses
            if (pending && command === 'subscribeObjects' && pending.type === 'subscribeObjects') {
                this.logger.info(`Received subscribeObjects response for server ${serverId}, messageId: ${messageId}`);
                this.pendingSubscriptions.delete(messageId);
                // result[0] is null for success, string for error
                if (result && result[0] !== null) {
                    this.logger.error(`SubscribeObjects failed for server ${serverId}: ${result[0]}`);
                } else {
                    this.logger.info(`SubscribeObjects successful for server ${serverId}`);
                    // Notify all nodes that object subscription is confirmed
                    const objectSubscriptions = this.objectSubscriptions.get(serverId);
                    if (objectSubscriptions) {
                        this.logger.info(`Emitting object:subscription_confirmed for ${objectSubscriptions.size} nodes`);
                        objectSubscriptions.forEach(nodeId => {
                            this.logger.info(`Emitting object:subscription_confirmed for node ${nodeId}`);
                            eventBus.emit('object:subscription_confirmed', { 
                                serverId, 
                                nodeId,
                                objectId: pending.objectId
                            });
                        });
                    }
                }
                return;
            }

            // Handle unsubscribeObjects responses
            if (pending && command === 'unsubscribeObjects' && pending.type === 'unsubscribeObjects') {
                this.pendingSubscriptions.delete(messageId);
                // result[0] is null for success, string for error
                if (result && result[0] !== null) {
                    this.logger.error(`UnsubscribeObjects failed for server ${serverId}: ${result[0]}`);
                } else {
                    this.logger.info(`UnsubscribeObjects successful for server ${serverId}`);
                }
                return;
            }
        }
        
        // Handle log messages
        if (Array.isArray(message) && message[2] === 'log') {
            const [ , , , logData] = message;
            if (logData) {
                this.logger.debug(`Log message received for server ${serverId}: ${logData.message}`);
                // Forward log message to all subscribed nodes
                const logSubscriptions = this.logSubscriptions.get(serverId);
                if (logSubscriptions) {
                    logSubscriptions.forEach(nodeId => {
                        eventBus.emit('log:message', { 
                            serverId, 
                            nodeId, 
                            logData 
                        });
                    });
                }
            }
        }

        // Handle object changes
        if (Array.isArray(message) && message[2] === 'objectChange') {
            const [ , , , [objectId, objectData]] = message;
            this.logger.debug(`Object change for ${objectId}. Forwarding.`);
            // Forward object change to all subscribed nodes
            const objectSubscriptions = this.objectSubscriptions.get(serverId);
            if (objectSubscriptions) {
                objectSubscriptions.forEach(nodeId => {
                    eventBus.emit('object:changed', { 
                        serverId, 
                        nodeId,
                        objectId, 
                        objectData,
                        operation: objectData ? 'update' : 'delete'
                    });
                });
            }
        }
        
        if (Array.isArray(message) && message[2] === 'stateChange') {
            const [ , , , [stateId, state]] = message;
            if (state) {
                this.logger.debug(`State change for ${stateId}: ${state.val}. Forwarding.`);
                eventBus.emit('state:changed', { serverId, stateId, state });
            }
        }
    }

    // Helper method to process getObjectView results
    processObjectViewResult(result, pattern, objectType) {
        const objects = [];

        if (result && result.rows) {
            for (const row of result.rows) {
                const objectData = {
                    _id: row.id,
                    ...row.value
                };

                if (this.matchesPattern(row.id, pattern)) {
                    objects.push(objectData);
                }
            }
        }

        objects.sort((a, b) => (a._id || '').localeCompare(b._id || ''));
        return objects;
    }

    // Helper method to check if an object ID matches a pattern
    matchesPattern(objectId, pattern) {
        if (pattern === '*') {
            return true;
        }

        if (!pattern.includes('*')) {
            return objectId === pattern;
        }

        const regexPattern = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
        const regex = new RegExp(`^${regexPattern}$`);

        return regex.test(objectId);
    }

    // Helper method to filter alias objects from config objects
}

module.exports = StateService;