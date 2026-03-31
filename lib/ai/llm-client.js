'use strict';

/**
 * LLMClient – thin abstraction over OpenAI-compatible APIs (OpenAI, Azure, Ollama).
 *
 * All three providers expose an OpenAI-compatible /chat/completions endpoint,
 * so a single fetch-based implementation covers all of them.
 *
 * Only Node built-ins + the already-bundled `node-fetch` fallback are used;
 * no additional npm dependency is required (Node ≥ 18 has native fetch).
 */

const https = require('https');
const http  = require('http');

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal HTTP/HTTPS POST that works without any external dependencies.
 * Returns parsed JSON or throws on network/HTTP errors.
 */
function jsonPost(url, body, headers, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const parsed   = new URL(url);
        const isHttps  = parsed.protocol === 'https:';
        const lib      = isHttps ? https : http;
        const data     = JSON.stringify(body);

        const options = {
            hostname:      parsed.hostname,
            port:          parsed.port || (isHttps ? 443 : 80),
            path:          parsed.pathname + parsed.search,
            method:        'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(data),
                ...headers
            },
            // Accept self-signed certs (mirrors SocketClient behaviour)
            rejectUnauthorized: false
        };

        const req = lib.request(options, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(raw);
                    if (res.statusCode >= 400) {
                        const msg = json.error?.message || json.error || raw;
                        reject(new Error(`HTTP ${res.statusCode}: ${msg}`));
                    } else {
                        resolve(json);
                    }
                } catch (_) {
                    reject(new Error(`Invalid JSON response (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`));
                }
            });
        });

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`LLM request timed out after ${timeoutMs}ms`));
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// ── LLMClient ────────────────────────────────────────────────────────────────

class LLMClient {
    /**
     * @param {object} opts
     * @param {'openai'|'ollama'|'azure'} opts.provider
     * @param {string} opts.model
     * @param {string} [opts.apiKey]       – required for openai / azure
     * @param {string} [opts.baseUrl]      – required for ollama / azure
     * @param {number} [opts.maxTokens]    – default 2000
     * @param {number} [opts.temperature]  – default 0.3
     * @param {number} [opts.timeoutMs]    – default 60 000
     */
    constructor(opts = {}) {
        this.provider    = opts.provider    || 'none';
        this.model       = opts.model       || '';
        this.apiKey      = opts.apiKey      || '';
        this.baseUrl     = (opts.baseUrl || '').replace(/\/$/, '');
        this.maxTokens   = opts.maxTokens   || 2000;
        this.temperature = opts.temperature !== undefined ? opts.temperature : 0.3;
        this.timeoutMs   = opts.timeoutMs   || 60000;
    }

    /**
     * Returns true when this client is properly configured.
     */
    isConfigured() {
        if (this.provider === 'none' || !this.provider) return false;
        if (!this.model) return false;
        if (this.provider === 'openai' && !this.apiKey) return false;
        if (this.provider === 'azure'  && (!this.apiKey || !this.baseUrl)) return false;
        if (this.provider === 'ollama' && !this.baseUrl) return false;
        return true;
    }

    /**
     * Resolve the endpoint URL for the chat completions API.
     */
    _endpoint() {
        switch (this.provider) {
            case 'openai':
                return 'https://api.openai.com/v1/chat/completions';
            case 'ollama':
                return `${this.baseUrl}/api/chat`;
            case 'azure':
                // Azure: https://<resource>.openai.azure.com/openai/deployments/<model>/chat/completions?api-version=2024-02-01
                return `${this.baseUrl}/openai/deployments/${this.model}/chat/completions?api-version=2024-02-01`;
            default:
                throw new Error(`Unknown LLM provider: ${this.provider}`);
        }
    }

    /**
     * Build request headers for the given provider.
     */
    _headers() {
        switch (this.provider) {
            case 'openai':
                return { Authorization: `Bearer ${this.apiKey}` };
            case 'azure':
                return { 'api-key': this.apiKey };
            case 'ollama':
                return {};
            default:
                return {};
        }
    }

    /**
     * Build request body.
     * Ollama uses a slightly different schema (`stream: false`), but the
     * messages array is identical to OpenAI.
     */
    _body(messages) {
        const base = {
            model:       this.model,
            messages,
            temperature: this.temperature,
            max_tokens:  this.maxTokens,
            stream:      false
        };

        if (this.provider === 'ollama') {
            // Ollama uses `num_predict` instead of `max_tokens`
            delete base.max_tokens;
            base.options = { num_predict: this.maxTokens, temperature: this.temperature };
            delete base.temperature;
        }

        return base;
    }

    /**
     * Send a chat request.
     *
     * @param {Array<{role: string, content: string}>} messages
     * @returns {Promise<{text: string, model: string, usage: object}>}
     */
    async chat(messages) {
        if (!this.isConfigured()) {
            throw new Error('LLM client is not configured (provider or model missing)');
        }

        const url     = this._endpoint();
        const headers = this._headers();
        const body    = this._body(messages);

        const data = await jsonPost(url, body, headers, this.timeoutMs);

        // Normalise response across providers
        let text;
        if (this.provider === 'ollama') {
            // Ollama non-streaming: { message: { role, content }, done: true, model, ... }
            text = data.message?.content ?? data.choices?.[0]?.message?.content ?? '';
        } else {
            // OpenAI / Azure
            text = data.choices?.[0]?.message?.content ?? '';
        }

        return {
            text,
            model: data.model || this.model,
            usage: data.usage || {}
        };
    }

    /**
     * Convenience: single-turn prompt with optional system message.
     *
     * @param {string} prompt
     * @param {string} [systemPrompt]
     */
    async ask(prompt, systemPrompt) {
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });
        return this.chat(messages);
    }
}

module.exports = { LLMClient };
