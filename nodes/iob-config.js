const path = require('path');
const express = require('express');
const fs = require('fs');
const { Logger } = require('../lib/utils/logger');

let staticResourcesSetup = false;
let apiEndpointsSetup = false;

function setupStaticResources(RED) {
    Logger.setRED(RED);
    if (staticResourcesSetup) return true;

    try {
        const sharedPath = path.join(__dirname, '..', 'shared');

        if (!fs.existsSync(sharedPath)) {
            new Logger('iob-config').warn(`Shared directory not found: ${sharedPath}`);
            return false;
        }

        const treeViewPath = path.join(sharedPath, 'iobroker-treeview.js');
        if (!fs.existsSync(treeViewPath)) {
            new Logger('iob-config').warn(`TreeView component not found: ${treeViewPath}`);
            return false;
        }

        RED.httpAdmin.use('/iobroker/shared', (req, res, next) => {
            try {
                new Logger('iob-config').debug(`Shared request: ${req.method} ${req.originalUrl}`);
            } catch (e) { /* no-op */ }
            next();
        }, express.static(sharedPath, {
            maxAge: 0,
            etag: false,
            lastModified: false,
            setHeaders: (res, filePath) => {
                if (filePath.endsWith('.js')) {
                    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                    res.setHeader('X-Content-Type-Options', 'nosniff');
                    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                    res.setHeader('Pragma', 'no-cache');
                    res.setHeader('Expires', '0');
                }
            }
        }));

        staticResourcesSetup = true;
        return true;

    } catch (error) {
        new Logger('iob-config').error(`Failed to setup static resources: ${error.message}`);
        return false;
    }
}

function setupAPIEndpoints(RED) {
    if (apiEndpointsSetup) return true;

    try {
        const connectionManager = require('../lib/manager/websocket-manager');

        RED.httpAdmin.get('/iobroker/ws/states/:serverId', async (req, res) => {
            try {
                const serverId = decodeURIComponent(req.params.serverId);
                new Logger('iob-config').debug(`GET /ws/states for ${serverId}`);
                const states = await connectionManager.getStates(serverId);

                res.setHeader('Cache-Control', 'public, max-age=300');
                res.json(states);

            } catch (error) {
                new Logger('iob-config').error(`States API error: ${error.message}`);
                res.status(500).json({
                    error: 'Failed to retrieve states',
                    details: error.message
                });
            }
        });

        // Objects endpoint using getObjectView under the hood via OperationManager
        // Usage: /iobroker/ws/objects/:serverId?pattern=adapter.*&type=state
        RED.httpAdmin.get('/iobroker/ws/objects/:serverId', async (req, res) => {
            try {
                const serverId = decodeURIComponent(req.params.serverId);
                const pattern = (req.query.pattern || '*').toString();
                const type = req.query.type ? req.query.type.toString() : null;
                new Logger('iob-config').debug(`GET /ws/objects for ${serverId} pattern=${pattern} type=${type || 'any'}`);

                const allowedTypes = new Set(['state', 'channel', 'device', 'folder', 'adapter', 'instance', 'host', 'group', 'user', 'config', 'enum']);
                const objectType = type && allowedTypes.has(type) ? type : null;

                const objects = await connectionManager.getObjects(serverId, pattern, objectType);

                res.setHeader('Cache-Control', 'public, max-age=120');
                res.json({
                    pattern,
                    type: objectType,
                    count: Array.isArray(objects) ? objects.length : 0,
                    objects: Array.isArray(objects) ? objects : []
                });
            } catch (error) {
                new Logger('iob-config').error(`Objects API error: ${error.message}`);
                res.status(500).json({
                    error: 'Failed to retrieve objects',
                    details: error.message,
                    objects: []
                });
            }
        });

        RED.httpAdmin.get('/iobroker/ws/status/:serverId', (req, res) => {
            try {
                const serverId = decodeURIComponent(req.params.serverId);
                new Logger('iob-config').debug(`GET /ws/status for ${serverId}`);
                const status = connectionManager.getConnectionStatus(serverId);

                res.json({
                    ...status,
                    requestTime: Date.now()
                });

            } catch (error) {
                new Logger('iob-config').error(`Status API error: ${error.message}`);
                res.status(500).json({
                    error: 'Failed to get connection status',
                    details: error.message
                });
            }
        });

        RED.httpAdmin.get('/iobroker/ws/adapters/:serverId', async (req, res) => {
            try {
                const serverId = decodeURIComponent(req.params.serverId);
                const connectionManager = require('../lib/manager/websocket-manager');
                new Logger('iob-config').debug(`GET /ws/adapters for ${serverId}`);

                const states = await connectionManager.getStates(serverId);
                const historyAdapters = [];

                if (states && typeof states === 'object') {
                    const adapterConfigs = new Map();

                    Object.keys(states).forEach(stateId => {
                        const aliveMatch = stateId.match(/^system\.adapter\.(history|sql|influxdb)\.(\d+)\.alive$/);
                        if (aliveMatch) {
                            const adapterType = aliveMatch[1];
                            const instance = parseInt(aliveMatch[2]);
                            const adapterName = `${adapterType}.${instance}`;

                            const state = states[stateId];
                            const isAlive = state && typeof state.val === 'boolean' ? state.val : Boolean(state?.val);

                            if (!adapterConfigs.has(adapterName)) {
                                adapterConfigs.set(adapterName, {
                                    name: adapterName,
                                    type: adapterType,
                                    instance: instance,
                                    enabled: false,
                                    alive: isAlive,
                                    title: adapterName
                                });
                            } else {
                                adapterConfigs.get(adapterName).alive = isAlive;
                            }
                        }

                        const enabledMatch = stateId.match(/^system\.adapter\.(history|sql|influxdb)\.(\d+)\.enabled$/);
                        if (enabledMatch) {
                            const adapterType = enabledMatch[1];
                            const instance = parseInt(enabledMatch[2]);
                            const adapterName = `${adapterType}.${instance}`;

                            const state = states[stateId];
                            const isEnabled = state && typeof state.val === 'boolean' ? state.val : Boolean(state?.val);

                            if (!adapterConfigs.has(adapterName)) {
                                adapterConfigs.set(adapterName, {
                                    name: adapterName,
                                    type: adapterType,
                                    instance: instance,
                                    enabled: isEnabled,
                                    alive: false,
                                    title: adapterName
                                });
                            } else {
                                adapterConfigs.get(adapterName).enabled = isEnabled;
                            }
                        }
                    });

                    for (const config of adapterConfigs.values()) {
                        historyAdapters.push(config);
                    }
                }

                historyAdapters.sort((a, b) => {
                    if (a.type !== b.type) return a.type.localeCompare(b.type);
                    return a.instance - b.instance;
                });

                res.json({
                    adapters: historyAdapters,
                    count: historyAdapters.length
                });

            } catch (error) {
                new Logger('iob-config').error(`Adapters API error: ${error.message}`);
                res.status(500).json({
                    error: 'Failed to retrieve adapters',
                    details: error.message,
                    adapters: []
                });
            }
        });

        apiEndpointsSetup = true;
        return true;

    } catch (error) {
        new Logger('iob-config').error(`Failed to setup API endpoints: ${error.message}`);
        return false;
    }
}

module.exports = function (RED) {
    const staticResult = setupStaticResources(RED);
    const apiResult = setupAPIEndpoints(RED);

    function ioBConfig(n) {
        RED.nodes.createNode(this, n);
        this.iobhost = n.iobhost;
        this.iobport = n.iobport;
        this.user = this.credentials.user;
        this.password = this.credentials.password;
        this.usessl = n.usessl || false;

        const sslInfo = this.usessl ? ' (SSL enabled)' : '';
        const authInfo = this.user ? ' (with authentication)' : '';
        new Logger('iob-config').debug(`ioBroker config created: ${this.iobhost}:${this.iobport}${sslInfo}${authInfo}`);
    }

    RED.nodes.registerType("iob-config", ioBConfig, {
        credentials: {
            user: { type: "text" },
            password: { type: "password" }
        }
    });
};