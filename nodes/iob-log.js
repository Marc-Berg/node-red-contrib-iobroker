const Orchestrator = require('../lib/orchestrator');
const { StatusHelpers } = require('../lib/utils/status-helpers');

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

        // Helper function to update status with log info
        function updateStatusWithLogLevel(level) {
            const now = new Date().toLocaleTimeString(undefined, { hour12: false });
            const levelColor = {
                error: "red",
                warn: "yellow", 
                info: "blue",
                debug: "grey",
                silly: "grey"
            }[level] || "blue";
            
            node.status({ fill: levelColor, shape: "dot", text: `${level} - ${now}` });
        }

        // --- Event Handlers ---

        const onServerReady = ({ serverId }) => {
            if (serverId === node.server.id) {
                if (!node.isSubscribed) {
                    StatusHelpers.updateConnectionStatus(node, 'subscribing', 'Subscribing to logs...');
                    Orchestrator.subscribeToLogs(node.id, node.logLevel);
                }
            }
        };

        const onLogSubscriptionConfirmed = ({ serverId, nodeId }) => {
            if (serverId === node.server.id && nodeId === node.id) {
                node.log(`Log subscription confirmed for level ${node.logLevel}`);
                node.isSubscribed = true;
                node.status({ fill: "green", shape: "dot", text: `Monitoring (${node.logLevel}+)` });
            }
        };

        const onLogMessage = ({ serverId, nodeId, logData }) => {
            if (serverId === node.server.id && nodeId === node.id) {
                try {
                    const message = createLogMessage(logData);
                    if (message) {
                        node.send(message);
                        updateStatusWithLogLevel(message.level);
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

        // --- Node Lifecycle ---

        // Function to register with orchestrator
        const registerWithOrchestrator = () => {
            if (!node.isRegistered) {
                node.log(`Registering node with orchestrator after flows started`);
                Orchestrator.registerNode(node.id, node.server);
                node.isRegistered = true;
            }
        };

        // Register with orchestrator when flows are ready
        // Use timeout to ensure registration happens after flows are started
        setTimeout(() => {
            registerWithOrchestrator();
        }, 300);

        // Listen for events from the Orchestrator
        Orchestrator.on('server:ready', onServerReady);
        Orchestrator.on(`log:subscription_confirmed:${node.id}`, onLogSubscriptionConfirmed);
        Orchestrator.on(`log:message:${node.id}`, onLogMessage);
        Orchestrator.on('connection:disconnected', onDisconnected);
        Orchestrator.on('connection:retrying', onRetrying);
        Orchestrator.on('connection:failed_permanently', onPermanentFailure);

        node.on('close', function(done) {
            // Unsubscribe from logs if subscribed
            if (node.isSubscribed) {
                Orchestrator.unsubscribeFromLogs(node.id);
            }
            
            // Clean up all listeners to prevent memory leaks
            Orchestrator.removeListener('server:ready', onServerReady);
            Orchestrator.removeListener(`log:subscription_confirmed:${node.id}`, onLogSubscriptionConfirmed);
            Orchestrator.removeListener(`log:message:${node.id}`, onLogMessage);
            Orchestrator.removeListener('connection:disconnected', onDisconnected);
            Orchestrator.removeListener('connection:retrying', onRetrying);
            Orchestrator.removeListener('connection:failed_permanently', onPermanentFailure);
            
            // Only unregister if we were actually registered
            if (node.isRegistered) {
                Orchestrator.unregisterNode(node.id, node.server.id);
            }
            
            done();
        });

        // Initial status
        StatusHelpers.updateConnectionStatus(node, 'waiting', 'Waiting for server...');
    }

    RED.nodes.registerType("ioblog", IoBrokerLogNode);
};