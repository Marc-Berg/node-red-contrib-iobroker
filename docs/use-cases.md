# Use Cases for Node-RED ioBroker Integration

This guide provides practical examples of how to use the Node-RED ioBroker integration nodes in real-world scenarios.

## 1. Home Automation

### 1.1 Lighting Control

#### Automatic Door-Based Lighting
Monitor door sensors and automatically control room lighting based on door state changes.

**Flow Setup:**
1. Use **WS ioB in** with wildcard pattern `*.door.state`
2. Connect to **Switch** node to check if door is opened
3. Use **Function** node to determine specific light state ID
4. Use **WS ioB out** to control specific lights like `lights.livingroom.state`
5. Add **Delay** node to turn off lights after certain time

#### Motion-Activated Lighting
Control lights based on motion sensor detection with automatic timeout.

**Flow Setup:**
1. **WS ioB in** → Subscribe to `motion.*.detected`
2. **Switch** → Check motion state (true/false)
3. **Change** → Set light state to ON
4. **WS ioB out** → Send to `lights.room.state`
5. **Delay** → Wait 10 minutes after motion stops
6. **WS ioB out** → Send OFF to same light state

### 1.2 Climate Control

#### Temperature-Based Heating Control
Monitor room temperatures and automatically adjust heating setpoints.

**Flow Setup:**
1. **WS ioB in** → Monitor `*.temperature` states
2. **Function** → Calculate desired setpoint based on current temp
3. **Range** → Limit setpoint to safe values (16-25°C)
4. **Function** → Determine specific heating zone ID from temperature sensor
5. **WS ioB out** → Send to specific heating state like `heating.livingroom.setpoint`

#### Smart Thermostat Logic
Create intelligent heating control with time schedules and presence detection.

**Flow Setup:**
1. **WS ioB in** → Multiple inputs: temperature, presence, time
2. **Function** → Complex logic for comfort vs efficiency
3. **Split** → Send commands to multiple heating zones
4. **WS ioB out** → Control specific heating valves like `heating.zone1.valve`
5. **WS ioB out** → Control boiler state `heating.boiler.state`

### 1.3 Security Systems

#### Intrusion Detection
Monitor door/window sensors and trigger alarms when security is breached.

**Flow Setup:**
1. **WS ioB in** → Subscribe to `security.*.contact`
2. **Switch** → Filter only "open" states during armed periods
3. **Change** → Set alarm state
4. **Split** → Send commands to multiple devices
5. **WS ioB out** → Trigger specific devices like `alarm.siren.state`, `lights.all.flash`

#### Access Control
Control door locks based on user authentication and schedules.

**Flow Setup:**
1. **WS ioB in** → Monitor RFID/keypad inputs
2. **Function** → Validate user credentials and time restrictions
3. **WS ioB out** → Control door lock state `security.door.lock`
4. **WS ioB out** → Log access events to `security.access.log`

## 2. System Monitoring

### 2.1 Adapter Health Monitoring

#### Real-Time Status Dashboard
Create a comprehensive overview of all ioBroker adapter states.

**Flow Setup:**
1. **WS ioB in** → Subscribe to `system.adapter.*.alive`
2. **Function** → Process and format adapter status
3. **Dashboard** → Display adapter health grid
4. **Switch** → Filter only offline adapters for alerts

#### Automatic Restart Failed Adapters
Monitor adapter health and automatically restart failed instances.

**Flow Setup:**
1. **WS ioB in** → Monitor `system.adapter.*.alive`
2. **Switch** → Detect false (offline) states
3. **Delay** → Wait before restart to avoid false triggers
4. **WS ioB out** → Send restart command to specific adapter like `system.adapter.hm-rpc.restart`

### 2.2 Performance Monitoring

#### Memory Usage Tracking
Monitor system memory consumption and alert on high usage.

**Flow Setup:**
1. **WS ioB history** → Get historical `system.*.memRss` data
2. **Function** → Calculate memory trends and averages
3. **Switch** → Alert when usage exceeds thresholds
4. **Dashboard** → Display memory usage charts

#### CPU Load Monitoring
Track system performance and identify performance bottlenecks.

**Flow Setup:**
1. **WS ioB in** → Subscribe to `system.*.load`
2. **Function** → Calculate load averages and trends
3. **Range** → Normalize load values for display
4. **Chart** → Visualize load over time

### 2.3 Log Monitoring

#### Error Alert System
Monitor ioBroker logs and send notifications for critical errors.

**Flow Setup:**
1. **WS ioB log** → Set level to "error"
2. **Switch** → Filter specific error types or adapters
3. **Template** → Format notification message
4. **Email/Push** → Send alert notifications

#### Adapter Activity Monitoring
Track adapter startup, shutdown, and error events.

**Flow Setup:**
1. **WS ioB log** → Monitor all log levels
2. **Function** → Parse and categorize log messages
3. **Switch** → Route different message types
4. **Dashboard** → Display activity timeline

## 3. Data Analysis

### 3.1 Energy Consumption Tracking

#### Real-Time Energy Dashboard
Monitor current power consumption across all devices.

**Flow Setup:**
1. **WS ioB in** → Subscribe to `energy.*.power`
2. **Function** → Sum total consumption and calculate costs
3. **Chart** → Display real-time power usage
4. **Gauge** → Show current total consumption

#### Historical Energy Analysis
Analyze energy consumption patterns over time.

**Flow Setup:**
1. **WS ioB history** → Get `energy.*.consumption` data
2. **Function** → Calculate daily/weekly/monthly totals
3. **Chart** → Display consumption trends
4. **Table** → Show top energy consumers

### 3.2 Dashboard Data Preparation

#### Complete State Discovery for Dashboards
Discover all relevant objects and retrieve their current states with aliases for comprehensive dashboard displays.

**Flow Setup:**
1. **WS ioB getObject** → Discover objects with pattern matching (e.g., `lights.*`, `sensors.*.temperature`)
2. **WS ioB get** → Retrieve current states and values for all discovered objects
3. **Function** → Process and format data for dashboard consumption
4. **Dashboard/UI** → Display complete state information with names and values

**Example Configuration:**
- **Pattern**: `lights.*.level` to find all dimmer controls
- **Type Filter**: `state` to get only state objects
- **Output**: Complete object metadata with current values and alias definitions
- **Result**: Ready-to-use data including object names, current values, units, and translations

**Use Cases:**
- **Smart Home Dashboard**: Show all lights with current brightness levels
- **Sensor Overview**: Display all temperature sensors with current readings and aliases
- **Device Status Board**: List all devices with their current states and friendly names
- **System Monitoring**: Overview of all system states with descriptive names

**Benefits:**
- Automatic discovery of new objects when added to ioBroker
- Complete alias information for user-friendly display names
- Robust handling of missing or unavailable states
- Single workflow to populate complex dashboards with live data

### 3.3 Weather Data Analysis

#### Weather Station Data Collection
Collect and analyze data from multiple weather sensors.

**Flow Setup:**
1. **WS ioB in** → Multiple weather sensor inputs
2. **Function** → Combine and validate sensor data
3. **WS ioB history** → Store processed data
4. **Dashboard** → Display current conditions and forecasts

#### Climate Pattern Analysis
Analyze long-term weather patterns and trends.

**Flow Setup:**
1. **WS ioB history** → Get historical weather data
2. **Function** → Calculate averages, minimums, maximums
3. **Chart** → Display seasonal patterns
4. **Function** → Generate weather predictions

### 3.4 Device Usage Analytics

#### Smart Device Usage Patterns
Analyze how smart home devices are used throughout the day.

**Flow Setup:**
1. **WS ioB history** → Get device state changes
2. **Function** → Calculate usage duration and frequency
3. **Chart** → Display usage patterns by time of day
4. **Table** → Show device usage statistics

#### Optimization Recommendations
Generate recommendations for improving home automation efficiency.

**Flow Setup:**
1. **WS ioB history** → Collect multiple data sources
2. **Function** → Analyze patterns and inefficiencies
3. **Template** → Generate optimization suggestions
4. **Dashboard** → Display recommendations

## 4. Integration Examples

### 4.1 Third-Party Service Integration

#### Weather API Integration
Combine external weather data with local sensors.

**Flow Setup:**
1. **HTTP Request** → Get weather forecast from API
2. **WS ioB in** → Get local temperature sensor data
3. **Function** → Compare and validate data sources
4. **WS ioB out** → Store combined weather data in `weather.combined.forecast`

#### Smart Speaker Integration
Control ioBroker devices through voice commands.

**Flow Setup:**
1. **HTTP In** → Receive voice command webhooks
2. **Function** → Parse voice commands and extract device/action
3. **Switch** → Route to appropriate device controls
4. **Function** → Map commands to specific device state IDs
5. **WS ioB out** → Execute device commands like `lights.living.state` or `heating.setpoint`

### 4.2 Database Integration

#### External Database Logging
Store ioBroker data in external databases for advanced analytics.

**Flow Setup:**
1. **WS ioB in** → Subscribe to important state changes
2. **Function** → Format data for database storage
3. **Database** → Insert/update records
4. **Debug** → Monitor database operations

#### Data Synchronization
Keep ioBroker states synchronized with external systems.

**Flow Setup:**
1. **WS ioB in** → Monitor state changes
2. **HTTP Request** → Send updates to external API
3. **WS ioB out** → Update acknowledgment states like `sync.status.lastUpdate`
4. **Function** → Handle synchronization errors

## 5. Advanced Patterns

### 5.1 State Machine Implementation

#### Device State Management
Implement complex state machines for device control logic.

**Flow Setup:**
1. **WS ioB in** → Monitor device inputs and current state
2. **Function** → Implement state transition logic
3. **Context** → Store current state information
4. **WS ioB out** → Update specific device outputs like `device.currentState` or `device.outputValue`

### 5.2 Data Validation and Filtering

#### Sensor Data Validation
Implement data quality checks for sensor inputs.

**Flow Setup:**
1. **WS ioB in** → Receive raw sensor data
2. **Range** → Check values are within expected limits
3. **Rate Limit** → Prevent rapid fluctuations
4. **Switch** → Filter valid vs invalid readings
5. **WS ioB out** → Store validated data to specific states like `sensors.temperature.validated`

## 6. Performance Optimization

### 6.1 Efficient Wildcard Usage

#### Smart Pattern Design
Design wildcard patterns for optimal performance.

**Best Practices:**
- Use specific prefixes: `lights.*` instead of `*`
- Limit depth: `room.*.temperature` instead of `**`
- Combine patterns: Multiple specific subscriptions vs one broad pattern
- Monitor subscription count in node status

### 6.2 Message Flow Optimization

#### Reduce Message Frequency
Implement strategies to reduce unnecessary message processing.

**Flow Setup:**
1. **WS ioB in** → Raw high-frequency data
2. **Delay** → Batch messages over time window
3. **Function** → Process batch and extract relevant changes
4. **WS ioB out** → Send only significant changes to specific states