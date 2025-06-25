/*!
 * State Handler for ioBroker WebSocket Client
 * Manages state subscriptions, caching, and initial value requests
 */

class StateHandler {
    constructor(client) {
        this.client = client;
        this.subscriptions = new Map();
        this.stateCache = new Map();
        this.pendingStateRequests = new Map();
    }

    async getState(stateId, useCache = false) {
        // Check cache first if requested
        if (useCache && this.stateCache.has(stateId)) {
            const cached = this.stateCache.get(stateId);
            const age = Date.now() - cached.cachedAt;
            if (age < 5000) { // 5 second cache
                this.client.log.debug(`Using cached state for ${stateId} (age: ${age}ms)`);
                return cached.state;
            }
        }

        // Check for pending request
        if (this.pendingStateRequests.has(stateId)) {
            this.client.log.debug(`Waiting for pending getState request for ${stateId}`);
            return await this.pendingStateRequests.get(stateId);
        }

        // Create new request
        const requestPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingStateRequests.delete(stateId);
                reject(new Error(`getState timeout for ${stateId}`));
            }, 8000);

            this.client.emit('getState', stateId, (err, state) => {
                clearTimeout(timeout);
                this.pendingStateRequests.delete(stateId);
                
                if (err) {
                    reject(new Error(err));
                } else {
                    // Cache the result
                    if (state) {
                        this.stateCache.set(stateId, {
                            state: state,
                            cachedAt: Date.now()
                        });
                    }
                    resolve(state);
                }
            });
        });

        this.pendingStateRequests.set(stateId, requestPromise);
        return await requestPromise;
    }

    async subscribe(stateIdOrPattern, callback) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Subscribe timeout for ${stateIdOrPattern}`));
            }, 5000);

            this.client.emit('subscribe', stateIdOrPattern, (err) => {
                clearTimeout(timeout);
                
                if (err) {
                    reject(new Error(err));
                } else {
                    // Track subscription
                    this.subscriptions.set(stateIdOrPattern, {
                        callback: callback,
                        subscribedAt: Date.now()
                    });
                    
                    this.client.log.debug(`Successfully subscribed to ${stateIdOrPattern}`);
                    resolve();
                }
            });
        });
    }

    async requestInitialValue(stateId) {
        try {
            const state = await this.getState(stateId, false); // Don't use cache for initial values
            if (state && state.val !== undefined) {
                this.client.log.debug(`Initial value retrieved for ${stateId}: ${JSON.stringify(state)}`);
                return state;
            } else {
                this.client.log.debug(`No initial value found for ${stateId}`);
                return null;
            }
        } catch (error) {
            this.client.log.error(`Failed to get initial value for ${stateId}: ${error.message}`);
            throw error;
        }
    }

    clear() {
        this.stateCache.clear();
        this.pendingStateRequests.clear();
    }

    destroy() {
        this.clear();
        this.subscriptions.clear();
    }
}

module.exports = StateHandler;