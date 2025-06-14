# Node-RED Nodes for ioBroker Integration

This repository provides custom Node-RED nodes for seamless integration with ioBroker via WebSocket communication.

## Features

- **Real-time WebSocket communication**
- **Shared connection management** - multiple nodes share WebSocket connections
- **Interactive state browser** with search functionality
- **Automatic reconnection** and connection status monitoring
- **Bidirectional communication** for state changes and commands

## Nodes

### iobin
**Input Node**  
Subscribes to ioBroker state changes and forwards updates to your flow in real-time.

- **State:** An ioBroker state can be specified using the interactive tree browser or manual input.
- **Output:** The value of the changed state is sent as `msg.[outputProperty]` (default: `msg.payload`).  
  The complete state object is available in `msg.state`.
- **Trigger on:** Filter state updates by acknowledgment status:
  - **Both:** All updates (default)
  - **Acknowledged:** Only updates with `ack: true`
  - **Unacknowledged:** Only updates with `ack: false`
- **Server Configuration:** Configure the ioBroker server details in the node settings.

### iobout
**Output Node**  
Sends values to ioBroker states.

- **State:** Specify the target ioBroker state using the tree browser or manual input.  
  If left empty, `msg.topic` is used as the state ID.
- **Input:** Any message with a value in `msg.[inputProperty]` (default: `msg.payload`) will update the specified state.
- **Set Mode:** Choose whether to set the value as a `value` (ack=true) or as a `command` (ack=false).
- **Server Configuration:** Configure the ioBroker server details in the node settings.

### iobget
**Getter Node**  
Reads the current value of an ioBroker state on demand.

- **State:** Specify the ioBroker state to read using the tree browser or manual input.  
  If left empty, `msg.topic` is used as state ID.
- **Output:** The current value of the state is sent as `msg.[outputProperty]` (default: `msg.payload`).
- **Server Configuration:** Configure the ioBroker server details in the node settings.

### iob-config
**Configuration Node**  
Shared configuration for ioBroker server settings.

- **ioBroker Host/Port:** Configure the ioBroker WebSocket endpoint.
- **Authentication:** Optional username/password for secured ioBroker installations.

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
2. **Configure** the server settings in the `iob-config` node:
   - Enter the ioBroker host and port details.
   - Add authentication credentials if required.
3. **Configure** each node as needed:
   - Use the **interactive tree browser** to select states or enter them manually.
   - Set the output/input property for the value (default: `msg.payload`).
   - For `iobin`, select whether to trigger on all updates or only on acknowledged/unacknowledged changes.
   - For `iobout`, choose between "value" (ack=true) or "command" (ack=false) mode.
   - For `iobout` and `iobget`, set the state ID or leave it empty to use `msg.topic`.
4. **Connect** the nodes to your flow as needed.

## State Selection

All nodes feature an **interactive state browser** that makes it easy to find and select ioBroker states:

- **Manual input:** Type the state ID directly (e.g., `0_userdata.0.test`)
- **Tree browser:** Click "Switch to tree selection" to browse available states
- **Search functionality:** Use the search box to filter states in tree view
- **Smart caching:** State lists are cached for better performance
- **Real-time refresh:** Update the state list with the refresh button

## Connection Management

The nodes use a **shared WebSocket connection manager** that provides:

- **Efficient resource usage:** Multiple nodes share connections to the same ioBroker server
- **Automatic reconnection:** Connections are automatically restored after network interruptions
- **Connection monitoring:** Real-time status updates for all nodes
- **Configuration change detection:** Automatic reconnection when server settings change

## Examples

- **Subscribe to state changes:** Use `iobin` to receive real-time updates from ioBroker.
- **Send values to ioBroker:** Use `iobout` to update ioBroker states (as value or command).
- **Read state values on demand:** Use `iobget` to query the current value of a state.
- **Status monitoring:** Send `msg.topic = "status"` to any node to get connection information.
- **Manual reconnection:** Send `msg.topic = "reconnect"` to force a reconnection.

## WebSocket Connection

The nodes connect to ioBroker's WebSocket interface via one of three options:

- **WebSocket adapter** (default port 8084)
- **Web adapter** (default port 8082, requires "Use pure web-sockets (iobroker.ws)" to be enabled)
- **Admin adapter** (default port 8081)

Make sure that:

1. **One of the WebSocket-capable adapters is installed and running**
2. **The appropriate port is accessible** from your Node-RED instance
3. **Authentication is configured** if your ioBroker installation requires it

## Troubleshooting

If you experience connection issues:

1. **Check WebSocket adapters:** 
   - **WebSocket adapter (8084):** Ensure it's installed via `iobroker add ws` and running
   - **Web adapter (8082):** Ensure it's installed via `iobroker add web` and running
   - **Admin adapter (8081):** Ensure it's installed via `iobroker add admin` and running
2. **Verify network connectivity:** Test if the chosen port is reachable from Node-RED
3. **Check authentication:** Verify username/password if authentication is enabled in ioBroker
4. **Review logs:** Check both Node-RED debug logs and ioBroker logs for error messages
5. **Use status monitoring:** Send status messages to nodes to check connection health
6. **Try alternative ports:** If one port doesn't work, try the other WebSocket options

## License

MIT