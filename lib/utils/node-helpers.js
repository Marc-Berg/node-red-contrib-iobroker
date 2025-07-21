/*!
 * Common Node Helper Functions for ioBroker Node-RED Integration
 * Shared utilities to reduce code duplication across node implementations
 */

const Orchestrator = require('../orchestrator');

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
            serverId: globalConfig.id
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

        const newServerId = newGlobalConfig.id;
        settings.serverId = newServerId;

        if (oldServerId !== newServerId) {
            // Server switch needs to be handled by unregistering from old and registering to new
            node.log(`Server config changed from ${oldServerId} to ${newServerId}`);
        }

        return true;
    }

    /**
     * Standard connection initialization pattern
     */
    static async initializeConnection(node, config, RED, settings, globalConfig, setStatus, customStatusTexts) {
        try {
            setStatus("yellow", "ring", "Connecting...");
            await NodeHelpers.handleConfigChange(node, config, RED, settings);
            
            // Register node with orchestrator
            node.server = globalConfig;
            node.isRegistered = false;
            
            // Set up event listeners
            const onServerReady = ({ serverId }) => {
                if (serverId === settings.serverId) {
                    const readyText = customStatusTexts?.ready || "Ready";
                    setStatus("green", "dot", readyText);
                    node.isInitialized = true;
                }
            };
            
            const onDisconnected = ({ serverId }) => {
                if (serverId === settings.serverId) {
                    const disconnectedText = customStatusTexts?.disconnected || "Disconnected";
                    setStatus("red", "ring", disconnectedText);
                }
            };
            
            const onRetrying = ({ serverId, attempt, delay }) => {
                if (serverId === settings.serverId) {
                    setStatus("yellow", "ring", `Retrying... (${attempt})`);
                }
            };
            
            // Store event handlers for cleanup
            node._eventHandlers = { onServerReady, onDisconnected, onRetrying };
            
            Orchestrator.on('server:ready', onServerReady);
            Orchestrator.on('connection:disconnected', onDisconnected);
            Orchestrator.on('connection:retrying', onRetrying);
            
            // Register with orchestrator
            setTimeout(() => {
                if (!node.isRegistered) {
                    node.log(`Registering node with orchestrator`);
                    Orchestrator.registerNode(settings.nodeId, globalConfig);
                    node.isRegistered = true;
                }
            }, 100);
            
            setStatus("yellow", "ring", "Waiting for connection...");

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
            // Simple status response - orchestrator-based nodes don't expose detailed status
            const statusMsg = {
                payload: { ready: true, serverId: settings.serverId },
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
        // Clean up event listeners
        if (node._eventHandlers) {
            Orchestrator.removeListener('server:ready', node._eventHandlers.onServerReady);
            Orchestrator.removeListener('connection:disconnected', node._eventHandlers.onDisconnected);
            Orchestrator.removeListener('connection:retrying', node._eventHandlers.onRetrying);
        }
        
        // Unregister from orchestrator
        if (node.isRegistered) {
            Orchestrator.unregisterNode(settings.nodeId, settings.serverId);
        }

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
     * Setup message queue system for delayed message sending after flows are ready
     * This ensures messages are sent only when Node-RED is fully initialized
     */
    static setupMessageQueue(RED, node) {
        // Track readiness state
        node.isFlowsReady = false;
        node.isNodesReady = false;
        
        // Queue for messages that need to be sent when ready
        node.pendingMessages = [];
        
        // Function to send message when ready
        const sendWhenReady = (message, messageType = "message") => {
            const sendMessage = () => {
                try {
                    node.send(message);
                } catch (error) {
                    node.error(`Error sending ${messageType}: ${error.message}`);
                }
            };
            
            // If both flows and nodes are ready, send immediately
            if (node.isFlowsReady && node.isNodesReady) {
                setImmediate(sendMessage);
            } else {
                // Queue the message
                node.pendingMessages.push({ message, messageType, sendFn: sendMessage });
            }
        };
        
        // Function to process pending messages
        const processPendingMessages = () => {
            if (node.isFlowsReady && node.isNodesReady && node.pendingMessages.length > 0) {
                node.pendingMessages.forEach(({ sendFn }) => {
                    setImmediate(sendFn);
                });
                node.pendingMessages = [];
            }
        };
        
        // Listen for flows:started event
        const onFlowsStarted = () => {
            node.isFlowsReady = true;
            
            // Set nodes ready after a short delay to ensure downstream nodes are ready
            setTimeout(() => {
                node.isNodesReady = true;
                processPendingMessages();
            }, 250);
        };
        
        // Setup event listener
        RED.events.on('flows:started', onFlowsStarted);
        
        // Cleanup function for the close event
        const cleanup = () => {
            RED.events.removeListener('flows:started', onFlowsStarted);
        };
        
        return { sendWhenReady, cleanup };
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