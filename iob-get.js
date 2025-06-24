const connectionManager = require('./lib/websocket-manager');

module.exports = function(RED) {
    function iobget(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const globalConfig = RED.nodes.getNode(config.server);
        if (!globalConfig) {
            return setError("No server configuration selected", "No server config");
        }

        const { iobhost, iobport, user, password, usessl } = globalConfig;
        if (!iobhost || !iobport) {
            return setError("ioBroker host or port missing", "Host/port missing");
        }

        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            serverId: `${iobhost}:${iobport}`,
            nodeId: node.id
        };

        node.currentConfig = { iobhost, iobport, user, password, usessl };
        node.isInitialized = false;

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

        function createEventCallback() {
            const callback = function() {};

            callback.updateStatus = function(status) {
                switch (status) {
                    case 'ready':
                        setStatus("green", "dot", "Ready");
                        node.isInitialized = true;
                        break;
                    case 'connected':
                        setStatus("green", "ring", "Connected");
                        break;
                    case 'connecting':
                        setStatus("yellow", "ring", "Connecting...");
                        break;
                    case 'disconnected':
                        setStatus("red", "ring", "Disconnected");
                        node.isInitialized = false;
                        break;
                    case 'reconnecting':
                        setStatus("yellow", "ring", "Reconnecting...");
                        break;
                    case 'retrying':
                        setStatus("yellow", "ring", "Retrying...");
                        break;
                    case 'retrying_production':
                        setStatus("yellow", "ring", "Retrying (prod)...");
                        break;
                    case 'failed_permanently':
                        setStatus("red", "ring", "Auth failed");
                        break;
                    default:
                        setStatus("grey", "ring", status);
                }
            };

            callback.onReconnect = function() {
                node.log("Reconnection detected by get node");
                setStatus("green", "dot", "Ready");
                node.isInitialized = true;
            };

            callback.onDisconnect = function() {
                node.log("Disconnection detected by get node");
                setStatus("red", "ring", "Disconnected");
            };

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
            }
            
            return configChanged;
        }

        async function initializeConnection() {
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

                const eventCallback = createEventCallback();
                await connectionManager.registerForEvents(
                    settings.nodeId,
                    settings.serverId,
                    eventCallback,
                    globalConfig
                );
                
                setStatus("green", "dot", "Ready");
                node.isInitialized = true;
                node.log(`Connection established for get node`);
                
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                setError(`Connection failed: ${errorMsg}`, "Connection failed");
                node.error(`Connection failed: ${errorMsg}`);
                
                // The new architecture will handle retries automatically via recovery callbacks
                // No manual retry logic needed here
            }
        }

        node.on('input', async function(msg, send, done) {
            try {
                if (msg.topic === "status") {
                    const status = connectionManager.getConnectionStatus(settings.serverId);
                    const statusMsg = {
                        payload: status,
                        topic: "status",
                        timestamp: Date.now()
                    };
                    send(statusMsg);
                    done && done();
                    return;
                }
                
                const configState = config.state?.trim();
                const stateId = configState || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                
                if (!stateId) {
                    setStatus("red", "ring", "State ID missing");
                    const error = new Error("State ID missing (neither configured nor in msg.topic)");
                    done && done(error);
                    return;
                }

                setStatus("blue", "dot", `Reading ${stateId}...`);

                const state = await connectionManager.getState(settings.serverId, stateId);
                
                msg[settings.outputProperty] = state?.val !== undefined ? state.val : state;
                msg.state = state;
                msg.timestamp = Date.now();
                
                setStatus("green", "dot", "Ready");
                send(msg);
                done && done();
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Error processing input: ${error.message}`);
                done && done(error);
            }
        });

        node.on("close", async function(removed, done) {
            node.log("Get node closing...");
            
            connectionManager.unregisterFromEvents(settings.nodeId);

            try {
                node.status({});
            } catch (statusError) {}

            done();
        });

        node.on("error", function(error) {
            node.error(`Node error: ${error.message}`);
            setError(`Node error: ${error.message}`, "Node error");
        });

        initializeConnection();
    }

    RED.nodes.registerType("iobget", iobget);
};