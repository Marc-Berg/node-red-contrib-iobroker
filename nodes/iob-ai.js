'use strict';

/**
 * iob-ai – AI analysis node for ioBroker data in Node-RED.
 *
 * Modes
 * ─────
 *  • analyze   – Analyse a time-series payload (from iob-history) and return
 *                a human-readable insight plus structured statistics.
 *  • anomaly   – Detect anomalies in a time series based on statistical
 *                deviation from the mean (no LLM required for detection;
 *                LLM optionally explains the anomaly).
 *  • discover  – Filter an iob-getobject payload (msg.objects) to the subset
 *                that has active history recording, enriched with metadata.
 *  • query     – Natural language → structured ioBroker query parameters
 *                (stateId, start, end, aggregate) for use with iob-history.
 *  • summarize – Summarise multiple state values into a brief natural-language
 *                status description.
 */

const { NodeHelpers } = require('../lib/utils/node-helpers');
const { LLMClient }   = require('../lib/ai/llm-client');

// ── System prompts ────────────────────────────────────────────────────────────

const SYSTEM_PROMPTS = {
    analyze: `You are a smart-home data analyst. The user provides ioBroker time-series data.
Respond with a concise JSON object (no markdown) with these fields:
  summary   – one sentence plain-language description
  trend     – "rising" | "falling" | "stable" | "fluctuating"
  min       – numeric minimum value (null if non-numeric)
  max       – numeric maximum value (null if non-numeric)
  avg       – numeric average value (null if non-numeric)
  anomalies – array of {ts, val, reason} for notable data points (empty array if none)
  recommendation – optional actionable suggestion (null if none)`,

    anomaly: `You are a smart-home anomaly analyst. The user provides an ioBroker time-series
and a list of statistical outliers. Explain each anomaly briefly in plain language.
Respond with JSON: { explanations: [{ts, val, explanation}] }`,

    query: `You are an ioBroker query builder. Convert the user's natural-language question about
their smart home into a JSON query object with these fields:
  stateId   – ioBroker state ID pattern (use * for wildcards if unclear)
  start     – ISO 8601 start timestamp or relative string like "-24h", "-7d"
  end       – ISO 8601 end timestamp, or "now"
  aggregate – one of: onchange | average | min | max | total | count
  notes     – short explanation of your interpretation
Only output valid JSON, no markdown.`,

    summarize: `You are a smart-home assistant. The user provides a list of current ioBroker state
values with names and units. Write a short, friendly plain-language summary (2–4 sentences)
describing the current state of the home. No JSON, just text.`
};

// ── Statistical helpers (used by anomaly mode without LLM) ───────────────────

function calcStats(values) {
    if (!values.length) return { mean: 0, stddev: 0 };
    const mean   = values.reduce((s, v) => s + v, 0) / values.length;
    const stddev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
    return { mean, stddev };
}

function findAnomalies(dataPoints, threshold = 2.5) {
    const numeric = dataPoints.filter(p => typeof p.val === 'number' && p.val !== null);
    if (numeric.length < 4) return [];
    const { mean, stddev } = calcStats(numeric.map(p => p.val));
    if (stddev === 0) return [];
    return numeric
        .filter(p => Math.abs(p.val - mean) > threshold * stddev)
        .map(p => ({ ts: p.ts, val: p.val, deviation: +((p.val - mean) / stddev).toFixed(2) }));
}

// ── Mode implementations ──────────────────────────────────────────────────────

async function modeAnalyze(msg, settings, llm) {
    const data = Array.isArray(msg.payload) ? msg.payload : [];
    if (!data.length) {
        return { mode: 'analyze', error: 'No time-series data in msg.payload (expected array from iob-history)' };
    }

    const stateId = msg.stateId || msg.topic || 'unknown';
    const sample  = data.slice(0, 200); // keep prompt manageable

    if (!llm.isConfigured()) {
        // Fallback: pure statistics without LLM
        const numeric = sample.filter(p => typeof p.val === 'number');
        const vals    = numeric.map(p => p.val);
        const { mean, stddev } = calcStats(vals);
        return {
            mode: 'analyze',
            stateId,
            llmUsed: false,
            summary: `${stateId}: ${vals.length} numeric data points. Mean: ${mean.toFixed(2)}, StdDev: ${stddev.toFixed(2)}.`,
            trend: null,
            min: vals.length ? Math.min(...vals) : null,
            max: vals.length ? Math.max(...vals) : null,
            avg: vals.length ? +(mean.toFixed(4)) : null,
            anomalies: findAnomalies(sample, settings.anomalyThreshold),
            recommendation: null
        };
    }

    const prompt = `State ID: ${stateId}\nData (${sample.length} points):\n${JSON.stringify(sample)}`;
    const response = await llm.ask(prompt, SYSTEM_PROMPTS.analyze);

    let parsed;
    try {
        // Strip potential markdown fences
        const clean = response.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        parsed = JSON.parse(clean);
    } catch (_) {
        parsed = { summary: response.text, trend: null, min: null, max: null, avg: null, anomalies: [], recommendation: null };
    }

    return { mode: 'analyze', stateId, llmUsed: true, usage: response.usage, ...parsed };
}

async function modeAnomaly(msg, settings, llm) {
    const data      = Array.isArray(msg.payload) ? msg.payload : [];
    const stateId   = msg.stateId || msg.topic || 'unknown';
    const threshold = msg.anomalyThreshold || settings.anomalyThreshold || 2.5;
    const anomalies = findAnomalies(data, threshold);

    if (!anomalies.length) {
        return { mode: 'anomaly', stateId, anomaliesFound: false, anomalies: [], llmUsed: false };
    }

    if (!llm.isConfigured()) {
        return { mode: 'anomaly', stateId, anomaliesFound: true, anomalies, llmUsed: false };
    }

    const prompt   = `State: ${stateId}\nOutliers:\n${JSON.stringify(anomalies)}`;
    const response = await llm.ask(prompt, SYSTEM_PROMPTS.anomaly);

    let explanations = anomalies.map(a => ({ ...a, explanation: null }));
    try {
        const clean = response.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(clean);
        if (Array.isArray(parsed.explanations)) {
            explanations = parsed.explanations;
        }
    } catch (_) { /* keep raw anomalies */ }

    return { mode: 'anomaly', stateId, anomaliesFound: true, anomalies: explanations, llmUsed: true, usage: response.usage };
}

function modeDiscover(msg, settings) {
    const objects        = msg.objects || msg.payload || {};
    const historyAdapter = msg.historyAdapter || settings.historyAdapter || null;

    const result = [];

    for (const [entryKey, obj] of Object.entries(objects)) {
        if (!obj || obj.type !== 'state') continue;

        // Support both object-map and array payloads from iob-getobject.
        const id = obj._id || obj.id || entryKey;
        if (!id || typeof id !== 'string') continue;

        const custom = obj.common?.custom;
        if (!custom || typeof custom !== 'object') continue;

        // Find all history adapters active on this state
        const activeAdapters = Object.entries(custom)
            .filter(([key, val]) => {
                const isHistoryAdapter = /^(history|sql|influxdb)\.\d+$/.test(key);
                return isHistoryAdapter && val && val.enabled === true;
            })
            .map(([key]) => key);

        if (!activeAdapters.length) continue;

        // Optionally filter to a specific adapter
        if (historyAdapter && !activeAdapters.includes(historyAdapter)) continue;

        result.push({
            id,
            name:    obj.common?.name || id,
            unit:    obj.common?.unit || '',
            type:    obj.common?.type || 'mixed',
            role:    obj.common?.role || '',
            adapters: activeAdapters,
            // Enum assignments from iob-getobject +enums option
            rooms:     obj.enumAssignments?.rooms?.map(r => r.name) || [],
            functions: obj.enumAssignments?.functions?.map(f => f.name) || []
        });
    }

    return {
        mode:    'discover',
        count:   result.length,
        states:  result,
        llmUsed: false
    };
}

function parseRelativeTime(value, nowMs) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'now') return nowMs;

    const match = normalized.match(/^-(\d+)\s*([smhdw])$/);
    if (!match) return null;

    const amount = parseInt(match[1], 10);
    const unit = match[2];
    const multipliers = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000
    };
    return nowMs - (amount * multipliers[unit]);
}

function parseToTimestampMs(value, nowMs) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number') return value > 10000000000 ? value : value * 1000;

    if (typeof value === 'string') {
        const relative = parseRelativeTime(value, nowMs);
        if (relative !== null) return relative;

        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) return parsed;
    }

    return null;
}

function normalizeQueryForHistory(query) {
    const normalized = { ...(query || {}) };
    const nowMs = Date.now();

    const startMs = parseToTimestampMs(normalized.start, nowMs);
    const endMs = parseToTimestampMs(normalized.end, nowMs) ?? nowMs;

    if (startMs !== null) normalized.start = startMs;
    if (endMs !== null) normalized.end = endMs;

    const allowedAggregates = new Set(['onchange', 'average', 'min', 'max', 'total', 'count']);
    if (typeof normalized.aggregate !== 'string' || !allowedAggregates.has(normalized.aggregate)) {
        normalized.aggregate = 'onchange';
    }

    return normalized;
}

async function modeQuery(msg, settings, llm) {
    const question = (typeof msg.payload === 'string' ? msg.payload : '') ||
                     (typeof msg.question === 'string' ? msg.question : '');

    if (!question) {
        return { mode: 'query', error: 'msg.payload or msg.question must be a natural-language question string' };
    }

    if (!llm.isConfigured()) {
        return { mode: 'query', error: 'AI provider not configured. Cannot process natural-language query.' };
    }

    const context  = msg.context || '';
    const prompt   = context ? `Context: ${context}\n\nQuestion: ${question}` : question;
    const response = await llm.ask(prompt, SYSTEM_PROMPTS.query);

    let parsed;
    try {
        const clean = response.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        parsed = JSON.parse(clean);
    } catch (_) {
        return { mode: 'query', error: 'LLM did not return valid JSON', rawResponse: response.text };
    }

    const query = normalizeQueryForHistory(parsed);

    if (query.start === null || query.start === undefined) {
        return {
            mode: 'query',
            error: 'LLM query is missing a valid start time. Use ISO date/time or relative values like -24h.',
            rawQuery: parsed
        };
    }

    if (query.start >= query.end) {
        return {
            mode: 'query',
            error: 'LLM query produced an invalid time range (start must be before end).',
            rawQuery: parsed
        };
    }

    return { mode: 'query', llmUsed: true, usage: response.usage, query };
}

async function modeSummarize(msg, settings, llm) {
    if (!llm.isConfigured()) {
        return { mode: 'summarize', error: 'AI provider not configured.' };
    }

    // Accept both array of {id, name, val, unit} and a plain payload object
    let stateList;
    if (Array.isArray(msg.payload)) {
        stateList = msg.payload;
    } else if (msg.states && typeof msg.states === 'object') {
        stateList = Object.entries(msg.states).map(([id, val]) => ({ id, val }));
    } else {
        return { mode: 'summarize', error: 'Expected msg.payload (array) or msg.states (object)' };
    }

    const prompt   = `Current states:\n${JSON.stringify(stateList.slice(0, 100))}`;
    const response = await llm.ask(prompt, SYSTEM_PROMPTS.summarize);

    return { mode: 'summarize', llmUsed: true, usage: response.usage, summary: response.text.trim() };
}

// ── Node definition ───────────────────────────────────────────────────────────

module.exports = function (RED) {
    function iobAI(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);

        // Resolve iob-config node
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;
        const { globalConfig } = serverConfig;

        const settings = {
            mode:             config.mode             || 'analyze',
            historyAdapter:   config.historyAdapter   || '',
            anomalyThreshold: parseFloat(config.anomalyThreshold) || 2.5,
            outputProperty:   config.outputProperty?.trim() || 'payload',
            nodeId:           node.id
        };

        // Build LLM client from config-node credentials
        function buildLLMClient() {
            if (!globalConfig || globalConfig.aiProvider === 'none' || !globalConfig.aiProvider) {
                return new LLMClient({ provider: 'none' });
            }
            return new LLMClient({
                provider:    globalConfig.aiProvider,
                model:       globalConfig.aiModel,
                apiKey:      globalConfig.aiApiKey,
                baseUrl:     globalConfig.aiBaseUrl,
                maxTokens:   globalConfig.aiMaxTokens,
                temperature: globalConfig.aiTemperature
            });
        }

        setStatus('grey', 'ring', 'Ready');

        node.on('input', async function (msg, send, done) {
            const mode = msg.mode || settings.mode;

            setStatus('blue', 'dot', `${mode}…`);

            try {
                const llm = buildLLMClient();
                let result;

                switch (mode) {
                    case 'analyze':
                        result = await modeAnalyze(msg, settings, llm);
                        break;
                    case 'anomaly':
                        result = await modeAnomaly(msg, settings, llm);
                        break;
                    case 'discover':
                        result = modeDiscover(msg, settings);
                        break;
                    case 'query':
                        result = await modeQuery(msg, settings, llm);
                        break;
                    case 'summarize':
                        result = await modeSummarize(msg, settings, llm);
                        break;
                    default:
                        result = { error: `Unknown mode: ${mode}` };
                }

                if (result.error) {
                    setStatus('yellow', 'ring', result.error.slice(0, 50));
                } else {
                    const statusText = result.llmUsed
                        ? `✓ ${mode} (${result.usage?.total_tokens || '?'} tokens)`
                        : `✓ ${mode}`;
                    setStatus('green', 'dot', statusText);
                }

                NodeHelpers.setMessageProperty(RED, msg, settings.outputProperty, result);
                msg.aiMode  = mode;
                msg.aiResult = result;

                send(msg);
                done && done();

            } catch (err) {
                setError(`AI error (${mode})`, err.message);
                node.error(`iob-ai [${mode}] error: ${err.message}`, msg);
                msg.error = err.message;
                send(msg);
                done && done(err);
            }
        });

        node.on('close', function (removed, done) {
            done();
        });
    }

    RED.nodes.registerType('iob-ai', iobAI);
};
