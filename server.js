const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const PORT = 4444;
const DATA_FILE = path.join(__dirname, 'ports.json');
const TTL_MS = 30 * 60 * 1000; // 30 minutes default TTL

app.use(cors());
app.use(express.json());

// Prevent JS/CSS from being cached so edits are always reflected immediately
app.use((req, res, next) => {
  if (/\.(js|css)$/.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Data Persistence ──────────────────────────────────────────────────────────

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ registrations: [] }, null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return { registrations: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function pruneExpired(registrations) {
  const now = Date.now();
  return registrations.filter(r => {
    if (!r.expiresAt) return true;
    return r.expiresAt > now;
  });
}

// ─── OS Port Detection ─────────────────────────────────────────────────────────

// Build a map of PID -> process name from `tasklist`
function getPidMap() {
  try {
    const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf-8', timeout: 8000 });
    const map = new Map();
    for (const line of out.split(/\r?\n/)) {
      // CSV format: "process.exe","PID","Session","N","Mem"
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m) map.set(parseInt(m[2]), m[1]);
    }
    return map;
  } catch {
    return new Map();
  }
}

// Parses `netstat -ano` ONCE and returns a Map: port -> { pid, proto, state }
// Only includes ports that are actually BOUND/LISTENING — not outbound connections.
// TCP: state must be LISTENING
// UDP: always bound (no state column)
function getSystemPorts() {
  try {
    const output = execSync('netstat -ano', { encoding: 'utf-8', timeout: 8000 });
    // port -> { pid, proto, state } — first match wins (dedupes IPv4/IPv6 for same port)
    const portMap = new Map();
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      const m =
        line.match(/^\s+(TCP|UDP)\s+[\d.]*:(\d+)\s+\S+\s+(\S+)\s+(\d+)/) ||
        line.match(/^\s+(TCP|UDP)\s+\[.*?\]:(\d+)\s+\S+\s+(\S+)\s+(\d+)/);
      if (!m) continue;
      const [, proto, portStr, state, pidStr] = m;
      // Skip outbound connections — we only want listening/bound ports
      if (proto === 'TCP' && state !== 'LISTENING') continue;
      const port = parseInt(portStr);
      const pid = parseInt(pidStr);
      if (port > 0 && port <= 65535 && !portMap.has(port)) {
        portMap.set(port, { pid, proto, state: proto === 'UDP' ? 'UDP' : state });
      }
    }
    return portMap; // Map<number, {pid, proto, state}>
  } catch (e) {
    console.error('netstat failed:', e.message);
    return null;
  }
}



function isPortInUseByOS(port, portMap) {
  const map = portMap !== undefined ? portMap : getSystemPorts();
  if (map === null) return null;
  return map.has(parseInt(port));
}

// ─── API Routes ────────────────────────────────────────────────────────────────

// GET /api/ports — list all active registrations
app.get('/api/ports', (req, res) => {
  const data = loadData();
  data.registrations = pruneExpired(data.registrations);
  saveData(data);

  // Run netstat + tasklist ONCE and reuse for all registrations
  const portMap = getSystemPorts();
  const pidMap = portMap ? getPidMap() : new Map();
  const enriched = data.registrations.map(r => {
    const info = portMap ? portMap.get(r.port) : null;
    return {
      ...r,
      osInUse: portMap ? portMap.has(r.port) : null,
      osPid: info ? info.pid : null,
      osProto: info ? info.proto : null,
      osState: info ? info.state : null,
      osProcess: info ? (pidMap.get(info.pid) || null) : null,
    };
  });

  res.json({ registrations: enriched, count: enriched.length });
});

// GET /api/ports/system — all OS-level ports currently in use (with process info)
app.get('/api/ports/system', (req, res) => {
  const portMap = getSystemPorts();
  if (portMap === null) {
    return res.status(500).json({ error: 'Could not run netstat — check server permissions' });
  }

  const pidMap = getPidMap();

  const data = loadData();
  data.registrations = pruneExpired(data.registrations);
  const regMap = new Map(data.registrations.map(r => [r.port, r]));

  const allPorts = [...portMap.keys()].sort((a, b) => a - b);
  const annotated = allPorts.map(p => {
    const { pid, proto, state } = portMap.get(p);
    const process = pidMap.get(pid) || null;
    const registration = regMap.get(p) || null;
    return {
      port: p,
      pid,
      proto,
      state,
      process,
      registered: regMap.has(p),
      registration,
    };
  });

  res.json({ ports: annotated, total: annotated.length });
});

// GET /api/ports/check/:port — check if a port is available
app.get('/api/ports/check/:port', (req, res) => {
  const port = parseInt(req.params.port);

  if (isNaN(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'Invalid port number (1–65535)' });
  }

  const data = loadData();
  data.registrations = pruneExpired(data.registrations);
  saveData(data);

  const registered = data.registrations.find(r => r.port === port);
  const osInUse = isPortInUseByOS(port);

  res.json({
    port,
    available: !registered && !osInUse,
    registeredBy: registered || null,
    osInUse: osInUse,
    recommendation: registered
      ? `Port ${port} is registered by "${registered.agent}" for: ${registered.reason}`
      : osInUse
        ? `Port ${port} is in use by the OS (unregistered process)`
        : `Port ${port} appears to be free — safe to use`,
  });
});

// POST /api/ports/register — register a port
app.post('/api/ports/register', (req, res) => {
  const { port, agent, reason, ttlMinutes } = req.body;

  if (!port || isNaN(parseInt(port)) || parseInt(port) < 1 || parseInt(port) > 65535) {
    return res.status(400).json({ error: 'Invalid or missing port (1–65535)' });
  }
  if (!agent || typeof agent !== 'string' || !agent.trim()) {
    return res.status(400).json({ error: 'Missing required field: agent' });
  }
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'Missing required field: reason' });
  }

  const portNum = parseInt(port);
  const data = loadData();
  data.registrations = pruneExpired(data.registrations);

  const existing = data.registrations.find(r => r.port === portNum);
  if (existing) {
    return res.status(409).json({
      error: `Port ${portNum} is already registered`,
      registeredBy: existing,
    });
  }

  const now = Date.now();
  const ttl = ttlMinutes ? parseInt(ttlMinutes) * 60 * 1000 : TTL_MS;
  const registration = {
    port: portNum,
    agent: agent.trim(),
    reason: reason.trim(),
    registeredAt: new Date().toISOString(),
    expiresAt: now + ttl,
    id: `${portNum}-${now}`,
  };

  data.registrations.push(registration);
  saveData(data);

  res.status(201).json({ success: true, registration });
});

// POST /api/ports/:port/heartbeat — refresh TTL
app.post('/api/ports/:port/heartbeat', (req, res) => {
  const port = parseInt(req.params.port);
  const { agent } = req.body;

  const data = loadData();
  const reg = data.registrations.find(r => r.port === port);

  if (!reg) {
    return res.status(404).json({ error: `Port ${port} is not registered` });
  }
  if (agent && reg.agent !== agent) {
    return res.status(403).json({ error: 'Agent mismatch — cannot refresh another agent\'s registration' });
  }

  reg.expiresAt = Date.now() + TTL_MS;
  reg.lastHeartbeat = new Date().toISOString();
  saveData(data);

  res.json({ success: true, expiresAt: new Date(reg.expiresAt).toISOString() });
});

// DELETE /api/ports/:port — release a port
app.delete('/api/ports/:port', (req, res) => {
  const port = parseInt(req.params.port);
  const { agent } = req.body;

  const data = loadData();
  const idx = data.registrations.findIndex(r => r.port === port);

  if (idx === -1) {
    return res.status(404).json({ error: `Port ${port} is not registered` });
  }

  const reg = data.registrations[idx];
  if (agent && reg.agent !== agent) {
    return res.status(403).json({ error: 'Agent mismatch — cannot release another agent\'s port' });
  }

  data.registrations.splice(idx, 1);
  saveData(data);

  res.json({ success: true, released: reg });
});

// DELETE /api/ports — force-clear all (admin use)
app.delete('/api/ports', (req, res) => {
  saveData({ registrations: [] });
  res.json({ success: true, message: 'All registrations cleared' });
});

// GET /api/suggest — suggest an available port in a range
app.get('/api/suggest', (req, res) => {
  const min = parseInt(req.query.min) || 3000;
  const max = parseInt(req.query.max) || 9999;
  const data = loadData();
  data.registrations = pruneExpired(data.registrations);
  const registeredPorts = new Set(data.registrations.map(r => r.port));

  // Run netstat once for the whole range scan
  const portMap = getSystemPorts();

  for (let p = min; p <= max; p++) {
    if (!registeredPorts.has(p) && !isPortInUseByOS(p, portMap)) {
      return res.json({ port: p, message: `Port ${p} is available` });
    }
  }

  res.status(404).json({ error: `No available ports found in range ${min}–${max}` });
});

// ─── Start Server ──────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║   Port Register — running on :${PORT}   ║`);
  console.log(`╚════════════════════════════════════════╝`);
  console.log(`\n  Web UI:  http://localhost:${PORT}`);
  console.log(`  API:     http://localhost:${PORT}/api/ports\n`);
});
