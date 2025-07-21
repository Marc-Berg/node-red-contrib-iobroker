/*!
 * SendTo Service for ioBroker Node-RED Integration
 * Handles adapter communication and command processing
 */

const eventBus = require('../events/event-bus');
const LoggingService = require('../logging');

class SendToService {
    constructor() {
        this.logger = LoggingService.getLogger('SendToService');
        this.pendingRequests = new Map();

        eventBus.on('sendto:send_request', ({ serverId, nodeId, requestId, adapter, command, message, waitForResponse }) => {
            this.handleSendToRequest(serverId, nodeId, requestId, adapter, command, message, waitForResponse);
        });

        eventBus.on('websocket:message', ({ serverId, data }) => {
            this.handleWebSocketMessage(serverId, data);
        });

        this.logger.info('SendToService initialized');
    }

    handleSendToRequest(serverId, nodeId, requestId, adapter, command, message, waitForResponse) {
        this.logger.info(`Processing sendTo request: adapter=${adapter}, command=${command}, waitForResponse=${waitForResponse}`);

        if (waitForResponse) {
            this.pendingRequests.set(requestId, {
                nodeId,
                adapter,
                command,
                timestamp: Date.now()
            });
        }

        const msgId = Date.now();
        const payload = command ? [adapter, command, message] : [adapter, message];
        const wsMessage = [3, msgId, "sendTo", payload];

        if (waitForResponse) {
            this.pendingRequests.set(msgId.toString(), {
                nodeId,
                requestId,
                adapter,
                command,
                timestamp: Date.now()
            });
        }

        eventBus.emit('websocket:send', { 
            serverId, 
            payload: wsMessage 
        });

        this.logger.debug(`SendTo message sent: ${JSON.stringify(wsMessage)}`);
    }

    handleWebSocketMessage(serverId, data) {
        try {
            const messageStr = data.toString();
            let message;

            try {
                message = JSON.parse(messageStr);
            } catch (e) {
                return;
            }

            // Handle sendTo response in array format: [messageType, messageId, command, result]
            if (Array.isArray(message) && message[0] === 3 && message.length >= 4 && message[2] === 'sendTo') {
                const [, msgId, , result] = message;
                const msgIdStr = msgId.toString();
                
                const request = this.pendingRequests.get(msgIdStr);
                if (request) {
                    this.pendingRequests.delete(msgIdStr);
                    
                    const responseTime = Date.now() - request.timestamp;
                    this.logger.debug(`SendTo response received for adapter ${request.adapter} in ${responseTime}ms`);
                    
                    eventBus.emit(`sendto:response:${request.requestId}`, {
                        response: result,
                        responseTime,
                        error: null
                    });

                    eventBus.emit('sendto:response', {
                        nodeId: request.nodeId,
                        requestId: request.requestId,
                        response: result,
                        responseTime,
                        error: null
                    });
                }
            }
        } catch (error) {
            this.logger.error(`Error processing sendTo response: ${error.message}`);
        }
    }

    cleanup() {
        this.logger.info('SendToService cleanup started');
        this.pendingRequests.clear();
        this.logger.info('SendToService cleanup completed');
    }
}

module.exports = SendToService;
