# WS ioB getObject - Object Getter

Retrieve ioBroker object definitions and metadata with support for wildcard patterns and multiple output formats.

## Purpose

The WS ioB getObject node allows you to retrieve ioBroker object definitions, which contain metadata about states, devices, adapters, and other ioBroker entities. This is useful for discovering available states, reading device configurations, and understanding object structures.

## Configuration

### Basic Settings

**Object ID**
- Single object ID (e.g., `system.adapter.admin.0`)
- Wildcard pattern (e.g., `system.adapter.*`)
- Leave empty to use `msg.topic` for dynamic selection

**Output Property**
- Target message property for the retrieved object(s)
- Default: `payload`
- Can be set to any valid message property

**Output Format**
- **Single Object**: Returns object directly (for single matches)
- **Array**: Returns array of objects
- **Object Map**: Returns `{objectId: object}` mapping

## Object Types

### System Objects
**Adapter Objects**
- `system.adapter.admin.0` - Admin adapter instance
- `system.adapter.*` - All adapter instances
- `system.adapter.*.alive` - Adapter alive states

**Host Objects**
- `system.host.hostname` - Host system information
- `system.host.*.processes` - Running processes

**Configuration Objects**
- `system.config` - System configuration
- `system.certificates` - SSL certificates

### Device Objects
**Device Instances**
- `hue.0.lights.1` - Philips Hue light device
- `sonoff.0.DVES_123456` - Sonoff device
- `zigbee.0.00158d00023a5b7c` - Zigbee device

**Channel Objects**
- `hue.0.lights` - Light device channel
- `homematic.0.BidCos-RF.NEQ1234567` - HomeMatic channel

### State Objects
**Data Points**
- `0_userdata.0.temperature` - User-defined state
- `javascript.0.myScript` - JavaScript variable
- `hue.0.lights.1.state` - Device state

## Wildcard Patterns

### Single Level Wildcards (`*`)
Match exactly one level in the object hierarchy:

- `system.adapter.*` - All adapter objects
- `hue.0.lights.*` - All light devices
- `*.alive` - All alive states at any adapter level

### Multi-Level Wildcards (`**`)
Match multiple levels:

- `system.**` - All system objects at any depth
- `hue.0.**` - All objects under hue.0 adapter
- `**.temperature` - All temperature objects anywhere

### Pattern Examples

**Discover Adapters**
```
system.adapter.*          // All adapter instances
system.adapter.*.alive    // Adapter status states
system.adapter.hue.*      // All Hue adapter objects
```

**Find Device Objects**
```
hue.0.**                  // All Hue objects
*.lights.*                // All light objects
zigbee.0.*.available      // Zigbee device availability
```

**System Information**
```
system.host.*             // Host information
system.config             // System configuration
system.certificates       // SSL certificates
```

## Output Formats

### Single Object Format
Returns the object directly when only one match is found:

```
{
  _id: "system.adapter.admin.0",
  type: "instance",
  common: {
    name: "admin",
    version: "5.3.8",
    enabled: true,
    host: "iobroker-host"
  },
  native: {
    port: 8081,
    auth: false
  }
}
```

### Array Format
Returns an array of objects:

```
[
  {
    _id: "system.adapter.admin.0",
    type: "instance",
    // ... object data
  },
  {
    _id: "system.adapter.web.0", 
    type: "instance",
    // ... object data
  }
]
```

### Object Map Format
Returns a mapping of object IDs to objects:

```
{
  "system.adapter.admin.0": {
    _id: "system.adapter.admin.0",
    type: "instance",
    // ... object data
  },
  "system.adapter.web.0": {
    _id: "system.adapter.web.0",
    type: "instance", 
    // ... object data
  }
}
```

## Object Structure

### Common Properties
All objects contain these properties:

- `_id`: Unique object identifier
- `type`: Object type (state, channel, device, instance, etc.)
- `common`: Common metadata (name, role, type, etc.)
- `native`: Adapter-specific configuration

### Object Types
- **state**: Data points with values
- **channel**: Grouping of related states
- **device**: Physical or logical devices
- **instance**: Adapter instances
- **host**: System host information
- **config**: Configuration objects

### Common Metadata
The `common` section contains:

- `name`: Human-readable name
- `role`: Functional role (e.g., "value.temperature")
- `type`: Data type (number, string, boolean, object)
- `read`/`write`: Access permissions
- `unit`: Physical unit
- `min`/`max`: Value ranges
- `states`: Possible values for enums

## Advanced Usage

### Dynamic Object Discovery
```javascript
// Find all temperature sensors
msg.topic = "**.temperature";
return msg;
```

### Object Filtering
```javascript
// Filter only enabled adapters
const adapters = msg.payload.filter(obj => 
    obj.common && obj.common.enabled === true
);
msg.payload = adapters;
return msg;
```

### Metadata Extraction
```javascript
// Extract adapter versions
const versions = {};
for (let obj of msg.payload) {
    if (obj.common && obj.common.version) {
        versions[obj._id] = obj.common.version;
    }
}
msg.payload = versions;
return msg;
```

### Configuration Analysis
```javascript
// Analyze adapter configurations
const configs = msg.payload.map(obj => ({
    id: obj._id,
    name: obj.common.name,
    enabled: obj.common.enabled,
    host: obj.common.host,
    native: obj.native
}));
msg.payload = configs;
return msg;
```

## Use Cases

### System Discovery
- Find all installed adapters
- Discover available devices
- Map system architecture
- Audit configurations

### Dynamic Configuration
- Build device lists for UIs
- Generate adapter monitoring
- Create automatic backups
- Validate object structures

### Troubleshooting
- Check object definitions
- Verify permissions and roles
- Analyze configuration issues
- Document system state

## Performance Considerations

### Pattern Scope
- Use specific patterns when possible
- Avoid overly broad wildcards
- Monitor result count for large patterns
- Consider pagination for massive results

### Caching
- Cache frequently accessed objects
- Implement cache invalidation
- Use WS ioB inObj for change monitoring
- Store results in context for reuse

### Request Optimization
- Batch multiple requests when possible
- Use appropriate output format
- Filter results early in the flow
- Avoid repeated identical requests

## Error Handling

### Common Errors
- **Object not found**: Specified object doesn't exist
- **Permission denied**: User lacks read permissions
- **Pattern too broad**: Wildcard matches too many objects
- **Connection error**: WebSocket unavailable

### Error Recovery
```javascript
// Handle errors gracefully
if (msg.error) {
    node.warn(`Object retrieval failed: ${msg.error}`);
    msg.payload = []; // Return empty result
    return msg;
}

// Validate result
if (!Array.isArray(msg.payload)) {
    msg.payload = [msg.payload]; // Normalize to array
}
return msg;
```

## Best Practices

### Pattern Design
- Start with specific patterns and broaden as needed
- Test patterns with small scopes first
- Document expected result counts
- Use consistent naming conventions

### Result Processing
- Handle different output formats consistently
- Implement proper error checking
- Filter results appropriately
- Cache expensive operations

### Security
- Limit access to sensitive objects
- Validate object permissions
- Sanitize object data before use
- Monitor access patterns

## Troubleshooting

### No Results
1. Check object ID syntax and existence
2. Verify wildcard pattern is correct
3. Confirm read permissions
4. Test with simpler patterns

### Too Many Results
1. Narrow wildcard scope
2. Add filtering logic
3. Implement result pagination
4. Use more specific patterns

### Performance Issues
1. Reduce pattern scope
2. Implement result caching
3. Monitor system resources
4. Optimize downstream processing

## Related Nodes

- **WS ioB inObj**: Monitor object changes
- **WS ioB get**: Read state values
- **WS ioB in**: Subscribe to state changes

## Examples

See [Common Use Cases](use-cases.md) for practical implementation examples.