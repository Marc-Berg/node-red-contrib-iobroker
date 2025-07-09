const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function (RED) {
    function iobhistory(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Use helper to create status functions
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        // Use helper to validate server config
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

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
            queryMode: config.queryMode || "parallel",
            serverId,
            nodeId: node.id
        };

        node.currentConfig = connectionDetails;
        node.isInitialized = false;

        // Query management state
        node.isQueryRunning = false;
        node.queryQueue = [];
        node.currentQueryId = 0;

        // Log configuration

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

        // Query queue management functions
        function getQueueStatusText() {
            if (settings.queryMode === 'parallel') {
                return node.isQueryRunning ? "Processing..." : "Ready";
            } else if (settings.queryMode === 'sequential') {
                if (node.queryQueue.length > 0) {
                    return `Queue: ${node.queryQueue.length}`;
                }
                return node.isQueryRunning ? "Processing..." : "Ready";
            } else { // drop mode
                return node.isQueryRunning ? "Running (dropping)" : "Ready";
            }
        }

        function updateQueueStatus() {
            const queueText = getQueueStatusText();
            if (node.isQueryRunning) {
                setStatus("blue", "dot", queueText);
            } else {
                setStatus("green", "dot", queueText);
            }
        }

        function enqueueQuery(queryData) {
            const queryId = ++node.currentQueryId;
            const queueItem = {
                id: queryId,
                ...queryData,
                enqueuedAt: Date.now()
            };

            switch (settings.queryMode) {
                case 'parallel':
                    // Execute immediately
                    executeQuery(queueItem);
                    break;

                case 'sequential':
                    node.queryQueue.push(queueItem);
                    updateQueueStatus();
                    
                    // Process queue if not already running
                    if (!node.isQueryRunning) {
                        processNextQuery();
                    }
                    break;

                case 'drop':
                    if (node.isQueryRunning) {
                        // Drop the query
                        node.warn(`Query ${queryId} dropped - another query is running`);
                        
                        // Send error response
                        const errorMsg = { ...queueItem.msg };
                        errorMsg.error = "Query dropped - another query was already running";
                        errorMsg[settings.outputProperty] = null;
                        errorMsg.queryTime = 0;
                        errorMsg.dropped = true;
                        
                        queueItem.send(errorMsg);
                        queueItem.done && queueItem.done(new Error("Query dropped"));
                        return;
                    } else {
                        // Execute immediately
                        executeQuery(queueItem);
                    }
                    break;
            }
        }

        function processNextQuery() {
            if (node.queryQueue.length === 0) {
                updateQueueStatus();
                return;
            }

            const nextQuery = node.queryQueue.shift();          
            updateQueueStatus();
            executeQuery(nextQuery);
        }

        async function executeQuery(queryItem) {
            const { id, msg, send, done, stateId, timeRange, queryOptions } = queryItem;
            
            node.isQueryRunning = true;
            updateQueueStatus();

            const queryStartTime = Date.now();

            try {
                const result = await connectionManager.getHistory(
                    settings.serverId,
                    settings.historyAdapter,
                    stateId,
                    queryOptions
                );

                const queryTime = Date.now() - queryStartTime;

                const outputFormat = msg.outputFormat || settings.outputFormat;
                const formattedResult = formatOutput(result, stateId, queryOptions, queryTime, outputFormat);

                Object.assign(msg, formattedResult);
                msg.queryId = id;
                msg.queryMode = settings.queryMode;

                if (outputFormat === 'dashboard2') {
                    msg.topic = stateId;
                }


                send(msg);
                done && done();

            } catch (queryError) {
                node.error(`History query ${id} failed for ${stateId}: ${queryError.message}`);

                msg.error = queryError.message;
                msg[settings.outputProperty] = null;
                msg.stateId = stateId;
                msg.adapter = settings.historyAdapter;
                msg.queryTime = Date.now() - queryStartTime;
                msg.queryId = id;
                msg.queryMode = settings.queryMode;

                send(msg);
                done && done(queryError);

            } finally {
                node.isQueryRunning = false;

                if (settings.queryMode === 'sequential') {
                    // Small delay to prevent overwhelming the system
                    setTimeout(() => {
                        processNextQuery();
                    }, 50);
                } else {
                    updateQueueStatus();
                }
            }
        }

        const statusTexts = {
            ready: getQueueStatusText()
        };

        NodeHelpers.initializeConnection(
            node, config, RED, settings, globalConfig, setStatus, statusTexts
        );

        node.on('input', function (msg, send, done) {
            try {
                if (NodeHelpers.handleStatusRequest(msg, send, done, settings)) {
                    msg.payload = {
                        ...msg.payload,
                        queryMode: settings.queryMode,
                        isQueryRunning: node.isQueryRunning,
                        queueLength: node.queryQueue.length,
                        currentQueryId: node.currentQueryId
                    };
                    send(msg);
                    return;
                }

                const stateId = settings.stateId || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                if (!NodeHelpers.validateRequiredInput(stateId, "State ID", setStatus, done)) {
                    return;
                }

                try {
                    // Calculate time range
                    const timeRange = calculateTimeRange(msg);

                    // Build query options
                    const queryOptions = buildQueryOptions(msg, timeRange);

                    // Enqueue the query based on the selected mode
                    enqueueQuery({
                        msg: msg,
                        send: send,
                        done: done,
                        stateId: stateId,
                        timeRange: timeRange,
                        queryOptions: queryOptions
                    });

                } catch (queryError) {
                    setError("Query error", "Query error");
                    node.error(`History query preparation failed for ${stateId}: ${queryError.message}`);

                    // Send error message with details
                    msg.error = queryError.message;
                    msg[settings.outputProperty] = null;
                    msg.stateId = stateId;
                    msg.adapter = settings.historyAdapter;
                    msg.queryTime = 0;

                    send(msg);
                    done && done(queryError);
                }

            } catch (error) {
                setError("Error", "Error");
                node.error(`Error processing input: ${error.message}`);
                done && done(error);
            }
        });

        node.on("close", async function (removed, done) {
            const droppedQueries = node.queryQueue.length;
            node.queryQueue.forEach(queueItem => {
                if (queueItem.done) {
                    queueItem.done(new Error("Node is closing"));
                }
            });
            node.queryQueue = [];

            await NodeHelpers.handleNodeClose(node, settings, "History");
            done();
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));
    }

    RED.nodes.registerType("iobhistory", iobhistory);
};