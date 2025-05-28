module.exports = function(RED) {
    function iobin(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const axios = require('axios');
        const uuid = Date.now().toString(36); // Eindeutige ID pro Node-Instanz

        const globalConfig = RED.nodes.getNode(config.server);
        const nodeRedSrv = globalConfig.nrhost + ":" + globalConfig.nrport;
        const ioBrokerSrv = globalConfig.iobhost + ":" + globalConfig.iobport;

        const states = Array.isArray(config.states) ? config.states : JSON.parse(config.states || "[]");
        const outputType = config.outputType || "value"; // "value" oder "full"

        const callbackUrl = `/ioBroker/${node.id}/${uuid}`;
        
        // HTTP-Handler registrieren
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

        // Abonnieren mit eindeutiger URL
        const subscribe = async (stateId) => {
            try {
                await axios.post(
                    `http://${ioBrokerSrv}/v1/state/${stateId}/subscribe`,
                    {
                        url: `http://${nodeRedSrv}${callbackUrl}`,
                        method: 'POST'
                    }
                );
                node.status({fill:"green",shape:"dot",text:"connected"});
            } catch (error) {
                node.status({fill:"red",shape:"ring",text:error.message});
            }
        };

        // Initiale Subscriptions
        Promise.all(states.map(subscribe))
            .then(() => node.log(`${states.length} Subscriptions erfolgreich`))
            .catch((e) => node.error("Fehler beim Abonnieren"));

        // Cleanup bei Redeploy
        this.on("close", async (done) => {
            node.log(`Unsubscribe von ${states.length} States...`);
            await Promise.all(states.map(stateId => 
                axios.delete(`http://${ioBrokerSrv}/v1/state/${stateId}/subscribe`, {
                    data: { 
                        url: `http://${nodeRedSrv}${callbackUrl}`,
                        method: 'POST' 
                    }
                }).catch(e => {})
            ));
            done();
        });
    }
    RED.nodes.registerType("iobin", iobin);
};
