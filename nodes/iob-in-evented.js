const Orchestrator = require('../lib/orchestrator');

module.exports = function(RED) {
    function IoBrokerInEventedNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        node.server = RED.nodes.getNode(config.server);
        node.stateId = config.stateId;
        node.isSubscribed = false;
        
        // Configuration options
        node.sendInitialValue = config.sendInitialValue || false;
        node.ackFilter = config.ackFilter || "both";
        
        // Detect wildcard pattern
        node.isWildcardPattern = node.stateId && node.stateId.includes('*');
        
        // Wildcard patterns don't support initial values
        if (node.isWildcardPattern) {
            node.sendInitialValue = false;
        }

        if (!node.server || !node.stateId) {
            node.status({ fill: "red", shape: "dot", text: "Error: Server or State ID not configured" });
            return;
        }

        // --- Event Handler ---

        const onServerReady = ({ serverId }) => {
            if (serverId === node.server.id) {
                if (!node.isSubscribed) {
                    node.status({ fill: "blue", shape: "dot", text: `Subscribing to ${node.stateId}...` });
                    Orchestrator.subscribe(node.id, node.stateId);
                    node.isSubscribed = true;
                } else {
                    // Server is ready again after reconnection, but we don't need to re-subscribe
                    // The StateService will handle re-subscription automatically
                    node.status({ fill: "yellow", shape: "ring", text: `Reconnected, waiting for subscription...` });
                }
            }
        };

        const onSubscriptionConfirmed = ({ serverId, stateId }) => {
            if (serverId === node.server.id) {
                // For wildcard patterns, any matching subscription confirms our pattern is active
                if (node.isWildcardPattern) {
                    if (matchesWildcardPattern(stateId, node.stateId)) {
                        node.status({ fill: "green", shape: "ring", text: `Pattern active: ${node.stateId}` });
                        node.isSubscribed = true;
                    }
                } else {
                    // For single states, exact match
                    if (stateId === node.stateId) {
                        node.status({ fill: "green", shape: "ring", text: `Subscribed to ${node.stateId}` });
                        node.isSubscribed = true;
                    }
                }
            }
        };

        const onStateChanged = ({ serverId, stateId, state }) => {
            if (serverId === node.server.id) {
                // For wildcard patterns, check if the stateId matches the pattern
                if (node.isWildcardPattern) {
                    if (!matchesWildcardPattern(stateId, node.stateId)) {
                        return; // State doesn't match our pattern
                    }
                } else {
                    // For single states, exact match
                    if (stateId !== node.stateId) {
                        return;
                    }
                }
                
                // Apply ACK filter
                if (!shouldSendMessage(state.ack, node.ackFilter)) {
                    return;
                }
                
                // Create output message
                const message = {
                    payload: state.val,
                    topic: stateId,
                    ts: state.ts,
                    ack: state.ack,
                    state: state
                };
                
                // Add pattern info for wildcard matches
                if (node.isWildcardPattern) {
                    message.pattern = node.stateId;
                }
                
                // Update status and send message
                const statusText = node.isWildcardPattern 
                    ? `${stateId}: ${state.val} (ts: ${new Date(state.ts).toLocaleTimeString()})`
                    : `val: ${state.val} (ts: ${new Date(state.ts).toLocaleTimeString()})`;
                    
                node.status({ fill: "green", shape: "dot", text: statusText });
                node.send(message);
            }
        };
        
        // Helper function to check ACK filter
        function shouldSendMessage(ack, filter) {
            switch (filter) {
                case "ack": return ack === true;
                case "noack": return ack === false;
                default: return true; // "both"
            }
        }
        
        // Helper function to match wildcard patterns
        function matchesWildcardPattern(stateId, pattern) {
            // Convert wildcard pattern to regex
            // Escape special regex characters except *
            const regexPattern = pattern
                .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
                .replace(/\*/g, '.*'); // Replace * with .*
            
            const regex = new RegExp(`^${regexPattern}$`);
            return regex.test(stateId);
        }

        const onDisconnected = ({ serverId }) => {
            if (serverId === node.server.id) {
                node.status({ fill: "red", shape: "ring", text: "Disconnected" });
                node.isSubscribed = false; // Reset subscription status on disconnect
            }
        };

        const onRetrying = ({ serverId, attempt, delay }) => {
            if (serverId === node.server.id) {
                node.status({ 
                    fill: "yellow", 
                    shape: "ring", 
                    text: `Retrying in ${delay / 1000}s (Attempt #${attempt})` 
                });
            }
        };

        const onPermanentFailure = ({ serverId, error }) => {
            if (serverId === node.server.id) {
                node.status({ 
                    fill: "red", 
                    shape: "dot", 
                    text: `Failed: ${error.message}` 
                });
            }
        };

        // --- Node Lifecycle ---

        // Register the node with the Orchestrator. This triggers the initial connection request.
        Orchestrator.registerNode(node.id, node.server);

        // Listen for events from the Orchestrator
        Orchestrator.on('server:ready', onServerReady);
        Orchestrator.on('state:subscription_confirmed', onSubscriptionConfirmed);
        Orchestrator.on('state:changed', onStateChanged);
        Orchestrator.on('connection:disconnected', onDisconnected);
        Orchestrator.on('connection:retrying', onRetrying);
        Orchestrator.on('connection:failed_permanently', onPermanentFailure);

        node.on('close', (done) => {
            // Clean up all listeners to prevent memory leaks
            Orchestrator.removeListener('server:ready', onServerReady);
            Orchestrator.removeListener('state:subscription_confirmed', onSubscriptionConfirmed);
            Orchestrator.removeListener('state:changed', onStateChanged);
            Orchestrator.removeListener('connection:disconnected', onDisconnected);
            Orchestrator.removeListener('connection:retrying', onRetrying);
            Orchestrator.removeListener('connection:failed_permanently', onPermanentFailure);
            
            Orchestrator.unregisterNode(node.id, node.server.id);
            done();
        });

        // Initial status on deploy
        const initialStatusText = node.isWildcardPattern 
            ? `Waiting for pattern: ${node.stateId}` 
            : "Waiting for server...";
        node.status({ fill: "grey", shape: "dot", text: initialStatusText });
    }

    RED.nodes.registerType("iob-in-evented", IoBrokerInEventedNode);
};