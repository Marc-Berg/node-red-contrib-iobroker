const Orchestrator = require('../lib/orchestrator');
const { MessageHelpers } = require('../lib/utils/message-helpers');
const { FilterHelpers } = require('../lib/utils/filter-helpers');
const { StatusHelpers } = require('../lib/utils/status-helpers');
const { WildcardHelpers } = require('../lib/utils/wildcard-helpers');
const { StateManagementHelpers } = require('../lib/utils/state-management-helpers');
const { ExternalTriggerHelpers } = require('../lib/utils/external-trigger-helpers');
const { NodeRegistrationHelpers } = require('../lib/utils/node-registration-helpers');
const { SubscriptionHelpers } = require('../lib/utils/subscription-helpers');

module.exports = function(RED) {
    function IoBrokerInNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        node.server = RED.nodes.getNode(config.server);
        node.stateId = config.state;
        node.isSubscribed = false;
        
        node.sendInitialValue = config.sendInitialValue || false;
        node.outputProperty = config.outputProperty || "payload";
        node.filterMode = config.filterMode || "all";
        node.ackFilter = config.ackFilter || "both";
        node.inputMode = config.inputMode || "single";
        node.multipleStates = config.multipleStates || "";
        node.outputMode = config.outputMode || "individual";
        
        node.enableExternalTrigger = config.enableExternalTrigger !== false;
        node.triggerGroup = config.triggerGroup || 'iobroker_in_nodes';
        
        node.log(`Node configuration: inputMode=${node.inputMode}, sendInitialValue=${node.sendInitialValue}, outputMode=${node.outputMode}, outputProperty=${node.outputProperty}, filterMode=${node.filterMode}, ackFilter=${node.ackFilter}, multipleStates="${node.multipleStates}", enableExternalTrigger=${node.enableExternalTrigger}, triggerGroup=${node.triggerGroup}`);
        
        const stateTracking = StateManagementHelpers.initializeStateTracking();
        Object.assign(node, stateTracking);
        
        node.initialValueTimeout = null;
        
        node.pendingGroupedStates = null;
        node.groupedUpdateTriggeredBy = null;
        node.groupedTimeout = null;
        
        if (node.inputMode === 'multiple' && node.multipleStates) {
            node.statesList = StateManagementHelpers.parseMultipleStates(node.multipleStates);
            node.log(`Parsed ${node.statesList.length} states: [${node.statesList.join(', ')}]`);
        }
        
        node.isRegistered = false;
        
        const sendMessage = (message, description = '') => {
            if (description) {
                node.log(`Sending message: ${description}`);
            }
            node.send(message);
        };
        
        function updateNodeStatus(stateId, value, isInitial = false) {
            if (node.inputMode === 'single') {
                StatusHelpers.updateSingleStateStatus(node, stateId, value, node.filterMode, isInitial);
            } else if (node.inputMode === 'multiple') {
                StatusHelpers.updateMultipleStatesStatus(node, node.statesList, node.outputMode, node.filterMode);
            }
        }
        
        // Only validate wildcards when in single mode
        let wildcardValidation = { isWildcard: false, valid: true };
        if (node.inputMode === 'single') {
            wildcardValidation = WildcardHelpers.validateWildcardConfig(
                node.inputMode, 
                node.stateId, 
                node.sendInitialValue
            );
            
            node.isWildcardPattern = wildcardValidation.isWildcard;
            
            if (wildcardValidation.isWildcard && !wildcardValidation.valid) {
                node.status({ fill: "red", shape: "dot", text: wildcardValidation.error });
                return;
            }
            
            if (wildcardValidation.adjustments) {
                if (wildcardValidation.adjustments.sendInitialValue !== undefined) {
                    node.sendInitialValue = wildcardValidation.adjustments.sendInitialValue;
                }
            }
        } else {
            // For multiple mode, wildcard patterns are not relevant
            node.isWildcardPattern = false;
        }

        const stateValidation = StateManagementHelpers.validateStateConfiguration(
            node.inputMode, 
            node.stateId, 
            node.statesList
        );
        
        if (!stateValidation.valid) {
            const errorMessage = stateValidation.errors[0];
            node.status({ fill: "red", shape: "dot", text: `Error: ${errorMessage}` });
            return;
        }

        if (!node.server) {
            node.status({ fill: "red", shape: "dot", text: "Error: Server not configured" });
            return;
        }

        node.sendCachedValues = function() {
            ExternalTriggerHelpers.sendCachedValues(node);
        };

        node.currentStateValues = new Map();
        node.lastValue = undefined;

        ExternalTriggerHelpers.registerNodeForExternalTrigger(node);

        const onServerReady = ({ serverId }) => {
            SubscriptionHelpers.handleServerReady(node, { serverId });
        };

        const onSubscriptionConfirmed = ({ serverId, stateId }) => {
            SubscriptionHelpers.handleSubscriptionConfirmed(node, { serverId, stateId }, requestInitialValue, requestBaselineValue);
        };

        const onStateChanged = ({ serverId, stateId, state }) => {
            if (serverId === node.server.id) {
                if (!FilterHelpers.shouldSendMessage(state.ack, node.ackFilter)) {
                    return;
                }
                
                if (node.inputMode === 'single') {
                    if (node.isWildcardPattern) {
                        if (!WildcardHelpers.matchesWildcardPattern(stateId, node.stateId)) {
                            return;
                        }
                    } else {
                        if (stateId !== node.stateId) {
                            return;
                        }
                    }
                    
                    if (FilterHelpers.shouldFilterValue(stateId, state.val, node.previousValues, node.filterMode, false, (msg) => node.log(msg))) {
                        FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                        return;
                    }
                    
                    const message = MessageHelpers.createEnhancedMessage(state, stateId, node.outputProperty, {
                        pattern: node.isWildcardPattern ? node.stateId : null
                    });
                    
                    node.currentStateValues.set(stateId, state);
                    if (node.inputMode === 'single') {
                        node.lastValue = state.val;
                    }
                    
                    FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                    
                    updateNodeStatus(stateId, state.val, false);
                    
                    sendMessage(message);
                    
                } else if (node.inputMode === 'multiple') {
                    if (!node.statesList.includes(stateId)) {
                        return;
                    }
                    
                    if (node.outputMode === 'individual') {
                        if (FilterHelpers.shouldFilterValue(stateId, state.val, node.previousValues, node.filterMode, false, (msg) => node.log(msg))) {
                            FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                            return;
                        }
                        
                        const message = MessageHelpers.createEnhancedMessage(state, stateId, node.outputProperty, {
                            multipleStatesMode: true
                        });
                        
                        node.currentStateValues.set(stateId, state);
                        
                        FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                        
                        updateNodeStatus(stateId, state.val, false);
                        
                        sendMessage(message);
                        
                    } else if (node.outputMode === 'grouped') {
                        node.currentStateValues.set(stateId, state);
                        
                        StateManagementHelpers.storeGroupedStateValue(node.groupedStateValues, stateId, state);
                        
                        const missingStates = StateManagementHelpers.getMissingStates(node.groupedStateValues, node.statesList);
                        
                        if (missingStates.length > 0) {
                            node.log(`Grouped mode: Missing ${missingStates.length} states, requesting current values: [${missingStates.join(', ')}]`);
                            
                            node.pendingGroupedStates = new Set(missingStates);
                            node.groupedUpdateTriggeredBy = stateId;
                            
                            missingStates.forEach(missingStateId => {
                                Orchestrator.getState(node.id, missingStateId);
                            });
                            
                            node.groupedTimeout = StateManagementHelpers.setupGroupedTimeout(node, 2000, () => {
                                if (Object.keys(node.groupedStateValues).length > 0) {
                                    node.log(`Grouped mode: Timeout reached, sending partial grouped message`);
                                    const partialGroupedMessage = MessageHelpers.createGroupedMessage(
                                        node.groupedStateValues, 
                                        node.outputProperty, 
                                        {
                                            topic: 'grouped_states',
                                            triggeredBy: node.groupedUpdateTriggeredBy,
                                            partial: true
                                        }
                                    );
                                    
                                    sendMessage(partialGroupedMessage);
                                }
                                node.pendingGroupedStates = null;
                                node.groupedUpdateTriggeredBy = null;
                                node.groupedTimeout = null;
                            });
                            
                        } else {
                            node.log(`Grouped mode: All states available, sending grouped message immediately`);
                            const groupedMessage = MessageHelpers.createGroupedMessage(
                                node.groupedStateValues, 
                                node.outputProperty, 
                                {
                                    topic: 'grouped_states',
                                    triggeredBy: stateId
                                }
                            );
                            
                            sendMessage(groupedMessage);
                        }
                    }
                }
            }
        };
        
        function requestInitialValue(targetStateId) {
            const stateToRequest = targetStateId || node.stateId;
            
            if (node.inputMode === 'single' && node.isWildcardPattern) {
                return;
            }
            
            node.log(`Requesting initial value for state: ${stateToRequest}`);
            Orchestrator.getState(node.id, stateToRequest);
        }
        
        function requestBaselineValue(targetStateId) {
            const stateToRequest = targetStateId || node.stateId;
            
            if (node.inputMode === 'single' && node.isWildcardPattern) {
                return;
            }
            
            node.log(`Requesting baseline value for changes-smart mode: ${stateToRequest}`);
            StateManagementHelpers.trackBaselineRequest(node.pendingBaselineRequests, stateToRequest);
            Orchestrator.getState(node.id, stateToRequest);
        }
        
        const onInitialStateValue = ({ serverId, stateId, state, nodeId }) => {
            node.log(`Initial value response: serverId=${serverId}, stateId=${stateId}, nodeId=${nodeId}, state=${state ? 'present' : 'null'}`);
            
            const isBaselineRequest = StateManagementHelpers.isBaselineRequest(node.pendingBaselineRequests, stateId);
            
            if (serverId === node.server.id && nodeId === node.id) {
                const isRelevantState = (node.inputMode === 'single' && stateId === node.stateId) ||
                                      (node.inputMode === 'multiple' && node.statesList.includes(stateId));
                
                if (isRelevantState && state) {
                    if (isBaselineRequest) {
                        node.log(`Setting baseline value for changes-smart mode: ${stateId} = ${state.val}`);
                        FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                        StateManagementHelpers.completeBaselineRequest(node.pendingBaselineRequests, stateId);
                        return;
                    }
                    
                    node.log(`Processing initial value for ${stateId}: ${state.val}`);
                    
                    if (!FilterHelpers.shouldSendMessage(state.ack, node.ackFilter)) {
                        node.log(`Initial value filtered by ACK filter for ${stateId}`);
                        return;
                    }
                    
                    if (node.inputMode === 'single') {
                        if (FilterHelpers.shouldFilterValue(stateId, state.val, node.previousValues, node.filterMode, true, (msg) => node.log(msg))) {
                            FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                            return;
                        }
                        
                        const message = MessageHelpers.createEnhancedMessage(state, stateId, node.outputProperty, {
                            initial: true
                        });
                        
                        node.currentStateValues.set(stateId, state);
                        node.lastValue = state.val;
                        
                        FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                        
                        updateNodeStatus(stateId, state.val, true);
                        
                        sendMessage(message, "initial value");
                        
                    } else if (node.inputMode === 'multiple') {
                        if (node.outputMode === 'individual') {
                            if (FilterHelpers.shouldFilterValue(stateId, state.val, node.previousValues, node.filterMode, true, (msg) => node.log(msg))) {
                                FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                                return;
                            }
                            
                            const message = MessageHelpers.createEnhancedMessage(state, stateId, node.outputProperty, {
                                initial: true,
                                multipleStatesMode: true
                            });
                            
                            node.currentStateValues.set(stateId, state);
                            
                            FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                            
                            StateManagementHelpers.storeGroupedStateValue(node.groupedStateValues, stateId, state);
                            
                            sendMessage(message, "initial value");
                            
                            const receivedCount = Object.keys(node.groupedStateValues).length;
                            const totalCount = node.statesList.length;
                            StatusHelpers.updateInitialValuesProgress(node, receivedCount, totalCount);
                            
                        } else if (node.outputMode === 'grouped') {
                            if (node.pendingGroupedStates && node.pendingGroupedStates.has(stateId)) {
                                node.log(`Grouped mode: Received missing state for grouped update: ${stateId}: ${state.val}`);
                                
                                StateManagementHelpers.storeGroupedStateValue(node.groupedStateValues, stateId, state);
                                
                                node.currentStateValues.set(stateId, state);
                                
                                node.pendingGroupedStates.delete(stateId);
                                
                                if (node.pendingGroupedStates.size === 0) {
                                    node.log(`Grouped mode: All missing states received, sending complete grouped message`);
                                    
                                    if (node.groupedTimeout) {
                                        clearTimeout(node.groupedTimeout);
                                        node.groupedTimeout = null;
                                    }
                                    
                                    const completeGroupedMessage = MessageHelpers.createGroupedMessage(
                                        node.groupedStateValues, 
                                        node.outputProperty, 
                                        {
                                            topic: 'grouped_states',
                                            triggeredBy: node.groupedUpdateTriggeredBy
                                        }
                                    );
                                    
                                    sendMessage(completeGroupedMessage);
                                    
                                    node.pendingGroupedStates = null;
                                    node.groupedUpdateTriggeredBy = null;
                                }
                                
                                return;
                            }
                            
                            StateManagementHelpers.storeGroupedStateValue(node.groupedStateValues, stateId, state);
                            
                            node.currentStateValues.set(stateId, state);
                            
                            node.log(`Grouped mode: Stored initial value for ${stateId}. Now have ${Object.keys(node.groupedStateValues).length}/${node.statesList.length} values`);
                            
                            const hasAllInitialValues = StateManagementHelpers.areAllInitialValuesReceived(node.groupedStateValues, node.statesList);
                            
                            node.log(`Grouped mode: hasAllInitialValues = ${hasAllInitialValues}`);
                            
                            if (hasAllInitialValues) {
                                node.log(`Grouped mode: All initial values received. Sending grouped message.`);
                                if (node.initialValueTimeout) {
                                    clearTimeout(node.initialValueTimeout);
                                    node.initialValueTimeout = null;
                                }
                                
                                const groupedMessage = MessageHelpers.createGroupedMessage(
                                    node.groupedStateValues, 
                                    node.outputProperty, 
                                    {
                                        topic: 'grouped_states_initial',
                                        isInitial: true
                                    }
                                );
                                
                                sendMessage(groupedMessage, "grouped initial values");
                                
                                setTimeout(() => {
                                    StatusHelpers.updateMultipleStatesStatus(node, node.statesList, node.outputMode, node.filterMode);
                                }, 1000);
                            }
                        }
                        
                        const receivedCount = Object.keys(node.groupedStateValues).length;
                        const totalCount = node.statesList.length;
                        StatusHelpers.updateInitialValuesProgress(node, receivedCount, totalCount);
                        
                        if (receivedCount === totalCount && node.outputMode === 'individual') {
                            setTimeout(() => {
                                StatusHelpers.updateMultipleStatesStatus(node, node.statesList, node.outputMode, node.filterMode);
                            }, 1000);
                        }
                    }
                }
            }
        };
        
        const onDisconnected = ({ serverId }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'disconnected');
                node.isSubscribed = false;
            }
        };

        const onRetrying = ({ serverId, attempt, delay }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'retrying', `Retrying in ${delay / 1000}s (Attempt #${attempt})`);
            }
        };

        const onPermanentFailure = ({ serverId, error }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'error', `Failed: ${error.message}`);
            }
        };

        const registerWithOrchestrator = () => {
            NodeRegistrationHelpers.registerWithOrchestrator(node);
        };

        const eventHandlers = {
            onServerReady,
            onSubscriptionConfirmed,
            onStateChanged,
            onInitialStateValue,
            onDisconnected,
            onRetrying,
            onPermanentFailure
        };

        // Use immediate registration with event listeners
        NodeRegistrationHelpers.setupDelayedRegistrationWithListeners(node, eventHandlers, 0);

        const cleanupCallbacks = [
            () => StateManagementHelpers.cleanupTimeout(node, 'initialValueTimeout'),
            () => StateManagementHelpers.cleanupTimeout(node, 'groupedTimeout'),
            () => ExternalTriggerHelpers.unregisterNodeFromExternalTrigger(node)
        ];

        NodeRegistrationHelpers.setupCloseHandler(node, eventHandlers, cleanupCallbacks);

        const initialStatusText = node.isWildcardPattern 
            ? `Waiting for pattern: ${node.stateId}` 
            : "Waiting for server...";
        StatusHelpers.updateConnectionStatus(node, 'waiting', initialStatusText);
    }

    RED.nodes.registerType("iobin", IoBrokerInNode);
};