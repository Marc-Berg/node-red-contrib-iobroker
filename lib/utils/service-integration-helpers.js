/*!
 * Service Integration Helper Functions for ioBroker Node-RED Integration
 * Unified utilities for subscription management and external service integration
 */

class ServiceIntegrationHelpers {
    /**
     * Setup subscription to ioBroker states through StateService
     */
    static subscribeToStates(node, stateId, requireServerConnection = false) {
        if (requireServerConnection && (!node.server || !node.server.connected)) {
            node.warn("Cannot subscribe to states: server not connected");
            return false;
        }

        const Orchestrator = require('../orchestrator');
        Orchestrator.subscribeToStates(node.id, stateId);
        return true;
    }

    /**
     * Setup subscription to ioBroker objects through StateService
     */
    static subscribeToObjects(node, objectId, requireServerConnection = false) {
        if (requireServerConnection && (!node.server || !node.server.connected)) {
            node.warn("Cannot subscribe to objects: server not connected");
            return false;
        }

        const Orchestrator = require('../orchestrator');
        Orchestrator.subscribeToObjects(node.id, objectId);
        return true;
    }

    /**
     * Setup subscription to ioBroker logs through ConnectionService
     */
    static subscribeToLogs(node, logLevel = 'silly', requireServerConnection = false) {
        if (requireServerConnection && (!node.server || !node.server.connected)) {
            node.warn("Cannot subscribe to logs: server not connected");
            return false;
        }

        const Orchestrator = require('../orchestrator');
        Orchestrator.subscribeToLogs(node.id, logLevel);
        return true;
    }

    /**
     * Request initial state value through StateService
     */
    static requestInitialState(node, stateId) {
        const Orchestrator = require('../orchestrator');
        Orchestrator.getInitialState(node.id, stateId);
    }

    /**
     * Set state value through StateService
     */
    static setState(node, stateId, value, ack = false) {
        const Orchestrator = require('../orchestrator');
        Orchestrator.setState(node.id, stateId, value, ack);
    }

    /**
     * Get object through StateService
     */
    static getObject(node, objectId) {
        const Orchestrator = require('../orchestrator');
        Orchestrator.getObject(node.id, objectId);
    }

    /**
     * Set object through StateService
     */
    static setObject(node, objectId, obj) {
        const Orchestrator = require('../orchestrator');
        Orchestrator.setObject(node.id, objectId, obj);
    }

    /**
     * Send command to adapter through SendToService
     */
    static sendToAdapter(node, adapter, command, message) {
        const Orchestrator = require('../orchestrator');
        Orchestrator.sendTo(node.id, adapter, command, message);
    }

    /**
     * Request history data through HistoryService
     */
    static requestHistory(node, stateId, options) {
        const Orchestrator = require('../orchestrator');
        Orchestrator.getHistory(node.id, stateId, options);
    }

    /**
     * Validate service configuration
     */
    static validateServiceConfig(node, serviceName, config) {
        if (!node.server || !node.server.connected) {
            throw new Error(`${serviceName}: Server not connected`);
        }

        if (!config) {
            throw new Error(`${serviceName}: Missing configuration`);
        }

        return true;
    }

    /**
     * Check if external trigger should be ignored
     */
    static shouldIgnoreExternalTrigger(node, msg) {
        // Check if message is from this node (avoid loops)
        if (msg._nodeId === node.id) {
            return true;
        }

        // Check if message has external trigger flag
        if (msg._ignoreExternalTrigger) {
            return true;
        }

        // Check for other loop prevention mechanisms
        if (msg._fromIobroker && node.ignoreOwnEvents) {
            return true;
        }

        return false;
    }

    /**
     * Create external trigger context
     */
    static createExternalTriggerContext(sourceNode, targetStateId) {
        return {
            _nodeId: sourceNode.id,
            _triggeredBy: 'external',
            _targetState: targetStateId,
            _timestamp: Date.now()
        };
    }

    /**
     * Format error for service response
     */
    static formatServiceError(error, serviceName, operation) {
        return {
            error: true,
            service: serviceName,
            operation: operation,
            message: error.message || 'Unknown error',
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Handle service timeout
     */
    static handleServiceTimeout(node, serviceName, operation, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`${serviceName} ${operation} timeout after ${timeoutMs}ms`));
            }, timeoutMs);

            // Return cleanup function
            return () => clearTimeout(timeout);
        });
    }
}

// Legacy exports for backward compatibility
class SubscriptionHelpers {
    static subscribeToStates(node, stateId) {
        return ServiceIntegrationHelpers.subscribeToStates(node, stateId);
    }

    static subscribeToObjects(node, objectId) {
        return ServiceIntegrationHelpers.subscribeToObjects(node, objectId);
    }

    static subscribeToLogs(node, logLevel) {
        return ServiceIntegrationHelpers.subscribeToLogs(node, logLevel);
    }
}

class ExternalTriggerHelpers {
    static shouldIgnoreExternalTrigger(node, msg) {
        return ServiceIntegrationHelpers.shouldIgnoreExternalTrigger(node, msg);
    }

    static createExternalTriggerContext(sourceNode, targetStateId) {
        return ServiceIntegrationHelpers.createExternalTriggerContext(sourceNode, targetStateId);
    }
}

module.exports = { 
    ServiceIntegrationHelpers,
    SubscriptionHelpers,        // For backward compatibility
    ExternalTriggerHelpers      // For backward compatibility
};
