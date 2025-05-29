# Node-RED Nodes for ioBroker Integration

This repository provides custom Node-RED nodes for seamless integration with ioBroker via its REST API.

## Nodes

### iobin
**Input Node**  
Subscribes to ioBroker state changes and forwards updates to your flow.

- **State:** A ioBroker state can be specified.
- **Output:** The value of the changed state is sent as `msg.payload`.  
  Optionally, the full state object can be output.
- **Server Configuration:** Configure the ioBroker and Node-RED server details in the node settings.

### iobout
**Output Node**  
Sends values to ioBroker states.

- **State:** Specify the target ioBroker state.
- **Input:** Any message with a `msg.payload` will update the specified state.
- **Server Configuration:** Configure the ioBroker server details in the node settings.

### iobget
**Getter Node**  
Reads the current value of an ioBroker state on demand.

- **State:** Specify the ioBroker state to read.  
  If left empty, `msg.topic` is used as state ID.
- **Output:** The current value of the state is sent as `msg.payload`.
- **Server Configuration:** Configure the ioBroker server details in the node settings.

### iob-config
**Configuration Node**  
Shared configuration for ioBroker and Node-RED server settings.

- **ioBroker Host/Port:** Configure the ioBroker REST API endpoint.
- **Node-RED Host/Port:** Configure the Node-RED callback endpoint (for subscriptions).

## Installation

### As npm Package

1. Install the package in your Node-RED user directory:
cd ~/.node-red
npm install <your-package-name>
2. Restart Node-RED.

### Manual Installation

1. Copy the node files (`iobin.js`, `iobin.html`, `iobout.js`, `iobout.html`, `iobget.js`, `iobget.html`, `iob-config.js`, `iob-config.html`) to your Node-RED nodes directory (usually `~/.node-red/nodes/`).
2. Restart Node-RED.

## Usage

1. **Drag and drop** the nodes into your flow.
2. **Configure** the server settings in the `iob-config` node.
3. **Connect** the nodes to your flow as needed.

## Examples

- **Subscribe to state changes:** Use `iobin` to receive updates from ioBroker.
- **Send values to ioBroker:** Use `iobout` to update ioBroker states.
- **Read state values on demand:** Use `iobget` to query the current value of a state.

## License

MIT

---

**For support or feature requests, please open an issue on GitHub.**

