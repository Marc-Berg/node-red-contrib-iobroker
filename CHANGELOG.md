# Changelog

## [0.8.0] - 2025-01-30
### Added
- **New node "iobhistory"** - Historical data retrieval from ioBroker history adapters
- History adapter auto-detection with real-time status indicators (🟢🟡🔴)
- Support for History, SQL, and InfluxDB adapters
- Multiple time range modes: Duration, Absolute, and Message-based
- Advanced aggregation methods: none, onchange, average, min, max, minmax, total, count, percentile, quantile, integral
- Multiple output formats: Array, Chart.js, and Statistics

## [0.7.0] - 2025-06-29
### Added
- Object type filtering for iobgetobject node
- Wildcard pattern support for iobgetobject
- Auto-detection of wildcard patterns

### Fixed
- Object type filter parameter passing

## [0.6.0] - 2025-06-28
### Added
- New node "inobject"