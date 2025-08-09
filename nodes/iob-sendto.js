const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function(RED) {
    function iobsendto(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

        const settings = {
            adapter: config.adapter?.trim() || "",
            command: config.command?.trim() || "",
            message: config.message?.trim() || "",
            waitForResponse: config.waitForResponse || false,
            responseTimeout: parseInt(config.responseTimeout) || 10000,
            serverId,
            nodeId: node.id
        };

        node.currentConfig = connectionDetails;
        node.isInitialized = false;

        let staticMessageParsed = null;
        if (settings.message) {
            try {
                staticMessageParsed = JSON.parse(settings.message);
            } catch (error) {
                return setError(`Invalid JSON in static message: ${error.message}`, "JSON error");
            }
        }

        const statusTexts = {
            ready: settings.waitForResponse ? "Ready (with response)" : "Ready (fire-and-forget)",
            reconnected: settings.waitForResponse ? "Reconnected (with response)" : "Reconnected (fire-and-forget)"
        };

        NodeHelpers.initializeConnection(
            node, config, RED, settings, globalConfig, setStatus, statusTexts
        );

        node.on('input', async function(msg, send, done) {
            try {
                
                if (NodeHelpers.handleStatusRequest(msg, send, done, settings)) {
                    return;
                }

                const instance = msg.instance || settings.adapter;
                if (!instance || !instance.trim()) {
                    setStatus("red", "ring", "Instance missing");
                    const error = new Error("Target instance missing (neither configured nor in msg.instance)");
                    done && done(error);
                    return;
                }

                const trimmedInstance = instance.trim();
                const command = msg.command !== undefined ? msg.command : settings.command;
                const trimmedCommand = command ? command.trim() : null;
                const messageContent = msg.message !== undefined ? msg.message : 
                                     (staticMessageParsed !== null ? staticMessageParsed : msg.payload);
                const timeout = msg.timeout || settings.responseTimeout;

                if (messageContent === undefined) {
                    setStatus("red", "ring", "Message missing");
                    const error = new Error("Message content missing (no payload, static message, or msg.message)");
                    done && done(error);
                    return;
                }
                setStatus("blue", "dot", `Sending to ${trimmedInstance}...`);
                const startTime = Date.now();

                function setReadyStatus() {
                    const readyText = statusTexts.ready;
                    setStatus("green", "dot", readyText);
                }

                try {
                    if (settings.waitForResponse) {
                        const response = await connectionManager.sendToAdapter(
                            settings.serverId,
                            trimmedInstance,
                            trimmedCommand,
                            messageContent,
                            timeout
                        );

                        const responseTime = Date.now() - startTime;
                        
                        const responseMsg = {
                            payload: response,
                            instance: trimmedInstance,
                            command: trimmedCommand,
                            originalMessage: messageContent,
                            responseTime: responseTime,
                            timestamp: Date.now()
                        };

                        setReadyStatus();
                        send(responseMsg);
                        done && done();
                    } else {
                        await connectionManager.sendToAdapter(
                            settings.serverId,
                            trimmedInstance,
                            trimmedCommand,
                            messageContent,
                            null
                        );

                        setReadyStatus();                     
                        done && done();
                    }
                    
                } catch (sendError) {
                    setStatus("red", "ring", "SendTo failed");
                    node.error(`SendTo failed for ${trimmedInstance}: ${sendError.message}`);
                    done && done(sendError);
                }
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Error processing input: ${error.message}`);
                done && done(error);
            }
        });

        node.on("close", async function(removed, done) {
            await NodeHelpers.handleNodeClose(node, settings, "SendTo");
            done();
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));
    }

    RED.nodes.registerType("iobsendto", iobsendto);
};