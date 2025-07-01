# WS ioB get - State Getter

Read current state values from ioBroker on demand without continuous subscription.

## Purpose

The WS ioB get node allows you to retrieve the current value of ioBroker states when triggered by an incoming message. Unlike `WS ioB in` which continuously monitors states, this node reads values only when requested.

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

## Performance Considerations

### Request Frequency
- Avoid rapid successive requests to same state
- Implement debouncing for user-triggered reads
- Consider using `WS ioB in` for frequently changing values

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

## Related Nodes

- **WS ioB in**: Continuous state monitoring
- **WS ioB out**: Write values to states
- **WS ioB getObject**: Read object definitions

## Examples

See [Common Use Cases](../use-cases.md) for practical implementation examples.