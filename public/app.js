/* ════════════════════════════════════════════════════════════
   Port Register — Frontend App Logic
════════════════════════════════════════════════════════════ */

const API = 'http://localhost:4444/api';
const REFRESH_INTERVAL = 10000; // 10s

let allRegistrations = [];
let refreshTimer = null;
let countdown = REFRESH_INTERVAL / 1000;
let pendingReleasePort = null;
let pendingClearAll = false;

// ─── Utility ───────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function formatTime(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatRelative(isoStr) {
    if (!isoStr) return '—';
    const diff = new Date(isoStr) - Date.now();
    if (diff < 0) return 'Expired';
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    if (m > 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function isExpiringSoon(isoStr) {
    if (!isoStr) return false;
    return (new Date(isoStr) - Date.now()) < 5 * 60 * 1000; // < 5 min
}

// ─── Toast ─────────────────────────────────────────────────────────────────────

function toast(msg, type = 'info') {
    const icons = {
        success: '✓',
        error: '✕',
        info: 'ℹ',
        warn: '⚠',
    };
    const container = $('toastContainer');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ'}</span>
    <span class="toast-msg">${msg}</span>
    <button class="toast-close" onclick="this.parentElement.remove()">×</button>
  `;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4500);
}

// ─── Activity Log ──────────────────────────────────────────────────────────────

function log(msg, type = '') {
    const log = $('eventLog');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type ? 'log-' + type : ''}`;
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.textContent = `[${ts}] ${msg}`;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
    // Keep max 80 entries
    while (log.children.length > 80) log.removeChild(log.firstChild);
}

// ─── Server Status ─────────────────────────────────────────────────────────────

function setStatus(state, text) {
    const pill = $('serverStatus');
    pill.className = `status-pill ${state}`;
    pill.querySelector('.status-text').textContent = text;
}

// ─── Fetch Registrations ───────────────────────────────────────────────────────

async function fetchRegistrations() {
    try {
        const res = await fetch(`${API}/ports`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        allRegistrations = data.registrations || [];
        setStatus('connected', 'Connected');
        updateStats();
        renderTable(applyFilter());
        $('statLastUpdate').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) {
        setStatus('error', 'Server offline');
        log(`Fetch failed: ${e.message}`, 'error');
    }
}

// ─── Stats ─────────────────────────────────────────────────────────────────────

function updateStats() {
    $('statTotal').textContent = allRegistrations.length;
    // statSysBound and statUnregistered are updated by fetchSystemPorts
}

// ─── Table Rendering ───────────────────────────────────────────────────────────

function applyFilter() {
    const q = $('searchInput').value.trim().toLowerCase();
    if (!q) return allRegistrations;
    return allRegistrations.filter(r =>
        String(r.port).includes(q) ||
        r.agent.toLowerCase().includes(q) ||
        r.reason.toLowerCase().includes(q)
    );
}

function renderTable(regs) {
    const empty = $('emptyState');
    const table = $('registryTable');
    const body = $('registryBody');

    if (!regs.length) {
        empty.classList.remove('hidden');
        table.classList.add('hidden');
        return;
    }

    empty.classList.add('hidden');
    table.classList.remove('hidden');

    body.innerHTML = regs.map(r => {
        const expiringSoon = isExpiringSoon(r.expiresAt);
        const timeClass = expiringSoon ? 'time-text expires-soon' : 'time-text';

        let osBadge;
        if (r.osInUse === true) {
            osBadge = `<span class="os-badge os-up"><span class="os-dot"></span>Active</span>`;
        } else if (r.osInUse === false) {
            osBadge = `<span class="os-badge os-down"><span class="os-dot"></span>Not listening</span>`;
        } else {
            osBadge = `<span class="os-badge os-unk">Unknown</span>`;
        }

        return `
      <tr data-port="${r.port}">
        <td><span class="port-badge">${r.port}</span></td>
        <td><span class="agent-name">${escapeHtml(r.agent)}</span></td>
        <td><span class="reason-text" title="${escapeHtml(r.reason)}">${escapeHtml(r.reason)}</span></td>
        <td>${osBadge}</td>
        <td><span class="time-text">${formatTime(r.registeredAt)}</span></td>
        <td><span class="${timeClass}" title="${new Date(r.expiresAt).toLocaleString()}">${formatRelative(r.expiresAt)}</span></td>
        <td>
          <button class="action-btn" onclick="confirmRelease(${r.port}, '${escapeHtml(r.agent)}')">Release</button>
        </td>
      </tr>`;
    }).join('');
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Removed Check, Suggest, and Register port functions.

// ─── Release Port ──────────────────────────────────────────────────────────────

function confirmRelease(port, agent) {
    pendingReleasePort = port;
    pendingClearAll = false;
    $('modalTitle').textContent = `Release Port ${port}`;
    $('modalBody').textContent = `Are you sure you want to release port ${port} registered by "${agent}"? This action cannot be undone.`;
    $('modalConfirm').textContent = 'Release';
    $('modalOverlay').classList.remove('hidden');
}

async function releasePort(port) {
    try {
        const res = await fetch(`${API}/ports/${port}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const data = await res.json();
        if (!res.ok) {
            toast(data.error || 'Release failed', 'error');
            return;
        }
        toast(`Port ${port} released`, 'info');
        log(`Released port ${port}`, 'warn');
        await fetchRegistrations();
    } catch (e) {
        toast('Could not reach the server.', 'error');
    }
}

async function clearAll() {
    try {
        const res = await fetch(`${API}/ports`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) { toast(data.error || 'Clear failed', 'error'); return; }
        toast('All registrations cleared', 'warn');
        log('Cleared all registrations', 'warn');
        await fetchRegistrations();
    } catch (e) {
        toast('Could not reach the server.', 'error');
    }
}

// ─── Auto-Refresh Countdown ────────────────────────────────────────────────────

function startRefreshCycle() {
    if (refreshTimer) clearInterval(refreshTimer);
    countdown = REFRESH_INTERVAL / 1000;

    refreshTimer = setInterval(async () => {
        countdown--;
        $('refreshIndicator').textContent = `Auto-refresh: ${countdown}s`;
        if (countdown <= 0) {
            countdown = REFRESH_INTERVAL / 1000;
            await Promise.all([
                fetchRegistrations(),
                fetchSystemPorts(false), // always update stats; renders chips only if panel is open
            ]);
        }
    }, 1000);
}

// ─── System Port Scan ──────────────────────────────────────────────────────────

// ─── System Port Scan (Process Cloud) ──────────────────────────────────────────

async function fetchSystemPorts() {
    const cloud = $('procCloudBody');
    const loading = $('sysLoading');
    const count = $('sysPortCount');

    try {
        const res = await fetch(`${API}/ports/system`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // Update stats bar
        const unregisteredCount = data.ports.filter(p => !p.registered).length;
        $('statSysBound').textContent = data.total;
        $('statUnregistered').textContent = unregisteredCount;
        count.textContent = `(${data.total})`;

        if (loading) loading.classList.add('hidden');

        if (!data.ports || data.ports.length === 0) {
            cloud.innerHTML = '<div class="sys-loading">No active ports detected.</div>';
            return;
        }

        // Group by process for the cloud UI
        const processMap = {};
        data.ports.forEach(p => {
            const proc = p.process ? p.process.replace(/\.exe$/i, '') : `PID ${p.pid}`;
            if (!processMap[proc]) processMap[proc] = { count: 0, ports: [], registered: true };
            processMap[proc].count++;
            processMap[proc].ports.push(p.port);
            if (!p.registered) processMap[proc].registered = false; // if any unregistered, mark whole cloud unregistered
        });

        cloud.innerHTML = Object.entries(processMap)
            .sort((a, b) => b[1].count - a[1].count)
            .map(([proc, info]) => {
                const cls = info.registered ? 'proc-bubble sys-reg' : 'proc-bubble sys-unreg';
                const sizeStyle = info.count > 1 ? `font-size: ${Math.min(18, 11 + info.count)}px; padding: ${Math.min(10, 4 + info.count)}px ${Math.min(14, 8 + info.count)}px;` : '';
                const tip = `Process: ${proc} | Ports: ${info.ports.join(', ')}`;
                return `<span class="${cls}" style="${sizeStyle}" title="${escapeHtml(tip)}">${escapeHtml(proc)} <span style="opacity:0.6;font-size:0.85em">(${info.count})</span></span>`;
            }).join('');
    } catch (e) {
        if (loading) loading.classList.add('hidden');
        cloud.innerHTML = '<div class="sys-loading" style="color:var(--red)">Scan failed — server may be offline.</div>';
        log(`System scan failed: ${e.message}`, 'error');
    }
}

// ─── Event Listeners ───────────────────────────────────────────────────────────

$('refreshBtn').addEventListener('click', async () => {
    countdown = REFRESH_INTERVAL / 1000;
    $('refreshIndicator').textContent = `Auto-refresh: ${countdown}s`;
    await fetchRegistrations();
    log('Manual refresh triggered', 'info');
});

$('searchInput').addEventListener('input', () => renderTable(applyFilter()));

$('clearLogBtn').addEventListener('click', () => {
    $('eventLog').innerHTML = '';
    log('Log cleared', 'info');
});

$('clearAllBtn').addEventListener('click', () => {
    pendingClearAll = true;
    pendingReleasePort = null;
    $('modalTitle').textContent = 'Clear All Registrations';
    $('modalBody').textContent = 'This will force-delete ALL port registrations immediately. Any agents currently using registered ports will not be notified. Continue?';
    $('modalConfirm').textContent = 'Clear All';
    $('modalOverlay').classList.remove('hidden');
});

$('modalCancel').addEventListener('click', () => {
    $('modalOverlay').classList.add('hidden');
    pendingReleasePort = null;
    pendingClearAll = false;
});

$('modalConfirm').addEventListener('click', async () => {
    $('modalOverlay').classList.add('hidden');
    if (pendingClearAll) {
        await clearAll();
    } else if (pendingReleasePort !== null) {
        await releasePort(pendingReleasePort);
    }
    pendingReleasePort = null;
    pendingClearAll = false;
});

$('copySnippetBtn').addEventListener('click', () => {
    const code = $('snippetPre').textContent;
    navigator.clipboard.writeText(code).then(() => {
        toast('Snippet copied to clipboard', 'success');
    });
});

// ─── Detail Drawer ─────────────────────────────────────────────────────────────

let drawerData = [];   // current full dataset loaded into the drawer
let drawerMode = '';   // 'registered' | 'system' | 'unregistered'

function closeDrawer() {
    $('detailDrawer').classList.add('hidden');
    $('drawerOverlay').classList.add('hidden');
    $('drawerSearch').value = '';
}

function openDrawer(title, data, renderFn) {
    drawerData = data;
    $('drawerTitle').textContent = title;
    $('drawerCount').textContent = `${data.length} entries`;
    $('detailDrawer').classList.remove('hidden');
    $('drawerOverlay').classList.remove('hidden');
    $('drawerSearch').value = '';
    $('drawerBody').innerHTML = renderFn(data);
}

function filterDrawer(q) {
    const filtered = q
        ? drawerData.filter(r => JSON.stringify(r).toLowerCase().includes(q.toLowerCase()))
        : drawerData;
    $('drawerCount').textContent = `${filtered.length} entries`;
    if (drawerMode === 'registered') {
        $('drawerBody').innerHTML = renderRegisteredRows(filtered);
    } else {
        $('drawerBody').innerHTML = renderSystemRows(filtered);
    }
}

// ── Registered ports drawer ──────────────────────────────────
function renderRegisteredRows(regs) {
    if (!regs.length) return '<div class="drawer-empty">No matching registrations.</div>';
    return `<table class="drawer-table">
    <thead><tr>
      <th>Port</th><th>Agent</th><th>Reason</th><th>OS Status</th><th>Registered</th><th>Expires</th>
    </tr></thead>
    <tbody>${regs.map(r => {
        let osBadge;
        if (r.osInUse === true) osBadge = `<span class="os-badge os-up"><span class="os-dot"></span>${r.osProcess ? r.osProcess.replace(/\.exe$/i, '') : 'Active'}</span>`;
        else if (r.osInUse === false) osBadge = `<span class="os-badge os-down"><span class="os-dot"></span>Not listening</span>`;
        else osBadge = `<span class="os-badge os-unk">Unknown</span>`;
        const expSoon = isExpiringSoon(r.expiresAt);
        return `<tr>
        <td><span class="port-badge">${r.port}</span></td>
        <td><span class="agent-name">${escapeHtml(r.agent)}</span></td>
        <td><span class="reason-text" title="${escapeHtml(r.reason)}">${escapeHtml(r.reason)}</span></td>
        <td>${osBadge}</td>
        <td><span class="time-text">${formatTime(r.registeredAt)}</span></td>
        <td><span class="time-text ${expSoon ? 'expires-soon' : ''}">${formatRelative(r.expiresAt)}</span></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

// ── System ports drawer ──────────────────────────────────────
let cachedSystemPorts = [];

function renderSystemRows(ports) {
    if (!ports.length) return '<div class="drawer-empty">No matching ports.</div>';
    return `<table class="drawer-table">
    <thead><tr>
      <th>Port</th><th>Process</th><th>PID</th><th>Proto</th><th>State</th><th>Registered By</th>
    </tr></thead>
    <tbody>${ports.map(p => {
        const procName = p.process ? p.process.replace(/\.exe$/i, '') : '—';
        const regCell = p.registered && p.registration
            ? `<span class="reg-indicator yes">✓ ${escapeHtml(p.registration.agent)}</span>`
            : `<span class="reg-indicator no">Unregistered</span>`;
        return `<tr>
        <td><span class="port-badge">${p.port}</span></td>
        <td><span class="proc-badge" title="${escapeHtml(p.process || '')}">${escapeHtml(procName)}</span></td>
        <td><span class="time-text">${p.pid}</span></td>
        <td><span class="time-text">${p.proto}</span></td>
        <td><span class="time-text">${p.state}</span></td>
        <td>${regCell}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

async function openSystemDrawer(filter) {
    // Always re-fetch fresh data
    try {
        const res = await fetch(`${API}/ports/system`);
        const data = await res.json();
        cachedSystemPorts = data.ports || [];
    } catch { /* use cached */ }

    const subset = filter === 'unregistered'
        ? cachedSystemPorts.filter(p => !p.registered)
        : cachedSystemPorts;

    drawerMode = 'system';
    openDrawer(
        filter === 'unregistered' ? 'Unregistered System Ports' : 'All System Ports',
        subset,
        renderSystemRows
    );
}

// ── Stat card click handlers ─────────────────────────────────
$('cardRegistered').addEventListener('click', () => {
    drawerMode = 'registered';
    openDrawer('Registered Ports', [...allRegistrations], renderRegisteredRows);
});

$('cardSysBound').addEventListener('click', () => openSystemDrawer('all'));
$('cardUnregistered').addEventListener('click', () => openSystemDrawer('unregistered'));

// Drawer controls
$('drawerClose').addEventListener('click', closeDrawer);
$('drawerOverlay').addEventListener('click', closeDrawer);
$('drawerSearch').addEventListener('input', e => filterDrawer(e.target.value.trim()));
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

// ─── Init ──────────────────────────────────────────────────────────────────────

(async () => {
    log('Connecting to Port Register server…', 'info');
    // Fetch registry + system scan in parallel so stats populate immediately
    await Promise.all([
        fetchRegistrations(),
        fetchSystemPorts(false),
    ]);
    startRefreshCycle();
})();
