const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

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
                        [settings.outputProperty]: state.val,
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
                            [settings.outputProperty]: groupedValues,
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
                    stateList.forEach(stateId => {
                        const state = node.currentStateValues.get(stateId);
                        if (state && state.val !== undefined) {
                            const message = {
                                topic: stateId,
                                [settings.outputProperty]: state.val,
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
        };

        // Register node in flow context for external triggering (only if enabled)
        if (settings.enableExternalTrigger) {
            const flowContext = node.context().flow;
            const existingNodes = flowContext.get(settings.triggerGroup) || {};
            existingNodes[node.id] = {
                nodeRef: node,
                triggerCached: node.sendCachedValues,
                states: inputMode === 'single' ? [subscriptionPattern] : stateList,
                mode: inputMode,
                name: node.name || `iob-in-${node.id.substring(0, 8)}`,
                outputMode: settings.outputMode,
                stateId: inputMode === 'single' ? subscriptionPattern : undefined,
                group: settings.triggerGroup
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

        function formatValueForStatus(value) {
            let displayValue;

            if (value === null) {
                displayValue = "null";
            } else if (value === undefined) {
                displayValue = "undefined";
            } else if (typeof value === 'boolean') {
                displayValue = value ? "true" : "false";
            } else if (typeof value === 'object') {
                try {
                    displayValue = JSON.stringify(value);
                } catch (e) {
                    displayValue = "[Object]";
                }
            } else {
                displayValue = String(value);
            }

            if (displayValue.length > 20) {
                return "..." + displayValue.slice(-20);
            }

            return displayValue;
        }

        function updateStatusWithValue(isInitialValue = false) {
            if (isSingleState && node.hasReceivedValue && node.lastValue !== undefined) {
                const formattedValue = formatValueForStatus(node.lastValue);
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

        function shouldSendMessage(ack, filter) {
            switch (filter) {
                case "ack": return ack === true;
                case "noack": return ack === false;
                default: return true;
            }
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

            message[settings.outputProperty] = state.val;
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
                [settings.outputProperty]: values,
                states: states,
                timestamp: Date.now()
            };

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

                if (isMultipleStates) {
                    if (settings.outputMode === 'grouped') {
                        if (node.currentStateValues.size < node.subscribedStates.size) {
                            ensureAllStatesLoaded().then(() => {
                                const message = createGroupedMessage(stateId, state);
                                node.send(message);
                                node.hasReceivedValue = true;
                                updateStatusWithValue();
                            }).catch(error => {
                                node.warn(`Error loading all states: ${error.message}, sending available states`);
                                const message = createGroupedMessage(stateId, state);
                                node.send(message);
                                node.hasReceivedValue = true;
                                updateStatusWithValue();
                            });
                        } else {
                            const message = createGroupedMessage(stateId, state);
                            node.send(message);
                            node.hasReceivedValue = true;
                            updateStatusWithValue();
                        }
                    } else {
                        const message = createMessage(stateId, state, isInitialValue);
                        node.send(message);
                        node.hasReceivedValue = true;
                        updateStatusWithValue();
                    }
                } else {
                    const message = createMessage(stateId, state, isInitialValue);
                    node.send(message);
                    updateStatusWithValue(isInitialValue);
                }

            } catch (error) {
                node.error(`State change processing error: ${error.message}`);
                setError(`Processing error: ${error.message}`, "Process error");
            }
        }

        // WICHTIG: Funktion um subscribedStates vom NodeRegistry zu synchronisieren
        function syncSubscribedStatesFromRegistry() {
            try {
                // Diese Funktion würde die subscribedStates vom NodeRegistry holen
                // Da wir keinen direkten Zugriff haben, müssen wir das anders lösen
                if (isMultipleStates) {
                    const registryInfo = connectionManager.getMultipleStateInfo?.(settings.nodeId);
                    if (registryInfo && registryInfo.subscribedStates) {
                        node.subscribedStates = new Set(registryInfo.subscribedStates);
                        node.debug(`Synced ${node.subscribedStates.size} subscribed states from registry`);
                    }
                }
            } catch (error) {
                node.debug(`Could not sync subscribed states from registry: ${error.message}`);
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
                    // WICHTIG: Nach erfolgreicher Subscription subscribedStates synchronisieren
                    if (isMultipleStates) {
                        syncSubscribedStatesFromRegistry();
                    }
                },
                statusTexts
            );

            Object.assign(callback, baseCallback);

            // KORREKTUR: onSubscribed erweitern um die subscribedStates zu synchronisieren
            const originalOnSubscribed = callback.onSubscribed;
            callback.onSubscribed = function() {
                if (originalOnSubscribed) {
                    originalOnSubscribed();
                }
                
                // WICHTIG: subscribedStates nach erfolgreicher Subscription synchronisieren
                if (isMultipleStates) {
                    // Da wir die erfolgreichen States von subscribeMultiple bekommen haben,
                    // sollten sie bereits in node.subscribedStates sein
                    // Aber zur Sicherheit nochmals die ursprünglichen States setzen
                    if (node.subscribedStates.size === 0) {
                        stateList.forEach(stateId => {
                            node.subscribedStates.add(stateId);
                        });
                        node.debug(`Restored ${node.subscribedStates.size} subscribed states in onSubscribed`);
                    }
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
                
                // KORREKTUR: subscribedStates mit ursprünglichen States wiederherstellen
                if (isMultipleStates) {
                    node.subscribedStates.clear();
                    node.currentStateValues.clear();
                    stateList.forEach(stateId => {
                        node.subscribedStates.add(stateId);
                    });
                    node.expectedInitialValues = stateList.length;
                    node.debug(`Restored ${node.subscribedStates.size} subscribed states in onReconnect`);
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

                    // WICHTIG: subscribedStates mit den tatsächlich erfolgreichen States setzen
                    node.subscribedStates.clear();
                    successfulStates.forEach(stateId => {
                        node.subscribedStates.add(stateId);
                    });
                    
                    node.debug(`Successfully subscribed to ${node.subscribedStates.size}/${stateList.length} states`);

                } catch (error) {
                    node.error(`Failed to subscribe to multiple states: ${error.message}`);
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

                node.status({});

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