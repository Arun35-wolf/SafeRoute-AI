/**
 * SafeRoute AI — Safety Intelligence Engine
 * ------------------------------------------
 * Real road geometry comes from OSRM.
 * Safety scoring remains SafeRoute's own multi-factor engine.
 */

const { getOSRMRoutes } = require("./osrm");

const EARTH_RADIUS_KM = 6371;

// ---------------------------------------------------------------------
// Deterministic pseudo-random field
// ---------------------------------------------------------------------

function seededRandom(a, b, salt) {
  const v =
    Math.sin(a * 127.1 + b * 311.7 + salt * 74.7) *
    43758.5453123;

  return v - Math.floor(v);
}

function smoothField(lat, lng, salt) {
  const cell = 0.004;

  let sum = 0;
  let count = 0;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const glat =
        Math.round((lat + dx * cell) / cell) * cell;

      const glng =
        Math.round((lng + dy * cell) / cell) * cell;

      sum += seededRandom(
        glat * 1000,
        glng * 1000,
        salt
      );

      count++;
    }
  }

  return sum / count;
}

// ---------------------------------------------------------------------
// Geography helpers
// ---------------------------------------------------------------------

function haversineKm(a, b) {
  const dLat =
    ((b.lat - a.lat) * Math.PI) / 180;

  const dLng =
    ((b.lng - a.lng) * Math.PI) / 180;

  const lat1 =
    (a.lat * Math.PI) / 180;

  const lat2 =
    (b.lat * Math.PI) / 180;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(dLng / 2) ** 2;

  return (
    EARTH_RADIUS_KM *
    2 *
    Math.asin(Math.sqrt(h))
  );
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ---------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------

function hourOfDay() {
  return new Date().getHours();
}

function currentConditions() {
  const bucket =
    Math.floor(Date.now() / (1000 * 60 * 30));

  const conditions = [
    "clear",
    "cloudy",
    "light rain",
    "heavy rain",
    "fog"
  ];

  const r = seededRandom(bucket, 7, 91);

  const condition =
    conditions[Math.floor(r * conditions.length)];

  const penaltyMap = {
    clear: 0,
    cloudy: 4,
    "light rain": 12,
    "heavy rain": 25,
    fog: 20
  };

  const hour = hourOfDay();

  let dayPart = "day";

  if (hour >= 5 && hour < 8) {
    dayPart = "dawn";
  } else if (hour >= 8 && hour < 18) {
    dayPart = "day";
  } else if (hour >= 18 && hour < 21) {
    dayPart = "dusk";
  } else {
    dayPart = "night";
  }

  return {
    condition,
    weatherPenalty: penaltyMap[condition],
    hour,
    dayPart
  };
}

// ---------------------------------------------------------------------
// Safety factors
// ---------------------------------------------------------------------

function lighting(lat, lng) {
  return clamp(
    smoothField(lat, lng, 11) * 100,
    5,
    100
  );
}

function crowd(lat, lng, hour) {
  const base =
    smoothField(lat, lng, 22) * 100;

  let factor = 1;

  if (hour >= 7 && hour < 21) {
    factor = 1.1;
  } else if (
    (hour >= 21 && hour < 24) ||
    (hour >= 5 && hour < 7)
  ) {
    factor = 0.6;
  } else {
    factor = 0.25;
  }

  return clamp(base * factor, 3, 100);
}

function crimeSafety(lat, lng, reports) {
  let base =
    100 - smoothField(lat, lng, 33) * 78;

  const now = Date.now();

  for (const r of reports) {
    const d = haversineKm(
      { lat, lng },
      { lat: r.lat, lng: r.lng }
    );

    if (d > 0.35) continue;

    const ageHours =
      (now - r.timestamp) /
      (1000 * 60 * 60);

    if (ageHours > 24) continue;

    const decay =
      clamp(1 - ageHours / 24, 0, 1);

    const severityWeight = {
      low: 6,
      medium: 14,
      high: 26
    }[r.severity] || 10;

    const distanceWeight =
      clamp(1 - d / 0.35, 0, 1);

    base -=
      severityWeight *
      decay *
      distanceWeight;
  }

  return clamp(base, 2, 100);
}

function cctv(lat, lng) {
  const coverage =
    smoothField(lat, lng, 44);

  return coverage > 0.55
    ? clamp(
        70 + coverage * 30,
        0,
        100
      )
    : clamp(
        coverage * 70,
        0,
        100
      );
}

function proximityHelp(lat, lng, places) {
  let nearest = Infinity;

  for (const p of places) {
    const d = haversineKm(
      { lat, lng },
      {
        lat: p.lat,
        lng: p.lng
      }
    );

    if (d < nearest) {
      nearest = d;
    }
  }

  if (!isFinite(nearest)) {
    return 40;
  }

  return clamp(
    100 - nearest * 40,
    8,
    100
  );
}

// ---------------------------------------------------------------------
// Score a single point
// ---------------------------------------------------------------------

function scorePoint(
  lat,
  lng,
  reports,
  places
) {
  const {
    weatherPenalty,
    hour
  } = currentConditions();

  const L = lighting(lat, lng);
  const C = crowd(lat, lng, hour);
  const K = crimeSafety(
    lat,
    lng,
    reports
  );
  const V = cctv(lat, lng);
  const P = proximityHelp(
    lat,
    lng,
    places
  );

  const weatherScore =
    clamp(
      100 - weatherPenalty,
      0,
      100
    );

  const composite =
    L * 0.25 +
    C * 0.20 +
    K * 0.25 +
    V * 0.10 +
    P * 0.15 +
    weatherScore * 0.05;

  return {
    composite: clamp(
      composite,
      0,
      100
    ),

    breakdown: {
      lighting: L,
      crowd: C,
      crime: K,
      cctv: V,
      proximity: P,
      weather: weatherScore
    }
  };
}

// ---------------------------------------------------------------------
// Sample real OSRM path
// ---------------------------------------------------------------------

function samplePath(path, maxSamples = 20) {
  if (!path.length) {
    return [];
  }

  if (path.length <= maxSamples) {
    return path;
  }

  const samples = [];

  for (let i = 0; i < maxSamples; i++) {
    const index = Math.round(
      (i / (maxSamples - 1)) *
        (path.length - 1)
    );

    samples.push(path[index]);
  }

  return samples;
}

// ---------------------------------------------------------------------
// Score a real OSRM route
// ---------------------------------------------------------------------

function scoreRoute(
  route,
  reports,
  places,
  index
) {
  const path = route.path;

  const sampledPath =
    samplePath(path, 20);

  const pointScores =
    sampledPath.map((pt) =>
      scorePoint(
        pt.lat,
        pt.lng,
        reports,
        places
      )
    );

  const composites =
    pointScores.map(
      (p) => p.composite
    );

  const avg =
    composites.reduce(
      (a, b) => a + b,
      0
    ) / composites.length;

  const min =
    Math.min(...composites);

  // Average score matters most,
  // but dangerous sections also matter.
  const safetyScore = Math.round(
    clamp(
      avg * 0.7 +
        min * 0.3,
      0,
      100
    )
  );

  const breakdown = [
    "lighting",
    "crowd",
    "crime",
    "cctv",
    "proximity",
    "weather"
  ].reduce((acc, key) => {
    acc[key] = Math.round(
      pointScores.reduce(
        (sum, p) =>
          sum +
          p.breakdown[key],
        0
      ) / pointScores.length
    );

    return acc;
  }, {});

  const riskSegments =
    sampledPath
      .map((pt, i) => ({
        ...pt,
        score: Math.round(
          composites[i]
        )
      }))
      .filter(
        (pt) => pt.score < 50
      );

  return {
    id: route.id,
    name: route.name,

    path: path.map((p) => [
      p.lat,
      p.lng
    ]),

    distanceKm:
      Math.round(
        route.distanceKm * 100
      ) / 100,

    etaMin:
      route.durationMin,

    safetyScore,

    breakdown,

    riskSegments
  };
}

// ---------------------------------------------------------------------
// Generate real routes using OSRM,
// then apply SafeRoute safety scoring.
// ---------------------------------------------------------------------

async function generateRoutes(
  origin,
  dest,
  reports,
  places
) {
  const osrmRoutes =
    await getOSRMRoutes(
      origin,
      dest
    );

  if (!osrmRoutes.length) {
    throw new Error(
      "No road routes were returned by OSRM"
    );
  }

  // Keep at most 3 routes for the existing UI.
  const routes =
    osrmRoutes
      .slice(0, 3)
      .map((route, index) =>
        scoreRoute(
          route,
          reports,
          places,
          index
        )
      );

  const safestId =
    [...routes].sort(
      (a, b) =>
        b.safetyScore -
        a.safetyScore
    )[0].id;

  const fastestId =
    [...routes].sort(
      (a, b) =>
        a.distanceKm -
        b.distanceKm
    )[0].id;

  for (const route of routes) {
    if (
      route.id === safestId &&
      route.id === fastestId
    ) {
      route.label =
        "Safest & Fastest";
    } else if (
      route.id === safestId
    ) {
      route.label = "Safest";
    } else if (
      route.id === fastestId
    ) {
      route.label = "Fastest";
    } else {
      route.label = "Balanced";
    }
  }

  // Keep safest route first.
  routes.sort(
    (a, b) =>
      b.safetyScore -
      a.safetyScore
  );

  return {
    routes,
    recommendedId: safestId
  };
}

module.exports = {
  seededRandom,
  smoothField,
  haversineKm,
  clamp,
  currentConditions,
  scorePoint,
  generateRoutes
};
