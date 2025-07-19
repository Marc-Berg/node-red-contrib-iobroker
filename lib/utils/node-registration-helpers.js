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

        if (onServerReady && typeof onServerReady === 'function') {
            Orchestrator.on('server:ready', onServerReady);
        }
        if (onSubscriptionConfirmed && typeof onSubscriptionConfirmed === 'function') {
            Orchestrator.on('state:subscription_confirmed', onSubscriptionConfirmed);
        }
        if (onStateChanged && typeof onStateChanged === 'function') {
            Orchestrator.on('state:changed', onStateChanged);
        }
        if (onInitialStateValue && typeof onInitialStateValue === 'function') {
            Orchestrator.on(`state:initial_value:${node.id}`, onInitialStateValue);
        }
        if (onDisconnected && typeof onDisconnected === 'function') {
            Orchestrator.on('connection:disconnected', onDisconnected);
        }
        if (onRetrying && typeof onRetrying === 'function') {
            Orchestrator.on('connection:retrying', onRetrying);
        }
        if (onPermanentFailure && typeof onPermanentFailure === 'function') {
            Orchestrator.on('connection:failed_permanently', onPermanentFailure);
        }
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

        if (onServerReady && typeof onServerReady === 'function') {
            Orchestrator.removeListener('server:ready', onServerReady);
        }
        if (onSubscriptionConfirmed && typeof onSubscriptionConfirmed === 'function') {
            Orchestrator.removeListener('state:subscription_confirmed', onSubscriptionConfirmed);
        }
        if (onStateChanged && typeof onStateChanged === 'function') {
            Orchestrator.removeListener('state:changed', onStateChanged);
        }
        if (onInitialStateValue && typeof onInitialStateValue === 'function') {
            Orchestrator.removeListener(`state:initial_value:${node.id}`, onInitialStateValue);
        }
        if (onDisconnected && typeof onDisconnected === 'function') {
            Orchestrator.removeListener('connection:disconnected', onDisconnected);
        }
        if (onRetrying && typeof onRetrying === 'function') {
            Orchestrator.removeListener('connection:retrying', onRetrying);
        }
        if (onPermanentFailure && typeof onPermanentFailure === 'function') {
            Orchestrator.removeListener('connection:failed_permanently', onPermanentFailure);
        }
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
