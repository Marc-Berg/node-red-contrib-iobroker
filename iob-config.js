console.log('*** IOB-CONFIG.JS WIRD GELADEN ***');

const path = require('path');
const express = require('express'); 
const fs = require('fs');

let staticResourcesSetup = false;
let apiEndpointsSetup = false;

function setupStaticResources(RED) {
    console.log('*** SETUP STATIC RESOURCES AUFGERUFEN ***');
    
    if (staticResourcesSetup) {
        console.log('*** BEREITS SETUP - ÜBERSPRINGE ***');
        return true;
    }
    
    try {
        const sharedPath = path.join(__dirname, 'shared');
        console.log('*** __dirname:', __dirname);
        console.log('*** sharedPath:', sharedPath);
        console.log('*** sharedPath exists:', fs.existsSync(sharedPath));
        
        if (fs.existsSync(sharedPath)) {
            const files = fs.readdirSync(sharedPath);
            console.log('*** Files in shared:', files);
        }
        
        if (!fs.existsSync(sharedPath)) {
            console.warn('*** SHARED DIRECTORY NOT FOUND ***');
            return false;
        }
        
        const treeViewPath = path.join(sharedPath, 'iobroker-treeview.js');
        console.log('*** treeViewPath:', treeViewPath);
        console.log('*** treeViewPath exists:', fs.existsSync(treeViewPath));
        
        if (!fs.existsSync(treeViewPath)) {
            console.warn('*** TREEVIEW FILE NOT FOUND ***');
            return false;
        }
        
        console.log('*** SETTING UP EXPRESS ROUTE ***');
        RED.httpAdmin.use('/iobroker/shared', express.static(sharedPath, {
            maxAge: '0',
            etag: false,
            lastModified: false
        }));
        
        console.log('*** EXPRESS ROUTE SETUP COMPLETE ***');
        staticResourcesSetup = true;
        return true;
        
    } catch (error) {
        console.error('*** SETUP ERROR:', error);
        return false;
    }
}

function setupAPIEndpoints(RED) {
    console.log('*** SETUP API ENDPOINTS AUFGERUFEN ***');
    
    if (apiEndpointsSetup) {
        console.log('*** API BEREITS SETUP - ÜBERSPRINGE ***');
        return true;
    }
    
    try {
        const connectionManager = require('./lib/websocket-manager');
        console.log('*** CONNECTION MANAGER LOADED ***');
        
        // States endpoint for TreeView component
        RED.httpAdmin.get('/iobroker/ws/states/:serverId', async (req, res) => {
            console.log('*** STATES API CALLED:', req.params.serverId);
            
            try {
                const serverId = decodeURIComponent(req.params.serverId);
                console.log('*** DECODED SERVER ID:', serverId);
                
                // Skip server config validation for now - use connection manager directly
                console.log('*** GETTING STATES FROM CONNECTION MANAGER ***');
                const states = await connectionManager.getStates(serverId);
                console.log('*** STATES COUNT:', Object.keys(states).length);
                
                res.setHeader('Cache-Control', 'public, max-age=300');
                res.json(states);
                
            } catch (error) {
                console.error('*** STATES API ERROR:', error.message);
                res.status(500).json({ 
                    error: 'Failed to retrieve states',
                    details: error.message,
                    stack: error.stack
                });
            }
        });
        
        // Connection status endpoint
        RED.httpAdmin.get('/iobroker/ws/status/:serverId', (req, res) => {
            console.log('*** STATUS API CALLED:', req.params.serverId);
            
            try {
                const serverId = decodeURIComponent(req.params.serverId);
                const status = connectionManager.getConnectionStatus(serverId);
                
                console.log('*** STATUS RESULT:', status.connected);
                
                res.json({
                    ...status,
                    requestTime: Date.now()
                });
                
            } catch (error) {
                console.error('*** STATUS API ERROR:', error.message);
                res.status(500).json({ 
                    error: 'Failed to get connection status',
                    details: error.message,
                    stack: error.stack
                });
            }
        });
        
        console.log('*** API ENDPOINTS SETUP COMPLETE ***');
        apiEndpointsSetup = true;
        return true;
        
    } catch (error) {
        console.error('*** API SETUP ERROR:', error);
        return false;
    }
}

module.exports = function(RED) {
    console.log('*** IOB-CONFIG MODULE FUNCTION AUFGERUFEN ***');
    console.log('*** RED httpAdmin verfügbar:', !!RED.httpAdmin);
    
    // Setup static resources first
    const staticResult = setupStaticResources(RED);
    console.log('*** STATIC SETUP RESULT:', staticResult);
    
    // Setup API endpoints
    const apiResult = setupAPIEndpoints(RED);
    console.log('*** API SETUP RESULT:', apiResult);
    
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
    console.log('*** IOB-CONFIG REGISTERED ***');
};