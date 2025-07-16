const eventBus = require('../events/event-bus');
const LoggingService = require('../logging');

class StateService {
    constructor() {
        this.logger = LoggingService.getLogger('StateService');
        this.serverSubscriptions = new Map();
        
        eventBus.on('websocket:message', ({ serverId, data }) => this.handleWebSocketMessage(serverId, data));
        eventBus.on('state:subscribe_request', ({ serverId, stateId }) => this.addSubscription(serverId, stateId));
        
        this.logger.info('StateService constructed and listeners attached.');
    }

    addSubscription(serverId, stateId) {
        if (!this.serverSubscriptions.has(stateId)) {
            this.serverSubscriptions.set(stateId, new Set());
            this.logger.info(`First subscription for "${stateId}". Sending command to server ${serverId}.`);
            eventBus.emit('websocket:send', { serverId, payload: [0, 1, "subscribe", [stateId]] });
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