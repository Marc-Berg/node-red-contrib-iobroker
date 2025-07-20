const Orchestrator = require('../lib/orchestrator');
const { StatusHelpers } = require('../lib/utils/status-helpers');

module.exports = function (RED) {
    function iobinobject(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Get the server configuration
        node.server = RED.nodes.getNode(config.server);
        if (!node.server) {
            StatusHelpers.updateConnectionStatus(node, 'error', "Error: Server not configured");
            return;
        }

        // Configuration
        const objectPattern = config.objectPattern?.trim();
        if (!objectPattern) {
            StatusHelpers.updateConnectionStatus(node, 'error', "Error: Object Pattern missing");
            return;
        }

        const isWildcardPattern = objectPattern.includes('*');
        node.outputProperty = config.outputProperty?.trim() || "payload";
        node.objectPattern = objectPattern;
        node.isWildcardPattern = isWildcardPattern;

        // Track if the node has been registered with the orchestrator
        node.isRegistered = false;
        node.isSubscribed = false;

        // Helper function to create output message
        function createMessage(objectId, objectData, operation = 'update') {
            const message = {
                topic: objectId,
                object: objectData,
                operation: operation,
                timestamp: Date.now()
            };

            if (isWildcardPattern) {
                message.pattern = node.objectPattern;
            }

            message[node.outputProperty] = objectData;
            return message;
        }

        // Helper function to update status with object info
        function updateStatusWithObjectInfo(objectId, operation) {
            const now = new Date().toLocaleTimeString(undefined, { hour12: false });
            const statusText = isWildcardPattern
                ? `Pattern active - Last: ${now}`
                : `Last: ${now}`;
            node.status({ fill: "green", shape: "dot", text: statusText });
        }

        // --- Event Handlers ---

        const onServerReady = ({ serverId }) => {
            if (serverId === node.server.id) {
                if (!node.isSubscribed) {
                    node.log(`Server ready for ${serverId}, subscribing to object pattern: ${node.objectPattern}`);
                    StatusHelpers.updateConnectionStatus(node, 'subscribing', 'Subscribing to objects...');
                    Orchestrator.subscribeToObjects(node.id, node.objectPattern);
                } else {
                    node.log(`Server ready for ${serverId}, but already subscribed to objects`);
                }
            }
        };

        const onObjectSubscriptionConfirmed = ({ serverId, objectId }) => {
            if (serverId === node.server.id) {
                if (node.isWildcardPattern) {
                    // For wildcard patterns, any matching subscription confirms our pattern is active
                    if (objectId.includes('*') || objectId === node.objectPattern) {
                        node.status({ fill: "green", shape: "ring", text: `Pattern: ${node.objectPattern}` });
                        node.isSubscribed = true;
                    }
                } else {
                    // For single objects, exact match
                    if (objectId === node.objectPattern) {
                        node.status({ fill: "green", shape: "ring", text: `Subscribed to ${node.objectPattern}` });
                        node.isSubscribed = true;
                    }
                }
            }
        };

        const onObjectChanged = ({ serverId, objectId, objectData, operation }) => {
            if (serverId === node.server.id) {
                try {
                    // Check if this object change is relevant for our pattern
                    let isRelevant = false;
                    
                    if (node.isWildcardPattern) {
                        // For wildcard patterns, check if objectId matches the pattern
                        const patternRegex = new RegExp(node.objectPattern.replace(/\*/g, '.*'));
                        isRelevant = patternRegex.test(objectId);
                    } else {
                        // For single objects, exact match
                        isRelevant = objectId === node.objectPattern;
                    }
                    
                    if (isRelevant) {
                        // Handle deletion case
                        if (!objectData) {
                            operation = 'delete';
                            objectData = { _id: objectId, deleted: true };
                        }

                        const message = createMessage(objectId, objectData, operation);
                        node.send(message);
                        updateStatusWithObjectInfo(objectId, operation);
                    }
                } catch (error) {
                    node.error(`Object change processing error: ${error.message}`);
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
                StatusHelpers.updateConnectionStatus(node, 'error', `Connection failed: ${error}`);
                node.isSubscribed = false;
            }
        };

        // --- Node Lifecycle ---

        // Function to register with orchestrator
        const registerWithOrchestrator = () => {
            if (!node.isRegistered) {
                node.log(`Registering node with orchestrator after flows started`);
                Orchestrator.registerNode(node.id, node.server);
                node.isRegistered = true;
                
                // Set up event listeners AFTER registration is complete
                Orchestrator.on('server:ready', onServerReady);
                Orchestrator.on('object:subscription_confirmed', onObjectSubscriptionConfirmed);
                Orchestrator.on('object:changed', onObjectChanged);
                Orchestrator.on('connection:disconnected', onDisconnected);
                Orchestrator.on('connection:retrying', onRetrying);
                Orchestrator.on('connection:failed_permanently', onPermanentFailure);
            }
        };

        // Register with orchestrator when flows are ready
        // Use timeout to ensure registration happens after flows are started
        setTimeout(() => {
            registerWithOrchestrator();
        }, 300);

        node.on('close', function(done) {
            // Unsubscribe from objects if subscribed
            if (node.isSubscribed) {
                Orchestrator.unsubscribeFromObjects(node.id, node.objectPattern);
            }
            
            // Clean up all listeners to prevent memory leaks
            Orchestrator.removeListener('server:ready', onServerReady);
            Orchestrator.removeListener('object:subscription_confirmed', onObjectSubscriptionConfirmed);
            Orchestrator.removeListener('object:changed', onObjectChanged);
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

    RED.nodes.registerType("iobinobject", iobinobject);
};