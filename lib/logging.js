/*!
 * Logging Service for ioBroker Node-RED Integration  
 * Centralized logging management with Node-RED integration
 */

class LoggingService {
    constructor() {
        this.log = null;
        this.isInitialized = false;
    }

    init(RED) {
        if (this.isInitialized) return;
        this.log = RED.log;
        this.isInitialized = true;
    }

    getLogger(name) {
        const prefix = `[${name}]`;
        if (!this.isInitialized) {
            console.warn(`[LoggingService] Logger for ${name} created before initialization. Falling back to console.`);
            return console;
        }
        return {
            info: (...args) => this.log.info(`${prefix} ${args.join(' ')}`),
            warn: (...args) => this.log.warn(`${prefix} ${args.join(' ')}`),
            error: (...args) => this.log.error(`${prefix} ${args.join(' ')}`),
            debug: (...args) => this.log.debug(`${prefix} ${args.join(' ')}`),
            trace: (...args) => this.log.trace(`${prefix} ${args.join(' ')}`),
        };
    }
}

module.exports = new LoggingService();