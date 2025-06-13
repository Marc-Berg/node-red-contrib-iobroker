# Node-RED Nodes for ioBroker Integration

This repository provides custom Node-RED nodes for seamless integration with ioBroker via its REST API Adapter.


⚠️ Migration Notice:
This project is currently being migrated from REST API to WebSocket communication for improved real-time performance and bidirectional communication.

## Nodes

### iobin
**Input Node**  
Subscribes to ioBroker state changes and forwards updates to your flow.

- **State:** An ioBroker state can be specified.
- **Output:** The value of the changed state is sent as `msg.[outputProperty]` (default: `msg.payload`).  
  Optionally, the full state object can be output.
- **Trigger on:** Filter state updates by acknowledgment status:
  - **Both:** All updates (default)
  - **Acknowledged:** Only updates with `ack: true`
  - **Unacknowledged:** Only updates with `ack: false`
- **Server Configuration:** Configure the ioBroker and Node-RED server details in the node settings.
- **Supports both native (direct port) and web plugin modes** (although the web adapter plugin mode may currently have issues).

### iobout
**Output Node**  
Sends values to ioBroker states.

- **State:** Specify the target ioBroker state.  
  If left empty, `msg.topic` is used as the state ID.
- **Input:** Any message with a value in `msg.[inputProperty]` (default: `msg.payload`) will update the specified state.
- **Set Mode:** Choose whether to set the value as a `value` (ack=true) or as a `command` (ack=false).
- **Server Configuration:** Configure the ioBroker server details in the node settings.
- **Supports both native (direct port) and web plugin modes** (although the web adapter plugin mode may currently have issues).

### iobget
**Getter Node**  
Reads the current value of an ioBroker state on demand.

- **State:** Specify the ioBroker state to read.  
  If left empty, `msg.topic` is used as state ID.
- **Output:** The current value of the state is sent as `msg.[outputProperty]` (default: `msg.payload`).
- **Server Configuration:** Configure the ioBroker server details in the node settings.
- **Supports both native (direct port) and web plugin modes** (although the web adapter plugin mode may currently have issues).

### iob-config
**Configuration Node**  
Shared configuration for ioBroker and Node-RED server settings.

- **ioBroker Host/Port:** Configure the ioBroker REST API endpoint.
- **Node-RED Host/Port:** Configure the Node-RED callback endpoint (for subscriptions).
- **REST API Mode:** Choose between native (direct port) and web plugin (`/rest/` path) modes.

## Installation

### Upload .tgz
- **Download the .tgz file** from the latest release (https://github.com/Marc-Berg/node-red-contrib-iobroker/releases) on GitHub.
- **Open your Node-RED editor.**
- **Go to the palette manager** (Menu → "Manage palette").
- **Switch to the "Install" tab.**
- **Click on "Upload a .tgz file"** and select the downloaded .tgz file.
- **Wait for the installation to complete** and restart Node-RED if prompted.

## Usage

1. **Drag and drop** the nodes into your flow.
2. **Configure** the server settings in the `iob-config` node.
   - Select the REST API mode (`native` for direct port, `web` for web plugin).
   - Enter the ioBroker and Node-RED host/port details.
3. **Configure** each node as needed:
   - Set the output/input property for the value (default: `msg.payload`).
   - For `iobin`, select whether to trigger on all updates or only on acknowledged/unacknowledged changes.
   - For `iobout` and `iobget`, set the state ID or leave it empty to use `msg.topic`.
4. **Connect** the nodes to your flow as needed.

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
