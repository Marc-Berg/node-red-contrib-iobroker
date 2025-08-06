# WS ioB out - State Output

Send values to ioBroker states with automatic object creation and flexible configuration options.

## Purpose

The WS ioB out node allows you to write values to ioBroker states. It can automatically create missing objects and supports both static configuration and dynamic state targeting via message properties.

## Configuration

### Basic Settings

**State**
- Target state ID (e.g., `0_userdata.0.myValue`)
- Leave empty to use `msg.topic` for dynamic targeting

**Input Property**
- Source message property for the value
- Default: `payload`

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

### Batch Operations
Write multiple states from single message:

```javascript
// In function node before WS ioB out
const states = [
    { topic: "lights.living.state", payload: true },
    { topic: "lights.kitchen.state", payload: false }
];

// Send each state as separate message
states.forEach(state => {
    node.send({ ...msg, ...state });
});
```

### Custom Timestamps
Override automatic timestamp:
```
msg.ts = Date.now() - 3600000;  // 1 hour ago
```

**Behavior:** The `ts` (timestamp) will be set to your custom value, while `lc` (last changed) will always be set to the current time when the value is actually written. This ensures proper tracking of when the value was last modified in the system.

### Creating Empty Objects
Create ioBroker objects without setting a value by passing `null` as the payload. (Set payload type to JSON and value to null)

This creates the object structure in ioBroker without writing any value to it, useful for preparing object definitions before actual data arrives.

## Error Handling

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

## Related Nodes

- **WS ioB in**: Monitor state changes
- **WS ioB get**: Read current values
- **WS ioB getObject**: Retrieve object definitions

## Examples

See [Common Use Cases](../use-cases.md) for practical implementation examples.