/*!
 * Node Lifecycle Helper Functions for ioBroker Node-RED Integration
 * Unified utilities for node registration, status management, and lifecycle events
 */

class NodeLifecycleHelpers {
    /**
     * Update node connection status with consistent formatting
     */
    static updateConnectionStatus(node, state, text = '') {
        const statusMap = {
            'ready': { fill: 'green', shape: 'dot' },
            'connected': { fill: 'green', shape: 'dot' },
            'connecting': { fill: 'yellow', shape: 'ring' },
            'retrying': { fill: 'yellow', shape: 'ring' },
            'disconnected': { fill: 'red', shape: 'ring' },
            'error': { fill: 'red', shape: 'dot' },
            'waiting': { fill: 'grey', shape: 'ring' },
            'processing': { fill: 'blue', shape: 'dot' },
            'sending': { fill: 'blue', shape: 'dot' },
            'requesting': { fill: 'blue', shape: 'dot' }
        };

        const status = statusMap[state] || { fill: 'grey', shape: 'ring' };
        
        node.status({
            fill: status.fill,
            shape: status.shape,
            text: text || state
        });
    }

    /**
     * Setup delayed registration with event listeners
     */
    static setupDelayedRegistrationWithListeners(node, eventHandlers, delay = 300) {
        node.isRegistered = false;

        const registerWithOrchestrator = () => {
            if (!node.isRegistered && node.server) {
                node.log(`Registering node with orchestrator after flows started`);
                
                const Orchestrator = require('../orchestrator');
                Orchestrator.registerNode(node.id, node.server);
                node.isRegistered = true;
                
                // Setup event listeners
                NodeLifecycleHelpers.setupEventListeners(node, eventHandlers);
            }
        };

        setTimeout(registerWithOrchestrator, delay);
    }

    /**
     * Setup event listeners for a node
     */
    static setupEventListeners(node, eventHandlers) {
        const Orchestrator = require('../orchestrator');
        
        if (eventHandlers.onServerReady) {
            Orchestrator.on('server:ready', eventHandlers.onServerReady);
        }
        
        if (eventHandlers.onDisconnected) {
            Orchestrator.on('connection:disconnected', eventHandlers.onDisconnected);
        }
        
        if (eventHandlers.onRetrying) {
            Orchestrator.on('connection:retrying', eventHandlers.onRetrying);
        }
        
        if (eventHandlers.onPermanentFailure) {
            Orchestrator.on('connection:failed_permanently', eventHandlers.onPermanentFailure);
        }

        // Node-specific listeners
        if (eventHandlers.onGetStateResponse) {
            Orchestrator.on(`state:initial_value:${node.id}`, eventHandlers.onGetStateResponse);
        }
        
        if (eventHandlers.onLogSubscriptionConfirmed) {
            Orchestrator.on(`log:subscription_confirmed:${node.id}`, eventHandlers.onLogSubscriptionConfirmed);
        }
        
        if (eventHandlers.onLogMessage) {
            Orchestrator.on('log:message', eventHandlers.onLogMessage);
        }
        
        if (eventHandlers.onObjectSubscriptionConfirmed) {
            Orchestrator.on('object:subscription_confirmed', eventHandlers.onObjectSubscriptionConfirmed);
        }
        
        if (eventHandlers.onObjectChanged) {
            Orchestrator.on('object:changed', eventHandlers.onObjectChanged);
        }
        
        if (eventHandlers.onStateSetResult) {
            Orchestrator.on(`state:set_result:${node.id}`, eventHandlers.onStateSetResult);
        }
        
        if (eventHandlers.onObjectGetResult) {
            Orchestrator.on(`object:get_result:${node.id}`, eventHandlers.onObjectGetResult);
        }
        
        if (eventHandlers.onObjectSetResult) {
            Orchestrator.on(`object:set_result:${node.id}`, eventHandlers.onObjectSetResult);
        }

        if (eventHandlers.onSendToResponse) {
            Orchestrator.on(`sendto:response:${node.id}`, eventHandlers.onSendToResponse);
        }
    }

    /**
     * Setup close handler with cleanup
     */
    static setupCloseHandler(node, eventHandlers, cleanupCallbacks = []) {
        const Orchestrator = require('../orchestrator');
        
        // Remove event listeners
        if (eventHandlers.onServerReady) {
            Orchestrator.removeListener('server:ready', eventHandlers.onServerReady);
        }
        
        if (eventHandlers.onDisconnected) {
            Orchestrator.removeListener('connection:disconnected', eventHandlers.onDisconnected);
        }
        
        if (eventHandlers.onRetrying) {
            Orchestrator.removeListener('connection:retrying', eventHandlers.onRetrying);
        }
        
        if (eventHandlers.onPermanentFailure) {
            Orchestrator.removeListener('connection:failed_permanently', eventHandlers.onPermanentFailure);
        }

        // Node-specific listeners
        if (eventHandlers.onGetStateResponse) {
            Orchestrator.removeListener(`state:initial_value:${node.id}`, eventHandlers.onGetStateResponse);
        }
        
        if (eventHandlers.onLogSubscriptionConfirmed) {
            Orchestrator.removeListener(`log:subscription_confirmed:${node.id}`, eventHandlers.onLogSubscriptionConfirmed);
        }
        
        if (eventHandlers.onLogMessage) {
            Orchestrator.removeListener('log:message', eventHandlers.onLogMessage);
        }
        
        if (eventHandlers.onObjectSubscriptionConfirmed) {
            Orchestrator.removeListener('object:subscription_confirmed', eventHandlers.onObjectSubscriptionConfirmed);
        }
        
        if (eventHandlers.onObjectChanged) {
            Orchestrator.removeListener('object:changed', eventHandlers.onObjectChanged);
        }
        
        if (eventHandlers.onStateSetResult) {
            Orchestrator.removeListener(`state:set_result:${node.id}`, eventHandlers.onStateSetResult);
        }
        
        if (eventHandlers.onObjectGetResult) {
            Orchestrator.removeListener(`object:get_result:${node.id}`, eventHandlers.onObjectGetResult);
        }
        
        if (eventHandlers.onObjectSetResult) {
            Orchestrator.removeListener(`object:set_result:${node.id}`, eventHandlers.onObjectSetResult);
        }

        if (eventHandlers.onSendToResponse) {
            Orchestrator.removeListener(`sendto:response:${node.id}`, eventHandlers.onSendToResponse);
        }
        
        // Execute cleanup callbacks
        cleanupCallbacks.forEach(callback => {
            try {
                callback();
            } catch (error) {
                node.error(`Cleanup callback failed: ${error.message}`);
            }
        });
        
        // Unregister node if registered
        if (node.isRegistered && node.server) {
            Orchestrator.unregisterNode(node.id, node.server.id);
        }
    }

    /**
     * Register node with orchestrator (standalone)
     */
    static registerWithOrchestrator(node) {
        if (!node.isRegistered && node.server) {
            const Orchestrator = require('../orchestrator');
            Orchestrator.registerNode(node.id, node.server);
            node.isRegistered = true;
        }
    }

    /**
     * Create status text with server connection name prefix
     */
    static createStatusText(node, text) {
        return node.server?.connectionName ? `[${node.server.connectionName}] ${text}` : text;
    }
}

// Legacy exports for backward compatibility
class StatusHelpers {
    static updateConnectionStatus(node, state, text) {
        return NodeLifecycleHelpers.updateConnectionStatus(node, state, text);
    }

    static updateSingleStateStatus(node, stateId, value, filterMode, isInitial = false) {
        // Legacy method - could be moved to StateMessageHelpers
        const StateMessageHelpers = require('./state-and-message-helpers').StateMessageHelpers;
        const displayValue = StateMessageHelpers.formatValueForDisplay(value);
        const statusText = isInitial ? `${stateId}: ${displayValue} (initial)` : `${stateId}: ${displayValue}`;
        this.updateConnectionStatus(node, 'ready', statusText);
    }

    static updateMultipleStatesStatus(node, states, outputMode) {
        const count = Object.keys(states).length;
        const statusText = outputMode === 'grouped' ? 
            `${count} states (grouped)` : 
            `${count} states (individual)`;
        this.updateConnectionStatus(node, 'ready', statusText);
    }
}

class NodeRegistrationHelpers extends NodeLifecycleHelpers {}

module.exports = { 
    NodeLifecycleHelpers
};
