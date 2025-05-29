module.exports = function(RED) {
    function iobout(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const axios = require('axios');

        const globalConfig = RED.nodes.getNode(config.server);
        if (!globalConfig) {
            node.error("No server configuration selected");
            node.status({ fill: "red", shape: "ring", text: "No server config" });
            return;
        }
        if (!globalConfig.iobhost || !globalConfig.iobport) {
            node.error("ioBroker host or port missing");
            node.status({ fill: "red", shape: "ring", text: "Host/port missing" });
            return;
        }

        const state = config.state?.trim();
        if (!state) {
            node.error("State ID missing");
            node.status({ fill: "red", shape: "ring", text: "State ID missing" });
            return;
        }

        const apiBase = (globalConfig.apiMode === "web")
            ? "/rest/v1/state"
            : "/v1/state";
        const ioBrokerSrv = `http://${globalConfig.iobhost}:${globalConfig.iobport}`;
        const setMode = config.setMode || "value"; // "value" or "command"

        this.on('input', function(msg, send, done) {
            const value = msg.payload;
            let url;
            if (setMode === "command") {
                // Set as command (ack=false)
                url = `${ioBrokerSrv}${apiBase}/${state}?withInfo=false&value=${encodeURIComponent(value)}&ack=false`;
            } else {
                // Set as value (ack=true)
                url = `${ioBrokerSrv}${apiBase}/${state}?withInfo=false&value=${encodeURIComponent(value)}&ack=true`;
            }
            console.log("Request URL:", url);

            axios.get(url)
                .then(response => {
                    node.status({ fill: "green", shape: "dot", text: "OK" });
                    node.log("Value set successfully");
                    done && done();
                })
                .catch(error => {
                    node.status({ fill: "red", shape: "ring", text: "Error" });
                    node.error(`Failed to set value: ${error.message}`);
                    done && done(error);
                });
        });

        this.on("close", function(done) {
            done();
        });
    }
    RED.nodes.registerType("iobout", iobout);
};
