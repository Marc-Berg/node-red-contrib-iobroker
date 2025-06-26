/*!
 * State Handler for ioBroker WebSocket Client
 * Manages state subscriptions and requests
 */

class StateHandler {
    constructor(client) {
        this.client = client;
        this.subscriptions = new Map();
        this.pendingStateRequests = new Map();
    }

    async getState(stateId) {
        if (this.pendingStateRequests.has(stateId)) {
            this.client.log.debug(`Waiting for pending getState request for ${stateId}`);
            return await this.pendingStateRequests.get(stateId);
        }

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

    clear() {
        this.pendingStateRequests.clear();
    }

    destroy() {
        this.clear();
        this.subscriptions.clear();
    }
}

module.exports = StateHandler;