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
            subscriptionPattern = '';
        } else {
            subscriptionPattern = config.state ? config.state.trim() : '';
            if (!subscriptionPattern) {
                return setError("State ID or pattern missing", "Config missing");
            }
            stateList = [];
        }

        const isWildcardPattern = inputMode === 'single' && subscriptionPattern.includes('*');
        const isMultipleStates = inputMode === 'multiple';

        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            ackFilter: config.ackFilter || "both",
            sendInitialValue: config.sendInitialValue && !isWildcardPattern,
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
        node.currentStateValues = new Map();
        node.subscribedStates = new Set();
        node.initialValueCount = 0;
        node.expectedInitialValues = 0;
        node.initialGroupedMessageSent = false;

        if (isMultipleStates) {
            node.log(`Multiple states mode: ${stateList.length} states [${stateList.join(', ')}], output: ${settings.outputMode}`);
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

            const subscribedStateArray = Array.from(node.subscribedStates);
            const missingStates = subscribedStateArray.filter(stateId => !node.currentStateValues.has(stateId));

            if (missingStates.length === 0) {
                return true;
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

            node.log(`Callback created with wantsInitialValue: ${callback.wantsInitialValue}`);

            callback.onInitialValue = function (stateId, state) {
                try {
                    node.log(`Initial value callback triggered for ${stateId}: ${state.val}`);

                    if (!shouldSendMessage(state.ack, settings.ackFilter)) {
                        node.log(`Initial value filtered out due to ack filter: ${stateId}`);
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
                                node.log(`Initial grouped message sent with ${node.initialValueCount} states`);
                            } else if (node.initialValueCount === 1) {
                                setTimeout(() => {
                                    if (!node.initialGroupedMessageSent && node.currentStateValues.size > 0) {
                                        const message = createGroupedMessage(null, null, true);
                                        node.send(message);
                                        node.initialGroupedMessageSent = true;
                                        node.log(`Initial grouped message sent (timeout fallback)`);
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
                        node.log(`Initial value sent for ${stateId}: ${state.val}`);
                    }

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
                node.initialValueCount = 0;
                node.initialGroupedMessageSent = false;
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
                    
                    node.log(`Successfully subscribed to ${node.subscribedStates.size} states in ${settings.outputMode} mode`);
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

                node.currentStateValues.clear();
                node.subscribedStates.clear();
                node.initialValueCount = 0;
                node.initialGroupedMessageSent = false;

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
                    await connectionManager.unsubscribeMultiple(
                        settings.nodeId,
                        settings.serverId,
                        Array.from(node.subscribedStates)
                    );
                    node.log(`Successfully unsubscribed from ${node.subscribedStates.size} states`);
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

        initialize();
    }

    RED.nodes.registerType("iobin", iobin);
};