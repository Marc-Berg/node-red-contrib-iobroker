const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function (RED) {
    function iobhistory(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

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
            removeBorderValues: config.removeBorderValues || false,
            timestampFormat: config.timestampFormat || "unix",
            customTimeFormat: config.customTimeFormat || "DD.MM.YYYY HH:mm:ss",
            timezone: config.timezone || "Berlin",
            customTimezone: config.customTimezone?.trim() || "",
            dataFormat: config.dataFormat || "full",
            serverId,
            nodeId: node.id
        };

        node.currentConfig = connectionDetails;
        node.isInitialized = false;
        node.isQueryRunning = false;
        node.queryQueue = [];
        node.currentQueryId = 0;

        function parseTimeInput(timeInput) {
            if (!timeInput) return null;
            if (typeof timeInput === 'number') {
                return timeInput > 10000000000 ? timeInput : timeInput * 1000;
            }
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
            const removeBorderValues = msg.removeBorderValues !== undefined ? msg.removeBorderValues : settings.removeBorderValues;

            const options = {
                start: timeRange.start,
                end: timeRange.end,
                aggregate: aggregate,
                count: maxEntries,
                addId: true,
                removeBorderValues: removeBorderValues
            };

            const needsStep = ['average', 'min', 'max', 'total', 'count', 'percentile', 'quantile', 'integral'];
            if (needsStep.includes(aggregate)) {
                options.step = stepMs;
            }

            if (aggregate === 'percentile') {
                options.percentile = msg.percentile || settings.percentile;
            } else if (aggregate === 'quantile') {
                options.quantile = msg.quantile || settings.quantile;
            } else if (aggregate === 'integral') {
                options.integralUnit = msg.integralUnit || settings.integralUnit;
            }

            return options;
        }

        function resolveTimezone(timezone, customTimezone) {
            switch (timezone) {
                case 'auto':
                    return 'auto';
                case 'Berlin':
                    return 'Europe/Berlin';
                case 'custom':
                    if (!customTimezone) {
                        throw new Error('Custom timezone specified but no timezone value provided');
                    }
                    return validateTimezone(customTimezone);
                default:
                    return 'auto';
            }
        }

        function validateTimezone(timezone) {
            try {
                Intl.DateTimeFormat(undefined, { timeZone: timezone });
                return timezone;
            } catch (error) {
                throw new Error(`Invalid timezone: ${timezone}`);
            }
        }

        function formatTimestamp(timestamp, format, customFormat, timezone, customTimezone) {
            if (!timestamp) return timestamp;
            
            const date = new Date(timestamp);
            
            switch (format) {
                case 'unix':
                    return timestamp;
                case 'iso':
                    return date.toISOString();
                case 'custom':
                    const resolvedTimezone = resolveTimezone(timezone, customTimezone);
                    return formatCustomTimestamp(date, customFormat, resolvedTimezone);
                default:
                    return timestamp;
            }
        }

        function formatCustomTimestamp(date, formatString, timezone) {
            const options = parseFormatString(formatString);
            
            if (timezone && timezone !== 'auto') {
                options.timeZone = timezone === 'UTC' ? 'UTC' : timezone;
            }
            
            const locale = formatString.includes('.') ? 'de-DE' : 'en-US';
            return new Intl.DateTimeFormat(locale, options).format(date);
        }

        function parseFormatString(formatString) {
            const options = {};
            
            if (formatString.includes('YYYY')) options.year = 'numeric';
            if (formatString.includes('MM')) options.month = '2-digit';
            if (formatString.includes('DD')) options.day = '2-digit';
            
            if (formatString.includes('HH')) {
                options.hour = '2-digit';
                options.hour12 = false;
            } else if (formatString.includes('h')) {
                options.hour = 'numeric';
                options.hour12 = true;
            }
            
            if (formatString.includes('mm')) options.minute = '2-digit';
            if (formatString.includes('ss')) options.second = '2-digit';
            
            return options;
        }

        function processDataFormat(data, msg) {
            if (!Array.isArray(data)) return data;

            const timestampFormat = msg.timestampFormat || settings.timestampFormat;
            const customTimeFormat = msg.customTimeFormat || settings.customTimeFormat;
            const timezone = msg.timezone || settings.timezone;
            const customTimezone = msg.customTimezone || settings.customTimezone;
            const dataFormat = msg.dataFormat || settings.dataFormat;

            const processedData = data.map(point => {
                let processed;
                
                if (dataFormat === 'simple') {
                    processed = {
                        ts: point.ts,
                        val: point.val
                    };
                } else {
                    processed = { ...point };
                }
                
                if (processed.ts) {
                    processed.ts = formatTimestamp(processed.ts, timestampFormat, customTimeFormat, timezone, customTimezone);
                }
                
                return processed;
            });

            return processedData;
        }

        function formatForChart(data, stateId) {
            const labels = [];
            const values = [];

            data.forEach(point => {
                if (point.ts && point.val !== undefined) {
                    const timestamp = typeof point.ts === 'string' && !point.ts.match(/^\d+$/) 
                        ? point.ts
                        : new Date(point.ts).toLocaleString();
                    labels.push(timestamp);
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
                    const timestamp = typeof point.ts === 'string' && !point.ts.match(/^\d+$/)
                        ? new Date(point.ts).getTime()
                        : typeof point.ts === 'string' ? parseInt(point.ts) : point.ts;
                    chartData.push({
                        x: timestamp,
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

        function formatOutput(data, stateId, queryOptions, queryTime, format, msg) {
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

            const processedData = processDataFormat(data, msg);

            let output;
            switch (format) {
                case 'chart':
                    output = formatForChart(processedData, stateId);
                    break;
                case 'dashboard2':
                    output = formatForDashboard2(processedData, stateId);
                    break;
                case 'statistics':
                    output = formatStatistics(processedData, queryOptions);
                    break;
                case 'array':
                default:
                    output = processedData;
                    break;
            }

            return {
                [settings.outputProperty]: output,
                stateId: stateId,
                adapter: settings.historyAdapter,
                queryOptions: queryOptions,
                queryTime: queryTime,
                count: processedData.length,
                timestamp: Date.now(),
                formatOptions: {
                    timestampFormat: msg.timestampFormat || settings.timestampFormat,
                    dataFormat: msg.dataFormat || settings.dataFormat,
                    removeBorderValues: msg.removeBorderValues !== undefined ? msg.removeBorderValues : settings.removeBorderValues,
                    timezone: msg.timezone || settings.timezone,
                    customTimezone: msg.customTimezone || settings.customTimezone
                }
            };
        }

        function getQueueStatusText() {
            if (settings.queryMode === 'parallel') {
                return node.isQueryRunning ? "Processing..." : "Ready";
            } else if (settings.queryMode === 'sequential') {
                if (node.queryQueue.length > 0) {
                    return `Queue: ${node.queryQueue.length}`;
                }
                return node.isQueryRunning ? "Processing..." : "Ready";
            } else {
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
                    executeQuery(queueItem);
                    break;
                case 'sequential':
                    node.queryQueue.push(queueItem);
                    updateQueueStatus();
                    if (!node.isQueryRunning) {
                        processNextQuery();
                    }
                    break;
                case 'drop':
                    if (node.isQueryRunning) {
                        node.warn(`Query ${queryId} dropped - another query is running`);
                        const errorMsg = { ...queueItem.msg };
                        errorMsg.error = "Query dropped - another query was already running";
                        errorMsg[settings.outputProperty] = null;
                        errorMsg.queryTime = 0;
                        errorMsg.dropped = true;
                        queueItem.send(errorMsg);
                        queueItem.done && queueItem.done(new Error("Query dropped"));
                        return;
                    } else {
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
                const formattedResult = formatOutput(result, stateId, queryOptions, queryTime, outputFormat, msg);

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
                        currentQueryId: node.currentQueryId,
                        formatOptions: {
                            removeBorderValues: settings.removeBorderValues,
                            timestampFormat: settings.timestampFormat,
                            customTimeFormat: settings.customTimeFormat,
                            timezone: settings.timezone,
                            customTimezone: settings.customTimezone,
                            dataFormat: settings.dataFormat
                        }
                    };
                    send(msg);
                    return;
                }

                const stateId = settings.stateId || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                if (!NodeHelpers.validateRequiredInput(stateId, "State ID", setStatus, done)) {
                    return;
                }

                try {
                    const timeRange = calculateTimeRange(msg);
                    const queryOptions = buildQueryOptions(msg, timeRange);

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