module.exports = function(RED) {
    function iobget(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const axios = require('axios');

        const globalConfig = RED.nodes.getNode(config.server);
        if (!globalConfig?.iobhost || !globalConfig?.iobport) {
            node.error("Server-Konfiguration fehlt");
            node.status({ fill: "red", shape: "ring", text: "Konfigurationsfehler" });
            return;
        }

        const ioBrokerSrv = `http://${globalConfig.iobhost}:${globalConfig.iobport}`;
        const configState = config.state?.trim();

        this.on('input', function(msg, send, done) {
            // State-ID aus Config oder aus msg.topic
            const stateId = configState || (typeof msg.topic === "string" ? msg.topic.trim() : "");

            if (!stateId) {
                node.status({ fill: "red", shape: "ring", text: "State-ID fehlt" });
                done && done("State-ID fehlt (weder konfiguriert noch in msg.topic)");
                return;
            }

            node.status({ fill: "blue", shape: "dot", text: `Lese ${stateId}...` });

            axios.get(`${ioBrokerSrv}/v1/state/${stateId}`)
                .then(response => {
                    node.status({ fill: "green", shape: "dot", text: "OK" });
                    msg.payload = response.data?.val !== undefined ? response.data.val : response.data;
                    msg.state = response.data; // gesamtes Objekt zusätzlich
                    send(msg);
                    done && done();
                })
                .catch(error => {
                    node.status({ fill: "red", shape: "ring", text: "Fehler" });
                    node.error(`Fehler beim Lesen von ${stateId}: ${error.message}`);
                    done && done(error);
                });
        });
    }
    RED.nodes.registerType("iobget", iobget);
};
