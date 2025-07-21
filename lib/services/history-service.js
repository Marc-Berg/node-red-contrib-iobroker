/*!
 * History Service for ioBroker Node-RED Integration
 * Manages historical data requests and response coordination
 */

const eventBus = require('../events/event-bus');
const LoggingService = require('../logging');

class HistoryService {
    constructor() {
        this.logger = LoggingService.getLogger('HistoryService');
        this.messageId = 1;
        this.pendingRequests = new Map();

        eventBus.on('history:get_request', (data) => this.handleHistoryRequest(data));
        eventBus.on('websocket:message', (data) => this.handleWebSocketMessage(data));

        this.logger.info('HistoryService constructed and listeners attached.');
    }

    // Get WebSocket connection from ConnectionService via eventBus
    async getWebSocketConnection(serverId) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Timeout getting WebSocket connection for ${serverId}`));
            }, 1000);

            const requestId = `ws_conn_${Date.now()}_${Math.random()}`;
            
            const onResponse = ({ requestId: responseId, ws, error }) => {
                if (responseId === requestId) {
                    clearTimeout(timeout);
                    eventBus.removeListener('websocket:connection_response', onResponse);
                    
                    if (error) {
                        reject(new Error(error));
                    } else {
                        resolve(ws);
                    }
                }
            };

            eventBus.on('websocket:connection_response', onResponse);
            eventBus.emit('websocket:connection_request', { serverId, requestId });
        });
    }

    async handleHistoryRequest({ serverId, historyAdapter, stateId, options, nodeId, requestId }) {
        try {
            const ws = await this.getWebSocketConnection(serverId);
            if (!ws || ws.readyState !== ws.OPEN) {
                throw new Error(`No active connection for server ${serverId}`);
            }

            // Use incrementing message ID for WebSocket communication
            const msgId = this.messageId++;
            
            // Store the mapping between WebSocket message ID and original request ID
            this.pendingRequests.set(msgId, { 
                serverId, 
                requestId,
                stateId,
                historyAdapter,
                timestamp: Date.now() 
            });

            // Send as WebSocket message array, similar to StateService
            const wsMessage = [3, msgId, "sendTo", [historyAdapter, "getHistory", {
                id: stateId,
                options: {
                    start: options.start,
                    end: options.end,
                    count: options.count,
                    aggregate: options.aggregate,
                    step: options.step,
                    limit: options.limit,
                    from: options.from,
                    ack: options.ack,
                    q: options.q,
                    addId: options.addId,
                    sessionId: options.sessionId
                }
            }]];

            ws.send(JSON.stringify(wsMessage));

        } catch (error) {
            this.logger.error(`[${serverId}] Failed to send history request: ${error.message}`);
            eventBus.emit(`history:get_result:${requestId}`, { 
                error: error.message 
            });
        }
    }

    handleWebSocketMessage({ serverId, data }) {
        let message;
        try {
            // Parse raw WebSocket data to JSON
            message = JSON.parse(data.toString());
        } catch (e) {
            return;
        }

        try {
            // Handle sendTo response in array format: [messageType, messageId, command, result]
            if (Array.isArray(message) && message[0] === 3 && message.length >= 4 && message[2] === 'sendTo') {
                const [messageType, msgId, command, result] = message;
                
                // Check if this is a response to one of our history requests
                const pendingRequest = this.pendingRequests.get(msgId);
                if (pendingRequest) {
                    this.pendingRequests.delete(msgId);
                    
                    // For history requests, result[0] contains the response object: {result: [...], step: 0, error: null}
                    const responseData = result && result[0];
                    if (responseData && responseData.error !== null) {
                        const errorDetail = typeof responseData.error === 'object' ? JSON.stringify(responseData.error) : responseData.error;
                        this.logger.error(`[${serverId}] History request failed: ${errorDetail}`);
                        eventBus.emit(`history:get_result:${pendingRequest.requestId}`, { 
                            error: errorDetail
                        });
                    } else if (responseData) {
                        this.logger.info(`[${serverId}] History request successful for ${pendingRequest.stateId}`);
                        // responseData.result contains the history data array
                        const historyData = responseData.result;
                        eventBus.emit(`history:get_result:${pendingRequest.requestId}`, { 
                            result: historyData
                        });
                    } else {
                        this.logger.error(`[${serverId}] Invalid history response format`);
                        eventBus.emit(`history:get_result:${pendingRequest.requestId}`, { 
                            error: 'Invalid response format'
                        });
                    }
                }
            }
        } catch (error) {
            this.logger.error(`[${serverId}] Error handling WebSocket message for history: ${error.message}`);
        }
    }
}

module.exports = HistoryService;
