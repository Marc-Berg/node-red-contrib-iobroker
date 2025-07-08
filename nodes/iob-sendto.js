const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function(RED) {
    function iobsendto(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Use helper to create status functions
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        // Use helper to validate server config
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
                node.log(`Static message parsed: ${JSON.stringify(staticMessageParsed)}`);
            } catch (error) {
                return setError(`Invalid JSON in static message: ${error.message}`, "JSON error");
            }
        }

        node.log(`SendTo node initialized: adapter="${settings.adapter}", command="${settings.command}", waitForResponse=${settings.waitForResponse}`);

        // Custom status texts for sendto mode
        const statusTexts = {
            ready: settings.waitForResponse ? "Ready (with response)" : "Ready (fire-and-forget)",
            reconnected: settings.waitForResponse ? "Reconnected (with response)" : "Reconnected (fire-and-forget)"
        };

        // Initialize connection using helper
        NodeHelpers.initializeConnection(
            node, config, RED, settings, globalConfig, setStatus, statusTexts
        );

        node.on('input', async function(msg, send, done) {
            try {
                // Handle status requests using helper
                if (NodeHelpers.handleStatusRequest(msg, send, done, settings)) {
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

                node.log(`SendTo request: adapter="${adapter.trim()}", command="${command || '(none)'}", waitForResponse=${settings.waitForResponse}, timeout=${timeout}`);
                node.log(`Message content: ${JSON.stringify(messageContent).substring(0, 200)}${JSON.stringify(messageContent).length > 200 ? '...' : ''}`);

                setStatus("blue", "dot", `Sending to ${adapter}...`);
                const startTime = Date.now();

                try {
                    if (settings.waitForResponse) {
                        node.log(`Sending with response expected...`);
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

                        const readyText = statusTexts.ready;
                        setStatus("green", "dot", readyText);
                        
                        node.log(`SendTo completed with response: ${adapter}${command ? `.${command}` : ''} in ${responseTime}ms`);
                        node.log(`Response: ${JSON.stringify(response).substring(0, 200)}${JSON.stringify(response).length > 200 ? '...' : ''}`);
                        
                        send(responseMsg);
                        done && done();
                    } else {
                        node.log(`Sending fire-and-forget...`);
                        await connectionManager.sendToAdapter(
                            settings.serverId,
                            adapter.trim(),
                            command ? command.trim() : null,
                            messageContent,
                            null
                        );

                        const readyText = statusTexts.ready;
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
            await NodeHelpers.handleNodeClose(node, settings, "SendTo");
            done();
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));
    }

    RED.nodes.registerType("iobsendto", iobsendto);
};