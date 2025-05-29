module.exports = function(RED) {
    function iobout(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        const axios = require('axios');

        const globalConfig = RED.nodes.getNode(config.server);
        const ioBrokerSrv = globalConfig.iobhost + ":" + globalConfig.iobport;

        const state = config.state;

        // React to incoming messages
        this.on('input', function(msg, send, done) {
            // Build the URL for the REST API
            const url = `http://${ioBrokerSrv}/v1/state/${state}?withInfo=false&value=${msg.payload}`;
            console.log(url);
            // Send the request to the REST API
            axios.get(url)
                .then(response => {
                    console.log("Success!");
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
};