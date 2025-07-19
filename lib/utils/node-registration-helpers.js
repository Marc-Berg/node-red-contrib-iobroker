/*!
 * Node Registration Helper Functions for ioBroker Node-RED Integration
 * Utilities for node registration and lifecycle management
 */

const Orchestrator = require('../orchestrator');

class NodeRegistrationHelpers {
    /**
     * Register node with orchestrator
     */
    static registerWithOrchestrator(node) {
        if (!node.isRegistered) {
            node.log(`Registering node with orchestrator after flows started`);
            Orchestrator.registerNode(node.id, node.server);
            node.isRegistered = true;
        }
    }

    /**
     * Setup delayed registration with orchestrator
     */
    static setupDelayedRegistration(node, delay = 300) {
        setTimeout(() => {
            NodeRegistrationHelpers.registerWithOrchestrator(node);
        }, delay);
    }

    /**
     * Register all event listeners for a node
     */
    static registerEventListeners(node, handlers) {
        const {
            onServerReady,
            onSubscriptionConfirmed,
            onStateChanged,
            onInitialStateValue,
            onDisconnected,
            onRetrying,
            onPermanentFailure
        } = handlers;

        Orchestrator.on('server:ready', onServerReady);
        Orchestrator.on('state:subscription_confirmed', onSubscriptionConfirmed);
        Orchestrator.on('state:changed', onStateChanged);
        Orchestrator.on(`state:initial_value:${node.id}`, onInitialStateValue);
        Orchestrator.on('connection:disconnected', onDisconnected);
        Orchestrator.on('connection:retrying', onRetrying);
        Orchestrator.on('connection:failed_permanently', onPermanentFailure);
    }

    /**
     * Unregister all event listeners for a node
     */
    static unregisterEventListeners(node, handlers) {
        const {
            onServerReady,
            onSubscriptionConfirmed,
            onStateChanged,
            onInitialStateValue,
            onDisconnected,
            onRetrying,
            onPermanentFailure
        } = handlers;

        Orchestrator.removeListener('server:ready', onServerReady);
        Orchestrator.removeListener('state:subscription_confirmed', onSubscriptionConfirmed);
        Orchestrator.removeListener('state:changed', onStateChanged);
        Orchestrator.removeListener(`state:initial_value:${node.id}`, onInitialStateValue);
        Orchestrator.removeListener('connection:disconnected', onDisconnected);
        Orchestrator.removeListener('connection:retrying', onRetrying);
        Orchestrator.removeListener('connection:failed_permanently', onPermanentFailure);
    }

    /**
     * Setup node close handler with cleanup
     */
    static setupCloseHandler(node, handlers, cleanupCallbacks = []) {
        node.on('close', (done) => {
            // Run custom cleanup callbacks
            cleanupCallbacks.forEach(callback => {
                try {
                    callback();
                } catch (error) {
                    node.warn(`Cleanup error: ${error.message}`);
                }
            });

            // Unregister event listeners
            NodeRegistrationHelpers.unregisterEventListeners(node, handlers);
            
            // Unregister from orchestrator
            if (node.isRegistered) {
                Orchestrator.unregisterNode(node.id, node.server.id);
            }
            
            done();
        });
    }
}

module.exports = { NodeRegistrationHelpers };
