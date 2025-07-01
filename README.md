# Node-RED Nodes for ioBroker Integration

![Version](https://img.shields.io/npm/v/node-red-contrib-iobroker)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node-RED](https://img.shields.io/badge/Node--RED-compatible-red.svg)
![Downloads](https://img.shields.io/npm/dt/node-red-contrib-iobroker)

> **🌍 Languages:** [🇺🇸 English](#) | [🇩🇪 Deutsch](https://github.com/Marc-Berg/node-red-contrib-iobroker/blob/main/README.de.md)

External Node-RED integration nodes for ioBroker communication. **NOT an ioBroker adapter** - standalone package for external Node-RED instances to connect with ioBroker via WebSocket.

## 🚀 Quick Start

### Installation
Install the nodes through the Node-RED Palette Manager:
1. Open Node-RED interface
2. Click on hamburger menu (three lines) → Manage palette
3. Go to "Install" tab
4. Search for "node-red-contrib-iobroker"
5. Click "Install" button

### Basic Setup
1. **Configure iob-config node** with your ioBroker server details:
   - Host: iobroker.local or IP address
   - Port: 8081 (Admin), 8082 (Web), or 8084 (WebSocket)
   - Authentication: Optional username/password
2. **Use the nodes** in your flows

### First Flow Example
1. Drag "WS ioB in" node to canvas
2. Configure: State = "0_userdata.0.test"
3. Connect to Debug node
4. Deploy and watch state changes

## 📦 Available Nodes

| Node | Purpose | Example Use |
|------|---------|-------------|
| **WS ioB in** | Subscribe to state changes | Monitor temperature sensors |
| **WS ioB out** | Send values to states | Control lights, switches |
| **WS ioB get** | Read current state values | Get sensor readings on demand |
| **WS ioB getObject** | Retrieve object definitions | Access device metadata |
| **WS ioB inObj** | Monitor object changes | Track adapter installations |
| **WS ioB history** | Access historical data | Energy consumption analysis |
| **WS ioB log** | Live log monitoring | System health monitoring |

## ✨ Key Features

- **Real-time WebSocket communication** with automatic reconnection
- **Wildcard pattern support** - subscribe to multiple states at once
- **Automatic object creation** for missing ioBroker objects  
- **Shared connection management** - multiple nodes share connections
- **Historical data access** from history adapters (History, SQL, InfluxDB)
- **OAuth2 authentication** for secured installations
- **SSL/TLS support** for encrypted connections

## 🔧 Configuration

### Server Configuration (iob-config)
Configure your ioBroker connection with the following parameters:
- **Name**: Descriptive name for your ioBroker instance
- **Host**: IP address (e.g., 192.168.1.100) or hostname (e.g., iobroker.local)
- **Port**: 8081 for Admin, 8082 for Web, or 8084 for WebSocket adapter
- **Use SSL**: Enable for HTTPS/WSS connections
- **Username**: Optional for authentication
- **Password**: Optional for authentication

### Authentication Modes
- **No Authentication** (default): Leave username/password empty
- **OAuth2**: Enter valid ioBroker username/password

### WebSocket Adapters
Choose one of these ioBroker adapters:
- **Admin adapter** (port 8081) - Usually pre-installed, required for logs
- **WebSocket adapter** (port 8084) - Dedicated WebSocket adapter  
- **Web adapter** (port 8082) - Requires "Use pure web-sockets" enabled

## 📋 Node Documentation

### WS ioB in - State Subscription
Subscribe to ioBroker state changes in real-time.

**Configuration:**
- **State**: Single state ID or wildcard pattern
- **Output Property**: Message property for value (default: payload)
- **Trigger on**: All updates, acknowledged only, or unacknowledged only
- **Send initial value**: Emit current value on startup

**Wildcard Examples:**
- system.adapter.*.alive - All adapter alive states
- 0_userdata.0.* - All states under 0_userdata.0  
- *.temperature - All temperature states

**Output Message includes:**
- payload: The state value
- topic: State ID
- state: Complete state object with value, acknowledge flag, timestamp, and source
- timestamp: Update timestamp

### WS ioB out - State Output
Send values to ioBroker states with automatic object creation.

**Configuration:**
- **State**: Target state ID (or use msg.topic)
- **Input Property**: Source property (default: payload)
- **Set Mode**: Value (ack=true) or Command (ack=false)
- **Auto-Create Objects**: Create missing objects automatically

**Auto-Create Properties:**
Configure object properties either statically in the node configuration or dynamically via message properties like stateName, stateRole, payloadType, stateUnit, stateMin, and stateMax.

### WS ioB get - State Getter
Read current state values on demand.

**Usage:**
Send any message to trigger state reading. Use either the configured state or provide state ID via msg.topic. The current value will be returned in msg.payload.

### WS ioB getObject - Object Getter  
Retrieve ioBroker object definitions with wildcard support.

**Examples:**
- system.adapter.admin.0 - Single object
- system.adapter.* - All adapter objects
- 0_userdata.0.* - All user data objects

**Output Modes:**
- **Single Object**: Returns object directly
- **Array**: Returns array of objects  
- **Object Map**: Returns mapping of objectId to object

### WS ioB inObj - Object Subscription
Monitor changes to ioBroker objects (structure/configuration).

**Use Cases:**
- Monitor adapter installations: system.adapter.*
- Track configuration changes: system.adapter.admin.*  
- Watch user data: 0_userdata.0.*

### WS ioB history - Historical Data
Access historical data from ioBroker history adapters.

**Configuration:**
- **History Adapter**: Auto-detected with status indicators
- **Time Range**: Duration, Absolute, or From Message
- **Aggregation**: None, OnChange, Average, Min, Max, Total, etc.
- **Output Format**: Array, Chart.js, or Statistics

**Example Query Parameters:**
- stateId: system.adapter.admin.0.memRss
- duration: 24 with durationUnit: hours
- aggregate: average
- step: 3600 (for hourly intervals)

### WS ioB log - Live Logs
Subscribe to ioBroker live log messages.

**Log Levels:** silly, debug, info, warn, error

**Output includes:**
- payload: Log message text
- level: Log level
- source: Source adapter
- timestamp: ISO timestamp

## ⚠️ Important Notes

- **External Installation Only**: This package is for external Node-RED instances, not the ioBroker Node-RED adapter
- **Authentication Token Issue**: Use session durations ≥3600 seconds (1 hour) to avoid connection drops
- **WebSocket Required**: Needs Admin, WebSocket, or Web adapter with WebSocket support
- **Performance**: Avoid overly broad wildcard patterns like * or *.*

## 📚 Additional Resources

- **🔍 Troubleshooting**: [Troubleshooting Guide](troubleshooting.md)
- **🎯 Use Cases**: [Common Use Cases](use-cases.md)
- **📖 Full Documentation**: [GitHub Repository](https://github.com/Marc-Berg/node-red-contrib-iobroker)
- **🐛 Bug Reports**: [GitHub Issues](https://github.com/Marc-Berg/node-red-contrib-iobroker/issues)
- **💡 Feature Requests**: [GitHub Discussions](https://github.com/Marc-Berg/node-red-contrib-iobroker/discussions)
- **📘 ioBroker Documentation**: [ioBroker.net](https://www.iobroker.net)

## 📄 License

MIT License - see [LICENSE](https://github.com/Marc-Berg/node-red-contrib-iobroker/blob/main/LICENSE) file for details.

---

**Need help?** Check the [troubleshooting guide](https://github.com/Marc-Berg/node-red-contrib-iobroker/blob/main/docs/troubleshooting.md) or open an issue on GitHub.