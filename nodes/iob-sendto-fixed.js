const Orchestrator = require('../lib/orchestrator');
const { NodeLifecycleHelpers } = require('../lib/utils/node-lifecycle-helpers');

module.exports = function(RED) {
    function iobsendto(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.server = RED.nodes.getNode(config.server);
        
        if (!node.server) {
            node.status({ fill: "red", shape: "dot", text: "Error: Server not configured" });
            return;
        }

        node.adapter = config.adapter?.trim() || "";
        node.command = config.command?.trim() || "";
        node.message = config.message?.trim() || "";
        node.waitForResponse = config.waitForResponse || false;
        node.responseTimeout = parseInt(config.responseTimeout) || 10000;

        node.log(`SendTo node initialized: adapter=${node.adapter}, command=${node.command}, waitForResponse=${node.waitForResponse}, timeout=${node.responseTimeout}ms`);

        let staticMessageParsed = null;
        if (node.message) {
            try {
                staticMessageParsed = JSON.parse(node.message);
            } catch (error) {
                node.status({ fill: "red", shape: "dot", text: `JSON error: ${error.message}` });
                return;
            }
        }

        node.isRegistered = false;

        const onServerReady = ({ serverId }) => {
            if (serverId === node.server.id) {
                const statusText = node.waitForResponse ? "Ready (with response)" : "Ready (fire-and-forget)";
                NodeLifecycleHelpers.updateConnectionStatus(node, 'ready', statusText);
            }
        };

        const onDisconnected = ({ serverId }) => {
            if (serverId === node.server.id) {
                NodeLifecycleHelpers.updateConnectionStatus(node, 'disconnected');
            }
        };

        const onRetrying = ({ serverId, attempt, delay }) => {
            if (serverId === node.server.id) {
                NodeLifecycleHelpers.updateConnectionStatus(node, 'retrying', `Retrying in ${delay / 1000}s (Attempt #${attempt})`);
            }
        };

        const onPermanentFailure = ({ serverId, error }) => {
            if (serverId === node.server.id) {
                NodeLifecycleHelpers.updateConnectionStatus(node, 'error', `Failed: ${error.message}`);
            }
        };

        const onSendToResponse = ({ nodeId, response, error, responseTime }) => {
            if (nodeId === node.id) {
                if (error) {
                    node.error(`SendTo failed: ${error.message}`);
                    NodeLifecycleHelpers.updateConnectionStatus(node, 'error', 'SendTo failed');
                } else {
                    node.debug(`SendTo response received in ${responseTime}ms: ${JSON.stringify(response)}`);
                    const statusText = node.waitForResponse ? "Ready (with response)" : "Ready (fire-and-forget)";
                    NodeLifecycleHelpers.updateConnectionStatus(node, 'ready', statusText);
                }
            }
        };

        const eventHandlers = {
            onServerReady,
            onDisconnected,
            onRetrying,
            onPermanentFailure,
            onSendToResponse
        };

        NodeLifecycleHelpers.setupDelayedRegistrationWithListeners(node, eventHandlers, 0);

        node.on('input', async function(msg, send, done) {
            try {
                const adapter = msg.adapter || node.adapter;
                if (!adapter || !adapter.trim()) {
                    const error = new Error("Target adapter missing (neither configured nor in msg.adapter)");
                    NodeLifecycleHelpers.updateConnectionStatus(node, 'error', "Adapter missing");
                    done && done(error);
                    return;
                }

                const command = msg.command !== undefined ? msg.command : node.command;
                const messageContent = msg.message !== undefined ? msg.message : 
                                     (staticMessageParsed !== null ? staticMessageParsed : msg.payload);
                const timeout = msg.timeout || node.responseTimeout;

                if (messageContent === undefined) {
                    const error = new Error("Message content missing (no payload, static message, or msg.message)");
                    NodeLifecycleHelpers.updateConnectionStatus(node, 'error', "Message missing");
                    done && done(error);
                    return;
                }

                NodeLifecycleHelpers.updateConnectionStatus(node, 'sending', `Sending to ${adapter}...`);
                const startTime = Date.now();

                try {
                    if (node.waitForResponse) {
                        const response = await Orchestrator.sendToAdapter(
                            node.id,
                            adapter.trim(),
                            command ? command.trim() : null,
                            messageContent,
                            timeout
                        );

                        const responseTime = Date.now() - startTime;
                        node.debug(`SendTo completed in ${responseTime}ms`);
                        
                        const responseMsg = {
                            payload: response,
                            adapter: adapter.trim(),
                            command: command ? command.trim() : null,
                            originalMessage: messageContent,
                            responseTime: responseTime,
                            timestamp: Date.now()
                        };

                        const statusText = node.waitForResponse ? "Ready (with response)" : "Ready (fire-and-forget)";
                        NodeLifecycleHelpers.updateConnectionStatus(node, 'ready', statusText);
                        
                        send(responseMsg);
                        done && done();
                    } else {
                        await Orchestrator.sendToAdapter(
                            node.id,
                            adapter.trim(),
                            command ? command.trim() : null,
                            messageContent,
                            null
                        );

                        const responseTime = Date.now() - startTime;
                        node.debug(`SendTo completed in ${responseTime}ms`);

                        const statusText = node.waitForResponse ? "Ready (with response)" : "Ready (fire-and-forget)";
                        NodeLifecycleHelpers.updateConnectionStatus(node, 'ready', statusText);                       
                        done && done();
                    }
                    
                } catch (sendError) {
                    node.error(`SendTo failed for ${adapter}: ${sendError.message}`);
                    NodeLifecycleHelpers.updateConnectionStatus(node, 'error', 'SendTo failed');
                    done && done(sendError);
                }
                
            } catch (error) {
                node.error(`Error processing input: ${error.message}`);
                NodeLifecycleHelpers.updateConnectionStatus(node, 'error', 'Error');
                done && done(error);
            }
        });

        const cleanupCallbacks = [];
        NodeLifecycleHelpers.setupCloseHandler(node, eventHandlers, cleanupCallbacks);

        NodeLifecycleHelpers.updateConnectionStatus(node, 'waiting', "Waiting for server...");
    }

    RED.nodes.registerType("iobsendto", iobsendto);
};
