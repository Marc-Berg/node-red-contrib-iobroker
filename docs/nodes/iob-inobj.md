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

**Send Initial Objects**
- When enabled, emits current objects immediately after subscription
- Useful for initialization and current state discovery

## Object Change Types

### Creation Events
Triggered when new objects are created:
- New adapter installations
- Device discovery and addition
- User-created objects
- Script-generated objects

### Modification Events
Triggered when object metadata changes:
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
hue.0.**                      // All Hue adapter objects
zigbee.0.*.available          // Zigbee device availability objects
sonoff.0.**                   // All Sonoff objects
```

### User Data Monitoring
Monitor user-created objects:

```
0_userdata.0.**               // All user data objects
javascript.0.**               // JavaScript adapter objects
```

### System Monitoring
Track system-level changes:

```
system.**                     // All system objects
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
- `changeType`: "create", "update", or "delete"
- `oldObject`: Previous object definition (for updates)
- `newObject`: New object definition (for updates/creates)

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
  oldObject: { /* previous object */ }
}
```

## Common Use Cases

### Adapter Management
**Monitor Adapter Installations**
```
Pattern: system.adapter.*
Use: Track when adapters are installed, updated, or removed
```

**Configuration Monitoring**
```
Pattern: system.adapter.*.instance
Use: Monitor adapter configuration changes
```

### Device Discovery
**New Device Detection**
```
Pattern: hue.0.**
Use: Detect when new Hue devices are discovered
```

**Device Status Monitoring**
```
Pattern: *.*.available
Use: Track device availability object changes
```

### System Administration
**Configuration Tracking**
```
Pattern: system.config
Use: Monitor system configuration changes
```

**Certificate Management**
```
Pattern: system.certificates
Use: Track SSL certificate updates
```

### Development and Debugging
**Object Structure Analysis**
```
Pattern: **
Use: Understand complete object hierarchy changes
```

**Script Object Monitoring**
```
Pattern: javascript.0.**
Use: Track script-created objects
```

## Advanced Features

### Dynamic Subscription
Change subscription pattern at runtime:

```javascript
// Switch to monitor different adapter
msg.topic = "system.adapter.sonoff.*";
return msg;
```

### Change Type Filtering
Filter specific types of changes:

```javascript
// Only process new objects
if (msg.changeType === "create") {
    return msg;
}
return null;
```

### Object Comparison
Analyze what specifically changed:

```javascript
// Compare old and new objects
if (msg.oldObject && msg.payload) {
    const changes = findDifferences(msg.oldObject, msg.payload);
    msg.changes = changes;
}
return msg;
```

### Metadata Extraction
Extract specific information from objects:

```javascript
// Extract adapter version changes
if (msg.changeType === "update" && 
    msg.payload.common && 
    msg.payload.common.version) {
    
    msg.version = {
        old: msg.oldObject.common.version,
        new: msg.payload.common.version
    };
}
return msg;
```

## Event Processing

### Installation Detection
```javascript
// Detect new adapter installations
if (msg.changeType === "create" && 
    msg.topic.startsWith("system.adapter.")) {
    
    const adapterName = msg.topic.split('.')[2];
    msg.payload = {
        event: "adapter_installed",
        adapter: adapterName,
        version: msg.payload.common.version
    };
    return msg;
}
```

### Configuration Monitoring
```javascript
// Monitor critical configuration changes
if (msg.changeType === "update" && 
    msg.payload.common && 
    msg.payload.common.enabled !== msg.oldObject.common.enabled) {
    
    msg.payload = {
        event: "adapter_enabled_changed",
        adapter: msg.topic,
        enabled: msg.payload.common.enabled
    };
    return msg;
}
```

### Device Tracking
```javascript
// Track device additions
if (msg.changeType === "create" && 
    msg.payload.type === "device") {
    
    msg.payload = {
        event: "device_added",
        device: msg.topic,
        name: msg.payload.common.name,
        adapter: msg.topic.split('.')[0]
    };
    return msg;
}
```

## Performance Considerations

### Pattern Scope
- Use specific patterns to reduce event volume
- Avoid overly broad patterns like `**`
- Monitor subscription count and event frequency
- Consider performance impact of complex processing

### Event Filtering
- Filter events early in the flow
- Use specific change type filtering
- Implement debouncing for rapid changes
- Cache frequently accessed object data

### Resource Management
- Limit simultaneous subscriptions
- Monitor memory usage with large object sets
- Implement efficient object comparison algorithms
- Use context storage wisely

## Error Handling

### Common Issues
- **Too many events**: Overly broad patterns
- **Permission denied**: Insufficient read permissions
- **Connection lost**: WebSocket disconnection
- **Object parsing errors**: Malformed object data

### Error Recovery
```javascript
// Handle malformed objects
try {
    if (msg.payload && msg.payload._id) {
        // Process valid object
        return msg;
    }
} catch (error) {
    node.warn(`Object processing error: ${error.message}`);
    return null;
}
```

## Security Considerations

### Access Control
- Limit object monitoring to necessary scopes
- Validate object permissions
- Monitor sensitive configuration changes
- Log security-relevant events

### Data Sensitivity
- Filter sensitive configuration data
- Sanitize outputs for logging
- Protect authentication credentials
- Implement audit trails

## Best Practices

### Pattern Design
- Start with specific patterns and broaden as needed
- Test pattern impact on system performance
- Document expected event volumes
- Use consistent naming conventions

### Event Processing
- Implement efficient filtering logic
- Handle all change types appropriately
- Provide meaningful error messages
- Use context for state management

### System Integration
- Coordinate with other monitoring systems
- Implement proper logging
- Provide administrative notifications
- Handle system maintenance events

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

### Missing Change Details
1. Check if oldObject is available
2. Verify change type detection
3. Implement custom comparison logic
4. Review object structure

## Integration Examples

### Adapter Health Dashboard
```
[WS ioB inObj: "system.adapter.*"] → [Filter: alive changes] → [Dashboard]
```

### Configuration Audit
```
[WS ioB inObj: "system.adapter.*.instance"] → [Log Changes] → [Audit Trail]
```

### Device Discovery
```
[WS ioB inObj: "hue.0.**"] → [Filter: new devices] → [Notification]
```

## Related Nodes

- **WS ioB getObject**: Read current object definitions
- **WS ioB in**: Monitor state value changes
- **WS ioB out**: Modify state values

## Examples

See [Common Use Cases](use-cases.md) for practical implementation examples.