module.exports = function(RED) {
    function iobin(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const axios = require('axios');
        const uuid = Date.now().toString(36); // Unique ID per node instance

        const globalConfig = RED.nodes.getNode(config.server);
        const nodeRedSrv = globalConfig.nrhost + ":" + globalConfig.nrport;
        const ioBrokerSrv = globalConfig.iobhost + ":" + globalConfig.iobport;

        // State ID as string (no array anymore!)
        const stateId = config.state?.trim();
        const outputType = config.outputType || "value"; // "value" or "full"

        if (!stateId) {
            node.error("State ID missing");
            node.status({ fill: "red", shape: "ring", text: "State ID missing" });
            return;
        }

        const callbackUrl = `/ioBroker/${node.id}/${uuid}`;

        // Register HTTP handler
        RED.httpNode.post(callbackUrl, (req, res) => {
            try {
                res.sendStatus(200);
                if (req.body?.state?.val !== undefined) {
                    const msg = {
                        payload: outputType === "full" ? req.body : req.body.state.val,
                        topic: req.body.id,
                        _original: req.body
                    };
                    node.send(msg);
                }
            } catch (error) {
                node.error(`Callback error: ${error.message}`);
            }
        });

        // Subscribe with unique URL
        const subscribe = async (stateId) => {
            try {
                await axios.post(
                    `http://${ioBrokerSrv}/v1/state/${stateId}/subscribe`,
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
                `http://${ioBrokerSrv}/v1/state/${stateId}/subscribe`,
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
