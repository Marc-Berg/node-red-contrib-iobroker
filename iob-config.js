module.exports = function(RED) {
    function ioBConfig(n) {
        RED.nodes.createNode(this,n);
        this.iobhost = n.iobhost;
        this.iobport = n.iobport;
        this.nrhost = n.nrhost;
        this.nrport = n.nrport;
    }
    RED.nodes.registerType("iob-config",ioBConfig);
}