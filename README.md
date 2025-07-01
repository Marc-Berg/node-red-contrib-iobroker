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
1. **Create dedicated Admin adapter instance** (recommended):
   - Install second Admin adapter instance in ioBroker
   - Configure on different port (e.g., 8091) 
   - Use exclusively for Node-RED connections
2. **Configure iob-config node** with your dedicated instance:
   - Host: hostname or IP address
   - Port: 8091 (your dedicated Admin instance)
   - Authentication: Optional username/password
3. **Use the nodes** in your flows

## 🏗️ Architecture Overview

![Node-RED to ioBroker Architecture](images/iobroker_architecture_diagram.svg)

The diagram shows the recommended architecture with a dedicated Admin adapter instance for Node-RED connections, separate from the main Admin interface used by regular users.

## 📦 Available Nodes

| Node | Purpose | Example Use | Documentation |
|------|---------|-------------|---------------|
| **WS ioB in** | Subscribe to state changes | Monitor temperature sensors  | [📖 Details](docs/nodes/iob-in.md) |
| **WS ioB out** | Send values to states with auto-creation | Control lights, switches |[📖 Details](docs/nodes/iob-out.md) |
| **WS ioB get** | Read current state values | Get sensor readings on demand |  [📖 Details](docs/nodes/iob-get.md) |
| **WS ioB getObj** | Retrieve object definitions | Access device metadata | [📖 Details](docs/nodes/iob-getobject.md) |
| **WS ioB inObj** | Monitor object changes | Track adapter installations | [📖 Details](docs/nodes/iob-inobj.md) |
| **WS ioB history** | Access historical data | Energy consumption analysis | [📖 Details](docs/nodes/iob-history.md) |
| **WS ioB log** | Live log monitoring | System health monitoring | [📖 Details](docs/nodes/iob-log.md) |

## 🔧 Configuration

### Recommended Setup: Dedicated Admin Instance

**Why use a dedicated Admin instance?**
- Isolates Node-RED traffic from main admin interface
- Prevents conflicts with regular admin usage
- Allows custom security settings

**Setup Steps:**
1. **Install second Admin adapter instance** in ioBroker:
   - Go to Adapters → Admin → Add Instance
   - Configure custom port (e.g., 8091)
   - Enable/disable features as needed
2. **Configure security** for Node-RED access:
   - Create dedicated user for Node-RED
   - Set appropriate permissions
   - Configure session duration ≥3600 seconds

### Server Configuration (iob-config)

**Connection Settings:**
- **Name**: Descriptive name for your ioBroker instance
- **Host**: IP address (e.g., 192.168.1.100) or hostname (e.g., iobroker.local)
- **Port**: Your dedicated Admin instance port (e.g., 8091)
- **Use SSL**: Enable for HTTPS/WSS connections

**Authentication Settings:**
- **No Authentication** (default): Leave username/password empty
- **OAuth2**: Enter valid ioBroker username/password

### Alternative Adapter Options

If you prefer not to use a dedicated Admin instance:

**WebSocket adapter** (port 8084) - Dedicated WebSocket adapter for external connections
**Web adapter** (port 8082) - Requires "Use pure web-sockets" option enabled

## ⚠️ Important Notes

- **External Installation Only**: This package is for external Node-RED instances, not the ioBroker Node-RED adapter
- **Dedicated Admin Instance Recommended**: Use a separate Admin adapter instance for Node-RED connections
- **Authentication Token Issue**: Use session durations ≥3600 seconds (1 hour) to avoid connection drops
- **Performance**: Avoid overly broad wildcard patterns like * or *.*

## 📚 Additional Resources

- **🔍 Troubleshooting**: [Troubleshooting Guide](docs/troubleshooting.md)
- **🎯 Use Cases**: [Common Use Cases](docs/use-cases.md)
- **📖 Full Documentation**: [GitHub Repository](https://github.com/Marc-Berg/node-red-contrib-iobroker)
- **🐛 Bug Reports**: [GitHub Issues](https://github.com/Marc-Berg/node-red-contrib-iobroker/issues)
- **📘 ioBroker Forum**: [ioBroker.net](https://forum.iobroker.net)

## 📄 License

MIT

---