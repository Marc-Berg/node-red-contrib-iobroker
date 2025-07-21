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

        return false;
    }

    /**
     * Start subscriptions after node registration
     */
    static startSubscriptionsAfterRegistration(node) {
        if (!node.serverReady) {
            node.log('Server not ready yet, waiting...');
            return;
        }
        
        const { ErrorAndLoggerHelpers } = require('./error-and-logger-helpers');
        ErrorAndLoggerHelpers.updateConnectionStatus(node, 'connected', 'Starting subscriptions...');
        
        // Subscribe to states based on input mode
        const Orchestrator = require('../orchestrator');
        
        if (node.inputMode === 'single') {
            if (node.isWildcardPattern) {
                // For wildcard patterns, subscribe to the pattern
                node.log(`Subscribing to wildcard pattern: ${node.stateId}`);
                Orchestrator.subscribe(node.id, node.stateId);
            } else {
                // For single states, subscribe directly
                node.log(`Subscribing to single state: ${node.stateId}`);
                Orchestrator.subscribe(node.id, node.stateId);
            }
        } else if (node.inputMode === 'multiple' && node.statesList) {
            // For multiple states, subscribe to each state
            node.log(`Subscribing to ${node.statesList.length} states`);
            node.statesList.forEach(stateId => {
                Orchestrator.subscribe(node.id, stateId);
            });
        }
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

    /**
     * Register node for external triggering
     */
    static registerNodeForExternalTrigger(node) {
        if (!node.enableExternalTrigger) return;
        
        // Register the node's sendCachedValues function for external triggers
        if (typeof node.sendCachedValues === 'function') {
            // Store reference for external trigger mechanism
            if (!global.ioBrokerExternalTriggerNodes) {
                global.ioBrokerExternalTriggerNodes = new Map();
            }
            
            const triggerGroup = node.triggerGroup || 'iobroker_in_nodes';
            if (!global.ioBrokerExternalTriggerNodes.has(triggerGroup)) {
                global.ioBrokerExternalTriggerNodes.set(triggerGroup, new Set());
            }
            
            global.ioBrokerExternalTriggerNodes.get(triggerGroup).add(node);
            node.log(`Node registered for external trigger in group: ${triggerGroup}`);
        }
    }

    /**
     * Handle server ready for subscription helpers
     */
    static handleServerReady(node, { serverId }) {
        if (serverId === node.server.id) {
            node.log(`Server ${serverId} is ready`);
            
            // Update status to connected
            const { ErrorAndLoggerHelpers } = require('./error-and-logger-helpers');
            ErrorAndLoggerHelpers.updateConnectionStatus(node, 'connected', 'Server ready, waiting for registration...');
            
            // Store that server is ready - subscription will happen after node registration
            node.serverReady = true;
        }
    }

    /**
     * Handle subscription confirmed
     */
    static handleSubscriptionConfirmed(node, { serverId, stateId }, requestInitialValue, requestBaselineValue) {
        if (serverId === node.server.id) {
            node.log(`Subscription confirmed for ${stateId}`);
            node.isSubscribed = true;
            
            // Track subscribed states
            if (!node.subscribedStates.includes(stateId)) {
                node.subscribedStates.push(stateId);
            }
            
            // Update status to show subscription is active
            const { ErrorAndLoggerHelpers } = require('./error-and-logger-helpers');
            
            if (node.inputMode === 'single') {
                const statusText = node.isWildcardPattern 
                    ? `Listening to pattern: ${node.stateId}` 
                    : `Listening: ${stateId}`;
                ErrorAndLoggerHelpers.updateConnectionStatus(node, 'connected', statusText);
            } else if (node.inputMode === 'multiple') {
                const subscribedCount = node.subscribedStates.length;
                const totalCount = node.statesList ? node.statesList.length : 1;
                const statusText = `Subscribed ${subscribedCount}/${totalCount} states`;
                ErrorAndLoggerHelpers.updateConnectionStatus(node, 'connected', statusText);
            }
            
            // Request initial values if needed
            if (node.sendInitialValue && requestInitialValue && typeof requestInitialValue === 'function') {
                node.log(`Requesting initial value for ${stateId}`);
                requestInitialValue(stateId);
            }
            
            // Request baseline values for filter mode
            if (node.filterMode === 'changes-smart' && requestBaselineValue && typeof requestBaselineValue === 'function') {
                node.log(`Requesting baseline value for ${stateId}`);
                requestBaselineValue(stateId);
            }
            
            // If no initial values are requested, update final status now
            if (!node.sendInitialValue && node.filterMode !== 'changes-smart') {
                if (node.inputMode === 'single') {
                    const statusText = node.isWildcardPattern 
                        ? `Ready for pattern: ${node.stateId}` 
                        : `Ready: ${stateId}`;
                    ErrorAndLoggerHelpers.updateConnectionStatus(node, 'connected', statusText);
                } else if (node.inputMode === 'multiple') {
                    const subscribedCount = node.subscribedStates.length;
                    const totalCount = node.statesList ? node.statesList.length : 1;
                    if (subscribedCount >= totalCount) {
                        ErrorAndLoggerHelpers.updateConnectionStatus(node, 'connected', `Ready: ${totalCount} states`);
                    }
                }
            }
        }
    }
}

module.exports = { 
    ServiceIntegrationHelpers
};
