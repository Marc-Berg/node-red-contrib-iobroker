const eventBus = require('../events/event-bus');
const LoggingService = require('../logging');

class StateService {
    constructor() {
        this.logger = LoggingService.getLogger('StateService');
        this.serverSubscriptions = new Map();
        this.messageId = 1; // Simple message ID counter
        this.pendingSubscriptions = new Map(); // Track pending subscribe requests by messageId
        
        eventBus.on('websocket:message', ({ serverId, data }) => this.handleWebSocketMessage(serverId, data));
        eventBus.on('state:subscribe_request', ({ serverId, stateId }) => this.addSubscription(serverId, stateId));
        
        this.logger.info('StateService constructed and listeners attached.');
    }

    addSubscription(serverId, stateId) {
        if (!this.serverSubscriptions.has(stateId)) {
            this.serverSubscriptions.set(stateId, new Set());
            this.logger.info(`First subscription for "${stateId}". Sending command to server ${serverId}.`);
            // Use ioBroker WebSocket protocol: [MESSAGE_TYPE, id, command, args]
            // MESSAGE_TYPE 3 = CALLBACK (with callback), incremented ID, command is 'subscribe', args is array with stateId
            const msgId = this.messageId++;
            this.pendingSubscriptions.set(msgId, { serverId, stateId, timestamp: Date.now() });
            eventBus.emit('websocket:send', { serverId, payload: [3, msgId, "subscribe", [stateId]] });
        }
        this.serverSubscriptions.get(stateId).add(serverId);
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
        
        // Handle callback responses (subscribe confirmations)
        if (Array.isArray(message) && message[0] === 3 && message.length >= 4) {
            const [messageType, messageId, command, result] = message;
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
            }
            return;
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