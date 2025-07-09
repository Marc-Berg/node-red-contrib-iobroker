const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function (RED) {
    function iobin(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Use helper to create status functions
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        // Use helper to validate server config
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

        // Node-specific configuration
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

        function shouldSendMessage(ack, filter) {
            switch (filter) {
                case "ack": return ack === true;
                case "noack": return ack === false;
                default: return true;
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

        function onStateChange(stateId, state) {
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
                        const message = createMessage(stateId, state);
                        node.send(message);
                    }
                } else {
                    const message = createMessage(stateId, state, false);
                    node.send(message);
                }

                const timestamp = new Date().toLocaleTimeString(undefined, { hour12: false });
                let statusText;

                if (isMultipleStates) {
                    const currentCount = node.currentStateValues.size;
                    const subscribedCount = node.subscribedStates.size;
                    statusText = `${subscribedCount} states (${currentCount} current) - Last: ${timestamp}`;
                } else if (isWildcardPattern) {
                    statusText = `Pattern active - Last: ${timestamp}`;
                } else {
                    statusText = `Last: ${timestamp}`;
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

                        if (settings.outputMode === 'grouped') {
                            if (node.initialValueCount >= node.expectedInitialValues && !node.initialGroupedMessageSent) {
                                const message = createGroupedMessage(null, null, true);
                                node.send(message);
                                node.initialGroupedMessageSent = true;
                            } else if (node.initialValueCount === 1) {
                                setTimeout(() => {
                                    if (!node.initialGroupedMessageSent && node.currentStateValues.size > 0) {
                                        const message = createGroupedMessage(null, null, true);
                                        node.send(message);
                                        node.initialGroupedMessageSent = true;
                                    }
                                }, 3000);
                            }
                        } else {
                            const message = createMessage(stateId, state, true);
                            node.send(message);
                        }
                    } else {
                        const message = createMessage(stateId, state, true);
                        node.send(message);
                    }

                } catch (error) {
                    node.error(`Initial value processing error: ${error.message}`);
                }
            };

            // Custom status texts for input subscription
            const statusTexts = {
                ready: isMultipleStates 
                    ? `${stateList.length} states (${settings.outputMode})`
                    : isWildcardPattern 
                        ? `Pattern: ${subscriptionPattern}` 
                        : "Ready",
                disconnected: "Disconnected"
            };

            // Use helper for subscription event handling
            const baseCallback = NodeHelpers.createSubscriptionEventCallback(
                node, 
                setStatus,
                () => { 
                    node.isSubscribed = true; 
                },
                statusTexts
            );

            // Merge the callbacks
            Object.assign(callback, baseCallback);

            // Override reconnect to handle resubscription with state reset
            callback.onReconnect = function() {
                node.isSubscribed = false;
                node.initialValueCount = 0;
                node.initialGroupedMessageSent = false;
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

                // Handle config changes using helper
                await NodeHelpers.handleConfigChange(node, config, RED, settings);

                await subscribeToStates();

                node.isSubscribed = true;

                let statusText;
                if (isMultipleStates) {
                    statusText = `${stateList.length} states (${settings.outputMode})`;
                } else if (isWildcardPattern) {
                    statusText = `Pattern: ${subscriptionPattern}`;
                } else {
                    statusText = "Ready";
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