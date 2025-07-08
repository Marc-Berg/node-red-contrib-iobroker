module.exports = function(RED) {
    function TestI18nNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        node.on('input', function(msg) {
            msg.payload = "i18n test node";
            node.send(msg);
        });
    }
    
    RED.nodes.registerType("test-i18n", TestI18nNode);
};