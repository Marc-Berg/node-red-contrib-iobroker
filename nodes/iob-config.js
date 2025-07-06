const path = require('path');
const express = require('express');
const fs = require('fs');

let staticResourcesSetup = false;
let apiEndpointsSetup = false;

function setupStaticResources(RED) {
    if (staticResourcesSetup) return true;

    try {
        const sharedPath = path.join(__dirname, '..', 'shared');

        if (!fs.existsSync(sharedPath)) {
            console.warn('[ioBroker] Shared directory not found:', sharedPath);
            return false;
        }

        const treeViewPath = path.join(sharedPath, 'iobroker-treeview.js');
        if (!fs.existsSync(treeViewPath)) {
            console.warn('[ioBroker] TreeView component not found:', treeViewPath);
            return false;
        }

        RED.httpAdmin.use('/iobroker/shared', express.static(sharedPath, {
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
        console.error('[ioBroker] Failed to setup static resources:', error.message);
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
                const states = await connectionManager.getStates(serverId);

                res.setHeader('Cache-Control', 'public, max-age=300');
                res.json(states);

            } catch (error) {
                console.error('[ioBroker] States API error:', error.message);
                res.status(500).json({
                    error: 'Failed to retrieve states',
                    details: error.message
                });
            }
        });

        RED.httpAdmin.get('/iobroker/ws/status/:serverId', (req, res) => {
            try {
                const serverId = decodeURIComponent(req.params.serverId);
                const status = connectionManager.getConnectionStatus(serverId);

                res.json({
                    ...status,
                    requestTime: Date.now()
                });

            } catch (error) {
                console.error('[ioBroker] Status API error:', error.message);
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

                // Use the same method as TreeView - get all states
                const states = await connectionManager.getStates(serverId);
                const historyAdapters = [];

                if (states && typeof states === 'object') {
                    const adapterConfigs = new Map();
                    
                    // Extract history adapter information from states
                    Object.keys(states).forEach(stateId => {
                        // Look for alive states of history adapters
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
                                    enabled: false, // Will be updated if enabled state found
                                    alive: isAlive,
                                    title: adapterName
                                });
                            } else {
                                adapterConfigs.get(adapterName).alive = isAlive;
                            }
                        }
                        
                        // Look for enabled states of history adapters
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
                                    alive: false, // Will be updated if alive state found
                                    title: adapterName
                                });
                            } else {
                                adapterConfigs.get(adapterName).enabled = isEnabled;
                            }
                        }
                    });

                    // Convert map to array
                    for (const config of adapterConfigs.values()) {
                        historyAdapters.push(config);
                    }
                }

                // Sort by type and instance
                historyAdapters.sort((a, b) => {
                    if (a.type !== b.type) return a.type.localeCompare(b.type);
                    return a.instance - b.instance;
                });

                res.json({
                    adapters: historyAdapters,
                    count: historyAdapters.length
                });

            } catch (error) {
                console.error('[ioBroker] Adapters API error:', error.message);
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
        console.error('[ioBroker] Failed to setup API endpoints:', error.message);
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
        this.user = n.user;
        this.password = n.password;
        this.usessl = n.usessl || false;

        const sslInfo = this.usessl ? ' (SSL enabled)' : '';
        const authInfo = this.user ? ' (with authentication)' : '';
        RED.log.debug(`ioBroker config created: ${this.iobhost}:${this.iobport}${sslInfo}${authInfo}`);
    }

    RED.nodes.registerType("iob-config", ioBConfig);
};