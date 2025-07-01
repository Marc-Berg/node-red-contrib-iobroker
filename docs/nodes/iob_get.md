# WS ioB get - State Getter

Read current state values from ioBroker on demand without continuous subscription.

## Purpose

The WS ioB get node allows you to retrieve the current value of ioBroker states when triggered by an incoming message. Unlike WS ioB in which continuously monitors states, this node reads values only when requested.

## Configuration

### Basic Settings

**State**
- Target state ID to read (e.g., `0_userdata.0.temperature`)
- Leave empty to use `msg.topic` for dynamic state selection
- Supports single state IDs only (no wildcards)

**Output Property**
- Target message property for the retrieved value
- Default: `payload`
- Can be set to any valid message property

## Usage Patterns

### Static State Reading
Configure a specific state ID in the node and trigger with any message:

1. Set state to `system.adapter.admin.0.alive`
2. Send any message to trigger reading
3. Receive current value in `msg.payload`

### Dynamic State Reading
Use `msg.topic` to specify which state to read at runtime:

```javascript
// In function node before WS ioB get
msg.topic = "0_userdata.0.temperature";
return msg;
```

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

**Initialization Reading**
- Read current states on Node-RED startup
- Initialize dashboard displays
- Restore last known values

## Output Message Format

The node preserves the original message and adds the state information:

**Retrieved Value**
- Target property (default `payload`): The current state value
- Original message properties are preserved

**Additional Properties**
- `topic`: The state ID that was read (if not already set)
- `timestamp`: When the value was retrieved

**State Information**
Complete state object available in `msg.state`:
- `val`: The actual value
- `ack`: Acknowledgment flag
- `ts`: State timestamp
- `from`: Source that last changed the state
- `lc`: Last change timestamp
- `q`: Quality indicator

**Example Output**
```
{
  // Original message properties preserved
  payload: 23.5,
  topic: "0_userdata.0.temperature",
  timestamp: 1640995200000,
  state: {
    val: 23.5,
    ack: true,
    ts: 1640995150000,
    from: "system.adapter.javascript.0",
    lc: 1640995100000,
    q: 0
  }
}
```

## Advanced Usage

### Multiple State Reading
To read multiple states, use multiple WS ioB get nodes or implement a loop:

```javascript
// Function node to read multiple states
const states = ["temp1", "temp2", "temp3"];
let messages = [];

for (let state of states) {
    messages.push({
        ...msg,
        topic: `sensors.${state}.temperature`
    });
}

return [messages];
```

### Conditional Reading
Read states based on conditions:

```javascript
// Only read temperature if motion detected
if (msg.payload === true) {
    msg.topic = "sensors.room.temperature";
    return msg;
}
return null;
```

### Data Aggregation
Collect multiple readings for analysis:

```javascript
// Store readings in context
let readings = context.get('readings') || [];
readings.push({
    state: msg.topic,
    value: msg.payload,
    timestamp: msg.timestamp
});

context.set('readings', readings.slice(-100)); // Keep last 100
msg.readings = readings;
return msg;
```

## Error Handling

### Common Errors
- **State not found**: The specified state ID doesn't exist
- **Permission denied**: User lacks read permissions
- **Connection error**: WebSocket connection is unavailable
- **Timeout**: Request took too long to complete

### Error Response
When an error occurs:
- `msg.error` contains error information
- `msg.payload` may be undefined or contain error details
- Node status shows error state

### Error Recovery
```javascript
// Check for errors before processing
if (msg.error) {
    node.warn(`Failed to read ${msg.topic}: ${msg.error}`);
    return null;
}

// Process successful reading
return msg;
```

## Performance Considerations

### Request Frequency
- Avoid rapid successive requests to same state
- Implement debouncing for user-triggered reads
- Consider using WS ioB in for frequently changing values

### Batch Optimization
- Group multiple readings when possible
- Use separate nodes for independent readings
- Avoid blocking flows with slow requests

### Connection Efficiency
- Reuse connection across multiple get nodes
- Monitor connection status
- Implement retry logic for failed requests

## Comparison with Other Nodes

### vs WS ioB in
- **WS ioB get**: On-demand reading, no continuous monitoring
- **WS ioB in**: Continuous subscription, automatic updates

### vs WS ioB history
- **WS ioB get**: Current value only
- **WS ioB history**: Historical data over time ranges

### Use Cases for WS ioB get
- One-time status checks
- Initialization sequences
- Manual refresh operations
- Conditional reading based on events

## Best Practices

### State Selection
- Use specific state IDs for better performance
- Validate state existence before reading
- Handle missing states gracefully

### Message Flow Design
- Preserve original message context
- Implement proper error handling
- Use meaningful property names

### Resource Management
- Limit concurrent requests
- Implement timeouts for long operations
- Monitor node performance

## Troubleshooting

### No Response
1. Check state ID exists in ioBroker
2. Verify WebSocket connection
3. Confirm read permissions
4. Test with simple static state

### Incorrect Values
1. Check state timestamp for staleness
2. Verify quality indicator
3. Confirm acknowledgment status
4. Review source adapter status

### Performance Issues
1. Reduce request frequency
2. Check for connection problems
3. Monitor system resources
4. Optimize flow design

## Integration Examples

### Dashboard Refresh
```javascript
// Manual refresh button
[Inject] → [WS ioB get: "sensors.*.temperature"] → [Dashboard]
```

### Status Check
```javascript
// Check adapter status before operation
[Event] → [WS ioB get: "system.adapter.hue.0.alive"] → [Switch] → [Action]
```

### Initialization
```javascript
// Read current states on startup
[Inject: once on start] → [WS ioB get] → [Initialize Dashboard]
```

## Related Nodes

- **WS ioB in**: Continuous state monitoring
- **WS ioB out**: Write values to states
- **WS ioB getObject**: Read object definitions

## Examples

See [Common Use Cases](use-cases.md) for practical implementation examples.