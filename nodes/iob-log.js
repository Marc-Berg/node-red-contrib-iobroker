const connectionManager = require('../lib/manager/websocket-manager');

module.exports = function (RED) {
    function ioblog(config) {
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

        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            logLevel: config.logLevel || "info",
            includeTimestamp: config.includeTimestamp !== false,
            includeSource: config.includeSource !== false,
            serverId: connectionManager.getServerId(globalConfig),
            nodeId: node.id
        };

        node.currentConfig = { iobhost, iobport, user, password, usessl };
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
            const shouldProcess = messageLevel >= minimumLevel;           
            return shouldProcess;
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

            // Status update callback - called by the centralized manager
            callback.updateStatus = function (status) {
                switch (status) {
                    case 'ready':
                        setStatus("green", "dot", `Monitoring (${settings.logLevel}+)`);
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
                node.log("Reconnection detected - resubscribing to logs");
                node.isSubscribed = false;
                setStatus("yellow", "ring", "Resubscribing...");
            };

            callback.onDisconnect = function () {
                node.log("Disconnection detected by node");
                setStatus("red", "ring", "Disconnected");
                node.isSubscribed = false;
            };

            callback.onSubscribed = function () {
                node.log("Log subscription successful");
                node.isSubscribed = true;
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
                node.isSubscribed = false;
            }

            return configChanged;
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

                // Handle configuration changes
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

        node.on("error", function (error) {
            node.error(`Node error: ${error.message}`);
            setError(`Node error: ${error.message}`, "Node error");
            node.isSubscribed = false;
        });

        // Initialize the node
        initialize();
    }

    RED.nodes.registerType("ioblog", ioblog);
};