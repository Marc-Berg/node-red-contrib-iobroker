const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function (RED) {
    function ioblog(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
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
                NodeHelpers.setMessageProperty(RED, outputMessage, settings.outputProperty, message);
                outputMessage.log = {
                    severity: severity,
                    message: message,
                    from: source,
                    ts: timestamp,
                    level: LOG_LEVELS[severity] || LOG_LEVELS.info
                };

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
            const statusTexts = {
                ready: `Monitoring (${settings.logLevel}+)`,
                disconnected: "Disconnected"
            };

            const baseCallback = NodeHelpers.createSubscriptionEventCallback(
                node,
                setStatus,
                () => {
                    node.isSubscribed = true;
                },
                statusTexts
            );

            Object.assign(callback, baseCallback);

            return callback;
        }

        async function initialize() {
            const status = connectionManager.getConnectionStatus(settings.serverId);
            if (node.isSubscribed && status.connected && status.ready) {
                return;
            }

            try {
                setStatus("yellow", "ring", "Connecting...");
                await NodeHelpers.handleConfigChange(node, config, RED, settings);
                const callback = createCallback();
                await connectionManager.subscribeToLiveLogs(
                    settings.nodeId,
                    settings.serverId,
                    callback,
                    globalConfig,
                    settings.logLevel
                );

                node.isSubscribed = true;

                setStatus("green", "dot", `Monitoring (${settings.logLevel}+)`);
                node.isInitialized = true;

            } catch (error) {
                const errorMsg = error.message || 'Unknown error';

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
            node.isInitialized = false;
            node.isSubscribed = false;

            try {
                const connectionStatus = connectionManager.getConnectionStatus ?
                    connectionManager.getConnectionStatus(settings.serverId) : null;

                if (connectionStatus && connectionStatus.ready && !connectionManager.destroyed) {
                    await connectionManager.unsubscribeFromLiveLogs(
                        settings.nodeId,
                        settings.serverId
                    );
                } else {
                    node.debug(`Skipping log unsubscribe for ${settings.nodeId} - connection not ready or manager destroyed`);
                }

                node.status({});

            } catch (error) {
                if (error.message && error.message.includes('timeout')) {
                    node.debug(`Log unsubscribe timeout during shutdown, ignoring: ${error.message}`);
                } else {
                    node.warn(`Cleanup error: ${error.message}`);
                }
            } finally {
                done();
            }
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));

        initialize();
    }

    RED.nodes.registerType("ioblog", ioblog);
};