// lib/services/state-service.js
const eventBus = require('../events/event-bus');

const MESSAGE_TYPES = {
    MESSAGE: 0,
    CALLBACK: 3,
};

/**
 * Manages ioBroker state subscriptions and data.
 * Reacts to events to subscribe/unsubscribe and emits state changes.
 */
class StateService {
    constructor() {
        this.subscriptions = new Map();
        this.subscribedPatterns = new Set();
        this.messageId = 0;
        this.isReady = false;

        eventBus.on('state:subscribe_request', ({ nodeId, stateId }) => this.addSubscription(nodeId, stateId));
        eventBus.on('state:unsubscribe_request', ({ nodeId, stateId }) => this.removeSubscription(nodeId, stateId));
        
        // The system is fully connected and authenticated. Now we can subscribe.
        eventBus.on('auth:success', () => {
            this.isReady = true;
            this.subscribeAll();
        });
        
        // If connection is lost, reset ready state.
        eventBus.on('connection:disconnected', () => {
            this.isReady = false;
        });

        eventBus.on('websocket:message', ({ data }) => this.handleWebSocketMessage(data));
    }

    addSubscription(nodeId, stateId) {
        if (!this.subscriptions.has(stateId)) {
            this.subscriptions.set(stateId, new Set());
        }
        this.subscriptions.get(stateId).add(nodeId);
        
        // If we are already connected and ready, subscribe immediately.
        if (this.isReady) {
            this.subscribe(stateId);
        }
    }
    
    removeSubscription(nodeId, stateId) {
        if (this.subscriptions.has(stateId)) {
            this.subscriptions.get(stateId).delete(nodeId);
            if (this.subscriptions.get(stateId).size === 0) {
                this.subscriptions.delete(stateId);
                if (this.isReady) {
                    this.unsubscribe(stateId);
                }
            }
        }
    }

    subscribe(stateId) {
        if (this.subscribedPatterns.has(stateId)) return;
        this.messageId++;
        eventBus.emit('websocket:send', [MESSAGE_TYPES.MESSAGE, this.messageId, 'subscribe', [stateId]]);
        this.subscribedPatterns.add(stateId);
    }
    
    unsubscribe(stateId) {
        if (!this.subscribedPatterns.has(stateId)) return;
        this.messageId++;
        eventBus.emit('websocket:send', [MESSAGE_TYPES.MESSAGE, this.messageId, 'unsubscribe', [stateId]]);
        this.subscribedPatterns.delete(stateId);
    }
    
    subscribeAll() {
        this.subscribedPatterns.clear();
        for (const stateId of this.subscriptions.keys()) {
            this.subscribe(stateId);
        }
    }

    handleWebSocketMessage(rawMessage) {
        try {
            const message = JSON.parse(rawMessage.toString());
            if (!Array.isArray(message)) return;

            const type = message[0];
            const name = message[2];

            if (type === MESSAGE_TYPES.MESSAGE) {
                // The server confirms it's ready for commands
                if (name === '___ready___') {
                    eventBus.emit('connection:established');
                    // Now that the connection is established and ready, we declare auth as successful.
                    eventBus.emit('auth:success');
                }
                // Handle incoming state change messages
                else if (name === 'stateChange') {
                    const [stateId, stateObject] = message[3];
                    if (stateObject) {
                        eventBus.emit('state:changed', { stateId, state: stateObject });
                    }
                }
            }
        } catch (e) {
            // Not a valid JSON message, ignore
        }
    }
}

module.exports = StateService;