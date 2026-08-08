/**
 * In-memory store (resets on server restart). Swap for a real database
 * (Postgres/Mongo) in production — see README.
 */
let reports = [];
let sosLog = [];
let lastRoute = null; // used to anchor the live-alerts feed near the active route

function addReport(report) {
  reports.push(report);
  // keep the last 200 reports only
  if (reports.length > 200) reports = reports.slice(-200);
  return report;
}

function getReports() {
  const now = Date.now();
  // prune anything older than 24h so scoring/alerts stay relevant
  reports = reports.filter((r) => now - r.timestamp < 24 * 60 * 60 * 1000);
  return reports;
}

function addSos(entry) {
  sosLog.push(entry);
  return entry;
}

function setLastRoute(route) {
  lastRoute = route;
}

function getLastRoute() {
  return lastRoute;
}

module.exports = { addReport, getReports, addSos, setLastRoute, getLastRoute };
