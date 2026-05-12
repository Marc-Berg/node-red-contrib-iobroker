const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function(RED) {
    function iobdelobject(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);

        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

        const settings = {
            objectId: config.objectId?.trim() || '',
            recursive: config.recursive === true,
            maintenance: config.maintenance === true,
            serverId,
            nodeId: node.id
        };

        node.currentConfig = connectionDetails;
        node.isInitialized = false;

        const statusTexts = {
            ready: settings.recursive ? 'Ready (recursive)' : 'Ready',
            reconnected: settings.recursive ? 'Reconnected (recursive)' : 'Reconnected'
        };

        NodeHelpers.initializeConnection(
            node, config, RED, settings, globalConfig, setStatus, statusTexts
        );

        node.on('input', async function(msg, send, done) {
            try {
                if (NodeHelpers.handleStatusRequest(msg, send, done, settings)) {
                    return;
                }

                const objectId = (msg.objectId || settings.objectId || '').trim();
                const recursive = typeof msg.recursive === 'boolean' ? msg.recursive : settings.recursive;
                const maintenance = typeof msg.maintenance === 'boolean' ? msg.maintenance : settings.maintenance;

                if (!objectId) {
                    setStatus('red', 'ring', 'Object ID missing');
                    const error = new Error('Object ID missing (configure Object ID or provide msg.objectId)');
                    done && done(error);
                    return;
                }

                setStatus('blue', 'dot', `Deleting ${objectId}...`);

                if (recursive) {
                    await connectionManager.delObjects(settings.serverId, objectId, maintenance);
                } else {
                    await connectionManager.delObject(settings.serverId, objectId, maintenance);
                }

                setStatus('green', 'dot', statusTexts.ready);

                send({
                    payload: {
                        success: true,
                        objectId,
                        recursive,
                        maintenance
                    },
                    objectId,
                    recursive,
                    maintenance,
                    timestamp: Date.now()
                });

                done && done();
            } catch (error) {
                setStatus('red', 'ring', 'Delete failed');
                node.error(`Failed to delete object: ${error.message}`);
                done && done(error);
            }
        });

        node.on('close', async function(removed, done) {
            await NodeHelpers.handleNodeClose(node, settings, 'DelObject');
            done();
        });

        node.on('error', NodeHelpers.createErrorHandler(node, setError));
    }

    RED.nodes.registerType('iobdelobject', iobdelobject);
};