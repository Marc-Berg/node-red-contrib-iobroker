const Orchestrator = require('../lib/orchestrator');

module.exports = function(RED) {
    function IoBrokerInEventedNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        node.server = RED.nodes.getNode(config.server);
        node.stateId = config.stateId;
        node.isSubscribed = false;

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
            if (serverId === node.server.id && stateId === node.stateId) {
                node.status({ fill: "green", shape: "ring", text: `Subscribed to ${node.stateId}` });
                node.isSubscribed = true; // Ensure subscription status is correct after re-subscription
            }
        };

        const onStateChanged = ({ serverId, stateId, state }) => {
            if (serverId === node.server.id && stateId === node.stateId) {
                const statusText = `val: ${state.val} (ts: ${new Date(state.ts).toLocaleTimeString()})`;
                node.status({ fill: "green", shape: "dot", text: statusText });
                node.send({ payload: state.val, topic: stateId, ts: state.ts, ack: state.ack });
            }
        };

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
        node.status({ fill: "grey", shape: "dot", text: "Waiting for server..." });
    }

    RED.nodes.registerType("iob-in-evented", IoBrokerInEventedNode);
};