/* =========================================================================
   SafeRoute AI — frontend application
   Vanilla JS + Leaflet. Talks to the Express backend for route scoring,
   live alerts, incident reporting and SOS.
   ========================================================================= */

const KOLKATA = { lat: 22.5726, lng: 88.3639 };
const DEMO_ORIGIN = { lat: 22.5850, lng: 88.3468 };   // near Sealdah
const DEMO_DEST = { lat: 22.5626, lng: 88.3629 };     // near Park Street

const state = {
  origin: null,
  destination: null,
  routes: [],
  places: [],
  activeRouteId: null,
  lastClick: null,
  contacts: JSON.parse(localStorage.getItem('sra_contacts') || '[]'),
  routeLayers: {},      // id -> {glow, line}
  markers: { origin: null, dest: null, places: [], risk: [] },
  alertsAnchor: null,
};

// ---------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------
const map = L.map('map', { zoomControl: true }).setView([KOLKATA.lat, KOLKATA.lng], 13);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  subdomains: 'abcd',
  maxZoom: 19,
}).addTo(map);

map.on('click', (e) => {
  state.lastClick = { lat: e.latlng.lat, lng: e.latlng.lng };
  document.getElementById('reportLocHint').textContent =
    `Pin location: ${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
  document.getElementById('submitReportBtn').disabled = false;

  if (!state.origin) {
    setOrigin(state.lastClick);
  } else if (!state.destination) {
    setDestination(state.lastClick);
  } else {
    // both set already -> clicking again resets destination for a quick re-plan
    setOrigin(state.lastClick);
    state.destination = null;
    document.getElementById('destInput').value = '';
    clearRoutes();
  }
});

function scoreColor(score) {
  if (score >= 75) return getCss('--safe');
  if (score >= 50) return getCss('--caution');
  return getCss('--danger');
}
function scoreBadgeClass(score) {
  if (score >= 75) return 'safe';
  if (score >= 50) return 'caution';
  return 'danger';
}
function getCss(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function endpointIcon(kind) {
  return L.divIcon({
    className: '',
    html: `<div class="endpoint-marker ${kind}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 14],
  });
}

function setOrigin(pt) {
  state.origin = pt;
  document.getElementById('originInput').value = `${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}`;
  if (state.markers.origin) map.removeLayer(state.markers.origin);
  state.markers.origin = L.marker([pt.lat, pt.lng], { icon: endpointIcon('origin') }).addTo(map);
  updateFindButton();
}

function setDestination(pt) {
  state.destination = pt;
  document.getElementById('destInput').value = `${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}`;
  if (state.markers.dest) map.removeLayer(state.markers.dest);
  state.markers.dest = L.marker([pt.lat, pt.lng], { icon: endpointIcon('dest') }).addTo(map);
  updateFindButton();
}

function updateFindButton() {
  document.getElementById('findRouteBtn').disabled = !(state.origin && state.destination);
}

// ---------------------------------------------------------------------
// Conditions bar
// ---------------------------------------------------------------------
async function refreshConditions() {
  try {
    const res = await fetch('/api/conditions');
    const data = await res.json();
    document.getElementById('dayPartValue').textContent = capitalize(data.dayPart);
    document.getElementById('weatherValue').textContent = capitalize(data.condition);
  } catch (e) { /* silent - non critical */ }
}
function tickClock() {
  const now = new Date();
  document.getElementById('clockValue').textContent =
    now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(tickClock, 1000);
tickClock();
refreshConditions();
setInterval(refreshConditions, 60000);

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------------------------------------------------------------------
// Route finding
// ---------------------------------------------------------------------
document.getElementById('findRouteBtn').addEventListener('click', findRoutes);

async function findRoutes() {
  if (!state.origin || !state.destination) return;

  const btn = document.getElementById('findRouteBtn');

  btn.disabled = true;
  btn.textContent = 'Finding real routes…';

  try {
    const res = await fetch('/api/route', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        origin: state.origin,
        destination: state.destination
      })
    });

    const data = await res.json();

    // Show the actual backend error instead of
    // pretending the server is offline.
    if (!res.ok) {
      throw new Error(
        data.details ||
        data.error ||
        `Route request failed (${res.status})`
      );
    }

    if (!Array.isArray(data.routes) || data.routes.length === 0) {
      throw new Error('No routes were returned by the routing service.');
    }

    state.routes = data.routes;
    state.places = data.places || [];
    state.activeRouteId = data.recommendedId;

    drawRoutes();
    drawPlaces();
    renderRouteList();
    renderScore();
    fitToRoutes();

    document.getElementById('scorePanel').hidden = false;
    document.getElementById('routesPanel').hidden = false;
    document.getElementById('reportPanel').hidden = false;

    state.alertsAnchor =
      midpointOf(state.origin, state.destination);

    refreshAlerts();

    pushToast(
      `Route analysis complete — ${data.routes.length} real road route(s) scored.`
    );

  } catch (e) {
    console.error('Route request failed:', e);

    pushToast(
      `Route error: ${e.message}`
    );

  } finally {
    btn.disabled = false;
    btn.textContent = 'Find safest route';
  }
}

function midpointOf(a, b) {
  return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
}

function clearRoutes() {
  Object.values(state.routeLayers).forEach(({ glow, line }) => {
    map.removeLayer(glow); map.removeLayer(line);
  });
  state.routeLayers = {};
  state.markers.risk.forEach((m) => map.removeLayer(m));
  state.markers.risk = [];
  state.markers.places.forEach((m) => map.removeLayer(m));
  state.markers.places = [];
}

function drawRoutes() {
  clearRoutes();
  state.routes.forEach((route) => {
    const color = scoreColor(route.safetyScore);
    const isActive = route.id === state.activeRouteId;

    const glow = L.polyline(route.path, {
      color, weight: isActive ? 14 : 9, opacity: isActive ? 0.28 : 0.12,
      lineCap: 'round', lineJoin: 'round',
    }).addTo(map);

    const line = L.polyline(route.path, {
      color, weight: isActive ? 5 : 3, opacity: isActive ? 1 : 0.55,
      lineCap: 'round', lineJoin: 'round', dashArray: isActive ? null : '2 8',
    }).addTo(map);

    line.on('click', () => selectRoute(route.id));
    glow.on('click', () => selectRoute(route.id));

    state.routeLayers[route.id] = { glow, line };

    route.riskSegments.forEach((seg) => {
      if (!isActive) return;
      const marker = L.marker([seg.lat, seg.lng], {
        icon: L.divIcon({ className: '', html: '<div class="risk-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
      }).addTo(map);
      marker.bindTooltip(`Risk score: ${seg.score}/100`, { direction: 'top' });
      state.markers.risk.push(marker);
    });
  });
}

function drawPlaces() {
  state.places.forEach((p) => {
    const marker = L.marker([p.lat, p.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="place-marker ${p.type}">${p.type === 'police' ? '🚓' : '🏥'}</div>`,
        iconSize: [22, 22], iconAnchor: [11, 11],
      }),
    }).addTo(map);
    marker.bindTooltip(p.name, { direction: 'top' });
    state.markers.places.push(marker);
  });
}

function fitToRoutes() {
  const all = state.routes.flatMap((r) => r.path);
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [60, 60] });
}

function selectRoute(id) {
  state.activeRouteId = id;
  drawRoutes();
  drawPlaces();
  renderRouteList();
  renderScore();
}

// ---------------------------------------------------------------------
// Route list + score panel
// ---------------------------------------------------------------------
function renderRouteList() {
  const container = document.getElementById('routeList');
  container.innerHTML = '';
  state.routes.forEach((route) => {
    const card = document.createElement('div');
    card.className = 'route-card' + (route.id === state.activeRouteId ? ' active' : '');
    card.innerHTML = `
      <div class="route-card-top">
        <span class="route-card-name">${route.name}</span>
        <span class="route-badge ${scoreBadgeClass(route.safetyScore)}">${route.label}</span>
      </div>
      <div class="route-card-meta">
        <span class="score mono">${route.safetyScore}/100</span>
        <span>${route.distanceKm} km</span>
        <span>${route.etaMin} min walk</span>
      </div>
    `;
    card.addEventListener('click', () => selectRoute(route.id));
    container.appendChild(card);
  });
}

function renderScore() {
  const route = state.routes.find((r) => r.id === state.activeRouteId);
  if (!route) return;

  const circumference = 2 * Math.PI * 68;
  const fill = document.getElementById('gaugeFill');
  fill.style.strokeDasharray = circumference;
  fill.style.strokeDashoffset = circumference - (route.safetyScore / 100) * circumference;
  fill.style.stroke = scoreColor(route.safetyScore);

  document.getElementById('gaugeNumber').textContent = route.safetyScore;
  document.getElementById('gaugeCaption').textContent =
    `${route.name} — ${route.label.toLowerCase()} · ${route.distanceKm} km · ${route.etaMin} min`;

  const labels = {
    lighting: 'Lighting', crowd: 'Crowd', crime: 'Crime history',
    cctv: 'CCTV cover', proximity: 'Help nearby', weather: 'Weather',
  };
  const bd = document.getElementById('breakdown');
  bd.innerHTML = '';
  Object.entries(route.breakdown).forEach(([key, value]) => {
    const row = document.createElement('div');
    row.className = 'bd-row';
    row.innerHTML = `
      <span class="bd-label">${labels[key] || key}</span>
      <div class="bd-track"><div class="bd-fill" style="width:${value}%; background:${scoreColor(value)}"></div></div>
      <span class="bd-value mono">${value}</span>
    `;
    bd.appendChild(row);
  });
}

// ---------------------------------------------------------------------
// Quick actions: current location / swap / demo points
// ---------------------------------------------------------------------
document.getElementById('useLocationBtn').addEventListener('click', () => {
  if (!navigator.geolocation) { pushToast('Geolocation not available in this browser.'); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setOrigin(pt);
      map.setView([pt.lat, pt.lng], 15);
    },
    () => pushToast('Could not get your location — check browser permissions.')
  );
});

document.getElementById('swapBtn').addEventListener('click', () => {
  if (!state.origin || !state.destination) return;
  const o = state.origin, d = state.destination;
  setOrigin(d);
  setDestination(o);
});

document.getElementById('demoBtn').addEventListener('click', () => {
  setOrigin(DEMO_ORIGIN);
  setDestination(DEMO_DEST);
  map.fitBounds(L.latLngBounds([[DEMO_ORIGIN.lat, DEMO_ORIGIN.lng], [DEMO_DEST.lat, DEMO_DEST.lng]]), { padding: [80, 80] });
  pushToast('Demo points loaded — click "Find safest route".');
});

// ---------------------------------------------------------------------
// Live alerts feed
// ---------------------------------------------------------------------
async function refreshAlerts() {
  const anchor = state.alertsAnchor || KOLKATA;
  try {
    const res = await fetch(`/api/alerts?lat=${anchor.lat}&lng=${anchor.lng}`);
    const data = await res.json();
    renderAlerts(data.alerts);
  } catch (e) { /* silent */ }
}
setInterval(refreshAlerts, 12000);

function renderAlerts(alerts) {
  const list = document.getElementById('alertsList');
  if (!alerts.length) {
    list.innerHTML = '<p class="alerts-empty">No recent activity nearby.</p>';
    return;
  }
  list.innerHTML = '';
  alerts.forEach((a) => {
    const item = document.createElement('div');
    item.className = 'alert-item';
    const mins = Math.max(1, Math.round((Date.now() - a.timestamp) / 60000));
    item.innerHTML = `
      <span class="alert-sev ${a.severity}"></span>
      <div>
        <div class="alert-text">${escapeHtml(a.text)}</div>
        <div class="alert-meta">${mins < 60 ? mins + ' min ago' : Math.round(mins / 60) + ' hr ago'} · ${a.source === 'community' ? 'community report' : 'live sensor'}</div>
      </div>
    `;
    list.appendChild(item);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------
function pushToast(text) {
  const stack = document.getElementById('toastStack');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = text;
  stack.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

// ---------------------------------------------------------------------
// Incident reporting
// ---------------------------------------------------------------------
document.getElementById('submitReportBtn').addEventListener('click', async () => {
  if (!state.lastClick) return;
  const type = document.getElementById('reportType').value;
  const severity = document.getElementById('reportSeverity').value;
  const description = document.getElementById('reportNote').value;

  try {
    await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, severity, description, lat: state.lastClick.lat, lng: state.lastClick.lng }),
    });
    pushToast('Report submitted — thanks for keeping the community safe.');
    document.getElementById('reportNote').value = '';
    if (state.origin && state.destination) findRoutes(); // live re-score
    refreshAlerts();
  } catch (e) {
    pushToast('Could not submit report — check the server.');
  }
});

// ---------------------------------------------------------------------
// Trusted contacts
// ---------------------------------------------------------------------
function saveContacts() {
  localStorage.setItem('sra_contacts', JSON.stringify(state.contacts));
  document.getElementById('contactsCount').textContent = state.contacts.length;
}
function renderContacts() {
  const list = document.getElementById('contactsList');
  if (!state.contacts.length) {
    list.innerHTML = '<p class="contacts-empty">No trusted contacts yet.</p>';
    return;
  }
  list.innerHTML = '';
  state.contacts.forEach((c, idx) => {
    const item = document.createElement('div');
    item.className = 'contact-item';
    item.innerHTML = `<span>${escapeHtml(c.name)} · ${escapeHtml(c.phone)}</span><button class="remove" data-idx="${idx}">&times;</button>`;
    list.appendChild(item);
  });
  list.querySelectorAll('.remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.contacts.splice(parseInt(btn.dataset.idx, 10), 1);
      saveContacts(); renderContacts();
    });
  });
}

document.getElementById('contactsBtn').addEventListener('click', () => {
  renderContacts();
  document.getElementById('contactsModal').hidden = false;
});
document.getElementById('closeContactsBtn').addEventListener('click', () => {
  document.getElementById('contactsModal').hidden = true;
});
document.getElementById('addContactBtn').addEventListener('click', () => {
  const name = document.getElementById('contactName').value.trim();
  const phone = document.getElementById('contactPhone').value.trim();
  if (!name || !phone) { pushToast('Enter a name and phone number.'); return; }
  state.contacts.push({ name, phone });
  saveContacts(); renderContacts();
  document.getElementById('contactName').value = '';
  document.getElementById('contactPhone').value = '';
});
saveContacts(); // sync count on load

// ---------------------------------------------------------------------
// SOS flow
// ---------------------------------------------------------------------
let sosTimer = null;
let sosCountdownStart = null;
const SOS_SECONDS = 5;

document.getElementById('sosBtn').addEventListener('click', openSosModal);

function openSosModal() {
  document.getElementById('sosModal').hidden = false;
  const fill = document.getElementById('countdownFill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  requestAnimationFrame(() => {
    fill.style.transition = `width ${SOS_SECONDS}s linear`;
    fill.style.width = '0%';
  });
  sosCountdownStart = Date.now();
  sosTimer = setTimeout(sendSos, SOS_SECONDS * 1000);
}

document.getElementById('sosCancelBtn').addEventListener('click', () => {
  clearTimeout(sosTimer);
  document.getElementById('sosModal').hidden = true;
});

document.getElementById('sosConfirmBtn').addEventListener('click', () => {
  clearTimeout(sosTimer);
  sendSos();
});

async function sendSos() {
  document.getElementById('sosModal').hidden = true;
  const loc = state.lastClick || state.origin || KOLKATA;

  try {
    const res = await fetch('/api/sos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: loc.lat, lng: loc.lng, contacts: state.contacts }),
    });
    const data = await res.json();
    showSosResult(data);
  } catch (e) {
    pushToast('SOS could not reach the server.');
  }
}

function showSosResult(data) {
  document.getElementById('sosTicket').textContent = `Ticket ${data.ticketId}`;
  const grid = document.getElementById('sosResultGrid');
  grid.innerHTML = `
    <div class="sos-result-item">
      <div class="label">Nearest police</div>
      <div class="value">${escapeHtml(data.nearestPolice?.name || 'Unavailable')} · ETA ~${data.etaPoliceMin} min</div>
    </div>
    <div class="sos-result-item">
      <div class="label">Nearest hospital</div>
      <div class="value">${escapeHtml(data.nearestHospital?.name || 'Unavailable')}</div>
    </div>
    <div class="sos-result-item">
      <div class="label">Trusted contacts notified</div>
      <div class="value">${data.contactsNotified} contact(s)</div>
    </div>
  `;
  document.getElementById('sosResultModal').hidden = false;
}
document.getElementById('sosResolveBtn').addEventListener('click', () => {
  document.getElementById('sosResultModal').hidden = true;
});
