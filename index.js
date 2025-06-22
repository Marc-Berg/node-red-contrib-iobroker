// ioBroker WebSocket Nodes for Node-RED
// Main entry point with shared TreeView support

module.exports = function(RED) {
    const path = require('path');
    const express = require('express');
    const fs = require('fs');
    
    // Module info
    let packageInfo;
    try {
        packageInfo = require('./package.json');
        console.log(`[ioBroker] Loading ${packageInfo.name} v${packageInfo.version}`);
    } catch (error) {
        packageInfo = { name: 'node-red-contrib-iobroker-ws', version: '2.0.0' };
        console.log(`[ioBroker] Loading module (package info not available)`);
    }
    
    // Setup static file serving for shared resources
    function setupStaticResources() {
        try {
            const sharedPath = path.join(__dirname, 'shared');
            
            // Check if shared directory exists
            if (!fs.existsSync(sharedPath)) {
                console.warn('[ioBroker] Shared directory not found:', sharedPath);
                console.warn('[ioBroker] TreeView components will not be available');
                return false;
            }
            
            // Verify TreeView component exists
            const treeViewPath = path.join(sharedPath, 'iobroker-treeview.js');
            if (!fs.existsSync(treeViewPath)) {
                console.warn('[ioBroker] TreeView component not found:', treeViewPath);
                console.warn('[ioBroker] Manual input mode will be used for all nodes');
                return false;
            }
            
            // Serve shared resources under /iobroker/shared/
            RED.httpAdmin.use('/iobroker/shared', express.static(sharedPath, {
                maxAge: process.env.NODE_ENV === 'production' ? '1h' : '0', // Cache in production only
                etag: true,
                lastModified: true,
                setHeaders: (res, filePath) => {
                    // Security headers for JavaScript files
                    if (filePath.endsWith('.js')) {
                        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                        res.setHeader('X-Content-Type-Options', 'nosniff');
                        res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour cache
                    }
                }
            }));
            
            console.log('[ioBroker] Shared TreeView resources available at /iobroker/shared/');
            
            // Version endpoint for cache busting
            RED.httpAdmin.get('/iobroker/shared/version', (req, res) => {
                try {
                    res.json({ 
                        moduleVersion: packageInfo.version,
                        treeviewVersion: '1.0.0',
                        timestamp: Date.now(),
                        nodeVersion: process.version,
                        environment: process.env.NODE_ENV || 'development'
                    });
                } catch (error) {
                    res.status(500).json({ 
                        error: 'Version info not available',
                        details: error.message 
                    });
                }
            });
            
            // Health check endpoint
            RED.httpAdmin.get('/iobroker/shared/health', (req, res) => {
                const treeViewExists = fs.existsSync(treeViewPath);
                const stats = treeViewExists ? fs.statSync(treeViewPath) : null;
                
                res.json({
                    status: treeViewExists ? 'ok' : 'error',
                    treeviewExists: treeViewExists,
                    treeviewSize: stats ? stats.size : 0,
                    treeviewModified: stats ? stats.mtime : null,
                    sharedPath: sharedPath,
                    uptime: process.uptime()
                });
            });
            
            return true;
            
        } catch (error) {
            console.error('[ioBroker] Failed to setup static resources:', error.message);
            return false;
        }
    }
    
    // Setup WebSocket states endpoint for TreeView data (using existing API)
    function setupAPIEndpoints() {
        const connectionManager = require('./lib/websocket-manager');
        
        // States endpoint for TreeView component (adapted to use existing connectionManager)
        RED.httpAdmin.get('/iobroker/ws/states/:serverId', async (req, res) => {
            try {
                const serverId = decodeURIComponent(req.params.serverId);
                const [host, port] = serverId.split(':');
                
                if (!host || !port) {
                    return res.status(400).json({ 
                        error: 'Invalid server ID format. Expected: host:port',
                        received: serverId
                    });
                }
                
                // Get server configuration from Node-RED registry
                let serverConfig = null;
                RED.nodes.eachConfig(config => {
                    if (config.type === 'iob-config' && 
                        config.iobhost === host && 
                        parseInt(config.iobport) === parseInt(port)) {
                        serverConfig = config;
                    }
                });
                
                if (!serverConfig) {
                    return res.status(404).json({ 
                        error: 'Server configuration not found',
                        serverId: serverId,
                        availableServers: getAvailableServers()
                    });
                }
                
                // Get states from WebSocket manager using existing API
                const states = await connectionManager.getStates(serverId);
                
                // Add response headers
                res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes cache
                res.setHeader('ETag', `"states-${Date.now()}"`);
                res.setHeader('X-States-Count', Object.keys(states).length);
                
                res.json(states);
                
            } catch (error) {
                console.error('[ioBroker] States endpoint error:', error.message);
                res.status(500).json({ 
                    error: 'Failed to retrieve states',
                    details: error.message,
                    serverId: req.params.serverId
                });
            }
        });
        
        // Connection status endpoint using existing API
        RED.httpAdmin.get('/iobroker/ws/status/:serverId', (req, res) => {
            try {
                const serverId = decodeURIComponent(req.params.serverId);
                const connectionManager = require('./lib/websocket-manager');
                const status = connectionManager.getConnectionStatus(serverId);
                
                res.json({
                    ...status,
                    requestTime: Date.now(),
                    moduleVersion: packageInfo.version
                });
                
            } catch (error) {
                console.error('[ioBroker] Status endpoint error:', error.message);
                res.status(500).json({ 
                    error: 'Failed to get connection status',
                    details: error.message,
                    serverId: req.params.serverId
                });
            }
        });
        
        // Debug endpoint for development
        if (process.env.NODE_ENV !== 'production') {
            RED.httpAdmin.get('/iobroker/debug/info', (req, res) => {
                res.json({
                    package: packageInfo,
                    nodeVersion: process.version,
                    platform: process.platform,
                    arch: process.arch,
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                    environment: process.env.NODE_ENV || 'development',
                    availableServers: getAvailableServers(),
                    staticResourcesActive: fs.existsSync(path.join(__dirname, 'shared', 'iobroker-treeview.js'))
                });
            });
        }
        
        console.log('[ioBroker] API endpoints configured');
    }
    
    // Helper function to get available server configurations
    function getAvailableServers() {
        const servers = [];
        RED.nodes.eachConfig(config => {
            if (config.type === 'iob-config') {
                servers.push({
                    id: config.id,
                    name: config.name,
                    host: config.iobhost,
                    port: config.iobport,
                    ssl: config.usessl,
                    hasAuth: !!(config.user && config.user.trim())
                });
            }
        });
        return servers;
    }
    
    // Initialize everything
    console.log('[ioBroker] Initializing module...');
    
    // Setup static resources (TreeView component)
    const staticResourcesOK = setupStaticResources();
    
    // Setup API endpoints for WebSocket communication
    setupAPIEndpoints();
    
    // Register all node types
    try {
        RED.nodes.registerType("iob-config", require("./iob-config"));
        RED.nodes.registerType("iobget", require("./iob-get"));
        RED.nodes.registerType("iobgetobject", require("./iob-getobject"));
        RED.nodes.registerType("iobin", require("./iob-in"));
        RED.nodes.registerType("iobout", require("./iob-out"));
        
        console.log('[ioBroker] All node types registered successfully');
        
    } catch (error) {
        console.error('[ioBroker] Failed to register node types:', error.message);
        throw error;
    }
    
    // Log final status
    const featuresStatus = {
        sharedTreeView: staticResourcesOK,
        sslSupport: true,
        wildcardSupport: true,
        tokenRefresh: true,
        apiEndpoints: true
    };
    
    console.log('[ioBroker] Module initialization complete');
    console.log('[ioBroker] Features:', JSON.stringify(featuresStatus, null, 2));
    
    if (!staticResourcesOK) {
        console.warn('[ioBroker] TreeView components not available - nodes will use manual input only');
    }
    
    // Graceful shutdown handler
    process.on('SIGTERM', () => {
        console.log('[ioBroker] Received SIGTERM, performing graceful shutdown...');
        try {
            const connectionManager = require('./lib/websocket-manager');
            connectionManager.cleanup().finally(() => {
                console.log('[ioBroker] Cleanup completed');
            });
        } catch (error) {
            console.log('[ioBroker] Cleanup error:', error.message);
        }
    });
};