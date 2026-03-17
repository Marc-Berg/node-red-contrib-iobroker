const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers, NodePatterns } = require('../lib/utils/node-helpers');

module.exports = function (RED) {
    function iobin(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);

        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

        const inputMode = config.inputMode || 'single';
        let stateList = [];
        let subscriptionPattern = '';

        if (inputMode === 'multiple') {
            const multipleStatesRaw = config.multipleStates || '';
            stateList = multipleStatesRaw
                .split('\n')
                .map(s => s.trim())
                .filter(s => s.length > 0)
                .map(s => {
                    // Check for environment variables ${VAR}
                    if (s.includes('${')) {
                        return s.replace(/\${([^}]+)}/g, (match, varName) => {
                            const envValue = RED.util.evaluateNodeProperty(varName, 'env', node);
                            return envValue !== undefined ? envValue : match;
                        });
                    }
                    return s;
                })
                .filter(s => s.length > 0);

            if (stateList.length === 0) {
                return setError("No states configured for multiple states mode", "No states");
            }
        } else {
            subscriptionPattern = config.state ? config.state.trim() : '';
            if (!subscriptionPattern) {
                return setError("State ID or pattern missing", "Config missing");
            }
        }

        const isWildcardPattern = inputMode === 'single' && subscriptionPattern.includes('*');
        const isMultipleStates = inputMode === 'multiple';
        const isSingleState = inputMode === 'single' && !isWildcardPattern;

        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            ackFilter: config.ackFilter || "both",
            sendInitialValue: config.sendInitialValue && !isWildcardPattern,
            outputMode: config.outputMode || "individual",
            filterMode: config.filterMode || "all",
            enableExternalTrigger: config.enableExternalTrigger === true, // Default false
            triggerGroup: config.triggerGroup || "iobroker_in_nodes",
            serverId,
            nodeId: node.id,
            useWildcard: isWildcardPattern,
            inputMode: inputMode
        };

        // Function to send cached values for external triggering
        node.sendCachedValues = function() {
            if (inputMode === 'single') {
                // First try currentStateValues, then fallback to lastValue
                let cachedValue = node.currentStateValues.get(subscriptionPattern);
                let state = cachedValue;
                
                if (!state && node.lastValue !== undefined) {
                    // Use lastValue as fallback
                    state = { val: node.lastValue };
                }
                
                if (state && state.val !== undefined) {
                    const message = {
                        topic: subscriptionPattern,
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
                    RED.util.setMessageProperty(message, settings.outputProperty, state.val);
                    node.send(message);
                }
            } else if (inputMode === 'multiple') {
                if (settings.outputMode === 'grouped') {
                    // Grouped mode: send all cached values in one message
                    const groupedValues = {};
                    const groupedStates = {};
                    let hasValues = false;
                    
                    stateList.forEach(stateId => {
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
                    
                    if (hasValues) {
                        const message = {
                            topic: 'cached_states',
                            states: groupedStates,
                            timestamp: Date.now(),
                            cached: true,
                            isInitial: true,
                            multipleStatesMode: true,
                            outputMode: 'grouped'
                        };
                        RED.util.setMessageProperty(message, settings.outputProperty, groupedValues);
                        node.send(message);
                    }
                } else {
                    // Individual mode: send separate message for each cached value
                    stateList.forEach(stateId => {
                        const state = node.currentStateValues.get(stateId);
                        if (state && state.val !== undefined) {
                            const message = {
                                topic: stateId,
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
                            RED.util.setMessageProperty(message, settings.outputProperty, state.val);
                            node.send(message);
                        }
                    });
                }
            }
        };

        // Function to dynamically switch to a new topic (only for single state mode)
        node.triggerWithTopic = async function(newTopic) {
            // Only available for single state mode (not wildcard, not multiple)
            if (inputMode !== 'single') {
                node.warn("Dynamic topic switching only available for single state mode");
                return;
            }

            if (!newTopic || typeof newTopic !== 'string') {
                node.warn("Invalid topic provided for dynamic switching");
                return;
            }

            // If same topic, just send cached value
            if (newTopic === subscriptionPattern) {
                node.sendCachedValues();
                return;
            }

            try {
                setStatus("yellow", "ring", `Switching to: ${newTopic}`);

                // Unsubscribe from old topic
                if (node.isSubscribed) {
                    await connectionManager.unsubscribe(
                        settings.nodeId,
                        settings.serverId,
                        subscriptionPattern,
                        globalConfig
                    );
                    node.debug(`Unsubscribed from: ${subscriptionPattern}`);
                }

                // Clear previous state
                node.currentStateValues.clear();
                node.lastValue = undefined;
                node.hasReceivedValue = false;
                node.previous.clear();

                // Update subscription pattern
                const oldPattern = subscriptionPattern;
                subscriptionPattern = newTopic;
                node.subscriptionPattern = newTopic;

                // Check if new topic is wildcard pattern
                const newIsWildcard = newTopic.includes('*');
                if (newIsWildcard) {
                    node.warn(`Wildcard patterns not supported for dynamic switching: ${newTopic}`);
                    // Restore old pattern
                    subscriptionPattern = oldPattern;
                    node.subscriptionPattern = oldPattern;
                    setStatus("red", "ring", "Wildcard not supported");
                    return;
                }

                // Subscribe to new topic
                const callback = createCallback();
                await connectionManager.subscribe(
                    settings.nodeId,
                    settings.serverId,
                    subscriptionPattern,
                    callback,
                    globalConfig
                );

                node.isSubscribed = true;
                node.debug(`Subscribed to: ${subscriptionPattern}`);

                // Initialize smart change filter for new topic if needed
                if (settings.filterMode === 'changes-smart') {
                    try {
                        const state = await connectionManager.getState(settings.serverId, subscriptionPattern);
                        if (state && state.val !== undefined) {
                            updatePreviousValue(subscriptionPattern, state.val);
                            node.debug(`Smart filter: Pre-loaded ${subscriptionPattern} = ${state.val}`);
                        }
                    } catch (error) {
                        node.debug(`Smart filter: Could not load ${subscriptionPattern}: ${error.message}`);
                    }
                }

                // Update status to show new topic
                updateStatusWithValue();

                // Update registration in flow context if external triggering is enabled
                if (settings.enableExternalTrigger) {
                    const flowContext = node.context().flow;
                    const existingNodes = flowContext.get(settings.triggerGroup) || {};
                    if (existingNodes[node.id]) {
                        existingNodes[node.id].states = [subscriptionPattern];
                        existingNodes[node.id].stateId = subscriptionPattern;
                        flowContext.set(settings.triggerGroup, existingNodes);
                    }
                }

            } catch (error) {
                setError(`Failed to switch topic: ${error.message}`, "Switch failed");
                node.isSubscribed = false;
            }
        };

        // Function to dynamically switch to new topics array (only for multiple state mode)
        node.triggerWithTopicArray = async function(newTopics, newOutputMode) {
            // Only available for multiple state mode
            if (inputMode !== 'multiple') {
                node.warn("Dynamic topics array switching only available for multiple state mode");
                return;
            }

            if (!Array.isArray(newTopics) || newTopics.length === 0) {
                node.warn("Invalid topics array provided - must be non-empty array");
                return;
            }

            // Filter and validate topics
            const validTopics = newTopics
                .map(t => typeof t === 'string' ? t.trim() : '')
                .filter(t => t.length > 0);

            if (validTopics.length === 0) {
                node.warn("No valid topics in array after filtering");
                return;
            }

            // Check for wildcards (not supported in dynamic switching)
            const wildcardTopics = validTopics.filter(t => t.includes('*'));
            if (wildcardTopics.length > 0) {
                node.warn(`Wildcard patterns not supported for dynamic switching: ${wildcardTopics.join(', ')}`);
                setStatus("red", "ring", "Wildcards not supported");
                return;
            }

            // Check if anything changed
            const currentTopicsStr = JSON.stringify([...stateList].sort());
            const newTopicsStr = JSON.stringify([...validTopics].sort());
            
            if (currentTopicsStr === newTopicsStr && !newOutputMode) {
                // Nothing changed, just trigger current values
                node.sendCachedValues();
                return;
            }

            try {
                setStatus("yellow", "ring", `Switching to ${validTopics.length} states...`);

                // Unsubscribe from old topics
                if (node.isSubscribed && node.subscribedStates.size > 0) {
                    await connectionManager.unsubscribeMultiple(
                        settings.nodeId,
                        settings.serverId,
                        Array.from(node.subscribedStates),
                        globalConfig
                    );
                    node.debug(`Unsubscribed from ${node.subscribedStates.size} states`);
                }

                // Clear previous state
                node.currentStateValues.clear();
                node.subscribedStates.clear();
                node.hasReceivedValue = false;
                node.previous.clear();

                // Update state list
                stateList = validTopics;
                node.stateList = validTopics;

                // Update output mode if provided
                if (newOutputMode && (newOutputMode === 'individual' || newOutputMode === 'grouped')) {
                    settings.outputMode = newOutputMode;
                }

                // Subscribe to new topics (with forced initial value)
                const callback = createCallback(true); // Force initial value
                
                const successfulStates = await connectionManager.subscribeMultiple(
                    settings.nodeId,
                    settings.serverId,
                    stateList,
                    callback,
                    globalConfig
                );

                // Sync subscribedStates with successful subscriptions
                node.subscribedStates.clear();
                successfulStates.forEach(s => node.subscribedStates.add(s));

                node.isSubscribed = true;
                node.debug(`Subscribed to ${successfulStates.length} states (${settings.outputMode} mode)`);

                // Initialize smart change filter for new topics if needed
                if (settings.filterMode === 'changes-smart') {
                    for (const stateId of stateList) {
                        try {
                            const state = await connectionManager.getState(settings.serverId, stateId);
                            if (state && state.val !== undefined) {
                                updatePreviousValue(stateId, state.val);
                                node.debug(`Smart filter: Pre-loaded ${stateId} = ${state.val}`);
                            }
                        } catch (error) {
                            node.debug(`Smart filter: Could not load ${stateId}: ${error.message}`);
                        }
                    }
                }

                // Update status
                updateStatusWithValue();

                // Update registration in flow context if external triggering is enabled
                if (settings.enableExternalTrigger) {
                    const flowContext = node.context().flow;
                    const existingNodes = flowContext.get(settings.triggerGroup) || {};
                    if (existingNodes[node.id]) {
                        existingNodes[node.id].states = stateList;
                        existingNodes[node.id].outputMode = settings.outputMode;
                        flowContext.set(settings.triggerGroup, existingNodes);
                    }
                }

            } catch (error) {
                setError(`Failed to switch topics array: ${error.message}`, "Switch failed");
                node.isSubscribed = false;
            }
        };

        // Register node in flow context for external triggering (only if enabled)
        if (settings.enableExternalTrigger) {
            const flowContext = node.context().flow;
            const existingNodes = flowContext.get(settings.triggerGroup) || {};
            existingNodes[node.id] = {
                nodeRef: node,
                triggerCached: node.sendCachedValues,
                triggerWithTopic: inputMode === 'single' && !isWildcardPattern ? node.triggerWithTopic : undefined,
                triggerWithTopicArray: inputMode === 'multiple' ? node.triggerWithTopicArray : undefined,
                states: inputMode === 'single' ? [subscriptionPattern] : stateList,
                mode: inputMode,
                name: node.name || `iob-in-${node.id.substring(0, 8)}`,
                outputMode: settings.outputMode,
                stateId: inputMode === 'single' ? subscriptionPattern : undefined,
                group: settings.triggerGroup,
                supportsDynamicTopic: inputMode === 'single' && !isWildcardPattern,
                supportsDynamicArray: inputMode === 'multiple'
            };
            flowContext.set(settings.triggerGroup, existingNodes);
        }

        node.currentConfig = connectionDetails;
        node.isInitialized = false;
        node.isSubscribed = false;
        node.subscriptionPattern = subscriptionPattern;
        node.stateList = stateList;
        node.currentStateValues = new Map();
        node.subscribedStates = new Set();
        node.initialValueCount = 0;
        node.expectedInitialValues = 0;
        node.initialGroupedMessageSent = false;
        node.fallbackTimeout = null;
        node.lastValue = undefined;
        node.hasReceivedValue = false;

        node.previous = new Map();

        function updateStatusWithValue(isInitialValue = false) {
            if (isSingleState && node.hasReceivedValue && node.lastValue !== undefined) {
                const formattedValue = NodeHelpers.formatValueForStatus(node.lastValue);
                const filterLabel = (settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') ? ' [Changes]' : '';
                const timestamp = new Date().toLocaleTimeString(undefined, { hour12: false });
                const initialLabel = isInitialValue ? ' (initial)' : '';
                setStatus("green", "dot", `${formattedValue}${filterLabel}${initialLabel}`);
            } else {
                const timestamp = new Date().toLocaleTimeString(undefined, { hour12: false });
                let statusText;

                if (isMultipleStates) {
                    const subscribedCount = node.subscribedStates.size;
                    const filterLabel = (settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') ? ' [Changes]' : '';
                    if (node.hasReceivedValue) {
                        statusText = `${subscribedCount} states${filterLabel} - Last: ${timestamp}`;
                    } else {
                        statusText = `${stateList.length} states (${settings.outputMode})${filterLabel}`;
                    }
                } else if (isWildcardPattern) {
                    const filterLabel = (settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') ? ' [Changes]' : '';
                    if (node.hasReceivedValue) {
                        statusText = `Pattern active${filterLabel} - Last: ${timestamp}`;
                    } else {
                        statusText = `Pattern: ${subscriptionPattern}${filterLabel}`;
                    }
                } else {
                    const filterLabel = (settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') ? ' [Changes]' : '';
                    statusText = `Ready${filterLabel}`;
                }
                setStatus("green", "dot", statusText);
            }
        }

        // Use NodeHelpers for standard validation and error handling
        function shouldSendMessage(ack, filter) {
            return NodeHelpers.shouldSendByAck(ack, filter);
        }

        function shouldSendByValue(stateId, newValue, filterMode, isInitialValue = false) {
            if (isInitialValue) {
                return true;
            }

            if (filterMode !== 'changes-only' && filterMode !== 'changes-smart') {
                return true;
            }

            const previousValue = node.previous.get(stateId);

            if (filterMode === 'changes-only' && previousValue === undefined) {
                return true;
            }

            if (typeof newValue === 'object' && newValue !== null) {
                const currentJSON = JSON.stringify(newValue);
                const previousJSON = previousValue !== undefined ? JSON.stringify(previousValue) : undefined;
                return currentJSON !== previousJSON;
            }

            return newValue !== previousValue;
        }

        function updatePreviousValue(stateId, value) {
            if (settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') {
                if (typeof value === 'object' && value !== null) {
                    try {
                        node.previous.set(stateId, JSON.parse(JSON.stringify(value)));
                    } catch (e) {
                        node.previous.set(stateId, value);
                    }
                } else {
                    node.previous.set(stateId, value);
                }
            }
        }

        async function initializeSmartChangeFilter() {
            if (settings.filterMode !== 'changes-smart') {
                return;
            }

            try {
                if (isMultipleStates) {
                    for (const stateId of stateList) {
                        try {
                            const state = await connectionManager.getState(settings.serverId, stateId);
                            if (state && state.val !== undefined) {
                                updatePreviousValue(stateId, state.val);
                                node.debug(`Smart filter: Pre-loaded ${stateId} = ${state.val}`);
                            }
                        } catch (error) {
                            node.debug(`Smart filter: Could not load ${stateId}: ${error.message}`);
                        }
                    }
                } else if (!isWildcardPattern) {
                    try {
                        const state = await connectionManager.getState(settings.serverId, subscriptionPattern);
                        if (state && state.val !== undefined) {
                            updatePreviousValue(subscriptionPattern, state.val);
                            node.debug(`Smart filter: Pre-loaded ${subscriptionPattern} = ${state.val}`);
                        }
                    } catch (error) {
                        node.debug(`Smart filter: Could not load ${subscriptionPattern}: ${error.message}`);
                    }
                }
            } catch (error) {
                node.warn(`Smart change filter initialization failed: ${error.message}`);
            }
        }

        function createMessage(stateId, state, isInitialValue = false) {
            const message = {
                topic: stateId,
                state: state,
                timestamp: Date.now()
            };

            if (isWildcardPattern) {
                message.pattern = node.subscriptionPattern;
            }

            if (isInitialValue) {
                message.initial = true;
            }

            RED.util.setMessageProperty(message, settings.outputProperty, state.val);
            return message;
        }

        async function ensureAllStatesLoaded() {
            if (!isMultipleStates || settings.outputMode !== 'grouped') {
                return true;
            }

            const subscribedStateArray = Array.from(node.subscribedStates);
            const missingStates = subscribedStateArray.filter(stateId => !node.currentStateValues.has(stateId));

            if (missingStates.length === 0) {
                return true;
            }

            try {
                for (const stateId of missingStates) {
                    try {
                        const state = await connectionManager.getState(settings.serverId, stateId);
                        if (state && state.val !== undefined) {
                            node.currentStateValues.set(stateId, state);
                        }
                    } catch (getError) {
                        node.warn(`Could not get value for ${stateId}: ${getError.message}`);
                    }
                }
                return true;
            } catch (error) {
                node.warn(`Error loading missing states: ${error.message}`);
                return false;
            }
        }

        function createGroupedMessage(changedStateId, changedState, isInitialMessage = false) {
            const values = {};
            const states = {};

            for (const [stateId, stateData] of node.currentStateValues.entries()) {
                if (stateData && stateData.val !== undefined) {
                    values[stateId] = stateData.val;
                    states[stateId] = stateData;
                }
            }

            const message = {
                topic: "grouped_states",
                states: states,
                timestamp: Date.now()
            };
            RED.util.setMessageProperty(message, settings.outputProperty, values);

            if (isInitialMessage) {
                message.initial = true;
            }

            if (changedStateId) {
                message.changedState = changedStateId;
            }

            if (changedState) {
                message.changedValue = changedState.val;
            }

            return message;
        }

        function sendGroupedInitialMessage() {
            if (node.initialGroupedMessageSent) {
                return;
            }

            if (node.fallbackTimeout) {
                clearTimeout(node.fallbackTimeout);
                node.fallbackTimeout = null;
            }

            const message = createGroupedMessage(null, null, true);
            node.send(message);
            node.initialGroupedMessageSent = true;
            node.hasReceivedValue = true;

            const expectedCount = node.expectedInitialValues;
            node.debug(`Grouped initial message sent with ${node.currentStateValues.size}/${expectedCount} states`);

            updateStatusWithValue(true);
        }

        function onStateChange(stateId, state, isInitialValue = false) {
            try {
                if (!state || state.val === undefined) {
                    node.warn(`Invalid state data received for ${stateId}`);
                    return;
                }

                if (!shouldSendMessage(state.ack, settings.ackFilter)) {
                    return;
                }

                if (isMultipleStates && !node.subscribedStates.has(stateId)) {
                    return;
                }

                if (!shouldSendByValue(stateId, state.val, settings.filterMode, isInitialValue)) {
                    node.debug(`Change filter blocked duplicate value for ${stateId}: ${state.val}`);
                    return;
                }

                if (!(isInitialValue && settings.filterMode === 'changes-smart')) {
                    updatePreviousValue(stateId, state.val);
                }

                if (isMultipleStates) {
                    node.currentStateValues.set(stateId, state);
                }

                if (isSingleState) {
                    node.lastValue = state.val;
                    node.hasReceivedValue = true;
                    // Also store in currentStateValues for caching
                    node.currentStateValues.set(stateId, state);
                }

                // Helper function to send message and update status
                function sendMessageAndUpdateStatus(message, isInitial = false) {
                    node.send(message);
                    node.hasReceivedValue = true;
                    updateStatusWithValue(isInitial);
                }

                if (isMultipleStates) {
                    if (settings.outputMode === 'grouped') {
                        if (node.currentStateValues.size < node.subscribedStates.size) {
                            ensureAllStatesLoaded().then(() => {
                                sendMessageAndUpdateStatus(createGroupedMessage(stateId, state));
                            }).catch(error => {
                                node.warn(`Error loading all states: ${error.message}, sending available states`);
                                sendMessageAndUpdateStatus(createGroupedMessage(stateId, state));
                            });
                        } else {
                            sendMessageAndUpdateStatus(createGroupedMessage(stateId, state));
                        }
                    } else {
                        sendMessageAndUpdateStatus(createMessage(stateId, state, isInitialValue));
                    }
                } else {
                    sendMessageAndUpdateStatus(createMessage(stateId, state, isInitialValue), isInitialValue);
                }

            } catch (error) {
                node.error(`State change processing error: ${error.message}`);
                setError(`Processing error: ${error.message}`, "Process error");
            }
        }

        // Consolidated function to sync subscribedStates 
        function syncSubscribedStates(stateArray) {
            if (isMultipleStates && stateArray) {
                node.subscribedStates.clear();
                stateArray.forEach(stateId => {
                    node.subscribedStates.add(stateId);
                });
                node.debug(`Synced ${node.subscribedStates.size} subscribed states`);
            }
        }

        function createCallback() {
            const callback = onStateChange;

            callback.wantsInitialValue = settings.sendInitialValue;

            callback.onInitialValue = function (stateId, state) {
                try {
                    if (!shouldSendMessage(state.ack, settings.ackFilter)) {
                        return;
                    }

                    if (isMultipleStates) {
                        node.currentStateValues.set(stateId, state);
                        node.initialValueCount++;

                        if (settings.filterMode !== 'changes-smart') {
                            updatePreviousValue(stateId, state.val);
                        }

                        if (settings.outputMode === 'grouped') {
                            if (node.initialValueCount >= node.expectedInitialValues) {
                                sendGroupedInitialMessage();
                            } else {
                                if (!node.fallbackTimeout) {
                                    node.fallbackTimeout = setTimeout(() => {
                                        node.warn(`Fallback timeout: sending grouped message with ${node.currentStateValues.size}/${node.expectedInitialValues} states`);
                                        sendGroupedInitialMessage();
                                    }, 2000);
                                }
                            }
                        } else {
                            const message = createMessage(stateId, state, true);
                            node.send(message);
                            node.hasReceivedValue = true;
                            updateStatusWithValue(true);
                        }
                    } else {
                        if (settings.filterMode !== 'changes-smart') {
                            updatePreviousValue(stateId, state.val);
                        }

                        if (isSingleState) {
                            node.lastValue = state.val;
                            node.hasReceivedValue = true;
                            // Also store in currentStateValues for caching
                            node.currentStateValues.set(stateId, state);
                        }

                        const message = createMessage(stateId, state, true);
                        node.send(message);
                        updateStatusWithValue(true);
                    }

                } catch (error) {
                    node.error(`Initial value processing error: ${error.message}`);
                }
            };

            const statusTexts = {
                ready: isMultipleStates
                    ? `${stateList.length} states (${settings.outputMode})${(settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') ? ' [Changes]' : ''}`
                    : isWildcardPattern
                        ? `Pattern: ${subscriptionPattern}${(settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') ? ' [Changes]' : ''}`
                        : `Ready${(settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') ? ' [Changes]' : ''}`,
                disconnected: "Disconnected"
            };

            const baseCallback = NodeHelpers.createSubscriptionEventCallback(
                node,
                setStatus,
                () => {
                    node.isSubscribed = true;
                    // Sync subscribedStates after successful subscription
                    if (isMultipleStates) {
                        syncSubscribedStates(stateList);
                    }
                },
                statusTexts
            );

            Object.assign(callback, baseCallback);

            // Store original onSubscribed function before overriding
            const originalOnSubscribed = callback.onSubscribed;
            callback.onSubscribed = function() {
                if (originalOnSubscribed) {
                    originalOnSubscribed();
                }
                
                // Sync subscribedStates after successful subscription
                if (isMultipleStates) {
                    syncSubscribedStates(stateList);
                }
            };

            callback.onReconnect = function() {
                node.isSubscribed = false;
                node.initialValueCount = 0;
                node.initialGroupedMessageSent = false;
                node.hasReceivedValue = false;
                node.lastValue = undefined;
                node.previous.clear();
                if (node.fallbackTimeout) {
                    clearTimeout(node.fallbackTimeout);
                    node.fallbackTimeout = null;
                }
                
                // Reset and restore subscribedStates  
                if (isMultipleStates) {
                    node.currentStateValues.clear();
                    node.expectedInitialValues = stateList.length;
                    syncSubscribedStates(stateList);
                }
                
                setStatus("yellow", "ring", "Resubscribing...");
                updateStatusWithValue();
            };

            return callback;
        }

        async function subscribeToStates() {
            const callback = createCallback();

            if (isMultipleStates) {
                node.expectedInitialValues = stateList.length;
                node.initialValueCount = 0;

                try {
                    const successfulStates = await connectionManager.subscribeMultiple(
                        settings.nodeId,
                        settings.serverId,
                        stateList,
                        callback,
                        globalConfig
                    );

                    // Sync subscribedStates with actually successful states
                    syncSubscribedStates(successfulStates);

                } catch (error) {
                    // Only log subscribe errors if not caused by known connection issues
                    const isAuthError = error.message && (error.message.includes('Authentication failed') || error.message.includes('auth_failed'));
                    if (!isAuthError) {
                        node.error(`Failed to subscribe to multiple states: ${error.message}`);
                    }
                    throw error;
                }
            } else {
                await connectionManager.subscribe(
                    settings.nodeId,
                    settings.serverId,
                    subscriptionPattern,
                    callback,
                    globalConfig
                );
            }
        }

        async function initialize() {
            const status = connectionManager.getConnectionStatus(settings.serverId);
            if (node.isSubscribed && status.connected && status.ready) {
                return;
            }

            try {
                setStatus("yellow", "ring", "Connecting...");

                node.currentStateValues.clear();
                node.subscribedStates.clear();
                node.initialValueCount = 0;
                node.initialGroupedMessageSent = false;
                node.hasReceivedValue = false;
                node.lastValue = undefined;
                node.previous.clear();
                if (node.fallbackTimeout) {
                    clearTimeout(node.fallbackTimeout);
                    node.fallbackTimeout = null;
                }

                await NodeHelpers.handleConfigChange(node, config, RED, settings);

                await subscribeToStates();

                await initializeSmartChangeFilter();

                node.isSubscribed = true;

                updateStatusWithValue();
                node.isInitialized = true;

            } catch (error) {
                const errorMsg = error.message || 'Unknown error';

                if (errorMsg.includes('auth_failed') || errorMsg.includes('Authentication failed')) {
                    setStatus("red", "ring", "Auth failed");
                } else if (errorMsg.includes('not possible in state')) {
                    setStatus("red", "ring", "Connection failed");
                } else {
                    setStatus("yellow", "ring", "Retrying...");
                }

                node.isSubscribed = false;
            }
        }

    node.on("close", async function (removed, done) {
            node.isInitialized = false;
            node.isSubscribed = false;

            // Remove from flow context (only if external triggering was enabled)
            if (settings.enableExternalTrigger) {
                const flowContext = node.context().flow;
                const existingNodes = flowContext.get(settings.triggerGroup) || {};
                delete existingNodes[node.id];
                flowContext.set(settings.triggerGroup, existingNodes);
            }

            if (node.fallbackTimeout) {
                clearTimeout(node.fallbackTimeout);
                node.fallbackTimeout = null;
            }

            try {
        // 1) Unsubscribe first while connection is still open
                if (isMultipleStates) {
                    await connectionManager.unsubscribeMultiple(
                        settings.nodeId,
                        settings.serverId,
                        Array.from(node.subscribedStates)
                    );
                } else {
                    await connectionManager.unsubscribe(
                        settings.nodeId,
                        settings.serverId,
                        subscriptionPattern
                    );
                }

        // 2) Now unregister from events and clear status
        await NodeHelpers.handleNodeClose(node, settings, 'subscription');

            } catch (error) {
                node.warn(`Cleanup error: ${error.message}`);
            } finally {
                done();
            }
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));

        initialize();
    }

    RED.nodes.registerType("iobin", iobin);
};