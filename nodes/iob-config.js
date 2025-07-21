const path = require('path');
const express = require('express');
const fs = require('fs');
const { Logger } = require('../lib/utils/logger');
const Orchestrator = require('../lib/orchestrator');
const eventBus = require('../lib/events/event-bus');

let staticResourcesSetup = false;
let apiEndpointsSetup = false;

function setupStaticResources(RED) {
    Logger.setRED(RED);

    if (staticResourcesSetup) return true;

    // Initialize the Orchestrator once when the config node is loaded
    Orchestrator.init(RED);

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
        // API endpoint that uses the Event-based architecture for states
        RED.httpAdmin.get('/iobroker/ws/states/:serverId', async (req, res) => {
            try {
                const serverParam = decodeURIComponent(req.params.serverId);
                
                // Try to find server by host:port if it's not a direct server ID
                let serverId = serverParam;
                if (serverParam.includes(':')) {
                    const foundServerId = Orchestrator.findServerByHostPort(serverParam);
                    if (foundServerId) {
                        serverId = foundServerId;
                    }
                }
                
                // Get states via the new Event-based architecture
                const states = await getStatesViaEventArchitecture(serverId);
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
        
        // Helper function to get states via Event-based architecture
        async function getStatesViaEventArchitecture(serverId) {
            return new Promise((resolve, reject) => {
                // Check if the server is connected via our new architecture
                if (!Orchestrator.servers || !Orchestrator.servers.has(serverId)) {
                    reject(new Error(`Server ${serverId} not found in Event-based architecture. Available servers: ${Array.from(Orchestrator.servers.keys()).join(', ')}`));
                    return;
                }
                
                const server = Orchestrator.servers.get(serverId);
                if (!server || !server.ready) {
                    reject(new Error('Server not ready in Event-based architecture'));
                    return;
                }
                
                // Send a request for all states via the WebSocket connection
                const requestId = `states_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                const timeout = setTimeout(() => {
                    reject(new Error('Timeout waiting for states response'));
                }, 10000);
                
                // Listen for the response
                const responseHandler = ({ serverId: responseServerId, requestId: responseRequestId, states, error }) => {
                    if (responseServerId === serverId && responseRequestId === requestId) {
                        clearTimeout(timeout);
                        eventBus.removeListener('api:states_response', responseHandler);
                        
                        if (error) {
                            reject(new Error(error));
                        } else {
                            resolve(states);
                        }
                    }
                };
                
                eventBus.on('api:states_response', responseHandler);
                
                // Send the request via WebSocket
                eventBus.emit('websocket:send', { 
                    serverId, 
                    payload: [3, requestId, "getStates", []] 
                });
            });
        }

        RED.httpAdmin.get('/iobroker/ws/status/:serverId', (req, res) => {
            try {
                const serverParam = decodeURIComponent(req.params.serverId);
                
                // Try to find server by host:port if it's not a direct server ID
                let serverId = serverParam;
                if (serverParam.includes(':')) {
                    const foundServerId = Orchestrator.findServerByHostPort(serverParam);
                    if (foundServerId) {
                        serverId = foundServerId;
                    }
                }
                
                const status = Orchestrator.getConnectionStatus(serverId);

                res.json({
                    ...status,
                    requestedServer: serverParam,
                    resolvedServerId: serverId,
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
                const serverParam = decodeURIComponent(req.params.serverId);
                
                // Try to find server by host:port if it's not a direct server ID
                let serverId = serverParam;
                if (serverParam.includes(':')) {
                    const foundServerId = Orchestrator.findServerByHostPort(serverParam);
                    if (foundServerId) {
                        serverId = foundServerId;
                    } else {
                        throw new Error(`No server found for ${serverParam}. Available servers: ${Array.from(Orchestrator.servers.keys()).join(', ')}`);
                    }
                }
                
                // Check if server exists and is ready
                const status = Orchestrator.getConnectionStatus(serverId);
                if (!status.ready) {
                    throw new Error(`Server ${serverId} (${serverParam}) is not ready. Status: connected=${status.connected}, ready=${status.ready}. Available servers: ${status.availableServers?.join(', ') || 'none'}`);
                }
                
                const states = await Orchestrator.getStates(serverId);
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
        this.user = this.credentials.user;
        this.password = this.credentials.password;
        this.usessl = n.usessl || false;

        const sslInfo = this.usessl ? ' (SSL enabled)' : '';
        const authInfo = this.user ? ' (with authentication)' : '';
        RED.log.debug(`ioBroker config created: ${this.iobhost}:${this.iobport}${sslInfo}${authInfo}`);
    }

    RED.nodes.registerType("iob-config", ioBConfig, {
        credentials: {
            user: { type: "text" },
            password: { type: "password" }
        }
    });
};