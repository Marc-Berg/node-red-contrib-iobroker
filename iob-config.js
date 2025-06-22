module.exports = function(RED) {
    function ioBConfig(n) {
        RED.nodes.createNode(this, n);
        this.iobhost = n.iobhost;
        this.iobport = n.iobport;
        this.user = n.user;
        this.password = n.password;
        this.usessl = n.usessl || false;
        
        // Log configuration creation for debugging
        const sslInfo = this.usessl ? ' (SSL enabled)' : '';
        const authInfo = this.user ? ' (with authentication)' : '';
        RED.log.debug(`ioBroker config created: ${this.iobhost}:${this.iobport}${sslInfo}${authInfo}`);
    }
    
    RED.nodes.registerType("iob-config", ioBConfig);
};