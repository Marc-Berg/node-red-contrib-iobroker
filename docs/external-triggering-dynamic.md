# External Triggering - Dynamic Topic Switching

Die **External Triggering** Funktionalität der iob-in Node wurde erweitert und bietet jetzt drei Modi:

## 1. Cached Value Triggering (bisherig)
Sendet den letzten empfangenen Wert erneut, ohne die Subscription zu ändern.

## 2. Dynamic Topic Switching (Single Mode)
Wechselt dynamisch zu einem neuen State/Topic und empfängt dann automatisch Updates von diesem neuen State.

## 3. Dynamic Topics Array (Multiple Mode)
Wechselt dynamisch zu einem neuen Array von States und empfängt automatisch Updates von allen neuen States.

---

## Konfiguration

### iob-in Node einrichten
1. **Enable external triggering** aktivieren
2. **Trigger Group** Name angeben (z.B. `iobroker_in_nodes`)
3. **Input Mode** wählen:
   - `single` → `triggerWithTopic()` verfügbar
   - `multiple` → `triggerWithTopicArray()` verfügbar
   - Wildcard → nur `triggerCached()` verfügbar

### Node wird registriert
Bei aktiviertem External Triggering wird die Node im Flow Context registriert:
```javascript
{
    nodeRef: node,                               // Referenz zur Node
    triggerCached: function(),                   // Sendet cached value
    triggerWithTopic: async function(topic),     // Wechselt zu neuem Topic (single only)
    triggerWithTopicArray: async function(array),// Wechselt zu neuem Array (multiple only)
    supportsDynamicTopic: true/false,            // Single Mode Capability Flag
    supportsDynamicArray: true/false,            // Multiple Mode Capability Flag
    states: ['current.state.id'],
    mode: 'single' | 'multiple',
    name: 'Node Name',
    // ...
}
```

---

## Verwendung

### Aus Function Node aufrufen

#### Cached Value senden
```javascript
// Flow Context auslesen
const nodes = flow.get('iobroker_in_nodes') || {};

// Node finden (ID von iob-in Node)
const targetNode = nodes['<NODE_ID>'];

if (targetNode && targetNode.triggerCached) {
    // Sendet cached value erneut
    targetNode.triggerCached();
}
```

#### Zu neuem Topic wechseln
```javascript
// Flow Context auslesen
const nodes = flow.get('iobroker_in_nodes') || {};

// Node finden
const targetNode = nodes['<NODE_ID>'];

// Prüfen ob Dynamic Topic Switching unterstützt wird
if (targetNode && targetNode.supportsDynamicTopic) {
    // Async: Wechsel zu neuem State
    await targetNode.triggerWithTopic('system.adapter.hm-rpc.0.alive');
} else {
    node.warn('Dynamic topic switching not supported (wildcard or multiple mode)');
}
```

#### Neues Topic aus msg.topic
```javascript
const nodes = flow.get('iobroker_in_nodes') || {};
const targetNode = nodes['<NODE_ID>'];

if (targetNode && targetNode.supportsDynamicTopic && msg.topic) {
    await targetNode.triggerWithTopic(msg.topic);
}
```

### Multiple Mode (Array of States)

#### Zu neuem Topics-Array wechseln
```javascript
// Flow Context auslesen
const nodes = flow.get('iobroker_in_nodes') || {};

// Node finden
const targetNode = nodes['<NODE_ID>'];

// Prüfen ob Dynamic Array Switching unterstützt wird
if (targetNode && targetNode.supportsDynamicArray) {
    // Async: Wechsel zu neuem State-Array
    const newTopics = [
        'system.adapter.admin.0.alive',
        'system.adapter.admin.0.connected',
        'system.adapter.admin.0.memRss'
    ];
    
    // Optional: Output Mode ändern
    const outputMode = 'grouped'; // oder 'individual' oder undefined
    
    await targetNode.triggerWithTopicArray(newTopics, outputMode);
} else {
    node.warn('Dynamic array switching not supported (not in multiple mode)');
}
```

#### Neues Array aus msg.payload
```javascript
const nodes = flow.get('iobroker_in_nodes') || {};
const targetNode = nodes['<NODE_ID>'];

if (targetNode && targetNode.supportsDynamicArray && Array.isArray(msg.payload)) {
    await targetNode.triggerWithTopicArray(msg.payload);
}
```

---

## Use Cases

### Single Mode Use Cases

### 1. Dashboard mit Raum-Auswahl
Nutzer wählt Raum aus → Node wechselt zu Temperature-State des gewählten Raums:
```javascript
// msg.room = 'living_room' | 'bedroom' | 'kitchen'
const stateId = `0_userdata.0.temperature.${msg.room}`;

await targetNode.triggerWithTopic(stateId);
```

### 2. Adapter-Monitoring per Dropdown
Liste von Adapters → wechselt zu `.alive` State des gewählten Adapters:
```javascript
// msg.adapter = 'admin.0' | 'hm-rpc.0' | 'sql.0'
const aliveState = `system.adapter.${msg.adapter}.alive`;

await targetNode.triggerWithTopic(aliveState);
```

### 3. Dynamische Device-Überwachung
Wechsel zwischen verschiedenen Geräten mit gleicher Struktur:
```javascript
// msg.deviceId = 'device_001' | 'device_002'
const deviceState = `hm-rpc.0.${msg.deviceId}.STATE`;

await targetNode.triggerWithTopic(deviceState);
```

### 4. Context-Aware Monitoring
Basierend auf Benutzer-Präferenzen oder System-Status:
```javascript
// Unterschiedliche States basierend auf Tageszeit
const now = new Date().getHours();
const stateId = now < 12 
    ? '0_userdata.0.morning_temperature'
    : '0_userdata.0.evening_temperature';

await targetNode.triggerWithTopic(stateId);
```

### Multiple Mode Use Cases

### 5. Dashboard mit Adapter-Gruppe Auswahl
Nutzer wählt Adapter-Gruppe → Node wechselt zu allen States dieser Gruppe:
```javascript
// msg.group = 'system' | 'hvac' | 'security'
const groups = {
    system: [
        'system.adapter.admin.0.alive',
        'system.adapter.admin.0.connected',
        'system.host.nuc.cpuPercent'
    ],
    hvac: [
        'hm-rpc.0.thermostat_1.ACTUAL_TEMPERATURE',
        'hm-rpc.0.thermostat_1.SET_TEMPERATURE',
        'hm-rpc.0.thermostat_2.ACTUAL_TEMPERATURE'
    ],
    security: [
        'hm-rpc.0.door_sensor_1.STATE',
        'hm-rpc.0.window_sensor_1.STATE',
        'hm-rpc.0.motion_sensor_1.MOTION'
    ]
};

await targetNode.triggerWithTopicArray(groups[msg.group]);
```

### 6. Dynamische Geräte-Liste
Liste von Geräten wird zur Laufzeit ermittelt und überwacht:
```javascript
// msg.deviceIds = ['device_001', 'device_002', 'device_003']
const stateIds = msg.deviceIds.map(id => `hm-rpc.0.${id}.STATE`);

await targetNode.triggerWithTopicArray(stateIds, 'grouped');
```

### 7. Multi-Raum Monitoring
Wechsel zwischen verschiedenen Raum-Konfigurationen:
```javascript
// msg.rooms = ['living_room', 'bedroom', 'kitchen']
const stateIds = msg.rooms.flatMap(room => [
    `0_userdata.0.${room}.temperature`,
    `0_userdata.0.${room}.humidity`,
    `0_userdata.0.${room}.presence`
]);

await targetNode.triggerWithTopicArray(stateIds, 'individual');
```

---

## Einschränkungen

### ✅ Unterstützt
- **Single State Mode**: `state: 'system.adapter.admin.0.alive'` → `triggerWithTopic()`
- **Multiple States Mode**: Liste von States → `triggerWithTopicArray()`
- Feste State-IDs (keine Wildcards)
- Environment Variables in konfiguriertem State
- Output Mode Wechsel bei Multiple Mode (individual ↔ grouped)

### ❌ Nicht unterstützt
- **Wildcard Patterns**: `state: 'system.adapter.*.alive'`
- **Mode-Switching**: Wechsel zwischen Single ↔ Multiple zur Laufzeit
- Wildcards in Dynamic Arrays

### Prüfung vor Verwendung
```javascript
// Single Mode
if (!targetNode.supportsDynamicTopic) {
    node.warn('Node is in wildcard or multiple mode - single topic switching not available');
    return;
}

// Multiple Mode
if (!targetNode.supportsDynamicArray) {
    node.warn('Node is in single or wildcard mode - array switching not available');
    return;
}
```

---

## Ablauf beim Topic-Wechsel

### Single Mode
1. **Status Update**: "Switching to: new.state.id"
2. **Unsubscribe**: Alte Subscription wird beendet
3. **State Clear**: Cache wird geleert
4. **Subscribe**: Neue Subscription wird aktiviert
5. **Smart Filter**: Bei `filterMode: 'changes-smart'` → Pre-load Baseline
6. **Initial Value**: Erster Wert wird automatisch gesendet
7. **Status Update**: Zeigt neuen State an
8. **Context Update**: Flow Context wird aktualisiert

### Multiple Mode
1. **Status Update**: "Switching to X states..."
2. **Unsubscribe**: Alte Subscriptions werden beendet
3. **State Clear**: Cache wird geleert
4. **Subscribe**: Neue Subscriptions werden aktiviert (mit forced initial)
5. **Smart Filter**: Bei `filterMode: 'changes-smart'` → Pre-load Baselines
6. **Initial Values**: Erste Werte werden automatisch gesendet
7. **Status Update**: Zeigt Anzahl der States an
8. **Context Update**: Flow Context wird aktualisiert

---

## Fehlerbehandlung

### Node nicht gefunden
```javascript
const targetNode = nodes['<NODE_ID>'];
if (!targetNode) {
    node.warn('Node not found - check Node ID and External Triggering enabled');
    return;
}
```

### Nicht unterstützter Modus
```javascript
if (!targetNode.supportsDynamicTopic) {
    node.error('Dynamic topic switching not supported for this node configuration');
    return;
}
```

### Ungültiges Topic
```javascript
const newTopic = msg.topic;
if (!newTopic || typeof newTopic !== 'string') {
    node.error('Invalid topic: must be non-empty string');
    return;
}
```

### Subscription Fehler
```javascript
try {
    await targetNode.triggerWithTopic(newTopic);
} catch (error) {
    node.error(`Failed to switch topic: ${error.message}`);
}
```

---

## Beispiel Flow

Siehe [iob-in-dynamic-trigger.json](../examples/iob-in-dynamic-trigger.json)

Der Beispiel-Flow demonstriert:
- Cached Value Trigger
- Topic-Wechsel zu verschiedenen States
- Registrierte Nodes auflisten
- Feature-Detection (`supportsDynamicTopic`)

---

## Debugging

### Alle registrierten Nodes anzeigen
```javascript
const nodes = flow.get('iobroker_in_nodes') || {};

for (const [nodeId, info] of Object.entries(nodes)) {
    node.warn(`Node ${info.name}:`);
    node.warn(`  - Mode: ${info.mode}`);
    node.warn(`  - Current State: ${info.stateId}`);
    node.warn(`  - Supports Dynamic: ${info.supportsDynamicTopic}`);
}
```

### Node-Logs prüfen
Die iob-in Node loggt:
```
[debug] Unsubscribed from: old.state.id
[debug] Subscribed to: new.state.id
[debug] Smart filter: Pre-loaded new.state.id = <value>
```

### Status der Node beobachten
Bei Topic-Wechsel ändert sich der Node-Status:
- **Gelb/Ring**: "Switching to: new.state.id"
- **Grün/Punkt**: Shows new value or state name
- **Rot/Ring**: "Switch failed" bei Fehler

---

## Vorteile gegenüber iob-get

| Feature | iob-get (Pull) | iob-in + Dynamic Trigger |
|---------|---------------|--------------------------|
| **Daten-Modus** | On-Demand Query | Continuous Push |
| **Performance** | Polling nötig | Automatische Updates |
| **Latenz** | Abhängig von Poll-Intervall | Real-time |
| **Bandwidth** | Höher (bei häufigem Polling) | Niedriger (nur bei Änderung) |
| **Dynamic Topic** | ✅ Via msg.topic | ✅ Via triggerWithTopic() |

**Empfehlung:**
- **iob-get**: Für einmalige Abfragen oder seltene Reads
- **iob-in + Dynamic Trigger**: Für kontinuierliches Monitoring mit wechselnden Targets
