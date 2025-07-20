const Orchestrator = require('../lib/orchestrator');
const { StatusHelpers, NodeRegistrationHelpers } = require('../lib/utils/node-lifecycle-helpers');

module.exports = function(RED) {
    function IoBrokerLogNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        node.server = RED.nodes.getNode(config.server);
        node.outputProperty = config.outputProperty?.trim() || "payload";
        node.logLevel = config.logLevel || "info";
        node.includeTimestamp = config.includeTimestamp !== false;
        node.includeSource = config.includeSource !== false;
        
        // Track if the node has been registered with the orchestrator
        node.isRegistered = false;
        node.isSubscribed = false;

        if (!node.server) {
            StatusHelpers.updateConnectionStatus(node, 'error', "Error: Server not configured");
            return;
        }

        const LOG_LEVELS = {
            silly: 0,
            debug: 1,
            info: 2,
            warn: 3,
            error: 4
        };

        const minimumLevel = LOG_LEVELS[node.logLevel] || LOG_LEVELS.info;

        // Helper function to check if log message should be processed
        function shouldProcessLogMessage(logLevel) {
            const messageLevel = LOG_LEVELS[logLevel];
            return messageLevel >= minimumLevel;
        }

        // Helper function to format timestamp
        function formatTimestamp(ts) {
            try {
                const date = new Date(ts);
                return date.toISOString();
            } catch (error) {
                return new Date().toISOString();
            }
        }

        // Helper function to create log message
        function createLogMessage(logData) {
            try {
                let severity = null;

                if (logData.severity && typeof logData.severity === 'string') {
                    severity = logData.severity.toLowerCase().trim();
                } else if (logData.level && typeof logData.level === 'string') {
                    severity = logData.level.toLowerCase().trim();
                } else if (typeof logData.level === 'number') {
                    const levelMap = { 0: 'silly', 1: 'debug', 2: 'info', 3: 'warn', 4: 'error' };
                    severity = levelMap[logData.level] || 'info';
                } else {
                    severity = 'info';
                }

                if (!LOG_LEVELS.hasOwnProperty(severity)) {
                    severity = 'info';
                }

                const message = logData.message || logData.msg || '';
                const source = logData.from || logData.source || '';
                const timestamp = logData.ts || logData.timestamp || Date.now();

                if (!shouldProcessLogMessage(severity)) {
                    return null;
                }

                const outputMessage = {
                    level: severity,
                    raw: logData
                };

                outputMessage[node.outputProperty] = message;
                outputMessage.log = {
                    severity: severity,
                    message: message,
                    from: source,
                    ts: timestamp,
                    level: LOG_LEVELS[severity] || LOG_LEVELS.info
                };

                if (node.includeSource && source) {
                    outputMessage.source = source;
                }

                if (node.includeTimestamp) {
                    outputMessage.timestamp = formatTimestamp(timestamp);
                }

                return outputMessage;

            } catch (error) {
                node.warn(`Log message processing error: ${error.message}`);
                return null;
            }
        }

        // --- Event Handlers ---

        const onServerReady = ({ serverId }) => {
            if (serverId === node.server.id) {
                if (!node.isSubscribed) {
                    node.log(`Server ready for ${serverId}, subscribing to logs with level ${node.logLevel}`);
                    Orchestrator.subscribeToLogs(node.id, node.logLevel);
                    
                    // Assume subscription is successful immediately
                    // ioBroker often doesn't send confirmation responses
                    node.isSubscribed = true;
                    StatusHelpers.updateConnectionStatus(node, 'connected', 'Subscribed to logs');
                } else {
                    node.log(`Server ready for ${serverId}, but already subscribed`);
                }
            }
        };

                const onLogSubscriptionConfirmed = ({ serverId, nodeId }) => {
            node.log(`Received log subscription confirmed: serverId=${serverId}, nodeId=${nodeId}, myNodeId=${node.id}`);
            if (serverId === node.server.id && nodeId === node.id) {
                node.log(`Log subscription confirmed for this node`);
                node.isSubscribed = true;
                StatusHelpers.updateConnectionStatus(node, 'connected', 'Subscribed to logs');
            } else {
                node.log(`Log subscription confirmed but not for this node (serverId match: ${serverId === node.server.id}, nodeId match: ${nodeId === node.id})`);
            }
        };

        const onLogMessage = ({ serverId, nodeId, logData }) => {
            if (serverId === node.server.id && nodeId === node.id) {
                try {
                    const message = createLogMessage(logData);
                    if (message) {
                        // Don't update status for each log message - keep connection status
                        node.send(message);
                    }
                } catch (error) {
                    node.error(`Log processing error: ${error.message}`);
                    StatusHelpers.updateConnectionStatus(node, 'error', `Processing error: ${error.message}`);
                }
            }
        };

        const onDisconnected = ({ serverId }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'disconnected', 'Disconnected');
                node.isSubscribed = false;
            }
        };

        const onRetrying = ({ serverId, attempt, delay }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'retrying', `Retrying in ${delay / 1000}s (Attempt #${attempt})`);
            }
        };

        const onPermanentFailure = ({ serverId, error }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'error', `Failed: ${error.message}`);
            }
        };

        const eventHandlers = {
            onServerReady,
            onLogSubscriptionConfirmed,
            onLogMessage,
            onDisconnected,
            onRetrying,
            onPermanentFailure
        };

        NodeRegistrationHelpers.setupDelayedRegistrationWithListeners(node, eventHandlers, 300);

        node.on('close', function(removed, done) {
            // Unsubscribe from logs if subscribed
            if (node.isSubscribed) {
                Orchestrator.unsubscribeFromLogs(node.id);
            }
            
            const cleanupCallbacks = [];
            NodeRegistrationHelpers.setupCloseHandler(node, eventHandlers, cleanupCallbacks);
            done();
        });

        // Initial status
        StatusHelpers.updateConnectionStatus(node, 'waiting', 'Waiting for server...');
    }

    RED.nodes.registerType("ioblog", IoBrokerLogNode);
};