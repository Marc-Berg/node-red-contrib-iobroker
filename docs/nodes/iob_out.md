# WS ioB out - State Output

Send values to ioBroker states with automatic object creation and flexible configuration options.

## Purpose

The WS ioB out node allows you to write values to ioBroker states. It can automatically create missing objects and supports both static configuration and dynamic state targeting via message properties.

## Configuration

### Basic Settings

**State**
- Target state ID (e.g., `0_userdata.0.myValue`)
- Leave empty to use `msg.topic` for dynamic targeting
- Supports dot notation for nested object paths

**Input Property**
- Source message property for the value
- Default: `payload`
- Can reference nested properties (e.g., `data.temperature`)

**Set Mode**
- **Value (ack=true)**: Confirmed value from device/sensor
- **Command (ack=false)**: Command to be executed by device

### Auto-Create Objects

**Enable Auto-Create**
When enabled, automatically creates missing ioBroker objects with proper metadata.

**Object Configuration (Static)**
- **Name**: Human-readable object name
- **Role**: Object role (e.g., `value.temperature`, `switch.state`)
- **Type**: Data type (`number`, `string`, `boolean`, `object`)
- **Unit**: Physical unit (e.g., `°C`, `%`, `W`)
- **Min/Max**: Value range limits
- **States**: Possible values for enums

## Dynamic Configuration

Override static settings using message properties:

### Dynamic State Targeting
```
msg.topic = "0_userdata.0.dynamicState";
msg.payload = 42;
```

### Dynamic Object Creation
```
msg.stateName = "Living Room Temperature";
msg.stateRole = "value.temperature";
msg.payloadType = "number";
msg.stateUnit = "°C";
msg.stateMin = -20;
msg.stateMax = 50;
```

### Dynamic Set Mode
```
msg.ack = false;  // Send as command
msg.ack = true;   // Send as value
```

## Object Roles

Common object roles for auto-creation:

### Sensor Values
- `value.temperature` - Temperature readings
- `value.humidity` - Humidity percentage
- `value.pressure` - Pressure measurements
- `value.brightness` - Light level
- `value.power` - Power consumption

### Control States
- `switch.state` - On/off switches
- `level.dimmer` - Dimmer controls (0-100)
- `level.volume` - Volume controls
- `level.color.rgb` - RGB color values

### Status Indicators
- `indicator.status` - General status
- `indicator.alarm` - Alarm states
- `indicator.connected` - Connection status

## Data Types

### Supported Types
- **number**: Numeric values (integer or float)
- **string**: Text values
- **boolean**: True/false values
- **object**: JSON objects
- **array**: Arrays of values

### Type Conversion
The node automatically converts between JavaScript and ioBroker types:
- JavaScript `true/false` → ioBroker boolean
- JavaScript numbers → ioBroker number
- JavaScript strings → ioBroker string
- JavaScript objects → ioBroker object (JSON)

## Advanced Features

### Conditional Writing
Use function nodes to implement conditional logic:

```javascript
// Only write if value changed significantly
if (Math.abs(msg.payload - context.get('lastValue') || 0) > 0.5) {
    context.set('lastValue', msg.payload);
    return msg;
}
return null;
```

### Batch Operations
Write multiple states from single message:

```javascript
// In function node before WS ioB out
const states = [
    { topic: "lights.living.state", payload: true },
    { topic: "lights.kitchen.state", payload: false }
];

return states.map(state => ({ ...msg, ...state }));
```

### Value Transformation
Transform values before writing:

```javascript
// Convert percentage to 0-255 range
msg.payload = Math.round(msg.payload * 255 / 100);
msg.topic = "lights.dimmer.brightness";
return msg;
```

## Quality and Timestamps

### Quality Indicators
Set data quality in message:
```
msg.q = 0;   // Good quality
msg.q = 64;  // Device not connected
msg.q = 128; // Substitute value
```

### Custom Timestamps
Override automatic timestamp:
```
msg.ts = Date.now() - 3600000;  // 1 hour ago
```

## Error Handling

### Common Errors
- **Object not found**: Enable auto-create or create object manually
- **Type mismatch**: Check data type configuration
- **Permission denied**: Verify user permissions in ioBroker
- **Connection lost**: Node will retry automatically

### Error Messages
The node provides status messages for troubleshooting:
- Green: Successfully written
- Yellow: Processing/connecting
- Red: Error occurred

### Retry Behavior
- Automatic retry on connection loss
- Exponential backoff for repeated failures
- Manual retry by redeploying flow

## Performance Optimization

### Reduce Write Frequency
- Implement debouncing for rapid changes
- Use change detection to avoid unnecessary writes
- Batch multiple writes when possible

### Efficient Object Creation
- Create objects once, then reuse state IDs
- Use consistent naming conventions
- Avoid recreating existing objects

### Connection Management
- Reuse ioBroker connection across nodes
- Monitor connection status
- Implement graceful degradation

## Security Considerations

### Authentication
- Use dedicated ioBroker user for Node-RED
- Limit permissions to required objects only
- Avoid storing credentials in flows

### Data Validation
- Validate input data before writing
- Sanitize user inputs
- Implement range checking

### Access Control
- Restrict write access to critical states
- Log important state changes
- Monitor for unauthorized modifications

## Best Practices

### State Naming
Use consistent hierarchical naming:
- `device.room.property` (e.g., `lights.living.brightness`)
- `system.component.metric` (e.g., `heating.zone1.setpoint`)
- `0_userdata.0.custom` for user-defined states

### Object Metadata
Provide complete object definitions:
- Meaningful names and descriptions
- Appropriate roles and types
- Proper units and ranges
- Useful default values

### Flow Organization
- Group related outputs together
- Use meaningful node names
- Document complex logic
- Implement error handling

## Troubleshooting

### Write Failures
1. Check object exists and is writable
2. Verify data type matches object definition
3. Confirm user permissions
4. Test with simple static value

### Auto-Create Issues
1. Verify auto-create is enabled
2. Check object naming conventions
3. Ensure sufficient permissions
4. Review ioBroker object view

### Performance Problems
1. Reduce write frequency
2. Optimize wildcard usage
3. Monitor system resources
4. Check for message loops

## Related Nodes

- **WS ioB in**: Monitor state changes
- **WS ioB get**: Read current values
- **WS ioB getObject**: Retrieve object definitions

## Examples

See [Common Use Cases](use-cases.md) for practical implementation examples.