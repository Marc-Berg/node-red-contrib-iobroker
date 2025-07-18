const Orchestrator = require('../lib/orchestrator');
const { MessageHelpers } = require('../lib/utils/message-helpers');
const { FilterHelpers } = require('../lib/utils/filter-helpers');
const { StatusHelpers } = require('../lib/utils/status-helpers');
const { WildcardHelpers } = require('../lib/utils/wildcard-helpers');
const { StateManagementHelpers } = require('../lib/utils/state-management-helpers');

module.exports = function(RED) {
    function IoBrokerInNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        node.server = RED.nodes.getNode(config.server);
        node.stateId = config.state; // Updated from config.stateId to config.state
        node.isSubscribed = false;
        
        // Configuration options
        node.sendInitialValue = config.sendInitialValue || false;
        node.outputProperty = config.outputProperty || "payload"; // New field
        node.filterMode = config.filterMode || "all"; // New field
        node.ackFilter = config.ackFilter || "both"; // ACK filter
        node.inputMode = config.inputMode || "single";
        node.multipleStates = config.multipleStates || "";
        node.outputMode = config.outputMode || "individual";
        
        // Debug configuration
        node.log(`Node configuration: inputMode=${node.inputMode}, sendInitialValue=${node.sendInitialValue}, outputMode=${node.outputMode}, outputProperty=${node.outputProperty}, filterMode=${node.filterMode}, ackFilter=${node.ackFilter}, multipleStates="${node.multipleStates}"`);
        
        // Parse multiple states if in multiple mode
        const stateTracking = StateManagementHelpers.initializeStateTracking();
        Object.assign(node, stateTracking);
        
        node.initialValueTimeout = null; // Timeout for grouped initial values
        
        // Variables for grouped mode getState requests
        node.pendingGroupedStates = null; // Set of states we're waiting for in grouped mode
        node.groupedUpdateTriggeredBy = null; // Which state triggered the grouped update
        node.groupedTimeout = null; // Timeout for grouped getState requests
        
        if (node.inputMode === 'multiple' && node.multipleStates) {
            node.statesList = StateManagementHelpers.parseMultipleStates(node.multipleStates);
            node.log(`Parsed ${node.statesList.length} states: [${node.statesList.join(', ')}]`);
        }
        
        // Track if the node has been registered with the orchestrator
        node.isRegistered = false;
        
        // Simple message sending function - new architecture handles delivery via orchestrator
        const sendMessage = (message, description = '') => {
            if (description) {
                node.log(`Sending message: ${description}`);
            }
            node.send(message);
        };
        
        // Helper function to update node status with current value
        function updateNodeStatus(stateId, value, isInitial = false) {
            if (node.inputMode === 'single') {
                StatusHelpers.updateSingleStateStatus(node, stateId, value, node.filterMode, isInitial);
            } else if (node.inputMode === 'multiple') {
                StatusHelpers.updateMultipleStatesStatus(node, node.statesList, node.outputMode, node.filterMode);
            }
        }
        
        // Detect wildcard pattern and validate configuration
        const wildcardValidation = WildcardHelpers.validateWildcardConfig(
            node.inputMode, 
            node.stateId, 
            node.sendInitialValue
        );
        
        node.isWildcardPattern = wildcardValidation.isWildcard;
        
        if (wildcardValidation.isWildcard && !wildcardValidation.valid) {
            node.status({ fill: "red", shape: "dot", text: wildcardValidation.error });
            return;
        }
        
        // Apply wildcard configuration adjustments
        if (wildcardValidation.adjustments) {
            if (wildcardValidation.adjustments.sendInitialValue !== undefined) {
                node.sendInitialValue = wildcardValidation.adjustments.sendInitialValue;
            }
        }

        // Validation using helper
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

        // --- External Triggering System ---

        // Function to send cached values for external triggering
        node.sendCachedValues = function() {
            if (node.inputMode === 'single') {
                // First try currentStateValues, then fallback to lastValue
                let cachedValue = node.currentStateValues && node.currentStateValues.get ? 
                    node.currentStateValues.get(node.stateId) : null;
                let state = cachedValue;
                
                if (!state && node.lastValue !== undefined) {
                    // Use lastValue as fallback
                    state = { val: node.lastValue };
                }
                
                if (state && state.val !== undefined) {
                    const message = {
                        topic: node.stateId,
                        [node.outputProperty || 'payload']: state.val,
                        state: {
                            val: state.val,
                            ts: state.ts || Date.now(),
                            ack: state.ack !== undefined ? state.ack : true,
                            from: 'cache'
                        },
                        timestamp: Date.now(),
                        cached: true,
                        initial: true
                    };
                    
                    node.send(message);
                }
            } else if (node.inputMode === 'multiple') {
                if (node.outputMode === 'grouped') {
                    // Grouped mode: send all cached values in one message
                    const groupedValues = {};
                    const groupedStates = {};
                    let hasValues = false;
                    
                    if (node.currentStateValues && node.statesList) {
                        node.statesList.forEach(stateId => {
                            const state = node.currentStateValues.get(stateId);
                            if (state && state.val !== undefined) {
                                groupedValues[stateId] = state.val;
                                groupedStates[stateId] = {
                                    val: state.val,
                                    ts: state.ts || Date.now(),
                                    ack: state.ack !== undefined ? state.ack : true,
                                    from: 'cache'
                                };
                                hasValues = true;
                            }
                        });
                    }
                    
                    if (hasValues) {
                        const message = {
                            topic: 'cached_states',
                            [node.outputProperty || 'payload']: groupedValues,
                            states: groupedStates,
                            timestamp: Date.now(),
                            cached: true,
                            isInitial: true,
                            multipleStatesMode: true,
                            outputMode: 'grouped'
                        };
                        
                        node.send(message);
                    }
                } else {
                    // Individual mode: send separate message for each cached value
                    if (node.currentStateValues && node.statesList) {
                        node.statesList.forEach(stateId => {
                            const state = node.currentStateValues.get(stateId);
                            if (state && state.val !== undefined) {
                                const message = {
                                    topic: stateId,
                                    [node.outputProperty || 'payload']: state.val,
                                    state: {
                                        val: state.val,
                                        ts: state.ts || Date.now(),
                                        ack: state.ack !== undefined ? state.ack : true,
                                        from: 'cache'
                                    },
                                    timestamp: Date.now(),
                                    cached: true,
                                    initial: true,
                                    multipleStatesMode: true
                                };
                                
                                node.send(message);
                            }
                        });
                    }
                }
            }
        };

        // Initialize cache for state values
        node.currentStateValues = new Map();
        node.lastValue = undefined;

        // Register node in flow context for external triggering
        const flowContext = node.context().flow;
        const existingNodes = flowContext.get('iobroker_in_nodes') || {};
        existingNodes[node.id] = {
            nodeRef: node,
            triggerCached: node.sendCachedValues,
            states: node.inputMode === 'single' ? [node.stateId] : (node.statesList || []),
            mode: node.inputMode,
            name: node.name || `iob-in-${node.id.substring(0, 8)}`,
            outputMode: node.outputMode
        };
        flowContext.set('iobroker_in_nodes', existingNodes);

        // --- Event Handler ---

        const onServerReady = ({ serverId }) => {
            if (serverId === node.server.id) {
                // Subscribe based on input mode
                if (node.inputMode === 'single') {
                    StatusHelpers.updateConnectionStatus(node, 'subscribing', `Subscribing to ${node.stateId}...`);
                    Orchestrator.subscribe(node.id, node.stateId);
                } else if (node.inputMode === 'multiple') {
                    StatusHelpers.updateConnectionStatus(node, 'subscribing', `Subscribing to ${node.statesList.length} states...`);
                    
                    // Subscribe to each state individually
                    node.statesList.forEach(stateId => {
                        Orchestrator.subscribe(node.id, stateId);
                    });
                }
                node.isSubscribed = true;
            }
        };

        const onSubscriptionConfirmed = ({ serverId, stateId }) => {
            if (serverId === node.server.id) {
                if (node.inputMode === 'single') {
                    // For wildcard patterns, any matching subscription confirms our pattern is active
                    if (node.isWildcardPattern) {
                        if (WildcardHelpers.matchesWildcardPattern(stateId, node.stateId)) {
                            StatusHelpers.updateWildcardStatus(node, node.stateId, true);
                            node.isSubscribed = true;
                        }
                    } else {
                        // For single states, exact match
                        if (stateId === node.stateId) {
                            node.status({ fill: "green", shape: "ring", text: `Subscribed to ${node.stateId}` });
                            node.isSubscribed = true;
                            
                            // Send initial value if requested (only for single states, not wildcards)
                            if (node.sendInitialValue && !node.isWildcardPattern) {
                                requestInitialValue();
                            }
                            
                            // For changes-smart mode, always request current value to establish baseline
                            // (even if sendInitialValue is false)
                            if (node.filterMode === 'changes-smart' && !node.sendInitialValue && !node.isWildcardPattern) {
                                node.log(`Changes-smart mode: requesting baseline value for ${node.stateId}`);
                                requestBaselineValue();
                            }
                        }
                    }
                } else if (node.inputMode === 'multiple') {
                    // For multiple states, check if this state is in our list
                    if (node.statesList.includes(stateId)) {
                        node.subscribedStates.add(stateId);
                        
                        node.log(`Multiple states: Subscription confirmed for ${stateId} (${node.subscribedStates.size}/${node.statesList.length})`);
                        
                        StatusHelpers.updateSubscriptionProgress(node, node.subscribedStates.size, node.statesList.length);
                        
                        // If all states are subscribed and we want initial values, request them all at once
                        node.log(`Checking for initial values: subscribedStates=${node.subscribedStates.size}, totalStates=${node.statesList.length}, sendInitialValue=${node.sendInitialValue}`);
                        
                        if (StateManagementHelpers.areAllStatesSubscribed(node.subscribedStates, node.statesList) && node.sendInitialValue) {
                            node.log(`All states subscribed. Requesting initial values for ${node.statesList.length} states.`);
                            
                            // Small delay to ensure all subscriptions are properly established
                            setTimeout(() => {
                                // Set timeout for grouped initial values (10 seconds)
                                if (node.outputMode === 'grouped') {
                                    node.initialValueTimeout = setTimeout(() => {
                                        node.log(`Initial value timeout reached. Sending partial data.`);
                                        // Send grouped message with whatever values we have using helper
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
                                            
                                            sendMessage(partialGroupedMessage, "grouped initial values (partial)");
                                        }
                                        StatusHelpers.updatePartialDataStatus(node, "Partial initial values (timeout)");
                                    }, 10000);
                                }
                                
                                // Request initial values for all states
                                node.statesList.forEach(state => {
                                    if (!node.initialValuesRequested.has(state)) {
                                        node.log(`Requesting initial value for: ${state}`);
                                        node.initialValuesRequested.add(state);
                                        requestInitialValue(state);
                                    }
                                });
                            }, 100);
                        }
                        
                        // For changes-smart mode, always request baseline values (even if sendInitialValue is false)
                        // Note: changes-only mode does NOT get baseline values - it waits for the first real change
                        if (StateManagementHelpers.areAllStatesSubscribed(node.subscribedStates, node.statesList) && 
                            node.filterMode === 'changes-smart' && !node.sendInitialValue) {
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
                }
            }
        };

        const onStateChanged = ({ serverId, stateId, state }) => {
            if (serverId === node.server.id) {
                // Apply ACK filter using helper
                if (!FilterHelpers.shouldSendMessage(state.ack, node.ackFilter)) {
                    return;
                }
                
                if (node.inputMode === 'single') {
                    // For wildcard patterns, check if the stateId matches the pattern
                    if (node.isWildcardPattern) {
                        if (!WildcardHelpers.matchesWildcardPattern(stateId, node.stateId)) {
                            return; // State doesn't match our pattern
                        }
                    } else {
                        // For single states, exact match
                        if (stateId !== node.stateId) {
                            return;
                        }
                    }
                    
                    // Apply filter logic using helper
                    if (FilterHelpers.shouldFilterValue(stateId, state.val, node.previousValues, node.filterMode, false, (msg) => node.log(msg))) {
                        FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                        return;
                    }
                    
                    // Create output message for single mode using helper
                    const message = MessageHelpers.createEnhancedMessage(state, stateId, node.outputProperty, {
                        pattern: node.isWildcardPattern ? node.stateId : null
                    });
                    
                    // Cache state value for external triggering
                    node.currentStateValues.set(stateId, state);
                    if (node.inputMode === 'single') {
                        node.lastValue = state.val;
                    }
                    
                    // Update previous value using helper
                    FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                    
                    // Update node status
                    updateNodeStatus(stateId, state.val, false);
                    
                    // Send the message through the orchestrator
                    sendMessage(message);
                    
                } else if (node.inputMode === 'multiple') {
                    // For multiple states, check if this state is in our list
                    if (!node.statesList.includes(stateId)) {
                        return;
                    }
                    
                    if (node.outputMode === 'individual') {
                        // Apply filter logic using helper
                        if (FilterHelpers.shouldFilterValue(stateId, state.val, node.previousValues, node.filterMode, false, (msg) => node.log(msg))) {
                            FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                            return;
                        }
                        
                        // Individual mode: send separate message for each state change using helper
                        const message = MessageHelpers.createEnhancedMessage(state, stateId, node.outputProperty, {
                            multipleStatesMode: true
                        });
                        
                        // Cache state value for external triggering
                        node.currentStateValues.set(stateId, state);
                        
                        // Update previous value using helper
                        FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                        
                        // Update node status for multiple states
                        updateNodeStatus(stateId, state.val, false);
                        
                        sendMessage(message);
                        
                    } else if (node.outputMode === 'grouped') {
                        // Cache state value for external triggering
                        node.currentStateValues.set(stateId, state);
                        
                        // Grouped mode: update the changed state value using helper
                        StateManagementHelpers.storeGroupedStateValue(node.groupedStateValues, stateId, state);
                        
                        // For grouped mode, we need current values of ALL states
                        // Request current values for all states that we don't have yet
                        const missingStates = StateManagementHelpers.getMissingStates(node.groupedStateValues, node.statesList);
                        
                        if (missingStates.length > 0) {
                            node.log(`Grouped mode: Missing ${missingStates.length} states, requesting current values: [${missingStates.join(', ')}]`);
                            
                            // Track which states we're requesting for this grouped update
                            node.pendingGroupedStates = new Set(missingStates);
                            node.groupedUpdateTriggeredBy = stateId;
                            
                            // Request current values for missing states using the normal node ID
                            missingStates.forEach(missingStateId => {
                                Orchestrator.getState(node.id, missingStateId);
                            });
                            
                            // Set timeout to send partial data if some states don't respond
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
                                // Clean up
                                node.pendingGroupedStates = null;
                                node.groupedUpdateTriggeredBy = null;
                                node.groupedTimeout = null;
                            });
                            
                        } else {
                            // We already have all states, send grouped message immediately using helper
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
        
        // Function to request initial value for a single state
        function requestInitialValue(targetStateId) {
            const stateToRequest = targetStateId || node.stateId;
            
            if (node.inputMode === 'single' && node.isWildcardPattern) {
                return; // Not supported for wildcards
            }
            
            node.log(`Requesting initial value for state: ${stateToRequest}`);
            Orchestrator.getState(node.id, stateToRequest);
        }
        
        // Function to request baseline value (for changes-smart mode without sending initial message)
        function requestBaselineValue(targetStateId) {
            const stateToRequest = targetStateId || node.stateId;
            
            if (node.inputMode === 'single' && node.isWildcardPattern) {
                return; // Not supported for wildcards
            }
            
            node.log(`Requesting baseline value for changes-smart mode: ${stateToRequest}`);
            // Use the normal node ID but mark this as a baseline request internally using helper
            StateManagementHelpers.trackBaselineRequest(node.pendingBaselineRequests, stateToRequest);
            Orchestrator.getState(node.id, stateToRequest);
        }
        
        // Event handler for initial state value response
        const onInitialStateValue = ({ serverId, stateId, state, nodeId }) => {
            node.log(`Initial value response: serverId=${serverId}, stateId=${stateId}, nodeId=${nodeId}, state=${state ? 'present' : 'null'}`);
            
            // Check if this is a baseline request (for changes-smart mode) using helper
            const isBaselineRequest = StateManagementHelpers.isBaselineRequest(node.pendingBaselineRequests, stateId);
            
            if (serverId === node.server.id && nodeId === node.id) {
                // Check if this is a state we're interested in
                const isRelevantState = (node.inputMode === 'single' && stateId === node.stateId) ||
                                      (node.inputMode === 'multiple' && node.statesList.includes(stateId));
                
                if (isRelevantState && state) {
                    if (isBaselineRequest) {
                        // This is a baseline value request - just store the value, don't send message
                        node.log(`Setting baseline value for changes-smart mode: ${stateId} = ${state.val}`);
                        FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                        // Remove from pending baseline requests using helper
                        StateManagementHelpers.completeBaselineRequest(node.pendingBaselineRequests, stateId);
                        return;
                    }
                    
                    node.log(`Processing initial value for ${stateId}: ${state.val}`);
                    
                    // Apply ACK filter using helper
                    if (!FilterHelpers.shouldSendMessage(state.ack, node.ackFilter)) {
                        node.log(`Initial value filtered by ACK filter for ${stateId}`);
                        return;
                    }
                    
                    if (node.inputMode === 'single') {
                        // Apply filter logic for initial values using helper
                        if (FilterHelpers.shouldFilterValue(stateId, state.val, node.previousValues, node.filterMode, true, (msg) => node.log(msg))) {
                            FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                            return;
                        }
                        
                        // Single state mode using helper
                        const message = MessageHelpers.createEnhancedMessage(state, stateId, node.outputProperty, {
                            initial: true
                        });
                        
                        // Cache state value for external triggering
                        node.currentStateValues.set(stateId, state);
                        node.lastValue = state.val;
                        
                        // Update previous value using helper
                        FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                        
                        // Update status
                        updateNodeStatus(stateId, state.val, true);
                        
                        sendMessage(message, "initial value");
                        
                    } else if (node.inputMode === 'multiple') {
                        if (node.outputMode === 'individual') {
                            // Apply filter logic for initial values using helper
                            if (FilterHelpers.shouldFilterValue(stateId, state.val, node.previousValues, node.filterMode, true, (msg) => node.log(msg))) {
                                FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                                return;
                            }
                            
                            // Individual mode: send separate message for each initial value using helper
                            const message = MessageHelpers.createEnhancedMessage(state, stateId, node.outputProperty, {
                                initial: true,
                                multipleStatesMode: true
                            });
                            
                            // Cache state value for external triggering
                            node.currentStateValues.set(stateId, state);
                            
                            // Update previous value using helper
                            FilterHelpers.updatePreviousValue(node.previousValues, stateId, state.val);
                            
                            sendMessage(message, "initial value");
                            
                        } else if (node.outputMode === 'grouped') {
                            // Check if this is a response for a pending grouped update
                            if (node.pendingGroupedStates && node.pendingGroupedStates.has(stateId)) {
                                node.log(`Grouped mode: Received missing state for grouped update: ${stateId}: ${state.val}`);
                                
                                // Store the state value using helper
                                StateManagementHelpers.storeGroupedStateValue(node.groupedStateValues, stateId, state);
                                
                                // Cache state value for external triggering
                                node.currentStateValues.set(stateId, state);
                                
                                // Remove from pending set
                                node.pendingGroupedStates.delete(stateId);
                                
                                // Check if we have all pending states
                                if (node.pendingGroupedStates.size === 0) {
                                    node.log(`Grouped mode: All missing states received, sending complete grouped message`);
                                    
                                    // Clear timeout
                                    if (node.groupedTimeout) {
                                        clearTimeout(node.groupedTimeout);
                                        node.groupedTimeout = null;
                                    }
                                    
                                    // Send complete grouped message using helper
                                    const completeGroupedMessage = MessageHelpers.createGroupedMessage(
                                        node.groupedStateValues, 
                                        node.outputProperty, 
                                        {
                                            topic: 'grouped_states',
                                            triggeredBy: node.groupedUpdateTriggeredBy
                                        }
                                    );
                                    
                                    sendMessage(completeGroupedMessage);
                                    
                                    // Clean up
                                    node.pendingGroupedStates = null;
                                    node.groupedUpdateTriggeredBy = null;
                                }
                                
                                return; // Don't process as regular initial value
                            }
                            
                            // Regular initial value processing (not for grouped update)
                            // Grouped mode: Store initial value and check if we have all values using helper
                            StateManagementHelpers.storeGroupedStateValue(node.groupedStateValues, stateId, state);
                            
                            // Cache state value for external triggering
                            node.currentStateValues.set(stateId, state);
                            
                            node.log(`Grouped mode: Stored initial value for ${stateId}. Now have ${Object.keys(node.groupedStateValues).length}/${node.statesList.length} values`);
                            
                            // Check if we have all initial values before sending grouped message using helper
                            const hasAllInitialValues = StateManagementHelpers.areAllInitialValuesReceived(node.groupedStateValues, node.statesList);
                            
                            node.log(`Grouped mode: hasAllInitialValues = ${hasAllInitialValues}`);
                            
                            if (hasAllInitialValues) {
                                node.log(`Grouped mode: All initial values received. Sending grouped message.`);
                                // Clear the timeout since we have all values
                                if (node.initialValueTimeout) {
                                    clearTimeout(node.initialValueTimeout);
                                    node.initialValueTimeout = null;
                                }
                                
                                // Send grouped message only when we have all initial values using helper
                                const groupedMessage = MessageHelpers.createGroupedMessage(
                                    node.groupedStateValues, 
                                    node.outputProperty, 
                                    {
                                        topic: 'grouped_states_initial',
                                        isInitial: true
                                    }
                                );
                                
                                sendMessage(groupedMessage, "grouped initial values");
                            }
                        }
                        
                        // Update status for multiple states using helper
                        const receivedCount = Object.keys(node.groupedStateValues).length;
                        const totalCount = node.statesList.length;
                        StatusHelpers.updateInitialValuesProgress(node, receivedCount, totalCount);
                    }
                }
            }
        };
        
        // Helper function to check ACK filter - replaced by FilterHelpers.shouldSendMessage
        
        const onDisconnected = ({ serverId }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'disconnected');
                node.isSubscribed = false; // Reset subscription status on disconnect
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

        // --- Node Lifecycle ---

        // Function to register with orchestrator
        const registerWithOrchestrator = () => {
            if (!node.isRegistered) {
                node.log(`Registering node with orchestrator after flows started`);
                Orchestrator.registerNode(node.id, node.server);
                node.isRegistered = true;
            }
        };

        // Register with orchestrator when flows are ready
        // Use timeout to ensure registration happens after flows are started
        setTimeout(() => {
            registerWithOrchestrator();
        }, 300);

        // Listen for events from the Orchestrator
        Orchestrator.on('server:ready', onServerReady);
        Orchestrator.on('state:subscription_confirmed', onSubscriptionConfirmed);
        Orchestrator.on('state:changed', onStateChanged);
        Orchestrator.on(`state:initial_value:${node.id}`, onInitialStateValue);
        Orchestrator.on('connection:disconnected', onDisconnected);
        Orchestrator.on('connection:retrying', onRetrying);
        Orchestrator.on('connection:failed_permanently', onPermanentFailure);

        node.on('close', (done) => {
            // Clean up timeouts if they exist using helper
            StateManagementHelpers.cleanupTimeout(node, 'initialValueTimeout');
            StateManagementHelpers.cleanupTimeout(node, 'groupedTimeout');
            
            // Remove from flow context
            const flowContext = node.context().flow;
            const existingNodes = flowContext.get('iobroker_in_nodes') || {};
            delete existingNodes[node.id];
            flowContext.set('iobroker_in_nodes', existingNodes);
            
            // Clean up all listeners to prevent memory leaks
            Orchestrator.removeListener('server:ready', onServerReady);
            Orchestrator.removeListener('state:subscription_confirmed', onSubscriptionConfirmed);
            Orchestrator.removeListener('state:changed', onStateChanged);
            Orchestrator.removeListener(`state:initial_value:${node.id}`, onInitialStateValue);
            Orchestrator.removeListener('connection:disconnected', onDisconnected);
            Orchestrator.removeListener('connection:retrying', onRetrying);
            Orchestrator.removeListener('connection:failed_permanently', onPermanentFailure);
            
            // Only unregister if we were actually registered
            if (node.isRegistered) {
                Orchestrator.unregisterNode(node.id, node.server.id);
            }
            done();
        });

        // Initial status on deploy using helper
        const initialStatusText = node.isWildcardPattern 
            ? `Waiting for pattern: ${node.stateId}` 
            : "Waiting for server...";
        StatusHelpers.updateConnectionStatus(node, 'waiting', initialStatusText);
    }

    RED.nodes.registerType("iobin", IoBrokerInNode);
};