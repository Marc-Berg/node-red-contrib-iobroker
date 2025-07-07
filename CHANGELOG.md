# Changelog

## [0.12.0] - 2025-07-07

### Added
- **Query management for iobhistory node**
  - Three query processing modes: parallel (default), sequential, drop
  - Sequential mode: queue multiple queries for ordered processing
  - Drop mode: discard new queries while one is running
  - Queue status display in node status indicator
  - Enhanced output with queryId, queryMode, and dropped properties

### Changed
- **iobhistory node UI improvements**
  - Reorganized configuration into tabbed interface: Data Source, Time Range, Processing, Output
  - Improved visual structure and user experience
  - Better grouping of related settings

### Fixed
- Clean up and standardize output properties for iobgetobject node

## [0.11.0] - 2025-07-06

### Added
- **New node "iobsendto"** - Send commands to ioBroker adapters via sendTo functionality
  - Support for fire-and-forget and response modes
  - Configurable timeout for response operations
  - Dynamic adapter, command, and message override via input messages

## [0.10.0] - 2025-07-06

### Added
- **Enum functionality for iobgetobject node**
  - New "Include assigned Enums" option for automatic enum assignment retrieval
  - Enum type filtering: all types, rooms only, functions only, or combinations
  - Enum data in output including room/function names, icons, and colors
  - Enum statistics showing coverage across retrieved objects

### Changed
- **Project structure reorganization**
  - Moved all node files (*.js, *.html) to `/nodes` directory for better organization
- **Node-RED palette organization**
  - Reorganized nodes into logical categories: "ioBroker WS" for all WebSocket-based nodes
- **Dependency management**
  - Downgraded Express from 5.x to 4.x (^4.19.0) for Node-RED compatibility
  - Fixed potential conflicts with Node-RED's internal Express usage

### Fixed
- **Race conditions in Multiple States subscriptions**
  - Implemented batch subscriptions replacing individual state subscriptions
  - Improved stability and performance for multiple states feature

## [0.9.5] - 2025-07-03
### Added
- **Multiple States mode for WS ioB in node**
  - New input mode supporting predefined lists of specific states
  - Grouped output format combining all current values in single message
  - Individual output mode for separate messages per state change

### Changed
- **Output message format for grouped mode**
  - New `grouped_states` topic for combined state messages
  - Added `changedState` and `changedValue` properties to track triggering state

### Fixed
 - Fix auth manager reauthenticate bug
 - Eliminate duplicate code and clean up utilities

## [0.9.4] - 2025-07-02
### Fixed
- **Dashboard 2.0 output format for iobhistory node**
  - Corrected data format to `[{x: timestamp, y: value}, ...]` for proper ui-chart compatibility

## [0.9.3] - 2025-07-02
### Added
- **Dashboard 2.0 output format for iobhistory node**
  - New "Dashboard 2.0 Format" option in output format dropdown
  - Direct compatibility with Node-RED Dashboard 2.0 ui-chart components
  - Timestamp-based data format: `[{series: [], data: [[timestamp, value], ...], labels: [""]}]`
  - Seamless integration for modern dashboard visualizations

## [0.9.2] - 2025-07-01
### Added
- **Architecture diagram** showing recommended Node-RED to ioBroker setup
- **Dedicated Admin instance recommendation** in documentation
- **Comprehensive node documentation** with individual files for each node

### Changed
- **Documentation structure** - extracted troubleshooting and use cases to separate files
- **Configuration section** - consolidated and simplified setup instructions
- **Node table** - added direct links to detailed documentation

## [0.9.1] - 2025-07-01
### Fixed
- **Race condition causing nodes to display "Waiting for Connection" status while functional**
  - Fixed timing issue between WebSocket connection establishment and node registration

## [0.9.0] - 2025-06-30
### Added
- **New node "ioblog"** - Live log subscription and monitoring
  - Real-time log message streaming from ioBroker with configurable log levels
  - Client-side log level filtering (silly, debug, info, warn, error)
  - Support for timestamp and source adapter inclusion in output messages

## [0.8.1] - 2025-06-30
### Fixed
- **iobgetobject node crash when type filter excludes all objects** - Fixed "Cannot set properties of null" error that occurred when object type filtering resulted in no matches

## [0.8.0] - 2025-06-30
### Added
- **New node "iobhistory"** - Historical data retrieval from ioBroker history adapters
  - History adapter auto-detection with real-time status indicators (🟢🟡🔴)
  - Support for History, SQL, and InfluxDB adapters
  - Multiple time range modes: Duration, Absolute, and Message-based
  - Advanced aggregation methods: none, onchange, average, min, max, minmax, total, count, percentile, quantile, integral
  - Multiple output formats: Array, Chart.js, and Statistics

## [0.7.0] - 2025-06-29
### Added
- **Object type filtering for iobgetobject node**
  - Wildcard pattern support for iobgetobject
  - Auto-detection of wildcard patterns

### Fixed
  - Object type filter parameter passing

## [0.6.0] - 2025-06-28
### Added
- **New node "iobinobject"** - Object subscription and monitoring
  - Real-time ioBroker object change monitoring
  - Wildcard pattern support for object subscriptions (e.g., system.adapter.*)
  - Object structure and configuration change detection
  - Object operation tracking (update/delete)