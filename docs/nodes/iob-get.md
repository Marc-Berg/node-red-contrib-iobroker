# WS ioB get - State Getter

Read current state values from ioBroker on demand with support for single states and batch processing.

## Purpose

The WS ioB get node allows you to retrieve current values of ioBroker states when triggered by an incoming message. It supports both single state reading and batch processing of multiple states with automatic alias detection.

## Configuration

### Basic Settings

**State**
- Target state ID to read (e.g., `0_userdata.0.temperature`)
- Has highest priority over dynamic inputs (`msg.objects`, `msg.topic`)
- Supports single state IDs only when configured (no wildcards)

**Output Property**
- Target message property for the retrieved value(s)
- Default: `payload`
- Can be set to any valid message property

## Input Priority

State selection follows this priority order:

1. **Configured State ID** (highest priority)
   - Always used when configured in the node
   - Overrides any dynamic input
   
2. **msg.objects** (medium priority)  
   - Auto-extracts from iob-getobject output
   - Only used when no state is configured
   
3. **msg.topic** (lowest priority)
   - Single state ID or array of state IDs
   - Only used when no state configured and no msg.objects present

## Input Formats

The node automatically detects different input formats:

### 1. Single State (msg.topic)
```javascript
msg.topic = "0_userdata.0.temperature";
```

### 2. Multiple States (msg.topic array)
```javascript
msg.topic = [
    "0_userdata.0.temperature",
    "0_userdata.0.humidity",
    "alias.0.livingroom.light"
];
```

### 3. Batch Processing (msg.objects)
Direct output from `iob-getobject` node:
```javascript
msg.objects = {
    "0_userdata.0.temp": { type: "state", aliasInfo: {...} },
    "0_userdata.0.folder": { type: "folder" },  // ignored
    "alias.0.light": { type: "state" }
};
```

## Batch Processing Features

### Automatic Type Filtering
- Processes only objects with `type: "state"`
- Ignores folders, channels, and other non-state objects
- Prevents errors when processing mixed getObject results

### Alias Support
Automatically extracts and includes:
- **aliasedBy**: Alias states that reference the original state
- **aliasTarget**: Target states referenced by alias objects
- Both simple and complex alias configurations

## Usage Patterns

### Static State Reading
Configure a specific state ID and trigger with any message:
1. Set state to `system.adapter.admin.0.alive`
2. Send any message to trigger reading
3. Receive current value in `msg.payload`

### Dynamic State Reading
Use `msg.topic` to specify which state(s) to read at runtime

### Batch State Processing
Chain with `iob-getobject` for comprehensive state retrieval:
1. `iob-getobject` → `iob-get` → Processing
2. Automatically gets all states and their aliases
3. Perfect for dashboard updates or bulk operations

### Triggered Readings
Common trigger scenarios:

**Timer-Based Reading**
- Use Inject node with repeat interval
- Read sensor values periodically
- Useful for slow-changing values

**Event-Based Reading**
- Trigger on button press or motion detection
- Read current status before making decisions
- Get baseline values for calculations

### Single State Mode
```javascript
{
    "payload": 23.5,                    // State value
    "state": {                          // Full state object
        "val": 23.5,
        "ack": true,
        "ts": 1234567890,
        "lc": 1234567890,
        "from": "system.adapter.javascript.0"
    },
    "timestamp": 1234567890,            // Read timestamp
    "topic": "Original topic preserved"
}
```

### Batch Mode (Multiple States)
Compatible with iob-in grouped message format:
```javascript
{
    "topic": "batch_states",
    "payload": {                        // State values only
        "0_userdata.0.temperature": 23.5,
        "0_userdata.0.humidity": 65,
        "alias.0.livingroom.light": true
    },
    "states": {                         // Full state objects
        "0_userdata.0.temperature": {
            "val": 23.5,
            "ack": true,
            "ts": 1234567890
        },
        "0_userdata.0.humidity": {
            "val": 65,
            "ack": true,
            "ts": 1234567890
        }
    },
    "timestamp": 1234567890
}
```

## Error Handling

### Common Error Scenarios
- **No valid state IDs found**: Check input format and state availability
- **State not found**: Verify state ID exists in ioBroker
- **Connection issues**: Node status shows connection problems

### Status Indicators
- **Green dot**: Ready for operation
- **Blue dot**: Reading state(s)
- **Red ring**: Error occurred
- **Yellow ring**: Connection issues

## Integration Examples

### Dashboard Data Collection
```javascript
// Flow: Timer → iob-getobject → iob-get → Dashboard
// Collect all device states and their aliases for display
```

### System Status Monitoring
```javascript
// Get multiple system states at once
msg.topic = [
    "system.adapter.admin.0.alive",
    "system.adapter.javascript.0.alive",
    "system.host.hostname.load"
];
```

### Alias-Aware Bulk Operations
```javascript
// Process getObject output including all aliases
// Perfect for device management and synchronization
```

## Best Practices

### Performance
- Use batch mode for multiple states instead of multiple nodes
- Leverage automatic alias detection for complete device coverage
- Consider timing between requests to avoid overloading ioBroker

### Reliability
- Handle missing states gracefully in your flow logic
- Use appropriate error handling after the node
- Monitor connection status for critical applications

### Architecture
- Chain with iob-getobject for object discovery + state reading
- Use with function nodes to filter/transform batch results
- Integrate with dashboard nodes for real-time displays

**Retrieved Value**
- Target property (default `payload`): The current state value
- Original message properties are preserved

### Use Cases for WS ioB get
- One-time status checks
- Batch data collection for dashboards
- Initialization sequences with complete device state
- Manual refresh operations with alias support
- Conditional reading based on events

## Related Nodes

- **WS ioB in**: Continuous state monitoring
- **WS ioB out**: Write values to states  
- **WS ioB getObject**: Read object definitions (perfect for chaining)

## Examples

See [Common Use Cases](../use-cases.md) for practical implementation examples.