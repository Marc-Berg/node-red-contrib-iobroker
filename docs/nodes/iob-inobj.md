# WS ioB inObj - Object Subscription

Monitor changes to ioBroker object definitions and metadata in real-time.

## Purpose

The WS ioB inObj node allows you to subscribe to changes in ioBroker object structure and metadata. Unlike state subscriptions that monitor data values, this monitors the creation, modification, and deletion of objects themselves - useful for tracking adapter installations, configuration changes, and system structure modifications.

## Configuration

### Basic Settings

**Object Pattern**
- Single object ID (e.g., `system.adapter.admin.0`)
- Wildcard pattern (e.g., `system.adapter.*`)
- Leave empty to use `msg.topic` for dynamic subscription

**Output Property**
- Target message property for the object data
- Default: `payload`
- Can be set to any valid message property

## Object Change Types

### Update Events
Triggered when objects are created or modified:

- New adapter installations
- Device discovery and addition
- User-created objects
- Script-generated objects
- Configuration updates
- Permission changes
- Role or type modifications
- Metadata updates

### Deletion Events
Triggered when objects are removed:
- Adapter uninstallation
- Device removal
- Object cleanup
- Manual deletion

## Wildcard Patterns

### Adapter Monitoring
Monitor adapter-related changes:

```
system.adapter.*              // All adapter instances
system.adapter.*.alive        // Adapter status objects
system.adapter.hue.*          // Specific adapter objects
```

### Device Monitoring
Track device objects:

```
hue.0.*                       // All Hue adapter objects
zigbee.0.*.available          // Zigbee device availability objects
sonoff.0.*                    // All Sonoff objects
```

### User Data Monitoring
Monitor user-created objects:

```
0_userdata.0.*                // All user data objects
```

### System Monitoring
Track system-level changes:

```
system.*                      // All system objects
system.config                 // System configuration
system.certificates           // SSL certificates
```

## Output Message Format

### Standard Properties
- **payload**: The complete object definition
- **topic**: The object ID that changed
- **timestamp**: When the change occurred

### Object Information
Complete object data in payload:
- `_id`: Object identifier
- `type`: Object type (state, channel, device, etc.)
- `common`: Common metadata
- `native`: Adapter-specific configuration

### Change Information
Additional properties describing the change:
- `changeType`: "update" or "delete"

**Example Output:**
```
{
  payload: {
    _id: "system.adapter.hue.0",
    type: "instance",
    common: {
      name: "hue",
      version: "3.7.0",
      enabled: true
    },
    native: {
      bridge: "192.168.1.100",
      user: "newuser123"
    }
  },
  topic: "system.adapter.hue.0",
  timestamp: 1640995200000,
  changeType: "update",
}
```

## Troubleshooting

### No Events Received
1. Check object pattern syntax
2. Verify objects exist and change
3. Confirm subscription permissions
4. Test with simpler patterns

### Too Many Events
1. Narrow pattern scope
2. Implement event filtering
3. Add debouncing logic
4. Monitor system performance

## Integration Examples

### Adapter Health Dashboard
```
[WS ioB inObj: "system.adapter.*"] → [Filter: alive changes] → [Dashboard]
```

### Configuration Audit
```
[WS ioB inObj: "system.adapter.*.instance"] → [Log Changes] → [Audit Trail]
```

## Related Nodes

- **WS ioB getObject**: Read current object definitions
- **WS ioB in**: Monitor state value changes
- **WS ioB out**: Modify state values

## Examples

See [Common Use Cases](../use-cases.md) for practical implementation examples.