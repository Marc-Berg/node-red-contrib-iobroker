module.exports = function(RED) {
    function iobget(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const axios = require('axios');

        const globalConfig = RED.nodes.getNode(config.server);
        if (!globalConfig?.iobhost || !globalConfig?.iobport) {
            node.error("Server configuration missing");
            node.status({ fill: "red", shape: "ring", text: "Configuration error" });
            return;
        }

        const ioBrokerSrv = `http://${globalConfig.iobhost}:${globalConfig.iobport}`;
        const configState = config.state?.trim();
        const outputProperty = config.outputProperty?.trim() || "payload";

        this.on('input', function(msg, send, done) {
            const stateId = configState || (typeof msg.topic === "string" ? msg.topic.trim() : "");

            if (!stateId) {
                node.status({ fill: "red", shape: "ring", text: "State ID missing" });
                done && done("State ID missing (neither configured nor in msg.topic)");
                return;
            }

            node.status({ fill: "blue", shape: "dot", text: `Reading ${stateId}...` });

            axios.get(`${ioBrokerSrv}/v1/state/${stateId}`)
                .then(response => {
                    node.status({ fill: "green", shape: "dot", text: "OK" });
                    msg[outputProperty] = response.data?.val !== undefined ? response.data.val : response.data;
                    msg.state = response.data;
                    send(msg);
                    done && done();
                })
                .catch(error => {
                    node.status({ fill: "red", shape: "ring", text: "Error" });
                    node.error(`Error reading ${stateId}: ${error.message}`);
                    done && done(error);
                });
        });
    }
    RED.nodes.registerType("iobget", iobget);
};
