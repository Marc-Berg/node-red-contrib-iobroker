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
const connectionManager = require('../lib/manager/websocket-manager');

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

function getLLMConfigInfo(llm) {
    const provider = llm?.provider || 'none';
    const model = llm?.model || '';
    const hasApiKey = !!llm?.apiKey;
    const hasBaseUrl = !!llm?.baseUrl;

    let reason = 'configured';
    if (provider === 'none' || !provider) {
        reason = 'provider-none';
    } else if (!model) {
        reason = 'model-missing';
    } else if ((provider === 'openai' || provider === 'azure' || provider === 'openai_compatible') && !hasApiKey) {
        reason = 'api-key-missing';
    } else if ((provider === 'azure' || provider === 'ollama' || provider === 'openai_compatible') && !hasBaseUrl) {
        reason = 'base-url-missing';
    }

    return {
        llmConfigured: llm && typeof llm.isConfigured === 'function' ? llm.isConfigured() : false,
        llmProvider: provider,
        llmModel: model,
        llmReason: reason
    };
}

async function ensureServerConnection(settings) {
    const { serverId, globalConfig, nodeId } = settings;

    if (!serverId || !globalConfig) {
        throw new Error('Missing server configuration for connection setup');
    }

    const status = connectionManager.getConnectionStatus(serverId);
    if (status?.ready) {
        return;
    }

    const eventCallback = {
        updateStatus: function () {},
        onReconnect: function () {},
        onDisconnect: function () {}
    };

    await connectionManager.registerForEvents(nodeId, serverId, eventCallback, globalConfig);

    for (let attempt = 0; attempt < 10; attempt += 1) {
        const nextStatus = connectionManager.getConnectionStatus(serverId);
        if (nextStatus?.ready) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    throw new Error(`Connection not ready for ${globalConfig.iobhost}:${globalConfig.iobport}`);
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
        const llmInfo = getLLMConfigInfo(llm);
        return {
            mode: 'analyze',
            stateId,
            llmUsed: false,
            ...llmInfo,
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
        return { mode: 'anomaly', stateId, anomaliesFound: false, anomalies: [], llmUsed: false, ...getLLMConfigInfo(llm) };
    }

    if (!llm.isConfigured()) {
        return { mode: 'anomaly', stateId, anomaliesFound: true, anomalies, llmUsed: false, ...getLLMConfigInfo(llm) };
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
    const diagnostics = {
        totalEntries: 0,
        nonStateObjects: 0,
        missingId: 0,
        missingCustomConfig: 0,
        noActiveHistoryAdapter: 0,
        historyAdapterFilteredOut: 0,
        matchedStates: 0
    };

    for (const [entryKey, obj] of Object.entries(objects)) {
        diagnostics.totalEntries += 1;

        if (!obj || obj.type !== 'state') {
            diagnostics.nonStateObjects += 1;
            continue;
        }

        // Support both object-map and array payloads from iob-getobject.
        const id = obj._id || obj.id || entryKey;
        if (!id || typeof id !== 'string') {
            diagnostics.missingId += 1;
            continue;
        }

        const custom = obj.common?.custom;
        if (!custom || typeof custom !== 'object') {
            diagnostics.missingCustomConfig += 1;
            continue;
        }

        // Find all history adapters active on this state
        const activeAdapters = Object.entries(custom)
            .filter(([key, val]) => {
                const isHistoryAdapter = /^(history|sql|influxdb)\.\d+$/.test(key);
                return isHistoryAdapter && val && val.enabled === true;
            })
            .map(([key]) => key);

        if (!activeAdapters.length) {
            diagnostics.noActiveHistoryAdapter += 1;
            continue;
        }

        // Optionally filter to a specific adapter
        if (historyAdapter && !activeAdapters.includes(historyAdapter)) {
            diagnostics.historyAdapterFilteredOut += 1;
            continue;
        }

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

        diagnostics.matchedStates += 1;
    }

    return {
        mode:    'discover',
        count:   result.length,
        states:  result,
        diagnostics,
        llmUsed: false
    };
}

function hasActiveHistory(custom, historyAdapter) {
    if (!custom || typeof custom !== 'object') {
        return { active: false, adapters: [] };
    }

    const activeAdapters = Object.entries(custom)
        .filter(([key, val]) => {
            const isHistoryAdapter = /^(history|sql|influxdb)\.\d+$/.test(key);
            return isHistoryAdapter && val && val.enabled === true;
        })
        .map(([key]) => key);

    if (!activeAdapters.length) {
        return { active: false, adapters: [] };
    }

    if (historyAdapter && !activeAdapters.includes(historyAdapter)) {
        return { active: false, adapters: activeAdapters };
    }

    return { active: true, adapters: activeAdapters };
}

function classifyStateImportance(obj, id) {
    const type = obj?.common?.type || '';
    const role = (obj?.common?.role || '').toLowerCase();
    const unit = (obj?.common?.unit || '').toLowerCase();
    const read = obj?.common?.read !== false;

    if (!id || !role) {
        return { level: 'optional', score: 0, reason: 'insufficient metadata' };
    }

    const roleText = `${id} ${role}`;

    if (!read) {
        return { level: 'optional', score: 1, reason: 'write-only state' };
    }

    const criticalPattern = /alarm|alert|siren|panic|smoke|fire|co(?:\b|2)|gas|leak|flood|water\.alarm|tamper|intrusion|security|lock(?:\.|$)|fault|error|battery\.low|unreachable|offline/;
    const recommendedPattern = /temperature|humidity|energy|power|consumption|voltage|current|co2|presence|motion|window|door|battery|rain|wind|weather|switch|light|dimmer|level|setpoint|target|heating|thermostat|scene|mode/;
    const configLikePattern = /notification|delay|timeout|threshold|sensitivity|interval|duration|debounce|hysteresis|calibration|offset|setting|config|parameter|alarm_?delay|start_?alarm|notification_?start|notification_?end/;

    if (configLikePattern.test(roleText)) {
        return { level: 'optional', score: 1, reason: 'configuration/tuning parameter' };
    }

    if (
        criticalPattern.test(roleText)
    ) {
        return { level: 'critical', score: 3, reason: 'safety, security or fault indicator' };
    }

    if (
        recommendedPattern.test(roleText) ||
        ['°c', '°f', '%', 'w', 'kw', 'kwh', 'v', 'a', 'ppm', 'lux', 'bar'].includes(unit) ||
        type === 'boolean' || type === 'number'
    ) {
        return { level: 'recommended', score: 2, reason: 'telemetry or operational state useful for analysis' };
    }

    return { level: 'optional', score: 1, reason: 'low analytical value by default' };
}

async function modeHistoryAudit(msg, settings) {
    const historyAdapter = msg.historyAdapter || settings.historyAdapter || null;
    const pattern = typeof msg.pattern === 'string' && msg.pattern.trim() ? msg.pattern.trim() : (settings.auditPattern || '*');

    const hasObjectMap = msg.objects && typeof msg.objects === 'object';
    const hasObjectPayload = msg.payload && typeof msg.payload === 'object';

    let objects = hasObjectMap ? msg.objects : (hasObjectPayload ? msg.payload : null);
    let source = hasObjectMap ? 'msg.objects' : (hasObjectPayload ? 'msg.payload' : 'server');

    if (!objects) {
        try {
            await ensureServerConnection(settings);
            const fetched = await connectionManager.getObjects(settings.serverId, pattern, 'state');
            if (Array.isArray(fetched)) {
                objects = {};
                for (const obj of fetched) {
                    if (obj && obj._id) {
                        objects[obj._id] = obj;
                    }
                }
            } else {
                objects = fetched || {};
            }
            source = 'server';
        } catch (error) {
            return {
                mode: 'history-audit',
                error: `No objects in msg and fetch failed: ${error.message}`,
                hint: 'Provide msg.objects from iob-getobject or ensure server connection is ready.',
                llmUsed: false
            };
        }
    }

    if (!objects || typeof objects !== 'object') {
        return {
            mode: 'history-audit',
            error: 'Expected msg.objects/msg.payload object map or array of state objects',
            llmUsed: false
        };
    }

    const entries = Array.isArray(objects)
        ? objects.map(obj => [obj?._id || obj?.id || '', obj])
        : Object.entries(objects);

    const criticalMissing = [];
    const recommendedMissing = [];
    const optionalMissing = [];
    const alreadyHistorized = [];

    const diagnostics = {
        totalEntries: 0,
        nonStateObjects: 0,
        missingId: 0,
        missingCommon: 0,
        historized: 0,
        missingHistory: 0,
        criticalMissing: 0,
        recommendedMissing: 0,
        optionalMissing: 0
    };

    for (const [entryKey, obj] of entries) {
        diagnostics.totalEntries += 1;

        if (!obj || obj.type !== 'state') {
            diagnostics.nonStateObjects += 1;
            continue;
        }

        const id = obj._id || obj.id || entryKey;
        if (!id || typeof id !== 'string') {
            diagnostics.missingId += 1;
            continue;
        }

        if (!obj.common || typeof obj.common !== 'object') {
            diagnostics.missingCommon += 1;
            continue;
        }

        const history = hasActiveHistory(obj.common.custom, historyAdapter);
        const importance = classifyStateImportance(obj, id);

        const stateItem = {
            id,
            name: obj.common.name || id,
            role: obj.common.role || '',
            type: obj.common.type || 'mixed',
            unit: obj.common.unit || '',
            importance: importance.level,
            reason: importance.reason,
            adapters: history.adapters
        };

        if (history.active) {
            diagnostics.historized += 1;
            alreadyHistorized.push(stateItem);
            continue;
        }

        diagnostics.missingHistory += 1;

        if (importance.level === 'critical') {
            diagnostics.criticalMissing += 1;
            criticalMissing.push(stateItem);
        } else if (importance.level === 'recommended') {
            diagnostics.recommendedMissing += 1;
            recommendedMissing.push(stateItem);
        } else {
            diagnostics.optionalMissing += 1;
            optionalMissing.push(stateItem);
        }
    }

    const byName = (a, b) => a.id.localeCompare(b.id);
    criticalMissing.sort(byName);
    recommendedMissing.sort(byName);
    optionalMissing.sort(byName);

    return {
        mode: 'history-audit',
        llmUsed: false,
        source,
        pattern,
        historyAdapter: historyAdapter || null,
        summary: {
            totalStates: diagnostics.totalEntries - diagnostics.nonStateObjects,
            historized: diagnostics.historized,
            missingHistory: diagnostics.missingHistory,
            criticalMissing: diagnostics.criticalMissing,
            recommendedMissing: diagnostics.recommendedMissing,
            optionalMissing: diagnostics.optionalMissing
        },
        missingHistory: {
            critical: criticalMissing,
            recommended: recommendedMissing,
            optional: optionalMissing
        },
        alreadyHistorizedCount: alreadyHistorized.length,
        diagnostics
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

function wildcardToRegExp(pattern) {
    const escaped = String(pattern || '')
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
}

function extractStateIdsFromObjects(objects) {
    if (!objects || typeof objects !== 'object') return [];

    const entries = Array.isArray(objects)
        ? objects.map(obj => [obj?._id || obj?.id || '', obj])
        : Object.entries(objects);

    const ids = [];
    for (const [entryKey, obj] of entries) {
        if (!obj || obj.type !== 'state') continue;
        const id = obj._id || obj.id || entryKey;
        if (typeof id === 'string' && id) ids.push(id);
    }
    return ids;
}

function uniqueSortedIds(ids) {
    return Array.from(new Set((ids || []).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function normalizeStateCandidatesFromFetchedObjects(fetched) {
    if (!fetched) return [];

    if (Array.isArray(fetched)) {
        const result = fetched
            .map(item => ({ id: item?._id || item?.id || null, obj: item }))
            .filter(entry => typeof entry.id === 'string' && entry.id);
        return result;
    }

    if (typeof fetched === 'object') {
        const entries = Object.entries(fetched);
        const result = entries
            .map(([key, value]) => {
                if (value && typeof value === 'object' && value.type === 'state') {
                    return { id: value._id || value.id || key, obj: value };
                }
                if (typeof key === 'string' && key.includes('.')) {
                    return { id: key, obj: (value && typeof value === 'object') ? value : null };
                }
                return null;
            })
            .filter(Boolean)
            .filter(entry => typeof entry.id === 'string' && entry.id);

        return result;
    }

    return [];
}

function uniqueCandidates(candidates) {
    const map = new Map();
    for (const entry of (candidates || [])) {
        if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
        if (!map.has(entry.id)) {
            map.set(entry.id, { id: entry.id, obj: entry.obj || null });
        }
    }
    return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function candidateIds(candidates) {
    return (candidates || []).map(entry => entry.id);
}

function hasAnyHistoryEnabled(obj) {
    const custom = obj?.common?.custom;
    if (!custom || typeof custom !== 'object') return false;

    return Object.entries(custom).some(([adapter, cfg]) => /^(history|sql|influxdb)\.\d+$/.test(adapter) && cfg && cfg.enabled === true);
}

function tokenizeForSimilarity(value) {
    return String(value || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(token => token.length >= 2);
}

function scoreStateIdCandidate(candidateEntry, intentText, queryPattern) {
    const candidateId = typeof candidateEntry === 'string' ? candidateEntry : candidateEntry?.id;
    const obj = typeof candidateEntry === 'string' ? null : candidateEntry?.obj;
    const candidate = String(candidateId || '').toLowerCase();
    if (!candidate) return 0;

    const intentTokens = tokenizeForSimilarity(intentText);
    const patternTokens = tokenizeForSimilarity(queryPattern);
    const tokens = uniqueSortedIds(intentTokens.concat(patternTokens));
    const role = String(obj?.common?.role || '').toLowerCase();
    const unit = String(obj?.common?.unit || '').toLowerCase();
    const type = String(obj?.common?.type || '').toLowerCase();
    const notesText = `${intentText} ${queryPattern}`.toLowerCase();
    const wantsRecordedSeries = /recorded|history|histor|average|avg|mean|january|february|march|april|may|june|july|august|september|october|november|december|last|past|week|month|year/.test(notesText);
    const wantsTemperature = /temperature|temp|celsius|°c/.test(notesText);
    const wantsHumidity = /humidity|feuchte|humid/.test(notesText);
    const wantsEnergy = /energy|consumption|verbrauch|kwh|power|leistung/.test(notesText);

    let score = 0;
    for (const token of tokens) {
        if (!token) continue;
        if (candidate === token) score += 20;
        else if (candidate.endsWith(`.${token}`)) score += 12;
        else if (candidate.includes(`.${token}.`)) score += 10;
        else if (candidate.includes(token)) score += 6;
    }

    if (intentTokens.includes('temperature') || patternTokens.includes('temperature') || patternTokens.includes('temp')) {
        if (/temperature|temp/.test(candidate)) score += 12;
    }
    if (intentTokens.includes('humidity') || patternTokens.includes('humidity')) {
        if (/humidity|hum/.test(candidate)) score += 10;
    }
    if (intentTokens.includes('energy') || patternTokens.includes('energy') || patternTokens.includes('consumption')) {
        if (/energy|consumption|kwh|power/.test(candidate)) score += 10;
    }

    if (wantsTemperature && /\.temperature(?:\.|$)/.test(candidate)) score += 14;
    if (wantsTemperature && /temperaturemin|temperaturemax/.test(candidate)) score -= 8;
    if (wantsTemperature && (unit === '°c' || unit === '°f' || /temperature/.test(role))) score += 10;

    if (wantsHumidity && (/humidity|hum/.test(candidate) || unit === '%' || /humidity/.test(role))) score += 10;
    if (wantsEnergy && (/energy|consumption|kwh|power/.test(candidate) || ['w', 'kw', 'kwh'].includes(unit))) score += 10;

    if (wantsRecordedSeries && hasAnyHistoryEnabled(obj)) score += 18;
    if (wantsRecordedSeries && /openweathermap|forecast/.test(candidate) && !hasAnyHistoryEnabled(obj)) score -= 10;

    if (/^0_userdata\./.test(candidate)) score -= 12;
    if (/profiles?\.|periods?\.|schedule|calendar|abfallkalender|example_state|test\b/.test(candidate)) score -= 14;
    if (/setpoint|target|desired|soll/.test(candidate)) score -= 10;
    if (/sensor/.test(candidate) && /temperature/.test(candidate)) score += 4;
    if (/\.temperature$/.test(candidate)) score += 6;

    if (/\.set(point)?\b|\.target\b|\.cmd\b|\.command\b/.test(candidate)) score -= 6;
    if (/\.ack\b|\.q\b|\.ts\b|\.lc\b/.test(candidate)) score -= 4;
    if (type && type !== 'number' && (wantsTemperature || wantsHumidity || wantsEnergy)) score -= 3;

    return score;
}

function findBestStateIdCandidate(allCandidates, queryPattern, intentText) {
    const scored = (allCandidates || [])
        .map(candidate => ({ id: candidate.id, score: scoreStateIdCandidate(candidate, intentText, queryPattern) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    if (!scored.length) {
        return { bestId: null, score: 0, topMatches: [] };
    }

    return {
        bestId: scored[0].id,
        score: scored[0].score,
        topMatches: scored.slice(0, 10)
    };
}

function resolveBestCandidateWithConfidence(bestResult) {
    const top = Array.isArray(bestResult?.topMatches) ? bestResult.topMatches : [];
    if (!top.length || !bestResult?.bestId) {
        return { resolved: false, reason: 'no-candidate', selectedId: null, scoreGap: 0, topMatches: top };
    }

    if (top.length === 1) {
        return { resolved: true, reason: 'single-candidate', selectedId: top[0].id, scoreGap: 999, topMatches: top };
    }

    const first = top[0];
    const second = top[1];
    const gap = first.score - second.score;

    if (gap >= 6) {
        return { resolved: true, reason: 'clear-winner', selectedId: first.id, scoreGap: gap, topMatches: top };
    }

    return { resolved: false, reason: 'ambiguous-candidates', selectedId: null, scoreGap: gap, topMatches: top };
}

function selectSuggestionIds(allCandidates, queryPattern, intentText, limit = 20) {
    const scored = (allCandidates || [])
        .map(candidate => ({ id: candidate.id, score: scoreStateIdCandidate(candidate, intentText, queryPattern) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    if (scored.length) {
        return scored.slice(0, limit).map(item => item.id);
    }

    return uniqueSortedIds(candidateIds(allCandidates)).slice(0, limit);
}

async function validateQueryStateId(stateIdPattern, msg, settings) {
    const regex = wildcardToRegExp(stateIdPattern || '*');

    const msgObjectIds = extractStateIdsFromObjects(msg.objects || msg.payload);
    if (msgObjectIds.length) {
        const allCandidates = uniqueCandidates(msgObjectIds.map(id => ({ id, obj: null })));
        const allIds = candidateIds(allCandidates);
        const matched = allIds.filter(id => regex.test(id));
        return {
            validated: true,
            source: 'msg.objects',
            totalCandidates: allIds.length,
            matchCount: matched.length,
            matchedIds: matched,
            allCandidateIds: allCandidates
        };
    }

    if (Array.isArray(msg.availableStateIds) && msg.availableStateIds.length) {
        const all = uniqueSortedIds(msg.availableStateIds.filter(id => typeof id === 'string'));
        const matched = all.filter(id => regex.test(id));
        return {
            validated: true,
            source: 'msg.availableStateIds',
            totalCandidates: all.length,
            matchCount: matched.length,
            matchedIds: matched,
            allCandidateIds: all.map(id => ({ id, obj: null }))
        };
    }

    try {
        await ensureServerConnection(settings);
        const fetched = await connectionManager.getObjects(settings.serverId, stateIdPattern || '*', 'state');
        const fetchedCandidates = uniqueCandidates(normalizeStateCandidatesFromFetchedObjects(fetched));
        const fetchedIds = candidateIds(fetchedCandidates);

        if (fetchedIds.length) {
            return {
                validated: true,
                source: 'server',
                totalCandidates: fetchedIds.length,
                matchCount: fetchedIds.length,
                matchedIds: fetchedIds,
                allCandidateIds: fetchedCandidates
            };
        }

        const fallbackAll = await connectionManager.getObjects(settings.serverId, '*', 'state');
        const allCandidates = uniqueCandidates(normalizeStateCandidatesFromFetchedObjects(fallbackAll));
        const allIds = candidateIds(allCandidates);
        const matched = allIds.filter(id => regex.test(id));

        return {
            validated: true,
            source: 'server',
            totalCandidates: allIds.length,
            matchCount: matched.length,
            matchedIds: matched,
            allCandidateIds: allCandidates
        };
    } catch (error) {
        return {
            validated: false,
            source: 'unavailable',
            reason: error.message,
            matchCount: 0,
            matchedIds: [],
            allCandidateIds: []
        };
    }
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

    const validation = await validateQueryStateId(query.stateId, msg, settings);
    const intentText = `${question} ${query.notes || ''} ${query.stateId || ''}`;
    const suggestionIds = selectSuggestionIds(validation.allCandidateIds || [], query.stateId, intentText, 20);

    if (validation.validated && validation.matchCount === 0) {
        const best = findBestStateIdCandidate(validation.allCandidateIds || [], query.stateId, intentText);
        const resolved = resolveBestCandidateWithConfidence(best);

        if (resolved.resolved && resolved.selectedId) {
            query.stateId = resolved.selectedId;
            return {
                mode: 'query',
                llmUsed: true,
                usage: response.usage,
                query,
                queryValidation: {
                    validated: validation.validated,
                    source: validation.source,
                    matchCount: validation.matchCount,
                    totalCandidates: validation.totalCandidates || 0,
                    resolvedStateIds: [resolved.selectedId],
                    fallbackResolution: 'best-candidate',
                    confidenceReason: resolved.reason,
                    scoreGap: resolved.scoreGap,
                    topMatches: resolved.topMatches,
                    suggestions: suggestionIds,
                    reason: validation.reason || null
                }
            };
        }

        return {
            mode: 'query',
            llmUsed: true,
            usage: response.usage,
            error: `No matching state IDs found for query.stateId="${query.stateId}" and candidate resolution is ambiguous.`,
            hint: 'Bitte Device/Raum präzisieren (z. B. "Wohnzimmer", "Lora esp03") oder msg.objects inkl. Enums zuführen.',
            query,
            queryValidation: {
                ...validation,
                fallbackResolution: 'ambiguous',
                confidenceReason: resolved.reason,
                scoreGap: resolved.scoreGap,
                topMatches: resolved.topMatches,
                suggestions: suggestionIds
            }
        };
    }

    if (validation.validated && validation.matchCount === 1) {
        query.stateId = validation.matchedIds[0];
    }

    return {
        mode: 'query',
        llmUsed: true,
        usage: response.usage,
        query,
        queryValidation: {
            validated: validation.validated,
            source: validation.source,
            matchCount: validation.matchCount,
            totalCandidates: validation.totalCandidates || 0,
            resolvedStateIds: (validation.matchedIds || []).slice(0, 50),
            suggestions: suggestionIds,
            reason: validation.reason || null
        }
    };
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
        const { globalConfig, serverId } = serverConfig;

        const settings = {
            mode:             config.mode             || 'analyze',
            historyAdapter:   config.historyAdapter   || '',
            auditPattern:     config.auditPattern     || '*',
            anomalyThreshold: parseFloat(config.anomalyThreshold) || 2.5,
            outputProperty:   config.outputProperty?.trim() || 'payload',
            nodeId:           node.id,
            serverId,
            globalConfig
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
                temperature: globalConfig.aiTemperature,
                allowInsecureTls: globalConfig.aiAllowInsecureTls === true
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
                    case 'history-audit':
                        result = await modeHistoryAudit(msg, settings);
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
                    let statusText;
                    if (result.llmUsed) {
                        statusText = `✓ ${mode} (${result.usage?.total_tokens || '?'} tokens)`;
                    } else if (result.llmConfigured === false) {
                        statusText = `✓ ${mode} (local: ${result.llmReason || 'llm-not-configured'})`;
                    } else {
                        statusText = `✓ ${mode}`;
                    }
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
