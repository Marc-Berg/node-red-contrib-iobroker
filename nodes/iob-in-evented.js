// nodes/iob-in-evented.js
const Orchestrator = require('../lib/orchestrator');

module.exports = function(RED) {
    function IoBrokerInEventedNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // 1. Get the server configuration from the existing iob-config node
        const server = RED.nodes.getNode(config.server);
        if (!server) {
            node.status({ fill: "red", shape: "ring", text: "No server configured" });
            return;
        }

        const stateId = config.stateId;
        if (!stateId) {
            node.status({ fill: "red", shape: "ring", text: "No State ID configured" });
            return;
        }
        
        // 2. Register this node with the new Orchestrator
        // The 'server' object contains all credentials and connection details.
        Orchestrator.registerNode(node.id, server);

        // 3. Define handlers for events from the Orchestrator
        const onStateChanged = ({ stateId: changedId, state }) => {
            if (changedId === stateId) {
                node.send({
                    topic: changedId,
                    payload: state.val,
                    state: state
                });
            }
        };

        const updateNodeStatus = () => {
             // This logic can be expanded to show more detailed status
            node.status({ fill: "green", shape: "dot", text: "connected" });
        };
       
        const handleDisconnect = () => {
            node.status({ fill: "red", shape: "ring", text: "disconnected" });
        };

        // 4. Subscribe to Orchestrator events
        Orchestrator.subscribe(node.id, stateId);
        Orchestrator.on('state:changed', onStateChanged);
        Orchestrator.on('auth:success', updateNodeStatus);
        Orchestrator.on('connection:disconnected', handleDisconnect);


        // 5. Clean up when the node is closed or redeployed
        node.on('close', (done) => {
            // Unregister this node's need for the connection
            Orchestrator.unregisterNode(node.id, server.id);
            
            // Unsubscribe from events to prevent memory leaks
            Orchestrator.off('state:changed', onStateChanged);
            Orchestrator.off('auth:success', updateNodeStatus);
            Orchestrator.off('connection:disconnected', handleDisconnect);
            
            // Stop listening for this specific state
            Orchestrator.unsubscribe(node.id, stateId);
            
            node.status({});
            done();
        });
    }

    RED.nodes.registerType("iob-in-evented", IoBrokerInEventedNode);
}