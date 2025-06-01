const axios = require('axios');

module.exports = function(RED) {
    function iobin(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        // Generate UUID only once and store it
        const uuid = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        const globalConfig = RED.nodes.getNode(config.server);
        if (!globalConfig) {
            return setError("No server configuration selected", "No server config");
        }
        
        const { iobhost, iobport, nrhost, nrport, apiMode } = globalConfig;
        if (!iobhost || !iobport) {
            return setError("ioBroker host or port missing", "Host/port missing");
        }
        if (!nrhost || !nrport) {
            return setError("Node-RED host or port missing", "NR host/port missing");
        }

        const stateId = config.state?.trim();
        if (!stateId) {
            return setError("State ID missing", "State ID missing");
        }

        // Configuration with defaults
        const settings = {
            outputType: config.outputType || "value",
            outputProperty: config.outputProperty?.trim() || "payload",
            ackFilter: config.ackFilter || "both",
            apiBase: apiMode === "web" ? "/rest/v1/state" : "/v1/state",
            callbackUrl: `/ioBroker/${node.id}/${uuid}`,
            nodeRedSrv: `${nrhost}:${nrport}`,
            ioBrokerSrv: `${iobhost}:${iobport}`
        };

        // Axios instance with default config and timeout
        const api = axios.create({
            baseURL: `http://${settings.ioBrokerSrv}${settings.apiBase}`,
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });

        // Helper function for error handling
        const setError = (message, statusText) => {
            node.error(message);
            node.status({ fill: "red", shape: "ring", text: statusText });
        };

        const handleCallback = (req, res) => {
            res.sendStatus(200); // Respond immediately
            
            try {
                const { body } = req;
                if (!body?.state || body.state.val === undefined) {
                    return; // Ignore invalid payloads
                }

                const { state, id } = body;
                
                // Filter by acknowledgment status
                if (!shouldSendMessage(state.ack, settings.ackFilter)) {
                    return;
                }

                const msg = createMessage(body, state, id, settings);
                node.send(msg);
                
            } catch (error) {
                node.error(`Callback processing error: ${error.message}`);
            }
        };

        // Helper functions
        const shouldSendMessage = (ack, filter) => {
            switch (filter) {
                case "ack": return ack === true;
                case "noack": return ack === false;
                default: return true; // "both"
            }
        };

        const createMessage = (body, state, id, settings) => ({
            [settings.outputProperty]: settings.outputType === "full" ? body : state.val,
            topic: id,
            state: state,
            timestamp: Date.now() // Add timestamp for debugging
        });

        // Register HTTP endpoint
        RED.httpNode.post(settings.callbackUrl, handleCallback);

        // Subscription management
        const subscriptionData = {
            url: `http://${settings.nodeRedSrv}${settings.callbackUrl}`,
            method: 'POST'
        };

        const subscribe = async () => {
            try {
                node.status({ fill: "yellow", shape: "ring", text: "connecting..." });
                
                await api.post(`/${stateId}/subscribe`, subscriptionData);
                
                node.status({ fill: "green", shape: "dot", text: "connected" });
                node.log(`Successfully subscribed to ${stateId}`);
                
            } catch (error) {
                const errorMsg = error.response?.data?.message || error.message;
                setError(`Subscription failed: ${errorMsg}`, `Sub failed: ${error.code || 'ERROR'}`);
                
                // Retry after delay if it's a connection error
                if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                    setTimeout(() => {
                        node.log("Retrying subscription...");
                        subscribe();
                    }, 5000);
                }
            }
        };

        const unsubscribe = async () => {
            try {
                await api.delete(`/${stateId}/subscribe`, { data: subscriptionData });
                node.log(`Successfully unsubscribed from ${stateId}`);
            } catch (error) {
                // Log but don't throw - cleanup should be graceful
                node.log(`Unsubscribe warning: ${error.message}`);
            }
        };

        // Initialize subscription
        subscribe();

        // Cleanup
        node.on("close", async (done) => {
            node.status({ fill: "yellow", shape: "ring", text: "disconnecting..." });
            
            try {
                await Promise.race([
                    unsubscribe(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
                ]);
            } catch (error) {
                node.log(`Cleanup timeout/error: ${error.message}`);
            } finally {
                node.status({});
                done();
            }
        });

    }
    
    RED.nodes.registerType("iobin", iobin);
};