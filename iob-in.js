module.exports = function(RED) {
    function iobin(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const axios = require('axios');
        const uuid = Date.now().toString(36); // Unique ID per node instance

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

        // State ID directly as string (no array)
        const stateId = config.state?.trim();
        if (!stateId) {
            node.error("State ID missing");
            node.status({ fill: "red", shape: "ring", text: "State ID missing" });
            return;
        }

        const outputType = config.outputType || "value"; // "value" or "full"
        const outputProperty = config.outputProperty?.trim() || "payload";
        const ackFilter = config.ackFilter || "both"; // "both", "ack", "noack"

        // Determine API base path based on config
        const apiBase = (globalConfig.apiMode === "web")
            ? `/rest/v1/state`
            : `/v1/state`;
        const callbackUrl = `/ioBroker/${node.id}/${uuid}`;
        const nodeRedSrv = globalConfig.nrhost + ":" + globalConfig.nrport;
        const ioBrokerSrv = globalConfig.iobhost + ":" + globalConfig.iobport;

        // Register HTTP handler for callbacks
        RED.httpNode.post(callbackUrl, (req, res) => {
            try {
                res.sendStatus(200);
                if (req.body?.state?.val !== undefined) {
                    const stateAck = req.body.state?.ack ?? false;
                    let shouldSend = false;

                    switch (ackFilter) {
                        case "ack":
                            shouldSend = stateAck === true;
                            break;
                        case "noack":
                            shouldSend = stateAck === false;
                            break;
                        default: // "both"
                            shouldSend = true;
                            break;
                    }

                    if (shouldSend) {
                        const msg = {
                            [outputProperty]: outputType === "full" ? req.body : req.body.state.val,
                            topic: req.body.id,
                            state: req.body.state
                        };
                        node.send(msg);
                    }
                }
            } catch (error) {
                node.error(`Callback error: ${error.message}`);
            }
        });

        // Subscribe with unique URL
        const subscribe = async (stateId) => {
            try {
                await axios.post(
                    `http://${ioBrokerSrv}${apiBase}/${stateId}/subscribe`,
                    {
                        url: `http://${nodeRedSrv}${callbackUrl}`,
                        method: 'POST'
                    }
                );
                node.status({ fill: "green", shape: "dot", text: "connected" });
            } catch (error) {
                node.status({ fill: "red", shape: "ring", text: error.message });
            }
        };

        subscribe(stateId)
            .then(() => node.log("Subscription successful"))
            .catch((e) => node.error("Error subscribing"));

        // Cleanup on redeploy
        this.on("close", async (done) => {
            node.log(`Unsubscribing from ${stateId}...`);
            await axios.delete(
                `http://${ioBrokerSrv}${apiBase}/${stateId}/subscribe`,
                {
                    data: {
                        url: `http://${nodeRedSrv}${callbackUrl}`,
                        method: 'POST'
                    }
                }
            ).catch(e => {});
            done();
        });
    }
    RED.nodes.registerType("iobin", iobin);
};
