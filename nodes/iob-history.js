const connectionManager = require('./lib/manager/websocket-manager');

module.exports = function (RED) {
    function iobhistory(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Get server configuration
        const globalConfig = RED.nodes.getNode(config.server);
        if (!globalConfig) {
            return setError("No server configuration selected", "No server config");
        }

        const { iobhost, iobport, user, password, usessl } = globalConfig;
        if (!iobhost || !iobport) {
            return setError("ioBroker host or port missing", "Host/port missing");
        }

        // Configuration with defaults
        const settings = {
            stateId: config.stateId?.trim() || "",
            historyAdapter: config.historyAdapter || "history.0",
            timeRange: config.timeRange || "duration",
            duration: parseInt(config.duration) || 24,
            durationUnit: config.durationUnit || "hours",
            startTime: config.startTime || "",
            endTime: config.endTime || "",
            aggregate: config.aggregate || "onchange",
            step: parseInt(config.step) || 300,
            stepUnit: config.stepUnit || "seconds",
            maxEntries: parseInt(config.maxEntries) || 2000,
            outputProperty: config.outputProperty?.trim() || "payload",
            outputFormat: config.outputFormat || "array",
            percentile: parseFloat(config.percentile) || 50,
            quantile: parseFloat(config.quantile) || 0.5,
            integralUnit: parseInt(config.integralUnit) || 3600,
            serverId: connectionManager.getServerId(globalConfig),
            nodeId: node.id
        };

        node.currentConfig = { iobhost, iobport, user, password, usessl };
        node.isInitialized = false;

        // Log configuration
        node.log(`History node configured: ${settings.stateId || 'from msg.topic'} via ${settings.historyAdapter}`);

        // Helper functions
        function setError(message, statusText) {
            node.error(message);
            setStatus("red", "ring", statusText);
        }

        function setStatus(fill, shape, text) {
            try {
                node.status({ fill, shape, text });
            } catch (error) {
                node.warn(`Status update error: ${error.message}`);
            }
        }

        function parseTimeInput(timeInput) {
            if (!timeInput) return null;

            // If it's already a number (timestamp), return it
            if (typeof timeInput === 'number') {
                return timeInput > 10000000000 ? timeInput : timeInput * 1000; // Convert seconds to ms if needed
            }

            // If it's a string, try to parse it
            if (typeof timeInput === 'string') {
                const parsed = new Date(timeInput).getTime();
                return isNaN(parsed) ? null : parsed;
            }

            return null;
        }

        function calculateTimeRange(msg) {
            const now = Date.now();
            let start, end;

            switch (settings.timeRange) {
                case 'duration':
                    const durationMs = convertDurationToMs(settings.duration, settings.durationUnit);
                    start = now - durationMs;
                    end = now;
                    break;

                case 'absolute':
                    start = parseTimeInput(settings.startTime);
                    end = parseTimeInput(settings.endTime);
                    if (!start || !end) {
                        throw new Error('Invalid absolute start or end time');
                    }
                    break;

                case 'message':
                    start = parseTimeInput(msg.start);
                    end = parseTimeInput(msg.end);

                    if (!start) {
                        throw new Error('msg.start is required for message time range mode');
                    }

                    if (!end && msg.duration) {
                        const durationMs = convertDurationToMs(parseFloat(msg.duration), 'hours');
                        end = start + durationMs;
                    }

                    if (!end) {
                        end = now;
                    }
                    break;

                default:
                    throw new Error(`Invalid time range mode: ${settings.timeRange}`);
            }

            if (start >= end) {
                throw new Error('Start time must be before end time');
            }

            return { start, end };
        }

        function convertDurationToMs(duration, unit) {
            const multipliers = {
                'seconds': 1000,
                'minutes': 60 * 1000,
                'hours': 60 * 60 * 1000,
                'days': 24 * 60 * 60 * 1000,
                'weeks': 7 * 24 * 60 * 60 * 1000
            };
            return duration * (multipliers[unit] || multipliers.hours);
        }

        function convertStepToMs(step, unit) {
            const multipliers = {
                'seconds': 1000,
                'minutes': 60 * 1000,
                'hours': 60 * 60 * 1000
            };
            return step * (multipliers[unit] || multipliers.seconds);
        }

        function buildQueryOptions(msg, timeRange) {
            const aggregate = msg.aggregate || settings.aggregate;
            const stepMs = convertStepToMs(msg.step || settings.step, msg.stepUnit || settings.stepUnit);
            const maxEntries = msg.maxEntries || settings.maxEntries;

            const options = {
                start: timeRange.start,
                end: timeRange.end,
                aggregate: aggregate,
                count: maxEntries,
                addId: true,
                removeBorderValues: false
            };

            // Add step for aggregation methods that need it
            const needsStep = ['average', 'min', 'max', 'total', 'count', 'percentile', 'quantile', 'integral'];
            if (needsStep.includes(aggregate)) {
                options.step = stepMs;
            }

            // Add special parameters
            if (aggregate === 'percentile') {
                options.percentile = msg.percentile || settings.percentile;
            } else if (aggregate === 'quantile') {
                options.quantile = msg.quantile || settings.quantile;
            } else if (aggregate === 'integral') {
                options.integralUnit = msg.integralUnit || settings.integralUnit;
            }

            return options;
        }

        function formatForChart(data, stateId) {
            const labels = [];
            const values = [];

            data.forEach(point => {
                if (point.ts && point.val !== undefined) {
                    labels.push(new Date(point.ts).toLocaleString());
                    values.push(point.val);
                }
            });

            return {
                labels: labels,
                datasets: [{
                    label: stateId,
                    data: values,
                    borderColor: "rgb(75, 192, 192)",
                    backgroundColor: "rgba(75, 192, 192, 0.2)",
                    tension: 0.1
                }]
            };
        }

        function formatForDashboard2(data, stateId) {
            const chartData = [];

            data.forEach(point => {
                if (point.ts && point.val !== undefined) {
                    chartData.push({
                        x: point.ts,
                        y: point.val
                    });
                }
            });

            return chartData;
        }

        function formatStatistics(data, queryOptions) {
            if (!data || data.length === 0) {
                return {
                    count: 0,
                    min: null,
                    max: null,
                    avg: null,
                    first: null,
                    last: null,
                    timeRange: { start: queryOptions.start, end: queryOptions.end }
                };
            }

            let min = null, max = null, sum = 0, count = 0;

            data.forEach(point => {
                if (point.val !== null && point.val !== undefined && typeof point.val === 'number') {
                    if (min === null || point.val < min.val) min = point;
                    if (max === null || point.val > max.val) max = point;
                    sum += point.val;
                    count++;
                }
            });

            return {
                count: data.length,
                numericCount: count,
                min: min,
                max: max,
                avg: count > 0 ? sum / count : null,
                sum: sum,
                first: data[0],
                last: data[data.length - 1],
                timeRange: { start: queryOptions.start, end: queryOptions.end }
            };
        }

        function formatOutput(data, stateId, queryOptions, queryTime, format) {
            if (!data || !Array.isArray(data)) {
                return {
                    [settings.outputProperty]: null,
                    stateId: stateId,
                    adapter: settings.historyAdapter,
                    queryOptions: queryOptions,
                    queryTime: queryTime,
                    count: 0,
                    error: "No data received"
                };
            }

            let output;
            switch (format) {
                case 'chart':
                    output = formatForChart(data, stateId);
                    break;
                case 'dashboard2':
                    output = formatForDashboard2(data, stateId);
                    break;
                case 'statistics':
                    output = formatStatistics(data, queryOptions);
                    break;
                case 'array':
                default:
                    output = data;
                    break;
            }

            return {
                [settings.outputProperty]: output,
                stateId: stateId,
                adapter: settings.historyAdapter,
                queryOptions: queryOptions,
                queryTime: queryTime,
                count: data.length,
                timestamp: Date.now()
            };
        }

        // Create callback for event notifications
        function createEventCallback() {
            const callback = function () { };

            callback.updateStatus = function (status) {
                switch (status) {
                    case 'ready':
                        setStatus("green", "dot", "Ready");
                        node.isInitialized = true;
                        break;
                    case 'connecting':
                        setStatus("yellow", "ring", "Connecting...");
                        break;
                    case 'disconnected':
                        setStatus("red", "ring", "Disconnected");
                        node.isInitialized = false;
                        break;
                    case 'retrying':
                        setStatus("yellow", "ring", "Retrying...");
                        break;
                    case 'failed_permanently':
                        setStatus("red", "ring", "Auth failed");
                        break;
                    default:
                        setStatus("grey", "ring", status);
                }
            };

            callback.onReconnect = function () {
                node.log("Reconnection detected by history node");
                setStatus("green", "dot", "Reconnected");
                node.isInitialized = true;
            };

            callback.onDisconnect = function () {
                node.log("Disconnection detected by history node");
                setStatus("red", "ring", "Disconnected");
            };

            return callback;
        }

        // Check if configuration has changed
        function hasConfigChanged() {
            const currentGlobalConfig = RED.nodes.getNode(config.server);
            if (!currentGlobalConfig) return false;

            return (
                node.currentConfig.iobhost !== currentGlobalConfig.iobhost ||
                node.currentConfig.iobport !== currentGlobalConfig.iobport ||
                node.currentConfig.user !== currentGlobalConfig.user ||
                node.currentConfig.password !== currentGlobalConfig.password ||
                node.currentConfig.usessl !== currentGlobalConfig.usessl
            );
        }

        // Initialize connection
        async function initializeConnection() {
            try {
                setStatus("yellow", "ring", "Connecting...");

                if (hasConfigChanged()) {
                    const newGlobalConfig = RED.nodes.getNode(config.server);
                    const oldServerId = settings.serverId;

                    node.currentConfig = {
                        iobhost: newGlobalConfig.iobhost,
                        iobport: newGlobalConfig.iobport,
                        user: newGlobalConfig.user,
                        password: newGlobalConfig.password,
                        usessl: newGlobalConfig.usessl
                    };

                    const newServerId = connectionManager.getServerId(newGlobalConfig);
                    settings.serverId = newServerId;

                    if (oldServerId !== newServerId) {
                        node.log(`Server changed from ${oldServerId} to ${newServerId}, forcing connection reset`);
                        await connectionManager.forceServerSwitch(oldServerId, newServerId, newGlobalConfig);
                    }
                }

                // Register for events using centralized manager
                const eventCallback = createEventCallback();
                await connectionManager.registerForEvents(
                    settings.nodeId,
                    settings.serverId,
                    eventCallback,
                    globalConfig
                );

                // Check connection status
                const status = connectionManager.getConnectionStatus(settings.serverId);
                if (status.ready) {
                    setStatus("green", "dot", "Ready");
                    node.isInitialized = true;
                    node.log(`Connection established for history node`);
                } else {
                    setStatus("yellow", "ring", "Waiting for connection...");
                    node.log(`History node registered - waiting for connection to be ready`);
                }

            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                setStatus("red", "ring", "Registration failed");
                node.error(`Node registration failed: ${errorMsg}`);
            }
        }

        // Input handler
        node.on('input', async function (msg, send, done) {
            try {
                if (msg.topic === "status") {
                    const status = connectionManager.getConnectionStatus(settings.serverId);
                    const statusMsg = {
                        payload: status,
                        topic: "status",
                        timestamp: Date.now()
                    };
                    send(statusMsg);
                    done && done();
                    return;
                }

                const stateId = settings.stateId || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                if (!stateId) {
                    setStatus("red", "ring", "State ID missing");
                    const error = new Error("State ID missing (neither configured nor in msg.topic)");
                    done && done(error);
                    return;
                }

                setStatus("blue", "dot", `Querying history for ${stateId}...`);
                const queryStartTime = Date.now();

                try {
                    // Calculate time range
                    const timeRange = calculateTimeRange(msg);

                    // Build query options
                    const queryOptions = buildQueryOptions(msg, timeRange);

                    node.log(`History query: ${stateId} from ${new Date(timeRange.start).toISOString()} to ${new Date(timeRange.end).toISOString()} (${queryOptions.aggregate})`);

                    // Execute history query via WebSocket manager
                    const result = await connectionManager.getHistory(
                        settings.serverId,
                        settings.historyAdapter,
                        stateId,
                        queryOptions
                    );

                    const queryTime = Date.now() - queryStartTime;

                    // Format output
                    const outputFormat = msg.outputFormat || settings.outputFormat;
                    const formattedResult = formatOutput(result, stateId, queryOptions, queryTime, outputFormat);

                    // Add result to message
                    Object.assign(msg, formattedResult);

                    // For Dashboard 2.0 format, set topic for series name
                    if (outputFormat === 'dashboard2') {
                        msg.topic = stateId;
                    }

                    setStatus("green", "dot", "Ready");
                    node.log(`History query completed: ${formattedResult.count} data points in ${queryTime}ms`);

                    send(msg);
                    done && done();

                } catch (queryError) {
                    setStatus("red", "ring", "Query error");
                    node.error(`History query failed for ${stateId}: ${queryError.message}`);

                    // Send error message with details
                    msg.error = queryError.message;
                    msg[settings.outputProperty] = null;
                    msg.stateId = stateId;
                    msg.adapter = settings.historyAdapter;
                    msg.queryTime = Date.now() - queryStartTime;

                    send(msg);
                    done && done(queryError);
                }

            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Error processing input: ${error.message}`);
                done && done(error);
            }
        });

        // Cleanup on node close
        node.on("close", async function (removed, done) {
            node.log("History node closing...");

            // Unregister from events
            connectionManager.unregisterFromEvents(settings.nodeId);

            try {
                node.status({});
            } catch (statusError) {
                // Ignore status errors during cleanup
            }

            done();
        });

        // Error handling
        node.on("error", function (error) {
            node.error(`History node error: ${error.message}`);
            setError(`Node error: ${error.message}`, "Node error");
        });

        // Initialize the node
        initializeConnection();
    }

    RED.nodes.registerType("iobhistory", iobhistory);
};