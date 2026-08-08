/**
 * SafeRoute AI — Safety Intelligence Engine
 * ------------------------------------------
 * This is a deterministic, multi-factor heuristic scoring engine that stands
 * in for real-world data sources (crime records, municipal lighting maps,
 * live footfall sensors, weather APIs, CCTV registries). It is seeded from
 * geographic coordinates so results are stable and demoable, and it reacts
 * live to community reports submitted through /api/report.
 *
 * SWAPPING IN REAL DATA (see README):
 *   - lighting()   -> municipal streetlight GIS layer
 *   - crowd()      -> footfall / mobility data (e.g. Google Popular Times)
 *   - crimeSafety()-> local police open-data crime feeds
 *   - cctv()       -> public CCTV registries
 *   - proximityHelp() -> Police/Hospital Places API
 *   - weather()    -> OpenWeather / any live weather API
 */

const EARTH_RADIUS_KM = 6371;

// ---- deterministic pseudo-random field, seeded by coordinates ----
function seededRandom(a, b, salt) {
  const v = Math.sin(a * 127.1 + b * 311.7 + salt * 74.7) * 43758.5453123;
  return v - Math.floor(v);
}

// Averages a small neighborhood of grid cells so the "field" is spatially
// smooth (like a real lighting/crime density map) instead of noisy per-pixel.
function smoothField(lat, lng, salt) {
  const cell = 0.004; // ~400m grid
  let sum = 0;
  let count = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const glat = Math.round((lat + dx * cell) / cell) * cell;
      const glng = Math.round((lng + dy * cell) / cell) * cell;
      sum += seededRandom(glat * 1000, glng * 1000, salt);
      count++;
    }
  }
  return sum / count; // 0..1
}

function haversineKm(a, b) {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(h));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function hourOfDay() {
  return new Date().getHours();
}

// ---- simulated "live" conditions, stable within a 30-minute window ----
function currentConditions() {
  const bucket = Math.floor(Date.now() / (1000 * 60 * 30));
  const conditions = ["clear", "cloudy", "light rain", "heavy rain", "fog"];
  const r = seededRandom(bucket, 7, 91);
  const condition = conditions[Math.floor(r * conditions.length)];
  const penaltyMap = { clear: 0, cloudy: 4, "light rain": 12, "heavy rain": 25, fog: 20 };
  const hour = hourOfDay();
  let dayPart = "day";
  if (hour >= 5 && hour < 8) dayPart = "dawn";
  else if (hour >= 8 && hour < 18) dayPart = "day";
  else if (hour >= 18 && hour < 21) dayPart = "dusk";
  else dayPart = "night";
  return { condition, weatherPenalty: penaltyMap[condition], hour, dayPart };
}

// ---- individual factor layers (0-100, higher = safer) ----
function lighting(lat, lng) {
  return clamp(smoothField(lat, lng, 11) * 100, 5, 100);
}

function crowd(lat, lng, hour) {
  const base = smoothField(lat, lng, 22) * 100;
  let factor = 1;
  if (hour >= 7 && hour < 21) factor = 1.1;
  else if ((hour >= 21 && hour < 24) || (hour >= 5 && hour < 7)) factor = 0.6;
  else factor = 0.25;
  return clamp(base * factor, 3, 100);
}

function crimeSafety(lat, lng, reports) {
  let base = 100 - smoothField(lat, lng, 33) * 78; // baseline skews 22-100
  const now = Date.now();
  for (const r of reports) {
    const d = haversineKm({ lat, lng }, { lat: r.lat, lng: r.lng });
    if (d > 0.35) continue;
    const ageHours = (now - r.timestamp) / (1000 * 60 * 60);
    if (ageHours > 24) continue;
    const decay = clamp(1 - ageHours / 24, 0, 1);
    const severityWeight = { low: 6, medium: 14, high: 26 }[r.severity] || 10;
    const distanceWeight = clamp(1 - d / 0.35, 0, 1);
    base -= severityWeight * decay * distanceWeight;
  }
  return clamp(base, 2, 100);
}

function cctv(lat, lng) {
  const coverage = smoothField(lat, lng, 44);
  return coverage > 0.55 ? clamp(70 + coverage * 30, 0, 100) : clamp(coverage * 70, 0, 100);
}

function proximityHelp(lat, lng, places) {
  let nearest = Infinity;
  for (const p of places) {
    const d = haversineKm({ lat, lng }, { lat: p.lat, lng: p.lng });
    if (d < nearest) nearest = d;
  }
  if (!isFinite(nearest)) return 40;
  return clamp(100 - nearest * 40, 8, 100);
}

/**
 * Score a single point. Returns breakdown + composite 0-100.
 */
function scorePoint(lat, lng, reports, places) {
  const { weatherPenalty, hour } = currentConditions();
  const L = lighting(lat, lng);
  const C = crowd(lat, lng, hour);
  const K = crimeSafety(lat, lng, reports);
  const V = cctv(lat, lng);
  const P = proximityHelp(lat, lng, places);
  const weatherScore = clamp(100 - weatherPenalty, 0, 100);

  const composite =
    L * 0.25 + C * 0.2 + K * 0.25 + V * 0.1 + P * 0.15 + weatherScore * 0.05;

  return {
    composite: clamp(composite, 0, 100),
    breakdown: { lighting: L, crowd: C, crime: K, cctv: V, proximity: P, weather: weatherScore },
  };
}

// Quadratic bezier interpolation between origin -> control -> destination
function bezierPoint(p0, p1, p2, t) {
  const mt = 1 - t;
  return {
    lat: mt * mt * p0.lat + 2 * mt * t * p1.lat + t * t * p2.lat,
    lng: mt * mt * p0.lng + 2 * mt * t * p1.lng + t * t * p2.lng,
  };
}

function buildCandidatePath(origin, dest, offsetFraction, samples) {
  const dx = dest.lng - origin.lng;
  const dy = dest.lat - origin.lat;
  const len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
  // perpendicular unit vector
  const px = -dy / len;
  const py = dx / len;

  const mid = { lat: (origin.lat + dest.lat) / 2, lng: (origin.lng + dest.lng) / 2 };
  const control = {
    lat: mid.lat + py * len * offsetFraction,
    lng: mid.lng + px * len * offsetFraction,
  };

  const path = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    path.push(bezierPoint(origin, control, dest, t));
  }
  return path;
}

function pathDistanceKm(path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += haversineKm(path[i - 1], path[i]);
  return total;
}

/**
 * Generates 3 candidate routes between origin & destination, scores every
 * sampled point along each, and returns fully-labeled route objects.
 */
function generateRoutes(origin, dest, reports, places) {
  const offsets = [-0.32, 0, 0.32];
  const names = ["Route A", "Route B", "Route C"];

  const routes = offsets.map((offset, idx) => {
    const path = buildCandidatePath(origin, dest, offset, 14);
    const pointScores = path.map((pt) => scorePoint(pt.lat, pt.lng, reports, places));
    const composites = pointScores.map((p) => p.composite);
    const avg = composites.reduce((a, b) => a + b, 0) / composites.length;
    const min = Math.min(...composites);
    const safetyScore = Math.round(clamp(avg * 0.7 + min * 0.3, 0, 100));

    const breakdown = ["lighting", "crowd", "crime", "cctv", "proximity", "weather"].reduce(
      (acc, key) => {
        acc[key] = Math.round(
          pointScores.reduce((s, p) => s + p.breakdown[key], 0) / pointScores.length
        );
        return acc;
      },
      {}
    );

    const distanceKm = pathDistanceKm(path);
    const etaMin = Math.round((distanceKm / 4.6) * 60); // ~4.6 km/h walking pace

    const riskSegments = path
      .map((pt, i) => ({ ...pt, score: Math.round(composites[i]) }))
      .filter((pt) => pt.score < 50);

    return {
      id: `route_${idx}`,
      name: names[idx],
      path: path.map((p) => [p.lat, p.lng]),
      distanceKm: Math.round(distanceKm * 100) / 100,
      etaMin,
      safetyScore,
      breakdown,
      riskSegments,
    };
  });

  const safestId = [...routes].sort((a, b) => b.safetyScore - a.safetyScore)[0].id;
  const fastestId = [...routes].sort((a, b) => a.distanceKm - b.distanceKm)[0].id;

  for (const r of routes) {
    if (r.id === safestId && r.id === fastestId) r.label = "Safest & Fastest";
    else if (r.id === safestId) r.label = "Safest";
    else if (r.id === fastestId) r.label = "Fastest";
    else r.label = "Balanced";
  }

  routes.sort((a, b) => b.safetyScore - a.safetyScore);

  return { routes, recommendedId: safestId };
}

module.exports = {
  seededRandom,
  smoothField,
  haversineKm,
  clamp,
  currentConditions,
  scorePoint,
  generateRoutes,
};
