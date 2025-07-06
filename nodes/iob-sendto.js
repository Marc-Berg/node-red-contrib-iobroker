const connectionManager = require('../lib/manager/websocket-manager');

module.exports = function(RED) {
    function iobsendto(config) {
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
            adapter: config.adapter?.trim() || "",
            command: config.command?.trim() || "",
            message: config.message?.trim() || "",
            waitForResponse: config.waitForResponse || false,
            responseTimeout: parseInt(config.responseTimeout) || 10000,
            serverId: connectionManager.getServerId(globalConfig),
            nodeId: node.id
        };

        node.currentConfig = { iobhost, iobport, user, password, usessl };
        node.isInitialized = false;

        let staticMessageParsed = null;
        if (settings.message) {
            try {
                staticMessageParsed = JSON.parse(settings.message);
            } catch (error) {
                return setError(`Invalid JSON in static message: ${error.message}`, "JSON error");
            }
        }

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
                        const readyText = settings.waitForResponse ? "Ready (with response)" : "Ready (fire-and-forget)";
                        setStatus("green", "dot", readyText);
                        node.isInitialized = true;
                        break;
                    case 'connecting':
                        setStatus("yellow", "ring", "Connecting...");
                        break;
                    case 'disconnected':
                        setStatus("red", "ring", "Disconnected");
                        node.isInitialized = false;
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

            callback.onReconnect = function() {
                node.log("Reconnection detected by sendTo node");
                const reconnectedText = settings.waitForResponse ? "Reconnected (with response)" : "Reconnected (fire-and-forget)";
                setStatus("green", "dot", reconnectedText);
                node.isInitialized = true;
            };

            callback.onDisconnect = function() {
                node.log("Disconnection detected by sendTo node");
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
                    
                    const newServerId = connectionManager.getServerId(newGlobalConfig);
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
                
                const status = connectionManager.getConnectionStatus(settings.serverId);
                if (status.ready) {
                    const readyText = settings.waitForResponse ? "Ready (with response)" : "Ready (fire-and-forget)";
                    setStatus("green", "dot", readyText);
                    node.isInitialized = true;
                    node.log(`Connection established for sendTo node (mode: ${settings.waitForResponse ? 'response' : 'fire-and-forget'})`);
                } else {
                    setStatus("yellow", "ring", "Waiting for connection...");
                    node.log(`SendTo node registered - waiting for connection to be ready`);
                }
                
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                setStatus("red", "ring", "Registration failed");
                node.error(`Node registration failed: ${errorMsg}`);
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

                const adapter = msg.adapter || settings.adapter;
                if (!adapter || !adapter.trim()) {
                    setStatus("red", "ring", "Adapter missing");
                    const error = new Error("Target adapter missing (neither configured nor in msg.adapter)");
                    done && done(error);
                    return;
                }

                const command = msg.command !== undefined ? msg.command : settings.command;
                const messageContent = msg.message !== undefined ? msg.message : 
                                     (staticMessageParsed !== null ? staticMessageParsed : msg.payload);
                const timeout = msg.timeout || settings.responseTimeout;

                if (messageContent === undefined) {
                    setStatus("red", "ring", "Message missing");
                    const error = new Error("Message content missing (no payload, static message, or msg.message)");
                    done && done(error);
                    return;
                }

                setStatus("blue", "dot", `Sending to ${adapter}...`);
                const startTime = Date.now();

                try {
                    if (settings.waitForResponse) {
                        const response = await connectionManager.sendToAdapter(
                            settings.serverId,
                            adapter.trim(),
                            command ? command.trim() : null,
                            messageContent,
                            timeout
                        );

                        const responseTime = Date.now() - startTime;
                        
                        const responseMsg = {
                            payload: response,
                            adapter: adapter.trim(),
                            command: command ? command.trim() : null,
                            originalMessage: messageContent,
                            responseTime: responseTime,
                            timestamp: Date.now()
                        };

                        const readyText = settings.waitForResponse ? "Ready (with response)" : "Ready (fire-and-forget)";
                        setStatus("green", "dot", readyText);
                        
                        node.log(`SendTo completed: ${adapter}${command ? `.${command}` : ''} in ${responseTime}ms`);
                        
                        send(responseMsg);
                        done && done();
                    } else {
                        await connectionManager.sendToAdapter(
                            settings.serverId,
                            adapter.trim(),
                            command ? command.trim() : null,
                            messageContent,
                            null
                        );

                        const readyText = settings.waitForResponse ? "Ready (with response)" : "Ready (fire-and-forget)";
                        setStatus("green", "dot", readyText);
                        
                        node.log(`SendTo completed (fire-and-forget): ${adapter}${command ? `.${command}` : ''}`);
                        
                        done && done();
                    }
                    
                } catch (sendError) {
                    setStatus("red", "ring", "SendTo failed");
                    node.error(`SendTo failed for ${adapter}: ${sendError.message}`);
                    done && done(sendError);
                }
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Error processing input: ${error.message}`);
                done && done(error);
            }
        });

        node.on("close", async function(removed, done) {
            node.log("SendTo node closing...");
            
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

    RED.nodes.registerType("iobsendto", iobsendto);
};