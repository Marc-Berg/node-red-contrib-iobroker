const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function (RED) {
    function ioblog(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Use helper to create status functions
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        // Use helper to validate server config
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            logLevel: config.logLevel || "info",
            includeTimestamp: config.includeTimestamp !== false,
            includeSource: config.includeSource !== false,
            serverId,
            nodeId: node.id
        };

        node.currentConfig = connectionDetails;
        node.isInitialized = false;
        node.isSubscribed = false;

        // Log level mapping
        const LOG_LEVELS = {
            silly: 0,
            debug: 1,
            info: 2,
            warn: 3,
            error: 4
        };

        const minimumLevel = LOG_LEVELS[settings.logLevel] || LOG_LEVELS.info;

        function shouldProcessLogMessage(logLevel) {
            const messageLevel = LOG_LEVELS[logLevel];
            return messageLevel >= minimumLevel;
        }

        function formatTimestamp(ts) {
            try {
                const date = new Date(ts);
                return date.toISOString();
            } catch (error) {
                return new Date().toISOString();
            }
        }

        function createLogMessage(logData) {
            try {
                let severity = null;
                
                // Try different field names for log level
                if (logData.severity && typeof logData.severity === 'string') {
                    severity = logData.severity.toLowerCase().trim();
                } else if (logData.level && typeof logData.level === 'string') {
                    severity = logData.level.toLowerCase().trim();
                } else if (typeof logData.level === 'number') {
                    // Convert numeric level to string
                    const levelMap = { 0: 'silly', 1: 'debug', 2: 'info', 3: 'warn', 4: 'error' };
                    severity = levelMap[logData.level] || 'info';
                } else {
                    severity = 'info'; // fallback
                }

                // Validate severity is a known level
                if (!LOG_LEVELS.hasOwnProperty(severity)) {
                    severity = 'info';
                }

                const message = logData.message || logData.msg || '';
                const source = logData.from || logData.source || '';
                const timestamp = logData.ts || logData.timestamp || Date.now();

                // Check if we should process this log level
                if (!shouldProcessLogMessage(severity)) {
                    return null;
                }

                const outputMessage = {
                    level: severity,
                    raw: logData
                };

                // Set the main output property
                outputMessage[settings.outputProperty] = message;

                // Add complete log object
                outputMessage.log = {
                    severity: severity,
                    message: message,
                    from: source,
                    ts: timestamp,
                    level: LOG_LEVELS[severity] || LOG_LEVELS.info
                };

                // Add optional fields
                if (settings.includeSource && source) {
                    outputMessage.source = source;
                }

                if (settings.includeTimestamp) {
                    outputMessage.timestamp = formatTimestamp(timestamp);
                }

                return outputMessage;

            } catch (error) {
                node.warn(`Log message processing error: ${error.message}`);
                return null;
            }
        }

        function onLogMessage(logData) {
            try {
                const message = createLogMessage(logData);
                if (message) {
                    node.send(message);

                    // Update status with recent log activity
                    const now = new Date().toLocaleTimeString(undefined, { hour12: false });
                    const levelColor = {
                        error: "red",
                        warn: "yellow", 
                        info: "blue",
                        debug: "grey",
                        silly: "grey"
                    }[message.level] || "blue";

                    setStatus(levelColor, "dot", `${message.level} - ${now}`);
                  }
            } catch (error) {
                node.error(`Log processing error: ${error.message}`);
                setError(`Processing error: ${error.message}`, "Process error");
            }
        }

        function createCallback() {
            const callback = onLogMessage;

            // Custom status texts for log monitoring
            const statusTexts = {
                ready: `Monitoring (${settings.logLevel}+)`,
                disconnected: "Disconnected"
            };

            // Use helper for subscription event handling
            const baseCallback = NodeHelpers.createSubscriptionEventCallback(
                node, 
                setStatus,
                () => { 
                    node.log("Log subscription successful");
                    node.isSubscribed = true; 
                },
                statusTexts
            );

            // Merge the callbacks
            Object.assign(callback, baseCallback);

            return callback;
        }

        async function initialize() {
            // Check if we're already subscribed and connection is ready
            const status = connectionManager.getConnectionStatus(settings.serverId);
            if (node.isSubscribed && status.connected && status.ready) {
                node.log("Already subscribed and connected, skipping initialization");
                return;
            }

            try {
                setStatus("yellow", "ring", "Connecting...");

                // Handle config changes using helper
                await NodeHelpers.handleConfigChange(node, config, RED, settings);

                const callback = createCallback();

                // Subscribe to live logs via the centralized manager
                await connectionManager.subscribeToLiveLogs(
                    settings.nodeId,
                    settings.serverId,
                    callback,
                    globalConfig,
                    settings.logLevel
                );

                node.isSubscribed = true;

                node.log(`Successfully subscribed to live logs (level: ${settings.logLevel}+, numeric: ${minimumLevel}+) via WebSocket`);

                setStatus("green", "dot", `Monitoring (${settings.logLevel}+)`);
                node.isInitialized = true;

            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                node.log(`Log subscription failed: ${errorMsg} - Manager will handle recovery`);

                // Set appropriate status based on error type
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
                await connectionManager.unsubscribeFromLiveLogs(
                    settings.nodeId,
                    settings.serverId
                );

                node.status({});
                node.log(`Successfully unsubscribed from live logs`);

            } catch (error) {
                node.warn(`Cleanup error: ${error.message}`);
            } finally {
                done();
            }
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));

        // Initialize the node
        initialize();
    }

    RED.nodes.registerType("ioblog", ioblog);
};