module.exports = function(RED) {
    function iobout(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        const axios = require('axios');

        const globalConfig=RED.nodes.getNode(config.server);
        const ioBrokerSrv = globalConfig.iobhost + ":" + globalConfig.iobport

        const state = config.state;

        // Reagieren auf eingehende Nachrichten
        this.on('input', function(msg, send, done) {
            // Erstellen Sie die URL für die REST-API
            const url = `http://${ioBrokerSrv}/v1/state/${state}?withInfo=false&value=${msg.payload}`;
			console.log(url);
            // Senden Sie die Anforderung an die REST-API
            axios.get(url)
                .then(response => {
                    console.log("Erfolg!");
                })
                .catch(error => {
                    console.log(`Error: ${error}`);
                });

            if (done) {
                done();
            }
        });

        this.on("close", async function(done) {
            done();
        });
    }
    RED.nodes.registerType("iobout", iobout);
}