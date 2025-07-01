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

| Node | Purpose | Documentation |
|------|---------|---------------|
| **WS ioB in** | Subscribe to state changes in real-time | [📖 Details](nodes/iob-in.md) |
| **WS ioB out** | Send values to states with auto-creation | [📖 Details](nodes/iob-out.md) |
| **WS ioB get** | Read current state values on demand | [📖 Details](nodes/iob-get.md) |
| **WS ioB getObject** | Retrieve object definitions | [📖 Details](nodes/iob-getobject.md) |
| **WS ioB inObj** | Monitor object structure changes | [📖 Details](nodes/iob-inobj.md) |
| **WS ioB history** | Access historical data from adapters | [📖 Details](nodes/iob-history.md) |
| **WS ioB log** | Subscribe to live log messages | [📖 Details](nodes/iob-log.md) |

## ⚠️ Important Notes

- **External Installation Only**: This package is for external Node-RED instances, not the ioBroker Node-RED adapter
- **Authentication Token Issue**: Use session durations ≥3600 seconds (1 hour) to avoid connection drops
- **WebSocket Required**: Needs Admin, WebSocket, or Web adapter with WebSocket support
- **Performance**: Avoid overly broad wildcard patterns like * or *.*

## 📚 Additional Resources

- **🔍 Troubleshooting**: [Troubleshooting Guide](troubleshooting.md)
- **🎯 Use Cases**: [Common Use Cases](use-cases.md)
- **📖 Node Documentation**: 
  - [WS ioB in](ws-iob-in.md) | [WS ioB out](ws-iob-out.md) | [WS ioB get](ws-iob-get.md)
  - [WS ioB getObject](ws-iob-getobject.md) | [WS ioB inObj](ws-iob-inobj.md) 
  - [WS ioB history](ws-iob-history.md) | [WS ioB log](ws-iob-log.md)
- **📖 Full Documentation**: [GitHub Repository](https://github.com/Marc-Berg/node-red-contrib-iobroker)
- **🐛 Bug Reports**: [GitHub Issues](https://github.com/Marc-Berg/node-red-contrib-iobroker/issues)
- **💡 Feature Requests**: [GitHub Discussions](https://github.com/Marc-Berg/node-red-contrib-iobroker/discussions)
- **📘 ioBroker Documentation**: [ioBroker.net](https://www.iobroker.net)

## 📄 License

MIT License - see [LICENSE](https://github.com/Marc-Berg/node-red-contrib-iobroker/blob/main/LICENSE) file for details.

---

**Need help?** Check the [troubleshooting guide](https://github.com/Marc-Berg/node-red-contrib-iobroker/blob/main/docs/troubleshooting.md) or open an issue on GitHub.