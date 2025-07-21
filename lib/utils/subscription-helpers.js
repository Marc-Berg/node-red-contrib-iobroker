/*!
 * Subscription Helper Functions for ioBroker Node-RED Integration
 * Utilities for managing state subscriptions
 */

const Orchestrator = require('../orchestrator');
const { StatusHelpers } = require('./status-helpers');
const { WildcardHelpers } = require('./wildcard-helpers');
const { StateManagementHelpers } = require('./state-management-helpers');
const { MessageHelpers } = require('./message-helpers');

class SubscriptionHelpers {
    /**
     * Handle server ready event and subscribe to states
     */
    static handleServerReady(node, { serverId, isReconnect }) {
        if (serverId === node.server.id && node.isRegistered) {
            // Reset subscription state for reconnect scenarios
            if (node.isSubscribed) {
                node.log(`Server ready after ${isReconnect ? 'reconnect/token refresh' : 'connection'} - resetting subscription state`);
                SubscriptionHelpers._resetSubscriptionState(node);
            }
            
            // Store reconnect flag for later use in subscription confirmation
            node._isReconnecting = isReconnect;
            
            if (node.inputMode === 'single') {
                StatusHelpers.updateConnectionStatus(node, 'subscribing', `Subscribing to ${node.stateId}...`);
                Orchestrator.subscribe(node.id, node.stateId);
            } else if (node.inputMode === 'multiple') {
                StatusHelpers.updateConnectionStatus(node, 'subscribing', `Subscribing to ${node.statesList.length} states...`);
                
                node.statesList.forEach(stateId => {
                    Orchestrator.subscribe(node.id, stateId);
                });
            }
            // Note: isSubscribed will be set to true in subscription confirmation handler
        } else if (serverId === node.server.id && !node.isRegistered) {
            node.log(`Server ready but node not yet registered. Will subscribe after registration.`);
        }
    }

    /**
     * Reset subscription state for clean re-subscription
     */
    static _resetSubscriptionState(node) {
        node.isSubscribed = false;
        
        if (node.inputMode === 'multiple') {
            // Clear subscription tracking
            if (node.subscribedStates) {
                node.subscribedStates.clear();
            }
            
            // Clear initial value tracking only if this is a true reconnect
            // For first-time connections, we want to preserve the ability to request initial values
            if (node._isReconnecting) {
                if (node.initialValuesRequested) {
                    node.initialValuesRequested.clear();
                }
                
                // Clear timeout if running
                if (node.initialValueTimeout) {
                    clearTimeout(node.initialValueTimeout);
                    node.initialValueTimeout = null;
                }
            }
            
            // Reset grouped values
            if (node.groupedStateValues) {
                Object.keys(node.groupedStateValues).forEach(key => {
                    delete node.groupedStateValues[key];
                });
            }
        }
        
        node.log(`Subscription state reset for ${node._isReconnecting ? 'reconnection/token refresh' : 'connection'}`);
    }

    /**
     * Handle subscription confirmation
     */
    static handleSubscriptionConfirmed(node, { serverId, stateId }, requestInitialValue, requestBaselineValue) {
        if (serverId === node.server.id) {
            if (node.inputMode === 'single') {
                SubscriptionHelpers._handleSingleSubscriptionConfirmed(node, stateId, requestInitialValue, requestBaselineValue);
            } else if (node.inputMode === 'multiple') {
                SubscriptionHelpers._handleMultipleSubscriptionConfirmed(node, stateId, requestInitialValue, requestBaselineValue);
            }
        }
    }

    /**
     * Handle single state subscription confirmation
     */
    static _handleSingleSubscriptionConfirmed(node, stateId, requestInitialValue, requestBaselineValue) {
        if (node.isWildcardPattern) {
            if (WildcardHelpers.matchesWildcardPattern(stateId, node.stateId)) {
                StatusHelpers.updateWildcardStatus(node, node.stateId, true);
                node.isSubscribed = true;
                SubscriptionHelpers.trackSubscription(node, stateId);
                
                // For wildcard patterns, we also respect the reconnect flag
                if (node._isReconnecting) {
                    node.log(`Wildcard: Skipping actions due to reconnect/token refresh`);
                }
                
                // Clear reconnect flag after processing
                node._isReconnecting = false;
            }
        } else {
            if (stateId === node.stateId) {
                node.status({ fill: "green", shape: "ring", text: `Subscribed to ${node.stateId}` });
                node.isSubscribed = true;
                SubscriptionHelpers.trackSubscription(node, stateId);
                
                // Only request initial values if this is NOT a reconnect/token refresh
                if (node.sendInitialValue && !node.isWildcardPattern && !node._isReconnecting) {
                    requestInitialValue();
                } else if (node._isReconnecting) {
                    node.log(`Skipping initial value request due to reconnect/token refresh`);
                }
                
                // Only request baseline values if this is NOT a reconnect/token refresh
                if (node.filterMode === 'changes-smart' && !node.sendInitialValue && !node.isWildcardPattern && !node._isReconnecting) {
                    node.log(`Changes-smart mode: requesting baseline value for ${node.stateId}`);
                    requestBaselineValue();
                } else if (node._isReconnecting && node.filterMode === 'changes-smart') {
                    node.log(`Skipping baseline value request due to reconnect/token refresh`);
                }
                
                // Clear reconnect flag after processing
                node._isReconnecting = false;
            }
        }
    }

    /**
     * Handle multiple states subscription confirmation
     */
    static _handleMultipleSubscriptionConfirmed(node, stateId, requestInitialValue, requestBaselineValue) {
        if (node.statesList.includes(stateId)) {
            // Prevent duplicate subscription tracking
            if (node.subscribedStates.has(stateId)) {
                return;
            }
            
            node.subscribedStates.add(stateId);
            SubscriptionHelpers.trackSubscription(node, stateId);
            
            node.log(`Multiple states: Subscription confirmed for ${stateId} (${node.subscribedStates.size}/${node.statesList.length})`);
            
            StatusHelpers.updateSubscriptionProgress(node, node.subscribedStates.size, node.statesList.length);
            
            // Set isSubscribed to true when all states are subscribed
            if (StateManagementHelpers.areAllStatesSubscribed(node.subscribedStates, node.statesList)) {
                node.isSubscribed = true;
                
                node.log(`Checking for initial values: subscribedStates=${node.subscribedStates.size}, totalStates=${node.statesList.length}, sendInitialValue=${node.sendInitialValue}, isReconnecting=${node._isReconnecting}`);
                
                // Only request initial values if we haven't already done so AND this is NOT a reconnect/token refresh
                if (node.sendInitialValue && !node.initialValuesRequested.size && !node._isReconnecting) {
                    SubscriptionHelpers._requestInitialValuesForAllStates(node, requestInitialValue);
                } else if (node.sendInitialValue && node.initialValuesRequested.size > 0) {
                    // Already requested, skip
                } else if (node._isReconnecting) {
                    node.log(`Skipping initial values request due to reconnect/token refresh`);
                }
                
                // Only request baseline values if this is NOT a reconnect/token refresh
                if (node.filterMode === 'changes-smart' && !node.sendInitialValue && !node._isReconnecting) {
                    SubscriptionHelpers._requestBaselineValuesForAllStates(node, requestBaselineValue);
                } else if (node._isReconnecting && node.filterMode === 'changes-smart') {
                    node.log(`Skipping baseline values request due to reconnect/token refresh`);
                }
                
                // Clear reconnect flag after processing all subscriptions
                node._isReconnecting = false;
            }
        }
    }

    /**
     * Request initial values for all states
     */
    static _requestInitialValuesForAllStates(node, requestInitialValue) {
        node.log(`All states subscribed. Requesting initial values for ${node.statesList.length} states.`);
        
        setTimeout(() => {
            if (node.outputMode === 'grouped') {
                // Clear any existing timeout to prevent duplicates
                if (node.initialValueTimeout) {
                    clearTimeout(node.initialValueTimeout);
                    node.initialValueTimeout = null;
                }
                
                node.initialValueTimeout = setTimeout(() => {
                    node.log(`Initial value timeout reached. Sending partial data.`);
                    if (Object.keys(node.groupedStateValues).length > 0) {
                        const partialGroupedMessage = MessageHelpers.createGroupedMessage(
                            node.groupedStateValues, 
                            node.outputProperty, 
                            {
                                topic: 'grouped_states_initial',
                                isInitial: true,
                                partial: true
                            }
                        );
                        
                        node.send(partialGroupedMessage);
                        node.log(`Sending message: grouped initial values (partial)`);
                    }
                    StatusHelpers.updatePartialDataStatus(node, "Partial initial values (timeout)");
                    node.initialValueTimeout = null;
                }, 2000);
            }
            
            node.statesList.forEach(state => {
                if (!node.initialValuesRequested.has(state)) {
                    node.initialValuesRequested.add(state);
                    requestInitialValue(state);
                }
            });
        }, 100);
    }

    /**
     * Request baseline values for all states
     */
    static _requestBaselineValuesForAllStates(node, requestBaselineValue) {
        node.log(`Changes-smart mode: requesting baseline values for ${node.statesList.length} states.`);
        
        setTimeout(() => {
            node.statesList.forEach(state => {
                if (!node.initialValuesRequested.has(state)) {
                    node.initialValuesRequested.add(state);
                    requestBaselineValue(state);
                }
            });
        }, 100);
    }

    /**
     * Cleanup subscriptions for a node
     * This should be called when a node is being reconfigured or closed
     */
    static cleanupSubscriptions(node) {
        if (!node.activeSubscriptions || node.activeSubscriptions.size === 0) {
            return;
        }

        node.log(`Cleaning up ${node.activeSubscriptions.size} subscriptions`);
        
        for (const stateId of node.activeSubscriptions) {
            Orchestrator.unsubscribe(node.id, stateId);
        }
        
        // Clear the tracking set
        node.activeSubscriptions.clear();
        node.isSubscribed = false;
    }

    /**
     * Initialize subscription tracking for a node
     */
    static initializeSubscriptionTracking(node) {
        if (!node.activeSubscriptions) {
            node.activeSubscriptions = new Set();
        }
    }

    /**
     * Track a successful subscription
     */
    static trackSubscription(node, stateId) {
        if (!node.activeSubscriptions) {
            node.activeSubscriptions = new Set();
        }
        node.activeSubscriptions.add(stateId);
    }
}

module.exports = { SubscriptionHelpers };
