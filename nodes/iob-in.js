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

        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            ackFilter: config.ackFilter || "both",
            sendInitialValue: config.sendInitialValue && !isWildcardPattern,
            outputMode: config.outputMode || "individual",
            filterMode: config.filterMode || "all",
            serverId,
            nodeId: node.id,
            useWildcard: isWildcardPattern,
            inputMode: inputMode
        };

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
        
        // Store previous values for change filtering
        node.previous = new Map();

        function shouldSendMessage(ack, filter) {
            switch (filter) {
                case "ack": return ack === true;
                case "noack": return ack === false;
                default: return true;
            }
        }

        function shouldSendByValue(stateId, newValue, filterMode, isInitialValue = false) {
            // Initial values always bypass change filter
            if (isInitialValue) {
                return true;
            }
            
            if (filterMode !== 'changes-only' && filterMode !== 'changes-smart') {
                return true; // Send all changes when not in change-filter mode
            }

            // Get previous value
            const previousValue = node.previous.get(stateId);
            
            // For standard change filter: if no previous value exists, always send (first change)
            if (filterMode === 'changes-only' && previousValue === undefined) {
                return true;
            }
            
            // For smart change filter or when previous value exists: only send if changed
            // Deep comparison for objects and arrays
            if (typeof newValue === 'object' && newValue !== null) {
                const currentJSON = JSON.stringify(newValue);
                const previousJSON = previousValue !== undefined ? JSON.stringify(previousValue) : undefined;
                return currentJSON !== previousJSON;
            }
            
            // Simple comparison for primitive values
            return newValue !== previousValue;
        }

        function updatePreviousValue(stateId, value) {
            if (settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') {
                // Store a deep copy for objects, or the value directly for primitives
                if (typeof value === 'object' && value !== null) {
                    try {
                        node.previous.set(stateId, JSON.parse(JSON.stringify(value)));
                    } catch (e) {
                        // Fallback for non-serializable objects
                        node.previous.set(stateId, value);
                    }
                } else {
                    node.previous.set(stateId, value);
                }
            }
        }

        // Smart Change Filter: Pre-load current values to initialize baseline
        async function initializeSmartChangeFilter() {
            if (settings.filterMode !== 'changes-smart') {
                return;
            }

            try {
                if (isMultipleStates) {
                    // Initialize multiple states
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
                    // Initialize single state (not wildcards)
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
            
            const currentCount = node.currentStateValues.size;
            const expectedCount = node.expectedInitialValues;
            node.debug(`Grouped initial message sent with ${currentCount}/${expectedCount} states`);
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

                // Change filtering: check if we should send based on value change
                if (!shouldSendByValue(stateId, state.val, settings.filterMode, isInitialValue)) {
                    node.debug(`Change filter blocked duplicate value for ${stateId}: ${state.val}`);
                    return;
                }

                // Update previous value for change filtering (but only if not initial value for smart mode)
                if (!(isInitialValue && settings.filterMode === 'changes-smart')) {
                    updatePreviousValue(stateId, state.val);
                }

                if (isMultipleStates) {
                    node.currentStateValues.set(stateId, state);
                }

                if (isMultipleStates) {
                    if (settings.outputMode === 'grouped') {
                        if (node.currentStateValues.size < node.subscribedStates.size) {
                            ensureAllStatesLoaded().then(() => {
                                const message = createGroupedMessage(stateId, state);
                                node.send(message);
                            }).catch(error => {
                                node.warn(`Error loading all states: ${error.message}, sending available states`);
                                const message = createGroupedMessage(stateId, state);
                                node.send(message);
                            });
                        } else {
                            const message = createGroupedMessage(stateId, state);
                            node.send(message);
                        }
                    } else {
                        const message = createMessage(stateId, state, isInitialValue);
                        node.send(message);
                    }
                } else {
                    const message = createMessage(stateId, state, isInitialValue);
                    node.send(message);
                }

                const timestamp = new Date().toLocaleTimeString(undefined, { hour12: false });
                let statusText;

                if (isMultipleStates) {
                    const currentCount = node.currentStateValues.size;
                    const subscribedCount = node.subscribedStates.size;
                    const filterLabel = (settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') ? ' [Changes]' : '';
                    statusText = `${subscribedCount} states (${currentCount} current)${filterLabel} - Last: ${timestamp}`;
                } else if (isWildcardPattern) {
                    const filterLabel = (settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') ? ' [Changes]' : '';
                    statusText = `Pattern active${filterLabel} - Last: ${timestamp}`;
                } else {
                    const filterLabel = (settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') ? ' [Changes]' : '';
                    statusText = `Last: ${timestamp}${filterLabel}`;
                }

                setStatus("green", "dot", statusText);

            } catch (error) {
                node.error(`State change processing error: ${error.message}`);
                setError(`Processing error: ${error.message}`, "Process error");
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

                        // Update previous value for change filtering (but not for smart mode to preserve baseline)
                        if (settings.filterMode !== 'changes-smart') {
                            updatePreviousValue(stateId, state.val);
                        }

                        if (settings.outputMode === 'grouped') {
                            // For grouped mode: collect all initial values, then send once
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
                            // For individual mode: send separate message for each initial value
                            const message = createMessage(stateId, state, true);
                            node.send(message);
                        }
                    } else {
                        // Single state mode: send individual initial message
                        // Update previous value for change filtering (but not for smart mode to preserve baseline)
                        if (settings.filterMode !== 'changes-smart') {
                            updatePreviousValue(stateId, state.val);
                        }
                        
                        const message = createMessage(stateId, state, true);
                        node.send(message);
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
                },
                statusTexts
            );

            Object.assign(callback, baseCallback);

            callback.onReconnect = function() {
                node.isSubscribed = false;
                node.initialValueCount = 0;
                node.initialGroupedMessageSent = false;
                // Clear previous values on reconnect for clean start
                node.previous.clear();
                if (node.fallbackTimeout) {
                    clearTimeout(node.fallbackTimeout);
                    node.fallbackTimeout = null;
                }
                setStatus("yellow", "ring", "Resubscribing...");
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
                    
                    successfulStates.forEach(stateId => {
                        node.subscribedStates.add(stateId);
                    });
                    
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
                node.previous.clear(); // Clear previous values
                if (node.fallbackTimeout) {
                    clearTimeout(node.fallbackTimeout);
                    node.fallbackTimeout = null;
                }

                await NodeHelpers.handleConfigChange(node, config, RED, settings);

                await subscribeToStates();

                // Initialize smart change filter with current values if requested
                await initializeSmartChangeFilter();

                node.isSubscribed = true;

                let statusText;
                if (isMultipleStates) {
                    const filterLabel = (settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') ? ' [Changes]' : '';
                    statusText = `${stateList.length} states (${settings.outputMode})${filterLabel}`;
                } else if (isWildcardPattern) {
                    const filterLabel = (settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') ? ' [Changes]' : '';
                    statusText = `Pattern: ${subscriptionPattern}${filterLabel}`;
                } else {
                    const filterLabel = (settings.filterMode === 'changes-only' || settings.filterMode === 'changes-smart') ? ' [Changes]' : '';
                    statusText = `Ready${filterLabel}`;
                }

                setStatus("green", "dot", statusText);
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