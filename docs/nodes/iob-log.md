# WS ioB log - Live Log Monitoring

Subscribe to ioBroker live log messages for real-time system monitoring and debugging.

## Purpose

The WS ioB log node allows you to monitor ioBroker's live log stream in real-time. This is essential for system monitoring, troubleshooting, error detection, and maintaining awareness of system activities across all adapters and components.

## Configuration

### Basic Settings

**Log Level**
- **silly**: Most verbose, includes all messages
- **debug**: Detailed debugging information
- **info**: General information messages
- **warn**: Warning messages that need attention
- **error**: Error messages requiring immediate attention

**Output Property**
- Target message property for log message text
- Default: `payload`
- Can be set to any valid message property

**Include Metadata**
- When enabled, includes additional log metadata
- Provides source, timestamp, and log level information
- Useful for detailed log analysis

## Log Levels Explained

### Error Level
Critical issues requiring immediate attention:
- Adapter crashes and startup failures
- Connection errors to external systems
- Configuration errors preventing operation
- Hardware communication failures

### Warn Level  
Important issues that should be monitored:
- Deprecated feature usage warnings
- Non-critical connection issues
- Performance warnings
- Configuration recommendations

### Info Level
General operational information:
- Adapter startup and shutdown messages
- Successful connections and operations
- Configuration changes
- Normal operational events

### Debug Level
Detailed information for troubleshooting:
- Function entry/exit messages
- Detailed operation steps
- Internal state information
- Protocol-level communications

### Silly Level
Extremely verbose debugging information:
- Very detailed internal operations
- Raw data dumps
- Timing information
- Development debugging messages

## Output Message Format

### Basic Format
When metadata is disabled:
```javascript
{
  payload: "Adapter started successfully",
  timestamp: 1640995200000
}
```

### Extended Format
When metadata is enabled:
```javascript
{
  payload: "Adapter started successfully",
  level: "info",
  source: "system.adapter.hue.0",
  timestamp: "2024-01-01T12:00:00.000Z",
  severity: 3,
  from: "hue.0"
}
```

### Message Properties
- **payload**: The actual log message text
- **level**: Log level (error, warn, info, debug, silly)
- **source**: Full source identifier
- **timestamp**: ISO timestamp string
- **severity**: Numeric severity (1=error, 2=warn, 3=info, 4=debug, 5=silly)
- **from**: Short source name

## Filtering and Processing

### Level-Based Filtering
The configured log level acts as a minimum threshold:
- **error**: Only error messages
- **warn**: Warning and error messages
- **info**: Info, warning, and error messages
- **debug**: Debug, info, warning, and error messages
- **silly**: All messages

### Source Filtering
Filter messages by source adapter:

```javascript
// Only show Hue adapter messages
if (msg.source && msg.source.includes("hue")) {
    return msg;
}
return null;
```

### Content Filtering
Filter by message content:

```javascript
// Only show error-related content
if (msg.payload && msg.payload.toLowerCase().includes("error")) {
    return msg;
}
return null;
```

### Time-Based Filtering
Filter recent messages:

```javascript
// Only messages from last 5 minutes
const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
if (msg.timestamp && new Date(msg.timestamp).getTime() > fiveMinutesAgo) {
    return msg;
}
return null;
```

## Advanced Usage

### Error Aggregation
Collect and summarize error patterns:

```javascript
// Count errors by adapter
let errorCounts = context.get('errorCounts') || {};
if (msg.level === 'error' && msg.source) {
    const adapter = msg.source.split('.')[2];
    errorCounts[adapter] = (errorCounts[adapter] || 0) + 1;
    context.set('errorCounts', errorCounts);
    
    msg.errorSummary = errorCounts;
}
return msg;
```

### Alert Generation
Generate alerts for critical messages:

```javascript
// Generate alerts for critical errors
const criticalKeywords = ['crash', 'fatal', 'failed to start', 'connection lost'];
const isCritical = criticalKeywords.some(keyword => 
    msg.payload.toLowerCase().includes(keyword)
);

if (msg.level === 'error' && isCritical) {
    msg.alert = {
        type: 'critical',
        source: msg.source,
        message: msg.payload,
        timestamp: msg.timestamp
    };
    return msg;
}
return null;
```

### Log Pattern Analysis
Analyze log patterns for trends:

```javascript
// Track startup/shutdown patterns
if (msg.payload.includes('started') || msg.payload.includes('stopped')) {
    let events = context.get('adapterEvents') || [];
    events.push({
        adapter: msg.source,
        event: msg.payload.includes('started') ? 'start' : 'stop',
        timestamp: msg.timestamp
    });
    
    // Keep last 100 events
    events = events.slice(-100);
    context.set('adapterEvents', events);
    
    msg.events = events;
}
return msg;
```

### Performance Monitoring
Monitor system performance through logs:

```javascript
// Extract performance metrics from logs
const memoryMatch = msg.payload.match(/memory usage: (\d+)MB/);
const cpuMatch = msg.payload.match(/CPU usage: (\d+)%/);

if (memoryMatch || cpuMatch) {
    msg.metrics = {
        adapter: msg.source,
        memory: memoryMatch ? parseInt(memoryMatch[1]) : null,
        cpu: cpuMatch ? parseInt(cpuMatch[1]) : null,
        timestamp: msg.timestamp
    };
    return msg;
}
return null;
```

## System Monitoring Use Cases

### Adapter Health Monitoring
Monitor adapter lifecycle events:

```javascript
// Track adapter status changes
const statusKeywords = ['started', 'stopped', 'crashed', 'restarted'];
const hasStatus = statusKeywords.some(keyword => 
    msg.payload.toLowerCase().includes(keyword)
);

if (hasStatus) {
    msg.adapterStatus = {
        adapter: msg.source,
        status: statusKeywords.find(keyword => 
            msg.payload.toLowerCase().includes(keyword)
        ),
        timestamp: msg.timestamp
    };
    return msg;
}
```

### Error Rate Monitoring
Track error frequency over time:

```javascript
// Calculate error rate per hour
if (msg.level === 'error') {
    const hour = new Date(msg.timestamp).getHours();
    let hourlyErrors = context.get('hourlyErrors') || {};
    hourlyErrors[hour] = (hourlyErrors[hour] || 0) + 1;
    context.set('hourlyErrors', hourlyErrors);
    
    msg.errorRate = hourlyErrors;
}
return msg;
```

### Connection Monitoring
Monitor external connections:

```javascript
// Track connection events
const connectionKeywords = ['connected', 'disconnected', 'timeout', 'reconnecting'];
const hasConnection = connectionKeywords.some(keyword => 
    msg.payload.toLowerCase().includes(keyword)
);

if (hasConnection) {
    msg.connectionEvent = {
        type: connectionKeywords.find(keyword => 
            msg.payload.toLowerCase().includes(keyword)
        ),
        adapter: msg.source,
        timestamp: msg.timestamp
    };
    return msg;
}
```

## Performance Considerations

### Message Volume
Log monitoring can generate high message volumes:
- Start with higher log levels (error, warn)
- Implement filtering early in the flow
- Use rate limiting for high-frequency logs
- Monitor Node-RED memory usage

### Processing Efficiency
- Keep filtering logic simple and fast
- Use context storage efficiently
- Implement circular buffers for historical data
- Avoid complex regex operations in filters

### Resource Management
- Limit stored log history
- Clean up old context data regularly
- Monitor CPU usage during log processing
- Implement backpressure handling

## Alert Integration

### Email Notifications
```javascript
// Format email alerts
if (msg.level === 'error') {
    msg.topic = `ioBroker Error: ${msg.source}`;
    msg.payload = `
        Error in ${msg.source} at ${msg.timestamp}:
        ${msg.payload}
    `;
    return msg;
}
```

### Push Notifications
```javascript
// Mobile push notifications for critical errors
if (msg.level === 'error' && msg.payload.includes('critical')) {
    msg.notification = {
        title: "Critical ioBroker Error",
        body: `${msg.source}: ${msg.payload}`,
        priority: "high"
    };
    return msg;
}
```

### Dashboard Integration
```javascript
// Format for dashboard display
msg.dashboard = {
    level: msg.level,
    source: msg.source.split('.')[2], // Adapter name only
    message: msg.payload.substring(0, 100), // Truncate long messages
    timestamp: new Date(msg.timestamp).toLocaleTimeString(),
    color: {
        error: 'red',
        warn: 'orange', 
        info: 'blue',
        debug: 'gray'
    }[msg.level] || 'black'
};
return msg;
```

## Security and Privacy

### Sensitive Information
- Filter out passwords and API keys from logs
- Sanitize personal data before processing
- Implement log redaction for sensitive adapters
- Monitor for data leakage in error messages

### Access Control
- Limit log access to authorized users only
- Implement audit trails for log access
- Consider log retention policies
- Secure log storage and transmission

## Troubleshooting

### No Log Messages
1. Check Admin adapter is running (required for logs)
2. Verify WebSocket connection
3. Confirm log level is appropriate
4. Test with lower (more verbose) log level

### Too Many Messages
1. Increase log level threshold
2. Implement source filtering
3. Add content-based filtering
4. Monitor Node-RED performance

### Missing Important Logs
1. Check adapter logging configuration
2. Verify log level settings in ioBroker
3. Confirm adapter is generating logs
4. Test with silly level temporarily

## Best Practices

### Log Level Strategy
- Use **error** level for production monitoring
- Use **warn** level for operational awareness
- Use **info** level for general monitoring
- Use **debug/silly** only for troubleshooting

### Message Processing
- Filter early and efficiently
- Implement proper error handling
- Use meaningful variable names
- Document filtering logic

### Storage and Retention
- Limit stored log data volume
- Implement log rotation
- Consider external log storage
- Plan for log analysis needs

## Integration Examples

### Error Dashboard
```
[WS ioB log: error] → [Format] → [Dashboard Error Panel]
```

### Email Alerts
```
[WS ioB log: error] → [Filter Critical] → [Email Node]
```

### Log Analysis
```
[WS ioB log: info] → [Parse] → [Database] → [Analytics]
```

## Related Nodes

- **WS ioB in**: Monitor state changes
- **WS ioB inObj**: Monitor object changes
- **WS ioB getObject**: Get adapter information

## Examples

See [Common Use Cases](use-cases.md) for practical implementation examples.