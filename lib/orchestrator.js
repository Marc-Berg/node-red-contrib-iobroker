// lib/orchestrator.js
const eventBus = require('./events/event-bus');
const ConnectionService = require('./services/connection-service');
const StateService = require('./services/state-service');
const AuthService = require('./services/auth-service');

let initialized = false;
const services = {};

/**
 * Initializes and manages all services.
 * Acts as the main entry point for Node-RED nodes.
 */
function initialize() {
    if (initialized) {
        return;
    }

    // Instantiate all services. They will self-register with the event bus.
    services.connection = new ConnectionService();
    services.state = new StateService();
    services.auth = new AuthService();

    console.log('[Orchestrator] All services initialized.');
    initialized = true;
}

/**
 * Main API for Node-RED nodes to interact with the system.
 */
const Orchestrator = {
    /**
     * Called by a config node to trigger a connection.
     * @param {object} config - The connection configuration.
     */
    ensureConnection(config) {
        initialize();
        eventBus.emit('connection:request', config);
    },

    /**
     * Called by an `iob-in` node to subscribe to a state.
     * @param {string} nodeId - The unique ID of the Node-RED node.
     * @param {string} stateId - The ioBroker state to subscribe to.
     */
    subscribe(nodeId, stateId) {
        initialize();
        eventBus.emit('state:subscribe_request', { nodeId, stateId });
    },
    
    /**
     * Called by an `iob-in` node when it's closed.
     * @param {string} nodeId - The unique ID of the Node-RED node.
     * @param {string} stateId - The ioBroker state to unsubscribe from.
     */
    unsubscribe(nodeId, stateId) {
        if (initialized) {
            eventBus.emit('state:unsubscribe_request', { nodeId, stateId });
        }
    },
    
    /**
     * Allows nodes to listen for events.
     * @param {string} event - The event name (e.g., 'state:changed').
     * @param {function} handler - The callback function.
     */
    on(event, handler) {
        initialize();
        eventBus.on(event, handler);
    },
    
    /**
     * Allows nodes to stop listening for events.
     * @param {string} event - The event name.
     * @param {function} handler - The callback function.
     */
    off(event, handler) {
        if (initialized) {
            eventBus.off(event, handler);
        }
    }
};

module.exports = Orchestrator;