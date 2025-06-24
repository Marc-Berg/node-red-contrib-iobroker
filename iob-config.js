const path = require('path');
const express = require('express'); 
const fs = require('fs');

let staticResourcesSetup = false;
let apiEndpointsSetup = false;

function setupStaticResources(RED) {
    if (staticResourcesSetup) return true;
    
    try {
        const sharedPath = path.join(__dirname, 'shared');
        
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
            maxAge: 0, // No caching for TreeView JavaScript
            etag: false,
            lastModified: false,
            setHeaders: (res, filePath) => {
                if (filePath.endsWith('.js')) {
                    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                    res.setHeader('X-Content-Type-Options', 'nosniff');
                    // Aggressive no-cache headers for JavaScript files
                    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                    res.setHeader('Pragma', 'no-cache');
                    res.setHeader('Expires', '0');
                }
            }
        }));
        
        console.log('[ioBroker] Shared TreeView resources available at /iobroker/shared/');
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
        const connectionManager = require('./lib/websocket-manager');
        
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
        
        console.log('[ioBroker] TreeView API endpoints configured');
        apiEndpointsSetup = true;
        return true;
        
    } catch (error) {
        console.error('[ioBroker] Failed to setup API endpoints:', error.message);
        return false;
    }
}

module.exports = function(RED) {
    const staticResult = setupStaticResources(RED);
    const apiResult = setupAPIEndpoints(RED);
    
    if (staticResult && apiResult) {
        console.log('[ioBroker] TreeView components initialized successfully');
    }
    
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