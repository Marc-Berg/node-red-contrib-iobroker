# Changelog

## [1.0.0] - 2025-xx-xx

### 🎉 **First Stable Release**
This marks the first stable release of node-red-contrib-iobroker

#### **Complete Feature Set**
- 8 production-ready nodes covering all essential ioBroker integrations
- Advanced WebSocket connection management with automatic recovery
- Comprehensive error handling and logging integration

#### **Production-Ready Architecture**
- Robust connection management with graceful reconnection
- Memory-efficient resource cleanup and management
- Performance optimizations for large-scale deployments

#### **Breaking Changes**
- None - fully backward compatible with all 0.x versions

#### **Migration from 0.x**
- No configuration changes required
- Automatic upgrade of existing flows
- All existing features preserved and enhanced

## [0.15.1] - 2025-xx-xx

### Changed
- **UI improvements and code optimization**
  - Tab-based configuration UI for iob-out node with conditional sections
  - Object creation properties moved to separate tab
  - Code optimization across multiple files

## [0.15.0] - 2025-07-25

### Added
- **Tab-based configuration UI for iob-in node**
  - Reorganized configuration into 4 tabs: Data Source, Filtering, Output, Advanced

- **Configurable external triggering for iob-in nodes**
  - Enable/disable external triggering via checkbox (disabled by default for better performance)
  - Configurable trigger group names for organizing nodes by function/area
  - Function nodes can trigger cached state values using `flow.get('trigger_group_name')`
 
## [0.14.3] - 2025-07-16

 - prevent duplicate messages with delayed subscription consolidation

## [0.14.0] - 2025-07-15

### Added
- **Current value display in node status indicators**
  - iob-get: Shows last successfully retrieved value in status
  - iob-out: Shows last successfully set value in status
  - iob-in: Shows last received value in status (single state mode only)
  - 20-character truncation with "..." prefix for long values
  - JSON stringification for objects/arrays, explicit "null"/"undefined" display
  - Only displays values that passed all filters and were forwarded
  - Preserves error/connecting status text with higher priority
  - Falls back to "Ready" when no value has been processed yet

### Changed
- **Security: Credentials now properly encrypted** - Username and password are now stored as encrypted credentials in flows_cred.json instead of plain text in flows.json
  - **⚠️ BREAKING CHANGE**: Existing users must re-enter their username and password in server configuration nodes

### Added
- **Value change filtering for iob-in node**
  - Three filter modes: send all events, send only value changes, send only value changes with baseline
  - Initial values always bypass change filtering to ensure reliable startup behavior
  - Enhanced status indicators showing active filter mode with [Changes] label
  - Deep object comparison with JSON.stringify and fallback for non-serializable objects

### Added
- **Advanced data format options for iobhistory node**
  - Remove Border Values option to exclude data points at start/end boundaries
  - Timestamp Format option: Unix milliseconds vs ISO 8601 string format
  - Data Format option: Full metadata vs Simple (ts/val only) for reduced payload
  - All options configurable via node settings and message property overrides

### Fixed
- **Event-based graceful OAuth token renewal** - Rewrite of authentication token refresh mechanism
  - Replaced full session rebuild with parallel connection strategy
  - Implemented subscribe-first overlap strategy to prevent missed events during token renewal

### Changed
- **Optimized multiple states subscription performance for iob-in**
  - Parallel subscription processing with concurrency limit
  - Optimized initial value loading with parallel batches for faster startup
  - Enhanced error handling with per-state retry logic

### Changed  
- **Improved grouped mode logic for iob-in**
  - Fallback timeout if some states are unavailable or do not exist
  - Cleaner handling of initial grouped messages
  - Better performance for large multiple state configurations

### Fixed
- **Improved timestamp formatting in iobhistory node**
  - Removed redundant "Local Time" format option - use "Custom Format" with "auto" timezone instead
  - Simplified custom timestamp formatting using native Intl.DateTimeFormat
  - Enhanced timezone handling with better internationalization support

### Fixed
  - Enhance coordination between ConnectionManager, RecoveryManager and WebSocketManager during reconnections
  - Improved error handling and recovery logic

## [0.13.0] - 2025-07-10

### Changed
- **Optimized getObjects with getObjectView** - Improved performance for object retrieval operations
- **Improved alias resolution performance in iobgetobject node**
  - Replaced individual getObject() calls with batch loading for alias targets
  - Added caching for already loaded objects to avoid redundant requests
  - Reduced API calls for large wildcard patterns with aliases

### Changed
- **Optimized logging levels across all core managers**
  - Reduced INFO-level messages for cleaner production logs
  - Implemented operation logging with automatic importance detection
  - Moved technical details and internal state changes to DEBUG level
  - INFO level now focuses on admin-relevant events: connections, authentication, subscriptions, and important operations
  - DEBUG level provides comprehensive technical details for development and troubleshooting
- **Integrate ioBroker logging with Node-RED logging system**

### Changed
- **Implement consistent cleanup/destroy pattern across all managers**
  - Standardized destroy() methods to call cleanup() first
  - Improved memory management and resource cleanup consistency
 
### Fixed
- **Shutdown timeout errors in log unsubscription**
  - Fixed race condition between log node cleanup and WebSocket manager destruction
  - Improved all unsubscribe methods with graceful degradation when clients are destroyed
  - Timeout errors during shutdown now logged as debug messages instead of errors
 
## [0.12.0] - 2025-07-07

### Added
- **Query management for iobhistory node**
  - Three query processing modes: parallel (default), sequential, drop
  - Sequential mode: queue multiple queries for ordered processing
  - Drop mode: discard new queries while one is running
  - Queue status display in node status indicator
  - Enhanced output with queryId, queryMode, and dropped properties

### Added
- **Alias resolution for iobgetobject node**
  - New "Include alias information" option for automatic alias resolution
  - Three resolution modes: both directions, target-only, reverse-only
  - aliasInfo property with isAlias, aliasTarget, and aliasedBy fields
  - Alias statistics for wildcard patterns showing relationship counts

### Changed
- **Simplified output format for iobgetobject node**
  - Removed redundant fields from output
  - Added conditional pattern field (only for wildcard queries)
  - Added conditional properties (appliedFilter, includesEnums, includesAliases)
  - Statistics now only included when data is available

### Changed
- **iobhistory node UI improvements**
  - Reorganized configuration into tabbed interface: Data Source, Time Range, Processing, Output
  - Improved visual structure and user experience
  - Better grouping of related settings

### Changed
- **Extracted Common Patterns**: Created comprehensive helper utilities to eliminate code duplication

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