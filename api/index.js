const express = require("express");
const cors = require("cors");

const {
  generateRoutes,
  currentConditions,
  seededRandom,
  haversineKm
} = require("../engine/safetyEngine");

const { generatePlacesNear } = require("../engine/places");
const store = require("../engine/store");

const app = express();

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------
// GET /api/conditions
// ---------------------------------------------------------
app.get("/api/conditions", (req, res) => {
  const c = currentConditions();

  res.json({
    ...c,
    serverTime: new Date().toISOString(),
    note: "Simulated for demo — connect a live weather API in production."
  });
});

// ---------------------------------------------------------
// POST /api/route
// Real OSRM routes + SafeRoute safety scoring
// ---------------------------------------------------------
app.post("/api/route", async (req, res) => {
  const { origin, destination } = req.body || {};

  if (
    !origin ||
    !destination ||
    typeof origin.lat !== "number" ||
    typeof origin.lng !== "number" ||
    typeof destination.lat !== "number" ||
    typeof destination.lng !== "number"
  ) {
    return res.status(400).json({
      error: "origin and destination ({lat,lng}) are required"
    });
  }

  try {
    const midLat = (origin.lat + destination.lat) / 2;
    const midLng = (origin.lng + destination.lng) / 2;

    const places = generatePlacesNear(midLat, midLng, 8);
    const reports = store.getReports();

    const { routes, recommendedId } =
      await generateRoutes(
        origin,
        destination,
        reports,
        places
      );

    const conditions = currentConditions();

    store.setLastRoute({
      origin,
      destination,
      midLat,
      midLng,
      routes,
      ts: Date.now()
    });

    return res.json({
      routes,
      recommendedId,
      places,
      conditions
    });

  } catch (error) {
    console.error("Route generation failed:", error);

    return res.status(502).json({
      error: "Unable to calculate route",
      details: error.message
    });
  }
});

// ---------------------------------------------------------
// GET /api/alerts
// ---------------------------------------------------------
const ALERT_TEMPLATES = [
  {
    type: "lighting",
    severity: "medium",
    text: "Streetlight outage reported"
  },
  {
    type: "crowd",
    severity: "low",
    text: "Low foot traffic right now"
  },
  {
    type: "suspicious",
    severity: "high",
    text: "Suspicious activity reported nearby"
  },
  {
    type: "police_presence",
    severity: "low",
    text: "Police patrol spotted — area feels active"
  },
  {
    type: "construction",
    severity: "medium",
    text: "Sidewalk construction / detour"
  },
  {
    type: "harassment",
    severity: "high",
    text: "Harassment incident reported"
  },
  {
    type: "crowd",
    severity: "low",
    text: "Crowded market street, good visibility"
  },
  {
    type: "lighting",
    severity: "low",
    text: "Well-lit stretch confirmed by a walker"
  }
];

app.get("/api/alerts", (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  const lastRoute = store.getLastRoute();

  const anchor =
    !isNaN(lat) && !isNaN(lng)
      ? { lat, lng }
      : lastRoute
        ? {
            lat: lastRoute.midLat,
            lng: lastRoute.midLng
          }
        : {
            lat: 22.5726,
            lng: 88.3639
          };

  const bucket = Math.floor(
    Date.now() / (1000 * 15)
  );

  const count =
    3 +
    Math.floor(
      seededRandom(bucket, 1, 3) * 3
    );

  const synthetic = [];

  for (let i = 0; i < count; i++) {
    const t =
      ALERT_TEMPLATES[
        Math.floor(
          seededRandom(
            bucket + i,
            2,
            9
          ) * ALERT_TEMPLATES.length
        )
      ];

    const jitter = 0.006;

    const lat2 =
      anchor.lat +
      (seededRandom(
        bucket + i,
        3,
        4
      ) - 0.5) * jitter;

    const lng2 =
      anchor.lng +
      (seededRandom(
        bucket + i,
        4,
        5
      ) - 0.5) * jitter;

    synthetic.push({
      id: `alert_${bucket}_${i}`,
      type: t.type,
      severity: t.severity,
      text: t.text,
      lat: lat2,
      lng: lng2,
      source: "sensor-sim",
      timestamp:
        Date.now() -
        Math.floor(
          seededRandom(
            bucket + i,
            5,
            6
          ) *
            1000 *
            60 *
            45
        )
    });
  }

  const community = store
    .getReports()
    .filter(
      (r) =>
        haversineKm(anchor, {
          lat: r.lat,
          lng: r.lng
        }) < 1.2
    )
    .map((r) => ({
      ...r,
      source: "community"
    }));

  const combined = [
    ...community,
    ...synthetic
  ].sort(
    (a, b) => b.timestamp - a.timestamp
  );

  res.json({
    alerts: combined.slice(0, 12)
  });
});

// ---------------------------------------------------------
// POST /api/report
// ---------------------------------------------------------
app.post("/api/report", (req, res) => {
  const {
    type,
    severity,
    lat,
    lng,
    description
  } = req.body || {};

  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !type
  ) {
    return res.status(400).json({
      error: "type, lat and lng are required"
    });
  }

  const report = {
    id: `report_${Date.now()}_${Math.floor(
      Math.random() * 1e4
    )}`,
    type,
    severity: [
      "low",
      "medium",
      "high"
    ].includes(severity)
      ? severity
      : "medium",
    lat,
    lng,
    description: (description || "").slice(
      0,
      280
    ),
    timestamp: Date.now(),
    text:
      description &&
      description.trim()
        ? description.trim()
        : `${type} reported by a community member`
  };

  store.addReport(report);

  res.json({
    ok: true,
    report
  });
});

// ---------------------------------------------------------
// POST /api/sos
// ---------------------------------------------------------
app.post("/api/sos", (req, res) => {
  const {
    lat,
    lng,
    contacts
  } = req.body || {};

  if (
    typeof lat !== "number" ||
    typeof lng !== "number"
  ) {
    return res.status(400).json({
      error: "lat and lng are required"
    });
  }

  const places =
    generatePlacesNear(lat, lng, 8);

  const nearestPolice = places
    .filter(
      (p) => p.type === "police"
    )
    .sort(
      (a, b) =>
        haversineKm(
          { lat, lng },
          a
        ) -
        haversineKm(
          { lat, lng },
          b
        )
    )[0];

  const nearestHospital = places
    .filter(
      (p) => p.type === "hospital"
    )
    .sort(
      (a, b) =>
        haversineKm(
          { lat, lng },
          a
        ) -
        haversineKm(
          { lat, lng },
          b
        )
    )[0];

  const ticketId =
    `SOS-${Date.now()
      .toString(36)
      .toUpperCase()}`;

  const entry = {
    ticketId,
    lat,
    lng,
    contacts: contacts || [],
    nearestPolice,
    nearestHospital,
    timestamp: Date.now()
  };

  store.addSos(entry);

  res.json({
    ok: true,
    ticketId,
    nearestPolice,
    nearestHospital,
    etaPoliceMin: nearestPolice
      ? Math.max(
          2,
          Math.round(
            haversineKm(
              { lat, lng },
              nearestPolice
            ) * 4
          )
        )
      : null,
    contactsNotified:
      (contacts || []).length,
    note:
      "DEMO ONLY — no real emergency services or contacts were notified."
  });
});

// ---------------------------------------------------------
// Health check
// ---------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true
  });
});

// Vercel serverless export
module.exports = app;
