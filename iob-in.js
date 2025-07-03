const connectionManager = require('./lib/manager/websocket-manager');

module.exports = function (RED) {
    function iobin(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        function setError(message, statusText) {
            node.error(message);
            setStatus("red", "ring", statusText);
        }

        function setStatus(fill, shape, text) {
            try {
                node.status({ fill, shape, text });
            } catch (error) {
                node.warn(`Status update error: ${error.message}`);
            }
        }

        // Get server configuration
        const globalConfig = RED.nodes.getNode(config.server);
        if (!globalConfig) {
            return setError("No server configuration selected", "No server config");
        }

        const { iobhost, iobport, user, password, usessl } = globalConfig;
        if (!iobhost || !iobport) {
            return setError("ioBroker host or port missing", "Host/port missing");
        }

        // Default to "single" if inputMode is not set
        const inputMode = config.inputMode || (
            config.multipleStates && config.multipleStates.trim() ? 'multiple' : 'single'
        );

        let stateList = [];
        let subscriptionPattern = '';

        if (inputMode === 'single') {
            subscriptionPattern = config.state ? config.state.trim() : '';
            if (!subscriptionPattern) {
                return setError("State ID or pattern missing", "Config missing");
            }
        } else if (inputMode === 'multiple') {
            const multipleStatesRaw = config.multipleStates || '';
            stateList = multipleStatesRaw
                .split('\n')
                .map(s => s.trim())
                .filter(s => s.length > 0);

            if (stateList.length === 0) {
                return setError("No states configured for multiple states mode", "No states");
            }
        }

        const isWildcardPattern = inputMode === 'single' && subscriptionPattern.includes('*');
        const isMultipleStates = inputMode === 'multiple';

        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            ackFilter: config.ackFilter || "both",
            sendInitialValue: config.sendInitialValue && !isWildcardPattern, // Allow for multiple states
            outputMode: config.outputMode || "individual",
            serverId: connectionManager.getServerId(globalConfig),
            nodeId: node.id,
            useWildcard: isWildcardPattern,
            inputMode: inputMode
        };

        node.currentConfig = { iobhost, iobport, user, password, usessl };
        node.isInitialized = false;
        node.isSubscribed = false;
        node.subscriptionPattern = subscriptionPattern;
        node.stateList = stateList;
        node.currentStateValues = new Map(); // For grouped mode - all current values
        node.subscribedStates = new Set(); // Track which states are actually subscribed

        // Log configuration
        if (isMultipleStates) {
            node.log(`Multiple states mode: ${stateList.length} states, output: ${settings.outputMode}`);
        } else if (isWildcardPattern) {
            node.log(`Wildcard state mode: ${subscriptionPattern}`);
        } else {
            node.log(`Single state mode: ${subscriptionPattern}`);
        }

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

            // Only check subscribed states, not all states in the list
            const subscribedStateArray = Array.from(node.subscribedStates);
            const missingStates = subscribedStateArray.filter(stateId => !node.currentStateValues.has(stateId));

            if (missingStates.length === 0) {
                return true; // All subscribed states already loaded
            }

            node.log(`Loading ${missingStates.length} missing subscribed states for grouped mode`);

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

        function createGroupedMessage(changedStateId, changedState) {
            const values = {};
            const states = {};

            // Add ALL subscribed states (not all states in the list)
            for (const stateId of node.subscribedStates) {
                if (node.currentStateValues.has(stateId)) {
                    const stateData = node.currentStateValues.get(stateId);
                    values[stateId] = stateData.val;
                    states[stateId] = stateData;
                } else {
                    // State not yet received - skip it for now
                    node.log(`Subscribed state ${stateId} not yet available in grouped message`);
                }
            }

            const message = {
                topic: "grouped_states",
                [settings.outputProperty]: values,
                states: states,
                timestamp: Date.now()
            };

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

                // For multiple states, check if this state is in our subscribed list
                if (isMultipleStates && !node.subscribedStates.has(stateId)) {
                    return;
                }

                // Always update current state values
                if (isMultipleStates) {
                    node.currentStateValues.set(stateId, state);
                }

                // Handle message creation
                if (isMultipleStates) {
                    if (settings.outputMode === 'grouped') {
                        // For grouped mode, ensure all states are loaded before sending
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
                            // All states already available
                            const message = createGroupedMessage(stateId, state);
                            node.send(message);
                        }
                    } else {
                        // Individual mode
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

            // IMPORTANT: Set the wantsInitialValue flag
            callback.wantsInitialValue = settings.sendInitialValue;

            node.log(`Callback created with wantsInitialValue: ${callback.wantsInitialValue}`);

            callback.onInitialValue = function (stateId, state) {
                try {
                    node.log(`Initial value callback triggered for ${stateId}: ${state.val}`);

                    if (!shouldSendMessage(state.ack, settings.ackFilter)) {
                        node.log(`Initial value filtered out due to ack filter: ${stateId}`);
                        return;
                    }

                    const message = createMessage(stateId, state, true);
                    node.send(message);

                    node.log(`Initial value sent for ${stateId}: ${state.val}`);

                } catch (error) {
                    node.error(`Initial value processing error: ${error.message}`);
                }
            };

            callback.updateStatus = function (status) {
                switch (status) {
                    case 'ready':
                        let statusText;
                        if (isMultipleStates) {
                            statusText = `${stateList.length} states (${settings.outputMode})`;
                        } else if (isWildcardPattern) {
                            statusText = `Pattern: ${node.subscriptionPattern}`;
                        } else {
                            statusText = "Ready";
                        }
                        setStatus("green", "dot", statusText);
                        node.isInitialized = true;
                        break;
                    case 'connecting':
                        setStatus("yellow", "ring", "Connecting...");
                        node.isSubscribed = false;
                        break;
                    case 'disconnected':
                        setStatus("red", "ring", "Disconnected");
                        node.isInitialized = false;
                        node.isSubscribed = false;
                        break;
                    case 'retrying':
                        setStatus("yellow", "ring", "Retrying...");
                        break;
                    case 'failed_permanently':
                        setStatus("red", "ring", "Auth failed");
                        break;
                    default:
                        setStatus("grey", "ring", status);
                }
            };

            callback.onReconnect = function () {
                node.log("Reconnection detected - resubscribing");
                node.isSubscribed = false;
                setStatus("yellow", "ring", "Resubscribing...");
            };

            callback.onDisconnect = function () {
                node.log("Disconnection detected by node");
                setStatus("red", "ring", "Disconnected");
                node.isSubscribed = false;
            };

            callback.onSubscribed = function () {
                node.log("Subscription successful");
                node.isSubscribed = true;
            };

            // IMPORTANT: Mark this callback as already subscribed to prevent resubscribe
            callback.alreadySubscribed = true;

            return callback;
        }

        function hasConfigChanged() {
            const currentGlobalConfig = RED.nodes.getNode(config.server);
            if (!currentGlobalConfig) return false;

            const configChanged = (
                node.currentConfig.iobhost !== currentGlobalConfig.iobhost ||
                node.currentConfig.iobport !== currentGlobalConfig.iobport ||
                node.currentConfig.user !== currentGlobalConfig.user ||
                node.currentConfig.password !== currentGlobalConfig.password ||
                node.currentConfig.usessl !== currentGlobalConfig.usessl
            );

            if (configChanged) {
                node.log(`Configuration change detected`);
                node.isSubscribed = false;
            }

            return configChanged;
        }

        async function subscribeToStates() {
            const callback = createCallback();

            if (isMultipleStates) {
                // Subscribe to each state individually
                for (const stateId of stateList) {
                    try {
                        await connectionManager.subscribe(
                            `${settings.nodeId}_${stateId}`,
                            settings.serverId,
                            stateId,
                            callback,
                            globalConfig
                        );
                        // Track successfully subscribed states
                        node.subscribedStates.add(stateId);
                    } catch (error) {
                        node.error(`Failed to subscribe to state ${stateId}: ${error.message}`);
                        throw error;
                    }
                }
                node.log(`Successfully subscribed to ${node.subscribedStates.size} states in ${settings.outputMode} mode`);
            } else {
                // Single state or wildcard - use original simple approach
                await connectionManager.subscribe(
                    settings.nodeId,
                    settings.serverId,
                    subscriptionPattern,
                    callback,
                    globalConfig
                );
                node.log(`Successfully subscribed to ${isWildcardPattern ? 'wildcard pattern' : 'single state'}: ${subscriptionPattern}${settings.sendInitialValue ? ' (with initial value)' : ''}`);
            }
        }

        async function initialize() {
            const status = connectionManager.getConnectionStatus(settings.serverId);
            if (node.isSubscribed && status.connected && status.ready) {
                node.log("Already subscribed and connected, skipping initialization");
                return;
            }

            try {
                setStatus("yellow", "ring", "Connecting...");

                if (hasConfigChanged()) {
                    const newGlobalConfig = RED.nodes.getNode(config.server);
                    const oldServerId = settings.serverId;

                    node.currentConfig = {
                        iobhost: newGlobalConfig.iobhost,
                        iobport: newGlobalConfig.iobport,
                        user: newGlobalConfig.user,
                        password: newGlobalConfig.password,
                        usessl: newGlobalConfig.usessl
                    };

                    const newServerId = `${newGlobalConfig.iobhost}:${newGlobalConfig.iobport}`;
                    settings.serverId = newServerId;

                    if (oldServerId !== newServerId) {
                        node.log(`Server changed from ${oldServerId} to ${newServerId}, forcing connection reset`);
                        await connectionManager.forceServerSwitch(oldServerId, newServerId, newGlobalConfig);
                    }
                }

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
                node.log(`Connection attempt failed: ${errorMsg} - Manager will handle recovery`);

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
            node.log("Node closing...");
            node.isInitialized = false;
            node.isSubscribed = false;

            try {
                if (isMultipleStates) {
                    // Unsubscribe from each state individually
                    for (const stateId of stateList) {
                        try {
                            await connectionManager.unsubscribe(
                                `${settings.nodeId}_${stateId}`,
                                settings.serverId,
                                stateId
                            );
                        } catch (error) {
                            node.warn(`Cleanup error for state ${stateId}: ${error.message}`);
                        }
                    }
                    node.log(`Successfully unsubscribed from ${stateList.length} states`);
                } else {
                    await connectionManager.unsubscribe(
                        settings.nodeId,
                        settings.serverId,
                        subscriptionPattern
                    );

                    node.log(`Successfully unsubscribed from ${isWildcardPattern ? 'wildcard pattern' : 'single state'}: ${subscriptionPattern}`);
                }

                node.status({});

            } catch (error) {
                node.warn(`Cleanup error: ${error.message}`);
            } finally {
                done();
            }
        });

        node.on("error", function (error) {
            node.error(`Node error: ${error.message}`);
            setError(`Node error: ${error.message}`, "Node error");
            node.isSubscribed = false;
        });

        // Initialize the node
        initialize();
    }

    RED.nodes.registerType("iobin", iobin);
};