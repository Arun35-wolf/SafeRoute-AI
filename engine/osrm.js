/**
 * SafeRoute AI — OSRM routing adapter
 *
 * Uses the public OSRM demo server to obtain real road-network routes.
 * OSRM returns real road geometries, distance and duration.
 */

const OSRM_BASE_URL = "https://router.project-osrm.org";

async function getOSRMRoutes(origin, destination) {
  if (
    !origin ||
    !destination ||
    typeof origin.lat !== "number" ||
    typeof origin.lng !== "number" ||
    typeof destination.lat !== "number" ||
    typeof destination.lng !== "number"
  ) {
    throw new Error("Valid origin and destination coordinates are required");
  }

  // OSRM expects longitude,latitude
  const coordinates =
    `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;

  const url =
    `${OSRM_BASE_URL}/route/v1/driving/${coordinates}` +
    `?alternatives=true&overview=full&geometries=geojson&steps=false`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "SafeRoute-AI-Hackathon/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`OSRM request failed with HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.code !== "Ok" || !Array.isArray(data.routes)) {
    throw new Error(data.message || "OSRM returned no routes");
  }

  return data.routes.map((route, index) => ({
    id: `osrm_route_${index}`,
    name: `Route ${String.fromCharCode(65 + index)}`,

    // OSRM GeoJSON coordinates are [lng, lat].
    // SafeRoute frontend uses [lat, lng].
    path: route.geometry.coordinates.map(([lng, lat]) => ({
      lat,
      lng
    })),

    distanceKm: route.distance / 1000,

    // OSRM duration is in seconds.
    durationMin: Math.max(1, Math.round(route.duration / 60))
  }));
}

module.exports = {
  getOSRMRoutes
};
