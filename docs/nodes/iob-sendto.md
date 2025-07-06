# WS ioB sendTo - Send Commands to Adapters

Send commands and messages to ioBroker adapters using the sendTo functionality for service integration, notifications, and automation tasks.

## Purpose

The WS ioB sendTo node allows you to send commands directly to ioBroker adapters that support the sendTo interface. This enables integration with notification services, database operations, script execution, media control, and many other adapter-specific functions from within Node-RED flows.

## Configuration

### Basic Settings

**Target Adapter**
- Dropdown selection of available adapters grouped by status:
  - 🟢 **Running Adapters**: Currently active and ready to receive commands
  - 🟡 **Enabled Adapters**: Enabled but not currently running
  - 🔴 **Disabled Adapters**: Available but disabled
  - ✏️ **Custom / Manual Input**: Enter any adapter name manually
- Leave empty to use `msg.adapter` for dynamic targeting
- Examples: `telegram.0`, `email`, `sql.0`, `javascript.0`

**Command**
- Optional command parameter required by some adapters
- Common commands: `send`, `query`, `toScript`, `play`, `stop`
- Leave empty if adapter doesn't require a command
- Can be overridden by `msg.command`

**Static Message**
- Optional JSON message content to send to the adapter
- If empty, `msg.payload` will be used as the message content
- Must be valid JSON when specified
- Can be overridden by `msg.message`

**Wait for Response**
- **Disabled (Fire-and-forget)**: Send command without waiting for response
- **Enabled (Response mode)**: Wait for adapter response and send as output

**Response Timeout** (Response mode only)
- Maximum time to wait for adapter response (1000-60000 milliseconds)
- Default: 10000ms (10 seconds)
- Can be overridden by `msg.timeout`

## Dynamic Configuration

Override static settings using message properties:

### Dynamic Adapter Targeting
```javascript
msg.adapter = "telegram.0";
msg.payload = { text: "Hello!", user: "admin" };
```

### Dynamic Command Selection
```javascript
msg.adapter = "sql.0";
msg.command = "query";
msg.payload = "SELECT * FROM sensors WHERE timestamp > NOW() - INTERVAL 1 HOUR";
```

### Dynamic Message Content
```javascript
msg.adapter = "javascript.0";
msg.command = "toScript";
msg.message = {
    script: "myAutomationScript",
    data: { temperature: 25, humidity: 60 }
};
```

### Dynamic Response Timeout
```javascript
msg.adapter = "influxdb.0";
msg.command = "query";
msg.timeout = 30000; // 30 seconds for complex database queries
```

## Adapter Categories and Examples

### Notification Adapters

**Telegram Notifications**
- **Adapter**: `telegram.0`
- **Command**: `send`
- **Message**: `{ text: "Alert message", user: "username" }`

**Email Alerts**
- **Adapter**: `email`
- **Command**: (empty)
- **Message**: `{ to: "user@domain.com", subject: "Alert", text: "Message content" }`

**Push Notifications**
- **Adapter**: `pushover.0`
- **Command**: `send`
- **Message**: `{ message: "Alert", title: "Smart Home", priority: 1 }`

### Database Adapters

**SQL Database Operations**
- **Adapter**: `sql.0`
- **Command**: `query`
- **Message**: `"SELECT * FROM history WHERE device='sensor1'"`

**InfluxDB Queries**
- **Adapter**: `influxdb.0`
- **Command**: `query`
- **Message**: `"SELECT mean(value) FROM temperature WHERE time > now() - 1h"`

**History Data Retrieval**
- **Adapter**: `history.0`
- **Command**: `getHistory`
- **Message**: `{ id: "sensor.temperature", options: { start: startTime, end: endTime } }`

### Script and Logic Adapters

**JavaScript Execution**
- **Adapter**: `javascript.0`
- **Command**: `toScript`
- **Message**: `{ script: "scriptName", message: { action: "execute", data: [...] } }`

### Media and Entertainment

**Spotify Control**
- **Adapter**: `spotify-premium.0`
- **Command**: `play`
- **Message**: `{ playlist: "Morning Music", volume: 60 }`

**Sonos Control**
- **Adapter**: `sonos.0`
- **Command**: `play`
- **Message**: `{ room: "Living Room", uri: "spotify:playlist:123" }`

**Kodi Media Center**
- **Adapter**: `kodi.0`
- **Command**: `send`
- **Message**: `{ method: "Player.PlayPause", params: { playerid: 1 } }`

### System and Utility Adapters

**Backup Operations**
- **Adapter**: `backitup.0`
- **Command**: `send`
- **Message**: `{ command: "start", type: "minimal" }`

**Weather Queries**
- **Adapter**: `weather.0`
- **Command**: `getWeather`
- **Message**: `{ location: "Berlin", details: true }`

## Output Message Format (Response Mode)

When "Wait for Response" is enabled, the node outputs:

### Standard Response Properties
- **payload**: Adapter response data (varies by adapter and command)
- **adapter**: Target adapter that was called
- **command**: Command that was sent (if any)
- **originalMessage**: Original message content sent to adapter
- **responseTime**: Time taken for response in milliseconds
- **timestamp**: When response was received

### Example Response Messages

**Telegram Send Response:**
```javascript
{
    payload: { success: true, messageId: 123 },
    adapter: "telegram.0",
    command: "send",
    originalMessage: { text: "Hello!", user: "admin" },
    responseTime: 245,
    timestamp: 1640995200000
}
```

**SQL Query Response:**
```javascript
{
    payload: [
        { id: 1, sensor: "temp1", value: 23.5, timestamp: "2024-01-01 12:00:00" },
        { id: 2, sensor: "temp1", value: 23.7, timestamp: "2024-01-01 12:05:00" }
    ],
    adapter: "sql.0",
    command: "query",
    originalMessage: "SELECT * FROM sensors WHERE sensor='temp1'",
    responseTime: 156,
    timestamp: 1640995200000
}
```

**Script Execution Response:**
```javascript
{
    payload: { 
        result: "success", 
        output: "Script completed successfully",
        data: { processed: 42, errors: 0 }
    },
    adapter: "javascript.0",
    command: "toScript",
    originalMessage: { script: "dataProcessor", input: [...] },
    responseTime: 1234,
    timestamp: 1640995200000
}
```

## Fire-and-Forget Mode

When "Wait for Response" is disabled:
- Command is sent without waiting for response
- No output message is generated
- Faster execution for simple notifications
- Suitable for commands where response is not needed

## Common Use Cases

### Smart Home Notifications
```javascript
// Motion detection alert
msg.adapter = "telegram.0";
msg.command = "send";
msg.payload = {
    text: `Motion detected in ${msg.room} at ${new Date().toLocaleTimeString()}`,
    user: "homeowner"
};
```

### Data Analysis and Reporting
```javascript
// Daily energy consumption report
msg.adapter = "sql.0";
msg.command = "query";
msg.payload = `
    SELECT DATE(timestamp) as date, SUM(consumption) as total 
    FROM energy_log 
    WHERE timestamp >= CURDATE() - INTERVAL 7 DAY 
    GROUP BY DATE(timestamp)
`;
```

### Automated Backup Management
```javascript
// Scheduled backup trigger
msg.adapter = "backitup.0";
msg.command = "send";
msg.payload = {
    command: "start",
    type: "complete",
    ccuOption: "yes"
};
```

### Media Automation
```javascript
// Morning routine music
msg.adapter = "spotify-premium.0";
msg.command = "play";
msg.payload = {
    device: "Living Room Speaker",
    playlist: "Morning Motivation",
    volume: 40,
    shuffle: true
};
```

### Dynamic Script Execution
```javascript
// Process sensor data through custom script
msg.adapter = "javascript.0";
msg.command = "toScript";
msg.payload = {
    script: "sensorDataProcessor",
    message: {
        sensorData: msg.sensorReadings,
        timestamp: Date.now(),
        action: "analyze"
    }
};
```

## Error Handling

### Common Error Scenarios
- **Adapter not found**: Specified adapter doesn't exist or isn't running
- **Invalid command**: Command not supported by the target adapter
- **Timeout**: Adapter didn't respond within the specified timeout period
- **Invalid message format**: Message content not compatible with adapter expectations
- **Permission denied**: Insufficient rights to execute command on adapter

### Error Response Format
When an error occurs, the output includes:
```javascript
{
    error: "Timeout waiting for response from telegram.0",
    adapter: "telegram.0",
    command: "send",
    originalMessage: { text: "Test message" },
    timestamp: 1640995200000
}
```

### Error Recovery Strategies
1. **Implement retry logic** for network-related timeouts
2. **Validate adapter availability** before sending commands
3. **Use appropriate timeouts** based on expected response times
4. **Handle graceful degradation** for non-critical notifications
5. **Monitor adapter status** and adjust flows accordingly

## Performance Considerations

### Response Mode vs Fire-and-Forget
- **Fire-and-forget**: Faster execution, no feedback, suitable for notifications
- **Response mode**: Provides feedback but adds latency and resource usage

### Timeout Configuration
- **Short timeouts (1-5s)**: Simple commands like notifications
- **Medium timeouts (5-15s)**: Database queries and file operations
- **Long timeouts (15-60s)**: Complex processing and large data transfers

### Adapter Load Management
- **Batch commands** when possible to reduce adapter load
- **Implement delays** between rapid successive commands
- **Monitor adapter performance** and adjust command frequency
- **Use connection pooling** features when available

## Integration Patterns

### Notification Chains
```javascript
// Multi-channel alert system
[Sensor Alert] → [WS ioB sendTo: Email] → [WS ioB sendTo: Telegram] → [WS ioB sendTo: Slack]
```

### Data Pipeline
```javascript
// Sensor data processing pipeline
[Data Collection] → [WS ioB sendTo: Script Processing] → [WS ioB sendTo: Database Storage] → [Dashboard Update]
```

### Conditional Automation
```javascript
// Adaptive home automation
[Time Trigger] → [WS ioB sendTo: Weather Query] → [Condition Check] → [WS ioB sendTo: Heating Control]
```

## Troubleshooting

### Adapter Not Responding
1. **Check adapter status** in ioBroker admin interface
2. **Verify adapter supports sendTo** functionality
3. **Test command manually** in ioBroker scripts or admin
4. **Check adapter logs** for error messages
5. **Restart adapter** if necessary

### Command Format Issues
1. **Review adapter documentation** for correct command format
2. **Test with minimal message** first
3. **Validate JSON syntax** in static messages
4. **Check parameter types** (string vs object vs array)
5. **Use adapter examples** from ioBroker community

### Timeout Problems
1. **Increase timeout value** for complex operations
2. **Check network connectivity** between systems
3. **Monitor adapter resource usage** (CPU, memory)
4. **Verify database performance** for data adapters
5. **Test during low-load periods** to isolate performance issues

## Related Nodes

- **WS ioB in**: Monitor adapter states and responses
- **WS ioB out**: Control adapter settings and configurations
- **WS ioB get**: Read adapter status and information
- **WS ioB log**: Monitor adapter log messages for debugging

## Examples

See [Common Use Cases](../use-cases.md) for practical implementation examples and complete flow configurations.