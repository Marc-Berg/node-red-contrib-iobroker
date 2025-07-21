/*!
 * Event Bus for ioBroker Node-RED Integration
 * Singleton event emitter for decoupled service communication
 */

const EventEmitter = require('events');
const LoggingService = require('../logging');

class EventBus extends EventEmitter {
    constructor() {
        super();
        // Increase listener limit for complex systems
        this.setMaxListeners(50);
        this.logger = null; // Will be initialized when LoggingService is ready
    }

    emit(event, ...args) {
        // For debugging: log all emitted events
        if (this.logger) {
            this.logger.trace(`Emitting: ${event}`, args.length > 0 ? args : '');
        } else {
            // Fallback to console if LoggingService not yet initialized
            console.log(`[EventBus] Emitting: ${event}`, args.length > 0 ? args : '');
        }
        super.emit(event, ...args);
    }

    initLogger() {
        this.logger = LoggingService.getLogger('EventBus');
    }
}

// Export a single instance to be used throughout the application
module.exports = new EventBus();