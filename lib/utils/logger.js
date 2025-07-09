/*!
 * Logger Utility for ioBroker Node-RED Integration
 * Automatically uses Node-RED's logging system when available
 */
class Logger {
    static RED = null;
    
    constructor(component) {
        this.component = component;
    }

    static setRED(RED) {
        Logger.RED = RED;
    }

    getRED() {
        if (Logger.RED) {
            return Logger.RED;
        }
        if (typeof RED !== 'undefined') {
            Logger.RED = RED;
            return RED;
        }
        if (global.RED) {
            Logger.RED = global.RED;
            return global.RED;
        }
        try {
            const nodeRed = require('node-red');
            Logger.RED = nodeRed;
            return nodeRed;
        } catch (e) {
            return null;
        }
    }

    log(level, msg) {
        const formatted = `[${this.component}] ${msg}`;
        const RED = this.getRED();
        
        if (RED && RED.log && RED.log[level]) {
            RED.log[level](formatted);
        } else {
            const now = new Date();
            const day = now.getDate().toString().padStart(2, '0');
            const month = now.toLocaleDateString('en', { month: 'short' });
            const time = now.toTimeString().slice(0, 8);
            
            const consoleMethod = console[level] || console.log;
            consoleMethod(`${day} ${month} ${time} - [${level}] ${formatted}`);
        }
    }

    debug(msg) { this.log('debug', msg); }
    info(msg)  { this.log('info', msg); }
    warn(msg)  { this.log('warn', msg); }
    error(msg) { this.log('error', msg); }
}

module.exports = { Logger };