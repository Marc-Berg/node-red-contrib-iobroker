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
    static handleServerReady(node, { serverId }) {
        if (serverId === node.server.id && node.isRegistered) {
            // Check if already subscribed to avoid duplicate subscriptions
            if (node.isSubscribed) {
                node.log(`Server ready but node already subscribed`);
                return;
            }
            
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
            }
        } else {
            if (stateId === node.stateId) {
                node.status({ fill: "green", shape: "ring", text: `Subscribed to ${node.stateId}` });
                node.isSubscribed = true;
                
                if (node.sendInitialValue && !node.isWildcardPattern) {
                    requestInitialValue();
                }
                
                if (node.filterMode === 'changes-smart' && !node.sendInitialValue && !node.isWildcardPattern) {
                    node.log(`Changes-smart mode: requesting baseline value for ${node.stateId}`);
                    requestBaselineValue();
                }
            }
        }
    }

    /**
     * Handle multiple states subscription confirmation
     */
    static _handleMultipleSubscriptionConfirmed(node, stateId, requestInitialValue, requestBaselineValue) {
        if (node.statesList.includes(stateId)) {
            node.subscribedStates.add(stateId);
            
            node.log(`Multiple states: Subscription confirmed for ${stateId} (${node.subscribedStates.size}/${node.statesList.length})`);
            
            StatusHelpers.updateSubscriptionProgress(node, node.subscribedStates.size, node.statesList.length);
            
            // Set isSubscribed to true when all states are subscribed
            if (StateManagementHelpers.areAllStatesSubscribed(node.subscribedStates, node.statesList)) {
                node.isSubscribed = true;
            }
            
            node.log(`Checking for initial values: subscribedStates=${node.subscribedStates.size}, totalStates=${node.statesList.length}, sendInitialValue=${node.sendInitialValue}`);
            
            if (StateManagementHelpers.areAllStatesSubscribed(node.subscribedStates, node.statesList) && node.sendInitialValue) {
                SubscriptionHelpers._requestInitialValuesForAllStates(node, requestInitialValue);
            }
            
            if (StateManagementHelpers.areAllStatesSubscribed(node.subscribedStates, node.statesList) && 
                node.filterMode === 'changes-smart' && !node.sendInitialValue) {
                SubscriptionHelpers._requestBaselineValuesForAllStates(node, requestBaselineValue);
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
                }, 2000);
            }
            
            node.statesList.forEach(state => {
                if (!node.initialValuesRequested.has(state)) {
                    node.log(`Requesting initial value for: ${state}`);
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
                    node.log(`Requesting baseline value for: ${state}`);
                    node.initialValuesRequested.add(state);
                    requestBaselineValue(state);
                }
            });
        }, 100);
    }
}

module.exports = { SubscriptionHelpers };
