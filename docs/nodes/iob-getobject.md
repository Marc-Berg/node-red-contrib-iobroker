# WS ioB getObject - Object Retrieval with Enum & Alias Support

Retrieve ioBroker object definitions and metadata with support for wildcard patterns, enum assignments, and alias resolution.

## Purpose

The WS ioB getObject node retrieves ioBroker object definitions containing metadata about states, devices, adapters, and other entities. It supports automatic enum assignment integration for room/function categorization and alias resolution for comprehensive object relationships.

## Configuration

### Basic Settings

**Object ID / Pattern**
- Single object ID (e.g., `system.adapter.admin.0`)
- Wildcard pattern (e.g., `system.adapter.*`)
- Leave empty to use `msg.topic` for dynamic input

**Output Property**
- Target message property (default: `payload`)

**Output Mode**
- **Single Object**: Returns object directly
- **Array of Objects**: Returns array (ideal for wildcards)
- **Object Map**: Returns `{objectId: object}` mapping

**Object Type Filter**
- Filter by type (state, channel, device, etc.)

### Enhanced Features

**Include assigned Enums**
- Adds room and function assignments to objects
- Configurable enum types (all, rooms only, functions only)

**Include alias information**
- Resolves alias relationships automatically
- Supports simple and complex (read/write) aliases
- Bidirectional resolution options

## Enhanced Output Features

### Enum Assignments

When enabled, each object includes an `enumAssignments` property:

```javascript
{
  _id: "hue.0.lights.1.state",
  type: "state",
  common: { name: "Living Room Light", role: "switch.state" },
  native: {},
  enumAssignments: {
    rooms: [{ id: "enum.rooms.living_room", name: "Living Room", type: "rooms" }],
    functions: [{ id: "enum.functions.lighting", name: "Lighting", type: "functions" }],
    other: [],
    totalEnums: 2,
    hasRoom: true,
    hasFunction: true,
    roomName: "Living Room",
    functionName: "Lighting"
  }
}
```

### Alias Information

When enabled, each object includes an `aliasInfo` property:

**Simple Alias (single target):**
```javascript
{
  _id: "alias.0.Wohnzimmer.Licht",
  aliasInfo: {
    isAlias: true,
    aliasTarget: {
      type: "simple",
      target: {
        _id: "hue.0.lights.1.state",
        type: "state",
        common: {...}
      }
    },
    aliasedBy: []
  }
}
```

**Complex Alias (read/write targets):**
```javascript
{
  _id: "alias.0.OG.Aktor",
  aliasInfo: {
    isAlias: true,
    aliasTarget: {
      type: "complex",
      readId: "mqtt.0.z2m.FH_Actor_OG.state_l1",
      writeId: "mqtt.0.z2m.FH_Actor_OG.set.state_l1",
      targets: {
        read: { _id: "mqtt.0.z2m.FH_Actor_OG.state_l1", ... },
        write: { _id: "mqtt.0.z2m.FH_Actor_OG.set.state_l1", ... }
      }
    },
    aliasedBy: []
  }
}
```

**Target Object (aliased by others):**
```javascript
{
  _id: "hue.0.lights.1.state",
  aliasInfo: {
    isAlias: false,
    aliasTarget: null,
    aliasedBy: [
      { _id: "alias.0.Wohnzimmer.Licht.switch", type: "state", ... }
    ]
  }
}
```

### Alias Resolution Modes

- **Both directions**: Resolves alias targets AND finds aliases pointing to targets
- **Target resolution only**: Only resolves alias → target relationships
- **Reverse lookup only**: Only finds target → alias relationships

### Message Properties

When retrieving objects, the output message contains:

- **Target property** (default `payload`): Retrieved object(s) with enriched data
- **`objects`**: Object map for compatibility
- **`objectId`**: The object ID or pattern used
- **`count`**: Number of objects returned
- **`timestamp`**: Retrieval timestamp
- **`includesEnums`**: Boolean flag when enum data is included
- **`includesAliases`**: Boolean flag when alias data is included
- **`enumStatistics`**: Summary statistics for enum coverage (multiple objects)
- **`aliasStatistics`**: Summary statistics for alias relationships (multiple objects)

## Object Types

**Supported Types:**
- **state**: Data points with values
- **channel**: Grouping of related states  
- **device**: Physical or logical devices
- **adapter**: Adapter instances
- **enum**: Enumeration objects
- **config**: Configuration objects

Use type filtering to narrow results and improve performance.

## Use Cases

### Smart Home Management
- **Room-based device lists**: Get all devices with room assignments automatically
- **Function grouping**: Group devices by function (lighting, heating, security)
- **Alias resolution**: Work with both aliases and targets seamlessly
- **System audit**: Find uncategorized or orphaned objects

### Dashboard Creation
- **Responsive UIs**: Build interfaces that adapt to ioBroker configuration
- **Navigation menus**: Generate room/function navigation automatically
- **Device discovery**: Find all available devices with context
- **Alias management**: Display alias relationships in management interfaces

### Automation & Logic
- **Scene control**: Find all lights in specific rooms for automation
- **Bulk operations**: Group devices by function for mass control
- **Voice control**: Build context-aware voice interfaces
- **Installation wizards**: Create setup flows based on existing structure

### Development & Maintenance
- **Object exploration**: Discover object structures and relationships
- **Configuration validation**: Verify enum and alias assignments
- **System monitoring**: Track adapter and device status
- **Documentation**: Generate system documentation automatically

## Examples & Patterns

### Basic Object Retrieval
```javascript
// Single object
msg.topic = "hue.0.lights.1.state";

// Wildcard patterns
msg.topic = "*.lights.*";           // All light objects
msg.topic = "system.adapter.*";     // All adapter instances
msg.topic = "enum.*";               // All enum objects
msg.topic = "alias.*";              // All alias objects
msg.outputMode = "array";
```

### System Discovery
```javascript
// Adapter monitoring
msg.topic = "system.adapter.*.alive";
msg.objectType = "state";

// Host information
msg.topic = "system.host.*";

// Device patterns
msg.topic = "hue.0.*";              // All Hue objects
msg.topic = "zigbee.0.*.available"; // Zigbee availability
```

### With Enhanced Features
```javascript
// Objects with room/function context
msg.topic = "*.lights.*";
msg.includeEnums = true;
msg.enumTypes = ["rooms", "functions"];

// Alias resolution
msg.topic = "alias.*";
msg.includeAliases = true;
msg.aliasResolution = "both";

// Combined features
msg.topic = "*";
msg.includeEnums = true;
msg.includeAliases = true;
msg.objectType = "state";
```

## Performance & Best Practices

### Query Optimization
- **Use specific patterns**: `lights.*` instead of `*`
- **Apply type filtering**: Reduces result sets significantly
- **Limit scope**: Avoid broad queries when possible
- **Monitor response times**: Large result sets may take longer

### Feature Impact
- **Enum assignments**: Minimal overhead, recommended for UI building
- **Alias resolution**: Requires additional queries, use specific resolution modes
- **Combined features**: Both can be used together efficiently

### Error Handling
- **No results**: Check object ID syntax and permissions
- **Missing enums/aliases**: Verify objects exist and are properly configured
- **Timeouts**: Use more specific patterns or type filters

## Related Nodes

- **WS ioB inObj**: Monitor object changes with enum context
- **WS ioB get**: Read state values with alias support
- **WS ioB in**: Subscribe to state changes
- **WS ioB out**: Create objects with enum assignments

See [Common Use Cases](../use-cases.md) for complete implementation examples.