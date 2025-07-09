/*!
 * Common Node Helper Functions for ioBroker Node-RED Integration
 * Shared utilities to reduce code duplication across node implementations
 */

const connectionManager = require('../manager/websocket-manager');

class NodeHelpers {
    /**
     * Create standard status helper functions for a node
     */
    static createStatusHelpers(node) {
        const setStatus = (fill, shape, text) => {
            try {
                node.status({ fill, shape, text });
            } catch (error) {
                node.warn(`Status update error: ${error.message}`);
            }
        };

        const setError = (message, statusText) => {
            node.error(message);
            setStatus("red", "ring", statusText);
        };

        return { setStatus, setError };
    }

    /**
     * Validate server configuration and extract connection details
     */
    static validateServerConfig(RED, config, setError) {
        const globalConfig = RED.nodes.getNode(config.server);
        if (!globalConfig) {
            setError("No server configuration selected", "No server config");
            return null;
        }

        const { iobhost, iobport, user, password, usessl } = globalConfig;
        if (!iobhost || !iobport) {
            setError("ioBroker host or port missing", "Host/port missing");
            return null;
        }

        return {
            globalConfig,
            connectionDetails: { iobhost, iobport, user, password, usessl },
            serverId: connectionManager.getServerId(globalConfig)
        };
    }

    /**
     * Check if server configuration has changed
     */
    static hasConfigChanged(node, config, RED) {
        const currentGlobalConfig = RED.nodes.getNode(config.server);
        if (!currentGlobalConfig) return false;

        const configChanged = (
            node.currentConfig.iobhost !== currentGlobalConfig.iobhost ||
            node.currentConfig.iobport !== currentGlobalConfig.iobport ||
            node.currentConfig.user !== currentGlobalConfig.user ||
            node.currentConfig.password !== currentGlobalConfig.password ||
            node.currentConfig.usessl !== currentGlobalConfig.usessl
        );

        return configChanged;
    }

    /**
     * Handle server configuration changes and connection switching
     */
    static async handleConfigChange(node, config, RED, settings) {
        if (!NodeHelpers.hasConfigChanged(node, config, RED)) {
            return false;
        }

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
            await connectionManager.forceServerSwitch(oldServerId, newServerId, newGlobalConfig);
        }

        return true;
    }

    /**
     * Create standard event callback with common status handling
     */
    static createEventCallback(node, setStatus, statusTexts = {}) {
        const defaultTexts = {
            ready: "Ready",
            connecting: "Connecting...",
            disconnected: "Disconnected", 
            retrying: "Retrying...",
            authFailed: "Auth failed",
            reconnected: "Reconnected"
        };

        const texts = { ...defaultTexts, ...statusTexts };

        const callback = function() {};

        callback.updateStatus = function(status) {
            switch (status) {
                case 'ready':
                    setStatus("green", "dot", texts.ready);
                    node.isInitialized = true;
                    break;
                case 'connecting':
                    setStatus("yellow", "ring", texts.connecting);
                    break;
                case 'disconnected':
                    setStatus("red", "ring", texts.disconnected);
                    node.isInitialized = false;
                    break;
                case 'retrying':
                    setStatus("yellow", "ring", texts.retrying);
                    break;
                case 'failed_permanently':
                    setStatus("red", "ring", texts.authFailed);
                    break;
                default:
                    setStatus("grey", "ring", status);
            }
        };

        callback.onReconnect = function() {
            setStatus("green", "dot", texts.reconnected);
            node.isInitialized = true;
        };

        callback.onDisconnect = function() {
            setStatus("red", "ring", texts.disconnected);
        };

        return callback;
    }

    /**
     * Standard connection initialization pattern
     */
    static async initializeConnection(node, config, RED, settings, globalConfig, setStatus, customStatusTexts) {
        try {
            setStatus("yellow", "ring", "Connecting...");
            await NodeHelpers.handleConfigChange(node, config, RED, settings);
            const eventCallback = NodeHelpers.createEventCallback(node, setStatus, customStatusTexts);

            await connectionManager.registerForEvents(
                settings.nodeId,
                settings.serverId,
                eventCallback,
                globalConfig
            );

            const status = connectionManager.getConnectionStatus(settings.serverId);
            if (status.ready) {
                const readyText = customStatusTexts?.ready || "Ready";
                setStatus("green", "dot", readyText);
                node.isInitialized = true;
            } else {
                setStatus("yellow", "ring", "Waiting for connection...");
            }

        } catch (error) {
            const errorMsg = error.message || 'Unknown error';
            setStatus("red", "ring", "Registration failed");
            node.error(`Node registration failed: ${errorMsg}`);
        }
    }

    /**
     * Handle status message requests
     */
    static handleStatusRequest(msg, send, done, settings) {
        if (msg.topic === "status") {
            const status = connectionManager.getConnectionStatus(settings.serverId);
            const statusMsg = {
                payload: status,
                topic: "status",
                timestamp: Date.now()
            };
            send(statusMsg);
            done && done();
            return true;
        }
        return false;
    }

    /**
     * Standard node cleanup on close
     */
    static async handleNodeClose(node, settings, nodeType) {
        connectionManager.unregisterFromEvents(settings.nodeId);

        try {
            node.status({});
        } catch (statusError) {
            // Ignore status errors during cleanup
        }
    }

    /**
     * Standard error event handler
     */
    static createErrorHandler(node, setError) {
        return function(error) {
            node.error(`Node error: ${error.message}`);
            setError(`Node error: ${error.message}`, "Node error");
        };
    }

    /**
     * Validate required input field
     */
    static validateRequiredInput(value, fieldName, setStatus, done) {
        if (!value || (typeof value === 'string' && !value.trim())) {
            setStatus("red", "ring", `${fieldName} missing`);
            const error = new Error(`${fieldName} missing`);
            done && done(error);
            return false;
        }
        return true;
    }

    /**
     * Enhanced event callback for subscription nodes
     */
    static createSubscriptionEventCallback(node, setStatus, onSubscribed, statusTexts = {}) {
        const callback = NodeHelpers.createEventCallback(node, setStatus, statusTexts);

        // Add subscription-specific callbacks
        callback.onSubscribed = function() {
            node.isSubscribed = true;
            if (onSubscribed) onSubscribed();
        };

        // Override reconnect to handle resubscription
        callback.onReconnect = function() {
            node.isSubscribed = false;
            setStatus("yellow", "ring", "Resubscribing...");
        };

        // Override disconnect to update subscription state
        callback.onDisconnect = function() {
            setStatus("red", "ring", statusTexts.disconnected || "Disconnected");
            node.isSubscribed = false;
        };

        return callback;
    }
}

/**
 * Common patterns for specific node types
 */
class NodePatterns {
    /**
     * Standard input node setup
     */
    static async setupInputNode(node, config, RED, subscriptionFunction) {
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return null;

        const { globalConfig, connectionDetails, serverId } = serverConfig;
        
        const settings = {
            serverId,
            nodeId: node.id,
            ...connectionDetails
        };

        node.currentConfig = connectionDetails;
        node.isInitialized = false;
        node.isSubscribed = false;

        const callback = NodeHelpers.createSubscriptionEventCallback(
            node, 
            setStatus,
            () => { node.isSubscribed = true; }
        );

        try {
            await subscriptionFunction(settings, callback, globalConfig);
            return { settings, setStatus, setError, callback };
        } catch (error) {
            setError(`Subscription failed: ${error.message}`, "Subscription failed");
            return null;
        }
    }

    /**
     * Standard output node setup
     */
    static async setupOutputNode(node, config, RED, customStatusTexts) {
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return null;

        const { globalConfig, connectionDetails, serverId } = serverConfig;
        
        const settings = {
            serverId,
            nodeId: node.id,
            ...connectionDetails
        };

        node.currentConfig = connectionDetails;
        node.isInitialized = false;

        await NodeHelpers.initializeConnection(
            node, config, RED, settings, globalConfig, setStatus, customStatusTexts
        );

        return { settings, setStatus, setError };
    }

    /**
     * Standard get/query node setup
     */
    static async setupGetNode(node, config, RED, customStatusTexts) {
        return await NodePatterns.setupOutputNode(node, config, RED, customStatusTexts);
    }
}

module.exports = {
    NodeHelpers,
    NodePatterns
};