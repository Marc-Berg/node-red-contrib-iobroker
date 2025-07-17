const eventBus = require('../events/event-bus');
const LoggingService = require('../logging');

class StateService {
    constructor() {
        this.logger = LoggingService.getLogger('StateService');
        this.serverSubscriptions = new Map(); // stateId -> Set of serverIds
        this.activeSubscriptions = new Map(); // serverId -> Set of stateIds (for re-subscription)
        this.messageId = 1; // Simple message ID counter
        this.pendingSubscriptions = new Map(); // Track pending subscribe requests by messageId
        
        eventBus.on('websocket:message', ({ serverId, data }) => this.handleWebSocketMessage(serverId, data));
        eventBus.on('state:subscribe_request', ({ serverId, stateId }) => this.addSubscription(serverId, stateId));
        eventBus.on('state:get_request', ({ serverId, stateId, nodeId }) => this.getState(serverId, stateId, nodeId));
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