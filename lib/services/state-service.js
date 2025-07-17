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
        
        eventBus.on('websocket:message', ({ serverId, data }) => this.handleWebSocketMessage(serverId, data));
        eventBus.on('state:subscribe_request', ({ serverId, stateId }) => this.addSubscription(serverId, stateId));
        eventBus.on('state:get_request', ({ serverId, stateId, nodeId }) => this.getState(serverId, stateId, nodeId));
        eventBus.on('state:set_request', ({ serverId, stateId, value, ack, nodeId }) => this.setState(serverId, stateId, value, ack, nodeId));
        eventBus.on('object:get_request', ({ serverId, objectId, nodeId }) => this.getObject(serverId, objectId, nodeId));
        eventBus.on('enums:get_request', ({ serverId, nodeId }) => this.getEnums(serverId, nodeId));
        eventBus.on('aliases:get_request', ({ serverId, nodeId }) => this.getAliases(serverId, nodeId));
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
            // Use getObjects for wildcard patterns
            eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "getObjects", [objectId]] });
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
        
        eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "getObjects", ["enum.*"]] });
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
        
        eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "getObjects", ["alias.*"]] });
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
            
            // Handle getObject responses
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

            // Handle getEnums responses
            if (pending && command === 'getObjects' && pending.type === 'getEnums') {
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
                    // result[1] contains the enums
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

            // Handle getAliases responses
            if (pending && command === 'getObjects' && pending.type === 'getAliases') {
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
                    // result[1] contains the aliases
                    const aliases = result && result[1];
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
}

module.exports = StateService;