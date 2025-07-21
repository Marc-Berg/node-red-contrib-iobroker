const Orchestrator = require('../lib/orchestrator');
const { StateMessageHelpers } = require('../lib/utils/state-and-message-helpers');
const { NodeLifecycleHelpers } = require('../lib/utils/node-lifecycle-helpers');
const { PatternHelpers } = require('../lib/utils/pattern-and-wildcard-helpers');
const { ServiceIntegrationHelpers } = require('../lib/utils/service-integration-helpers');
const { ErrorAndLoggerHelpers } = require('../lib/utils/error-and-logger-helpers');

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
        
        const stateTracking = StateMessageHelpers.initializeStateTracking();
        Object.assign(node, stateTracking);
        
        node.initialValueTimeout = null;
        
        node.pendingGroupedStates = null;
        node.groupedUpdateTriggeredBy = null;
        node.groupedTimeout = null;
        
        if (node.inputMode === 'multiple' && node.multipleStates) {
            node.statesList = StateMessageHelpers.parseMultipleStates(node.multipleStates);
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
                ErrorAndLoggerHelpers.updateSingleStateStatus(node, stateId, value, node.filterMode, isInitial);
            } else if (node.inputMode === 'multiple') {
                ErrorAndLoggerHelpers.updateMultipleStatesStatus(node, node.statesList, node.outputMode, node.filterMode);
            }
        }
        
        // Only validate wildcards when in single mode
        let wildcardValidation = { isWildcard: false, valid: true };
        if (node.inputMode === 'single') {
            wildcardValidation = PatternHelpers.validateWildcardConfig(
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

        const stateValidation = StateMessageHelpers.validateStateConfiguration(
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
            ServiceIntegrationHelpers.sendCachedValues(node);
        };

        node.currentStateValues = new Map();
        node.lastValue = undefined;

        ServiceIntegrationHelpers.registerNodeForExternalTrigger(node);

        const onServerReady = ({ serverId }) => {
            if (serverId === node.server.id) {
                node.log("Server connection ready");
                ErrorAndLoggerHelpers.updateConnectionStatus(node, 'connected', 'Starting subscriptions...');
                node.serverReady = true;
                
                // Subscribe to states based on input mode
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
        };

        const onSubscriptionConfirmed = ({ serverId, stateId }) => {
            if (serverId === node.server.id) {
                node.log(`Subscription confirmed for state: ${stateId}`);
                node.isSubscribed = true;
                
                if (node.sendInitialValue) {
                    if (node.inputMode === 'single') {
                        if (!node.isWildcardPattern) {
                            requestInitialValue(stateId);
                        }
                    } else if (node.inputMode === 'multiple') {
                        if (node.statesList.includes(stateId)) {
                            requestInitialValue(stateId);
                        }
                    }
                } else if (node.filterMode === 'changes-smart') {
                    if (node.inputMode === 'single') {
                        if (!node.isWildcardPattern) {
                            requestBaselineValue(stateId);
                        }
                    } else if (node.inputMode === 'multiple') {
                        if (node.statesList.includes(stateId)) {
                            requestBaselineValue(stateId);
                        }
                    }
                }
                
                // Update status to show we're ready
                if (node.inputMode === 'single') {
                    ErrorAndLoggerHelpers.updateConnectionStatus(node, 'connected', `Listening: ${stateId}`);
                } else if (node.inputMode === 'multiple') {
                    ErrorAndLoggerHelpers.updateConnectionStatus(node, 'connected', `Listening to ${node.statesList.length} states`);
                }
            }
        };

        const onStateChanged = ({ serverId, stateId, state }) => {
            if (serverId === node.server.id) {
                if (!StateMessageHelpers.shouldSendMessage(state.ack, node.ackFilter)) {
                    return;
                }
                
                if (node.inputMode === 'single') {
                    if (node.isWildcardPattern) {
                        if (!PatternHelpers.matchesWildcardPattern(stateId, node.stateId)) {
                            return;
                        }
                    } else {
                        if (stateId !== node.stateId) {
                            return;
                        }
                    }
                    
                    if (StateMessageHelpers.shouldFilterValue(stateId, state.val, node.previousValues, node.filterMode, false, (msg) => node.log(msg))) {
                        StateMessageHelpers.updatePreviousValue(node, stateId, state.val);
                        return;
                    }
                    
                    const message = StateMessageHelpers.createEnhancedMessage(state, stateId, node.outputProperty, {
                        pattern: node.isWildcardPattern ? node.stateId : null
                    });
                    
                    node.currentStateValues.set(stateId, state);
                    if (node.inputMode === 'single') {
                        node.lastValue = state.val;
                    }
                    
                    StateMessageHelpers.updatePreviousValue(node, stateId, state.val);
                    
                    updateNodeStatus(stateId, state.val, false);
                    
                    sendMessage(message);
                    
                } else if (node.inputMode === 'multiple') {
                    if (!node.statesList.includes(stateId)) {
                        return;
                    }
                    
                    if (node.outputMode === 'individual') {
                        if (StateMessageHelpers.shouldFilterValue(stateId, state.val, node.previousValues, node.filterMode, false, (msg) => node.log(msg))) {
                            StateMessageHelpers.updatePreviousValue(node, stateId, state.val);
                            return;
                        }
                        
                        const message = StateMessageHelpers.createEnhancedMessage(state, stateId, node.outputProperty, {
                            multipleStatesMode: true
                        });
                        
                        node.currentStateValues.set(stateId, state);
                        
                        StateMessageHelpers.updatePreviousValue(node, stateId, state.val);
                        
                        updateNodeStatus(stateId, state.val, false);
                        
                        sendMessage(message);
                        
                    } else if (node.outputMode === 'grouped') {
                        node.currentStateValues.set(stateId, state);
                        
                        StateMessageHelpers.storeGroupedStateValue(node.groupedStateValues, stateId, state);
                        
                        const missingStates = StateMessageHelpers.getMissingStates(node.groupedStateValues, node.statesList);
                        
                        if (missingStates.length > 0) {
                            node.log(`Grouped mode: Missing ${missingStates.length} states, requesting current values: [${missingStates.join(', ')}]`);
                            
                            node.pendingGroupedStates = new Set(missingStates);
                            node.groupedUpdateTriggeredBy = stateId;
                            
                            missingStates.forEach(missingStateId => {
                                Orchestrator.getState(node.id, missingStateId);
                            });
                            
                            node.groupedTimeout = StateMessageHelpers.setupGroupedTimeout(node, 2000, () => {
                                if (Object.keys(node.groupedStateValues).length > 0) {
                                    node.log(`Grouped mode: Timeout reached, sending partial grouped message`);
                                    const partialGroupedMessage = StateMessageHelpers.createGroupedMessage(
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
                            const groupedMessage = StateMessageHelpers.createGroupedMessage(
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
            StateMessageHelpers.trackBaselineRequest(node.pendingBaselineRequests, stateToRequest);
            Orchestrator.getState(node.id, stateToRequest);
        }
        
        const onInitialStateValue = ({ serverId, stateId, state, nodeId }) => {
            node.log(`Initial value response: serverId=${serverId}, stateId=${stateId}, nodeId=${nodeId}, state=${state ? 'present' : 'null'}`);
            
            const isBaselineRequest = StateMessageHelpers.isBaselineRequest(node.pendingBaselineRequests, stateId);
            
            if (serverId === node.server.id && nodeId === node.id) {
                const isRelevantState = (node.inputMode === 'single' && stateId === node.stateId) ||
                                      (node.inputMode === 'multiple' && node.statesList.includes(stateId));
                
                if (isRelevantState && state) {
                    if (isBaselineRequest) {
                        node.log(`Setting baseline value for changes-smart mode: ${stateId} = ${state.val}`);
                        StateMessageHelpers.updatePreviousValue(node, stateId, state.val);
                        StateMessageHelpers.completeBaselineRequest(node.pendingBaselineRequests, stateId);
                        return;
                    }
                    
                    node.log(`Processing initial value for ${stateId}: ${state.val}`);
                    
                    if (!StateMessageHelpers.shouldSendMessage(state.ack, node.ackFilter)) {
                        node.log(`Initial value filtered by ACK filter for ${stateId}`);
                        return;
                    }
                    
                    if (node.inputMode === 'single') {
                        if (StateMessageHelpers.shouldFilterValue(stateId, state.val, node.previousValues, node.filterMode, true, (msg) => node.log(msg))) {
                            StateMessageHelpers.updatePreviousValue(node, stateId, state.val);
                            return;
                        }
                        
                        const message = StateMessageHelpers.createEnhancedMessage(state, stateId, node.outputProperty, {
                            initial: true
                        });
                        
                        node.currentStateValues.set(stateId, state);
                        node.lastValue = state.val;
                        
                        StateMessageHelpers.updatePreviousValue(node, stateId, state.val);
                        
                        updateNodeStatus(stateId, state.val, true);
                        
                        sendMessage(message, "initial value");
                        
                    } else if (node.inputMode === 'multiple') {
                        if (node.outputMode === 'individual') {
                            if (StateMessageHelpers.shouldFilterValue(stateId, state.val, node.previousValues, node.filterMode, true, (msg) => node.log(msg))) {
                                StateMessageHelpers.updatePreviousValue(node, stateId, state.val);
                                return;
                            }
                            
                            const message = StateMessageHelpers.createEnhancedMessage(state, stateId, node.outputProperty, {
                                initial: true,
                                multipleStatesMode: true
                            });
                            
                            node.currentStateValues.set(stateId, state);
                            
                            StateMessageHelpers.updatePreviousValue(node, stateId, state.val);
                            
                            StateMessageHelpers.storeGroupedStateValue(node.groupedStateValues, stateId, state);
                            
                            sendMessage(message, "initial value");
                            
                            const receivedCount = Object.keys(node.groupedStateValues).length;
                            const totalCount = node.statesList.length;
                            ErrorAndLoggerHelpers.updateInitialValuesProgress(node, receivedCount, totalCount);
                            
                        } else if (node.outputMode === 'grouped') {
                            if (node.pendingGroupedStates && node.pendingGroupedStates.has(stateId)) {
                                node.log(`Grouped mode: Received missing state for grouped update: ${stateId}: ${state.val}`);
                                
                                StateMessageHelpers.storeGroupedStateValue(node.groupedStateValues, stateId, state);
                                
                                node.currentStateValues.set(stateId, state);
                                
                                node.pendingGroupedStates.delete(stateId);
                                
                                if (node.pendingGroupedStates.size === 0) {
                                    node.log(`Grouped mode: All missing states received, sending complete grouped message`);
                                    
                                    if (node.groupedTimeout) {
                                        clearTimeout(node.groupedTimeout);
                                        node.groupedTimeout = null;
                                    }
                                    
                                    const completeGroupedMessage = StateMessageHelpers.createGroupedMessage(
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
                            
                            StateMessageHelpers.storeGroupedStateValue(node.groupedStateValues, stateId, state);
                            
                            node.currentStateValues.set(stateId, state);
                            
                            node.log(`Grouped mode: Stored initial value for ${stateId}. Now have ${Object.keys(node.groupedStateValues).length}/${node.statesList.length} values`);
                            
                            const hasAllInitialValues = StateMessageHelpers.areAllInitialValuesReceived(node.groupedStateValues, node.statesList);
                            
                            node.log(`Grouped mode: hasAllInitialValues = ${hasAllInitialValues}`);
                            
                            if (hasAllInitialValues) {
                                node.log(`Grouped mode: All initial values received. Sending grouped message.`);
                                if (node.initialValueTimeout) {
                                    clearTimeout(node.initialValueTimeout);
                                    node.initialValueTimeout = null;
                                }
                                
                                const groupedMessage = StateMessageHelpers.createGroupedMessage(
                                    node.groupedStateValues, 
                                    node.outputProperty, 
                                    {
                                        topic: 'grouped_states_initial',
                                        isInitial: true
                                    }
                                );
                                
                                sendMessage(groupedMessage, "grouped initial values");
                                
                                setTimeout(() => {
                                    ErrorAndLoggerHelpers.updateMultipleStatesStatus(node, node.statesList, node.outputMode, node.filterMode);
                                }, 1000);
                            }
                        }
                        
                        const receivedCount = Object.keys(node.groupedStateValues).length;
                        const totalCount = node.statesList.length;
                        ErrorAndLoggerHelpers.updateInitialValuesProgress(node, receivedCount, totalCount);
                        
                        if (receivedCount === totalCount && node.outputMode === 'individual') {
                            setTimeout(() => {
                                ErrorAndLoggerHelpers.updateMultipleStatesStatus(node, node.statesList, node.outputMode, node.filterMode);
                            }, 1000);
                        }
                    }
                }
            }
        };
        
        const onDisconnected = ({ serverId }) => {
            if (serverId === node.server.id) {
                ErrorAndLoggerHelpers.updateConnectionStatus(node, 'disconnected');
                node.isSubscribed = false;
            }
        };

        const onRetrying = ({ serverId, attempt, delay }) => {
            if (serverId === node.server.id) {
                ErrorAndLoggerHelpers.updateConnectionStatus(node, 'retrying', `Retrying in ${delay / 1000}s (Attempt #${attempt})`);
            }
        };

        const onPermanentFailure = ({ serverId, error }) => {
            if (serverId === node.server.id) {
                ErrorAndLoggerHelpers.updateConnectionStatus(node, 'error', `Failed: ${error.message}`);
            }
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

        // Setup event listeners and register with orchestrator
        NodeLifecycleHelpers.setupDelayedRegistrationWithListeners(node, eventHandlers, 0);

        const cleanupCallbacks = [
            () => StateMessageHelpers.cleanupTimeout(node, 'initialValueTimeout'),
            () => StateMessageHelpers.cleanupTimeout(node, 'groupedTimeout'),
            () => PatternHelpers.unregisterNodeFromExternalTrigger(node)
        ];

        NodeLifecycleHelpers.setupCloseHandler(node, eventHandlers, cleanupCallbacks);

        ErrorAndLoggerHelpers.updateConnectionStatus(node, 'waiting', "Waiting for server...");
    }

    RED.nodes.registerType("iobin", IoBrokerInNode);
};