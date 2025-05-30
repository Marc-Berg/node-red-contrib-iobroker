# Node-RED Nodes for ioBroker Integration

This repository provides custom Node-RED nodes for seamless integration with ioBroker via its REST API Adapter.

## Nodes

### iobin
**Input Node**  
Subscribes to ioBroker state changes and forwards updates to your flow.

- **State:** An ioBroker state can be specified.
- **Output:** The value of the changed state is sent as `msg.payload`.  
  Optionally, the full state object can be output.
- **Server Configuration:** Configure the ioBroker and Node-RED server details in the node settings.

### iobout
**Output Node**  
Sends values to ioBroker states.

- **State:** Specify the target ioBroker state.
- **Input:** Any message with a `msg.payload` will update the specified state.
- **Set Mode:** Choose whether to set the value as a `value` (ack=true) or as a `command` (ack=false).
- **Server Configuration:** Configure the ioBroker server details in the node settings.

### iobget
**Getter Node**  
Reads the current value of an ioBroker state on demand.

- **State:** Specify the ioBroker state to read.  
  If left empty, `msg.topic` is used as state ID.
- **Output:** The current value of the state is sent as `msg.payload`.
- **Server Configuration:** Configure the ioBroker server details in the node settings.
- **REST API Mode:** Supports both native (direct port) and web plugin (`/rest/` path) modes.

### iob-config
**Configuration Node**  
Shared configuration for ioBroker and Node-RED server settings.

- **ioBroker Host/Port:** Configure the ioBroker REST API endpoint.
- **Node-RED Host/Port:** Configure the Node-RED callback endpoint (for subscriptions).
- **REST API Mode:** Choose between native (direct port) and web plugin (`/rest/` path) modes.

## Installation

### Upload .tgz

You can install this package manually by downloading the .tgz file from the GitHub Releases page and uploading it directly into your Node-RED palette.

## Usage

1. **Drag and drop** the nodes into your flow.
2. **Configure** the server settings in the `iob-config` node.
- Select the REST API mode (`native` for direct port, `web` for web plugin).
- Enter the ioBroker and Node-RED host/port details.
3. **Connect** the nodes to your flow as needed.

## Examples

- **Subscribe to state changes:** Use `iobin` to receive updates from ioBroker.
- **Send values to ioBroker:** Use `iobout` to update ioBroker states (as value or command).
- **Read state values on demand:** Use `iobget` to query the current value of a state.

## REST API Modes

- **Native (direct port):**  
The REST API Adapter runs on its own port (default: 8093).  
Example: `http://iobroker:8093/v1/state/<stateId>`
- **Web Plugin (`/rest/` path):**  
The REST API Adapter runs as a plugin in the web adapter (default port: 8082).  
Example: `http://iobroker:8082/rest/v1/state/<stateId>`

> **Note:**  
> **Currently, the web adapter plugin mode may not work due to issues with the REST API adapter or web adapter configuration.**  
> **If you experience problems, please use the native (direct port) mode instead.**  


## License

MIT

