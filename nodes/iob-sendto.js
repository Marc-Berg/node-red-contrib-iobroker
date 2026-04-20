const connectionManager = require('../lib/manager/websocket-manager');
const zlib = require('zlib');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function(RED) {
    function normalizeLogsResponse(response) {
        if (!Array.isArray(response)) {
            return response;
        }

        const lastEntry = response[response.length - 1];
        const hasSizeEntry = typeof lastEntry === 'number' ||
            (typeof lastEntry === 'string' && /^\d+$/.test(lastEntry));

        const lines = (hasSizeEntry ? response.slice(0, -1) : response)
            .filter(line => typeof line === 'string' && line.length > 0);

        return {
            lines,
            size: hasSizeEntry ? Number(lastEntry) : 0
        };
    }

    function normalizeLogFileResponse(response) {
        if (!response || typeof response !== 'object' || Array.isArray(response)) {
            return response;
        }

        const normalized = {
            ...response,
            text: null
        };
        let buffer = null;

        if (Buffer.isBuffer(response.data)) {
            buffer = response.data;
            normalized.text = response.gz ? null : response.data.toString('utf8');
        } else if (response.data && response.data.type === 'Buffer' && Array.isArray(response.data.data)) {
            buffer = Buffer.from(response.data.data);
            normalized.text = response.gz ? null : buffer.toString('utf8');
        } else if (typeof response.data === 'string') {
            normalized.text = response.gz ? null : response.data;
        }

        if (response.gz && buffer) {
            try {
                normalized.text = zlib.gunzipSync(buffer).toString('utf8');
            } catch (error) {
                normalized.decompressionError = error.message;
            }
        }

        return normalized;
    }

    function normalizeLogFilesResponse(response) {
        if (!response || typeof response !== 'object' || Array.isArray(response) || !Array.isArray(response.list)) {
            return response;
        }

        const files = response.list
            .map(entry => {
                const fullName = entry && typeof entry.fileName === 'string' ? entry.fileName : '';
                const parts = fullName.split('/').filter(Boolean);
                const name = parts[parts.length - 1] || fullName;
                const transport = parts.length >= 2 ? parts[parts.length - 2] : null;
                const host = parts.length >= 3 ? parts[parts.length - 3] : null;

                return {
                    path: fullName,
                    name,
                    host,
                    transport,
                    request: {
                        transport,
                        filename: name
                    },
                    size: typeof entry?.size === 'number' ? entry.size : Number(entry?.size || 0),
                    gz: name.endsWith('.gz'),
                    current: name === 'current'
                };
            })
            .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: 'base' }));

        return {
            files,
            count: files.length
        };
    }

    function normalizeResponse(command, response) {
        switch ((command || '').trim()) {
            case 'getLogs':
                return normalizeLogsResponse(response);
            case 'getLogFiles':
                return normalizeLogFilesResponse(response);
            case 'getLogFile':
                return normalizeLogFileResponse(response);
            default:
                return response;
        }
    }

    function extractTransportsFromLogFilesResponse(response) {
        if (!response || typeof response !== 'object' || !Array.isArray(response.list)) {
            return [];
        }

        return [...new Set(
            response.list
                .map(entry => {
                    const fullName = entry && typeof entry.fileName === 'string' ? entry.fileName : '';
                    const parts = fullName.split('/').filter(Boolean);
                    return parts.length >= 2 ? parts[parts.length - 2] : null;
                })
                .filter(Boolean)
        )];
    }

    function findMatchingLogFile(response, requestedFilename) {
        if (!response || typeof response !== 'object' || !Array.isArray(response.list) || !requestedFilename) {
            return null;
        }

        const normalize = value => String(value || '').trim().toLowerCase();
        const normalizeDisplayName = value => normalize(value)
            .replace(/\.current\.log$/i, 'current')
            .replace(/\.log$/i, '')
            .replace(/^[^.]+\./, '');

        const requested = normalize(requestedFilename);
        const requestedDisplay = normalizeDisplayName(requestedFilename);
        const candidates = response.list
            .map(entry => {
                const fullName = entry && typeof entry.fileName === 'string' ? entry.fileName : '';
                const actualName = fullName.split('/').filter(Boolean).pop() || '';
                return {
                    fullName,
                    actualName,
                    normalizedActual: normalize(actualName),
                    normalizedDisplay: normalizeDisplayName(actualName)
                };
            });

        return candidates.find(candidate =>
            candidate.normalizedActual === requested ||
            candidate.normalizedDisplay === requested ||
            candidate.normalizedActual === requestedDisplay ||
            candidate.normalizedDisplay === requestedDisplay
        ) || null;
    }

    async function resolveLogFileMessage(connectionManager, serverId, host, messageContent, timeout) {
        if (!host || !messageContent || typeof messageContent !== 'object' || Array.isArray(messageContent)) {
            return messageContent;
        }

        const resolvedMessage = { ...messageContent };

        if (typeof resolvedMessage.filename === 'string' && resolvedMessage.filename.includes('/')) {
            const parts = resolvedMessage.filename.split('/').filter(Boolean);
            const inferredTransport = parts.length >= 2 ? parts[parts.length - 2] : null;
            resolvedMessage.filename = parts[parts.length - 1] || resolvedMessage.filename;
            if (!resolvedMessage.transport && inferredTransport) {
                resolvedMessage.transport = inferredTransport;
            }
        }

        if (resolvedMessage.transport && resolvedMessage.transport !== 'file') {
            return resolvedMessage;
        }

        const logFilesResponse = await connectionManager.sendToHost(
            serverId,
            host,
            'getLogFiles',
            {},
            timeout
        );

        const transports = extractTransportsFromLogFilesResponse(logFilesResponse);
        if (transports.length === 1) {
            resolvedMessage.transport = transports[0];
        }

        if (typeof resolvedMessage.filename === 'string') {
            const matchedFile = findMatchingLogFile(logFilesResponse, resolvedMessage.filename);
            if (matchedFile) {
                resolvedMessage.filename = matchedFile.actualName;
            }
        }

        return resolvedMessage;
    }

    function iobsendto(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

        const settings = {
            adapter: config.adapter?.trim() || "",
            command: config.command?.trim() || "",
            message: config.message?.trim() || "",
            waitForResponse: config.waitForResponse || false,
            responseTimeout: parseInt(config.responseTimeout) || 10000,
            serverId,
            nodeId: node.id
        };

        node.currentConfig = connectionDetails;
        node.isInitialized = false;

        let staticMessageParsed = null;
        if (settings.message) {
            try {
                staticMessageParsed = JSON.parse(settings.message);
            } catch (error) {
                return setError(`Invalid JSON in static message: ${error.message}`, "JSON error");
            }
        }

        const statusTexts = {
            ready: settings.waitForResponse ? "Ready (with response)" : "Ready (fire-and-forget)",
            reconnected: settings.waitForResponse ? "Reconnected (with response)" : "Reconnected (fire-and-forget)"
        };

        NodeHelpers.initializeConnection(
            node, config, RED, settings, globalConfig, setStatus, statusTexts
        );

        node.on('input', async function(msg, send, done) {
            try {
                
                if (NodeHelpers.handleStatusRequest(msg, send, done, settings)) {
                    return;
                }

                const host = typeof msg.host === 'string' ? msg.host.trim() : '';
                const instance = msg.instance || settings.adapter;
                if (!host && (!instance || !instance.trim())) {
                    setStatus("red", "ring", "Instance missing");
                    const error = new Error("Target instance missing (neither configured nor in msg.instance)");
                    done && done(error);
                    return;
                }

                const trimmedInstance = instance ? instance.trim() : null;
                const command = msg.command !== undefined ? msg.command : settings.command;
                const trimmedCommand = command ? command.trim() : null;
                const timeout = msg.timeout || settings.responseTimeout;
                let messageContent = msg.message !== undefined ? msg.message : 
                                     (staticMessageParsed !== null ? staticMessageParsed : msg.payload);

                if (host && trimmedCommand === 'getLogFile') {
                    messageContent = await resolveLogFileMessage(
                        connectionManager,
                        settings.serverId,
                        host,
                        messageContent,
                        timeout
                    );
                }

                if (messageContent === undefined) {
                    setStatus("red", "ring", "Message missing");
                    const error = new Error("Message content missing (no payload, static message, or msg.message)");
                    done && done(error);
                    return;
                }
                const targetLabel = host || trimmedInstance;
                setStatus("blue", "dot", `Sending to ${targetLabel}...`);
                const startTime = Date.now();

                function setReadyStatus() {
                    const readyText = statusTexts.ready;
                    setStatus("green", "dot", readyText);
                }

                try {
                    if (settings.waitForResponse) {
                        const response = host
                            ? await connectionManager.sendToHost(
                                settings.serverId,
                                host,
                                trimmedCommand,
                                messageContent,
                                timeout
                            )
                            : await connectionManager.sendToAdapter(
                                settings.serverId,
                                trimmedInstance,
                                trimmedCommand,
                                messageContent,
                                timeout
                            );
                        const normalizedResponse = normalizeResponse(trimmedCommand, response);

                        const responseTime = Date.now() - startTime;
                        
                        const responseMsg = {
                            payload: normalizedResponse,
                            host: host || undefined,
                            instance: trimmedInstance,
                            command: trimmedCommand,
                            originalMessage: messageContent,
                            responseTime: responseTime,
                            timestamp: Date.now()
                        };

                        setReadyStatus();
                        send(responseMsg);
                        done && done();
                    } else {
                        if (host) {
                            await connectionManager.sendToHost(
                                settings.serverId,
                                host,
                                trimmedCommand,
                                messageContent,
                                null
                            );
                        } else {
                            await connectionManager.sendToAdapter(
                                settings.serverId,
                                trimmedInstance,
                                trimmedCommand,
                                messageContent,
                                null
                            );
                        }

                        setReadyStatus();                     
                        done && done();
                    }
                    
                } catch (sendError) {
                    setStatus("red", "ring", "SendTo failed");
                    node.error(`SendTo failed for ${targetLabel}: ${sendError.message}`);
                    done && done(sendError);
                }
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Error processing input: ${error.message}`);
                done && done(error);
            }
        });

        node.on("close", async function(removed, done) {
            await NodeHelpers.handleNodeClose(node, settings, "SendTo");
            done();
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));
    }

    RED.nodes.registerType("iobsendto", iobsendto);
};