const Orchestrator = require('../lib/orchestrator');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function(RED) {
    function IoBrokerInEventedNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        node.server = RED.nodes.getNode(config.server);
        node.stateId = config.stateId;
        node.isSubscribed = false;
        
        // Configuration options
        node.sendInitialValue = config.sendInitialValue || false;
        node.ackFilter = config.ackFilter || "both";
        node.inputMode = config.inputMode || "single";
        node.multipleStates = config.multipleStates || "";
        node.outputMode = config.outputMode || "individual";
        
        // Debug configuration
        node.log(`Node configuration: inputMode=${node.inputMode}, sendInitialValue=${node.sendInitialValue}, outputMode=${node.outputMode}, multipleStates="${node.multipleStates}"`);
        
        // Parse multiple states if in multiple mode
        node.statesList = [];
        node.groupedStateValues = {};  // For grouped output mode
        node.subscribedStates = new Set(); // Track which states are subscribed
        node.initialValuesRequested = new Set(); // Track initial value requests
        node.initialValueTimeout = null; // Timeout for grouped initial values
        
        // Variables for grouped mode getState requests
        node.pendingGroupedStates = null; // Set of states we're waiting for in grouped mode
        node.groupedUpdateTriggeredBy = null; // Which state triggered the grouped update
        node.groupedTimeout = null; // Timeout for grouped getState requests
        
        if (node.inputMode === 'multiple' && node.multipleStates) {
            node.statesList = node.multipleStates.split('\n')
                .map(s => s.trim())
                .filter(s => s.length > 0);
            
            node.log(`Parsed ${node.statesList.length} states: [${node.statesList.join(', ')}]`);
        }
        
        // Track if the node has been registered with the orchestrator
        node.isRegistered = false;
        
        // Setup message queue system for reliable message delivery
        const { sendWhenReady, cleanup } = NodeHelpers.setupMessageQueue(RED, node);
        
        // Detect wildcard pattern (only for single mode)
        node.isWildcardPattern = node.inputMode === 'single' && node.stateId && node.stateId.includes('*');
        
        // Wildcard patterns don't support initial values
        if (node.isWildcardPattern) {
            node.sendInitialValue = false;
        }

        // Validation
        if (!node.server) {
            node.status({ fill: "red", shape: "dot", text: "Error: Server not configured" });
            return;
        }
        
        if (node.inputMode === 'single' && !node.stateId) {
            node.status({ fill: "red", shape: "dot", text: "Error: State ID not configured" });
            return;
        }
        
        if (node.inputMode === 'multiple' && node.statesList.length === 0) {
            node.status({ fill: "red", shape: "dot", text: "Error: No states configured" });
            return;
        }

        // --- Event Handler ---

        const onServerReady = ({ serverId }) => {
            if (serverId === node.server.id) {
                // Subscribe based on input mode
                if (node.inputMode === 'single') {
                    node.status({ fill: "blue", shape: "dot", text: `Subscribing to ${node.stateId}...` });
                    Orchestrator.subscribe(node.id, node.stateId);
                } else if (node.inputMode === 'multiple') {
                    node.status({ fill: "blue", shape: "dot", text: `Subscribing to ${node.statesList.length} states...` });
                    
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
                        if (matchesWildcardPattern(stateId, node.stateId)) {
                            node.status({ fill: "green", shape: "ring", text: `Pattern active: ${node.stateId}` });
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
                        }
                    }
                } else if (node.inputMode === 'multiple') {
                    // For multiple states, check if this state is in our list
                    if (node.statesList.includes(stateId)) {
                        node.subscribedStates.add(stateId);
                        
                        node.log(`Multiple states: Subscription confirmed for ${stateId} (${node.subscribedStates.size}/${node.statesList.length})`);
                        
                        node.status({ 
                            fill: "green", 
                            shape: "ring", 
                            text: `Subscribed: ${node.subscribedStates.size}/${node.statesList.length} states` 
                        });
                        
                        // If all states are subscribed and we want initial values, request them all at once
                        node.log(`Checking for initial values: subscribedStates=${node.subscribedStates.size}, totalStates=${node.statesList.length}, sendInitialValue=${node.sendInitialValue}`);
                        
                        if (node.subscribedStates.size === node.statesList.length && node.sendInitialValue) {
                            node.log(`All states subscribed. Requesting initial values for ${node.statesList.length} states.`);
                            
                            // Small delay to ensure all subscriptions are properly established
                            setTimeout(() => {
                                // Set timeout for grouped initial values (10 seconds)
                                if (node.outputMode === 'grouped') {
                                    node.initialValueTimeout = setTimeout(() => {
                                        node.log(`Initial value timeout reached. Sending partial data.`);
                                        // Send grouped message with whatever values we have
                                        if (Object.keys(node.groupedStateValues).length > 0) {
                                            const partialGroupedMessage = {
                                                topic: 'grouped_states_initial',
                                                payload: Object.keys(node.groupedStateValues).reduce((acc, key) => {
                                                    acc[key] = node.groupedStateValues[key].value;
                                                    return acc;
                                                }, {}),
                                                states: Object.assign({}, node.groupedStateValues),
                                                initial: true,
                                                partial: true, // Indicate this is a partial result
                                                timestamp: Date.now(),
                                                multipleStatesMode: true,
                                                outputMode: 'grouped'
                                            };
                                            
                                            sendWhenReady(partialGroupedMessage, "grouped initial values (partial)");
                                        }
                                        node.status({ fill: "orange", shape: "dot", text: "Partial initial values (timeout)" });
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
                    }
                }
            }
        };

        const onStateChanged = ({ serverId, stateId, state }) => {
            if (serverId === node.server.id) {
                // Apply ACK filter
                if (!shouldSendMessage(state.ack, node.ackFilter)) {
                    return;
                }
                
                if (node.inputMode === 'single') {
                    // For wildcard patterns, check if the stateId matches the pattern
                    if (node.isWildcardPattern) {
                        if (!matchesWildcardPattern(stateId, node.stateId)) {
                            return; // State doesn't match our pattern
                        }
                    } else {
                        // For single states, exact match
                        if (stateId !== node.stateId) {
                            return;
                        }
                    }
                    
                    // Create output message for single mode
                    const message = {
                        topic: stateId,
                        payload: state.val,
                        ts: state.ts,
                        ack: state.ack,
                        state: state,
                        timestamp: Date.now()
                    };
                    
                    // Add pattern info for wildcard matches
                    if (node.isWildcardPattern) {
                        message.pattern = node.stateId;
                    }
                    
                    // Send the message through the queue system
                    sendWhenReady(message);
                    
                } else if (node.inputMode === 'multiple') {
                    // For multiple states, check if this state is in our list
                    if (!node.statesList.includes(stateId)) {
                        return;
                    }
                    
                    if (node.outputMode === 'individual') {
                        // Individual mode: send separate message for each state change
                        const message = {
                            topic: stateId,
                            payload: state.val,
                            ts: state.ts,
                            ack: state.ack,
                            state: state,
                            timestamp: Date.now(),
                            multipleStatesMode: true
                        };
                        
                        sendWhenReady(message);
                        
                    } else if (node.outputMode === 'grouped') {
                        // Grouped mode: update the changed state value
                        node.groupedStateValues[stateId] = {
                            value: state.val,
                            ts: state.ts,
                            ack: state.ack,
                            state: state
                        };
                        
                        // For grouped mode, we need current values of ALL states
                        // Request current values for all states that we don't have yet
                        const missingStates = node.statesList.filter(s => !node.groupedStateValues.hasOwnProperty(s));
                        
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
                            node.groupedTimeout = setTimeout(() => {
                                if (Object.keys(node.groupedStateValues).length > 0) {
                                    node.log(`Grouped mode: Timeout reached, sending partial grouped message`);
                                    const partialGroupedMessage = {
                                        topic: 'grouped_states',
                                        payload: Object.keys(node.groupedStateValues).reduce((acc, key) => {
                                            acc[key] = node.groupedStateValues[key].value;
                                            return acc;
                                        }, {}),
                                        states: Object.assign({}, node.groupedStateValues),
                                        triggeredBy: node.groupedUpdateTriggeredBy,
                                        timestamp: Date.now(),
                                        multipleStatesMode: true,
                                        outputMode: 'grouped',
                                        partial: true
                                    };
                                    
                                    sendWhenReady(partialGroupedMessage);
                                }
                                // Clean up
                                node.pendingGroupedStates = null;
                                node.groupedUpdateTriggeredBy = null;
                                node.groupedTimeout = null;
                            }, 2000); // 2 second timeout
                            
                        } else {
                            // We already have all states, send grouped message immediately
                            node.log(`Grouped mode: All states available, sending grouped message immediately`);
                            const groupedMessage = {
                                topic: 'grouped_states',
                                payload: Object.keys(node.groupedStateValues).reduce((acc, key) => {
                                    acc[key] = node.groupedStateValues[key].value;
                                    return acc;
                                }, {}),
                                states: Object.assign({}, node.groupedStateValues),
                                triggeredBy: stateId,
                                timestamp: Date.now(),
                                multipleStatesMode: true,
                                outputMode: 'grouped'
                            };
                            
                            sendWhenReady(groupedMessage);
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
        
        // Event handler for initial state value response
        const onInitialStateValue = ({ serverId, stateId, state, nodeId }) => {
            node.log(`Initial value response: serverId=${serverId}, stateId=${stateId}, nodeId=${nodeId}, state=${state ? 'present' : 'null'}`);
            
            if (serverId === node.server.id && nodeId === node.id) {
                // Check if this is a state we're interested in
                const isRelevantState = (node.inputMode === 'single' && stateId === node.stateId) ||
                                      (node.inputMode === 'multiple' && node.statesList.includes(stateId));
                
                if (isRelevantState && state) {
                    node.log(`Processing initial value for ${stateId}: ${state.val}`);
                    
                    // Apply ACK filter
                    if (!shouldSendMessage(state.ack, node.ackFilter)) {
                        node.log(`Initial value filtered by ACK filter for ${stateId}`);
                        return;
                    }
                    
                    if (node.inputMode === 'single') {
                        // Single state mode
                        const message = {
                            topic: stateId,
                            payload: state.val,
                            ts: state.ts,
                            ack: state.ack,
                            state: state,
                            initial: true,
                            timestamp: Date.now()
                        };
                        
                        // Update status
                        const statusText = `initial: ${message.payload} (ts: ${new Date(message.ts).toLocaleTimeString()})`;
                        node.status({ fill: "green", shape: "dot", text: statusText });
                        
                        sendWhenReady(message, "initial value");
                        
                    } else if (node.inputMode === 'multiple') {
                        if (node.outputMode === 'individual') {
                            // Individual mode: send separate message for each initial value
                            const message = {
                                topic: stateId,
                                payload: state.val,
                                ts: state.ts,
                                ack: state.ack,
                                state: state,
                                initial: true,
                                timestamp: Date.now(),
                                multipleStatesMode: true
                            };
                            
                            sendWhenReady(message, "initial value");
                            
                        } else if (node.outputMode === 'grouped') {
                            // Check if this is a response for a pending grouped update
                            if (node.pendingGroupedStates && node.pendingGroupedStates.has(stateId)) {
                                node.log(`Grouped mode: Received missing state for grouped update: ${stateId}: ${state.val}`);
                                
                                // Store the state value
                                node.groupedStateValues[stateId] = {
                                    value: state.val,
                                    ts: state.ts,
                                    ack: state.ack,
                                    state: state
                                };
                                
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
                                    
                                    // Send complete grouped message
                                    const completeGroupedMessage = {
                                        topic: 'grouped_states',
                                        payload: Object.keys(node.groupedStateValues).reduce((acc, key) => {
                                            acc[key] = node.groupedStateValues[key].value;
                                            return acc;
                                        }, {}),
                                        states: Object.assign({}, node.groupedStateValues),
                                        triggeredBy: node.groupedUpdateTriggeredBy,
                                        timestamp: Date.now(),
                                        multipleStatesMode: true,
                                        outputMode: 'grouped'
                                    };
                                    
                                    sendWhenReady(completeGroupedMessage);
                                    
                                    // Clean up
                                    node.pendingGroupedStates = null;
                                    node.groupedUpdateTriggeredBy = null;
                                }
                                
                                return; // Don't process as regular initial value
                            }
                            
                            // Regular initial value processing (not for grouped update)
                            // Grouped mode: Store initial value and check if we have all values
                            node.groupedStateValues[stateId] = {
                                value: state.val,
                                ts: state.ts,
                                ack: state.ack,
                                state: state
                            };
                            
                            node.log(`Grouped mode: Stored initial value for ${stateId}. Now have ${Object.keys(node.groupedStateValues).length}/${node.statesList.length} values`);
                            
                            // Check if we have all initial values before sending grouped message
                            const hasAllInitialValues = node.statesList.every(s => 
                                node.groupedStateValues.hasOwnProperty(s)
                            );
                            
                            node.log(`Grouped mode: hasAllInitialValues = ${hasAllInitialValues}`);
                            
                            if (hasAllInitialValues) {
                                node.log(`Grouped mode: All initial values received. Sending grouped message.`);
                                // Clear the timeout since we have all values
                                if (node.initialValueTimeout) {
                                    clearTimeout(node.initialValueTimeout);
                                    node.initialValueTimeout = null;
                                }
                                
                                // Send grouped message only when we have all initial values
                                const groupedMessage = {
                                    topic: 'grouped_states_initial',
                                    payload: Object.keys(node.groupedStateValues).reduce((acc, key) => {
                                        acc[key] = node.groupedStateValues[key].value;
                                        return acc;
                                    }, {}),
                                    states: Object.assign({}, node.groupedStateValues),
                                    initial: true,
                                    timestamp: Date.now(),
                                    multipleStatesMode: true,
                                    outputMode: 'grouped'
                                };
                                
                                sendWhenReady(groupedMessage, "grouped initial values");
                            }
                        }
                        
                        // Update status for multiple states
                        const receivedCount = Object.keys(node.groupedStateValues).length;
                        const totalCount = node.statesList.length;
                        const statusText = `Initial values: ${receivedCount}/${totalCount}`;
                        node.status({ fill: receivedCount === totalCount ? "green" : "yellow", shape: "dot", text: statusText });
                    }
                }
            }
        };
        
        // Helper function to check ACK filter
        function shouldSendMessage(ack, filter) {
            switch (filter) {
                case "ack": return ack === true;
                case "noack": return ack === false;
                default: return true; // "both"
            }
        }
        
        // Helper function to match wildcard patterns
        function matchesWildcardPattern(stateId, pattern) {
            // Convert wildcard pattern to regex
            // Escape special regex characters except *
            const regexPattern = pattern
                .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
                .replace(/\*/g, '.*'); // Replace * with .*
            
            const regex = new RegExp(`^${regexPattern}$`);
            return regex.test(stateId);
        }

        const onDisconnected = ({ serverId }) => {
            if (serverId === node.server.id) {
                node.status({ fill: "red", shape: "ring", text: "Disconnected" });
                node.isSubscribed = false; // Reset subscription status on disconnect
            }
        };

        const onRetrying = ({ serverId, attempt, delay }) => {
            if (serverId === node.server.id) {
                node.status({ 
                    fill: "yellow", 
                    shape: "ring", 
                    text: `Retrying in ${delay / 1000}s (Attempt #${attempt})` 
                });
            }
        };

        const onPermanentFailure = ({ serverId, error }) => {
            if (serverId === node.server.id) {
                node.status({ 
                    fill: "red", 
                    shape: "dot", 
                    text: `Failed: ${error.message}` 
                });
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
            // Clean up timeouts if they exist
            if (node.initialValueTimeout) {
                clearTimeout(node.initialValueTimeout);
                node.initialValueTimeout = null;
            }
            if (node.groupedTimeout) {
                clearTimeout(node.groupedTimeout);
                node.groupedTimeout = null;
            }
            
            // Clean up all listeners to prevent memory leaks
            Orchestrator.removeListener('server:ready', onServerReady);
            Orchestrator.removeListener('state:subscription_confirmed', onSubscriptionConfirmed);
            Orchestrator.removeListener('state:changed', onStateChanged);
            Orchestrator.removeListener(`state:initial_value:${node.id}`, onInitialStateValue);
            Orchestrator.removeListener('connection:disconnected', onDisconnected);
            Orchestrator.removeListener('connection:retrying', onRetrying);
            Orchestrator.removeListener('connection:failed_permanently', onPermanentFailure);
            
            // Cleanup message queue system
            cleanup();
            
            // Only unregister if we were actually registered
            if (node.isRegistered) {
                Orchestrator.unregisterNode(node.id, node.server.id);
            }
            done();
        });

        // Initial status on deploy
        const initialStatusText = node.isWildcardPattern 
            ? `Waiting for pattern: ${node.stateId}` 
            : "Waiting for server...";
        node.status({ fill: "grey", shape: "dot", text: initialStatusText });
    }

    RED.nodes.registerType("iob-in-evented", IoBrokerInEventedNode);
};