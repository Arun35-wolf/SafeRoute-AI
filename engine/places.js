/**
 * Procedurally places DEMO emergency-service markers (police outposts /
 * hospitals) around a given map area. These are clearly labeled as
 * simulated — swap this module for a real Places/Facilities API in
 * production (see README).
 */
const { seededRandom } = require("./safetyEngine");

function generatePlacesNear(centerLat, centerLng, count = 6) {
  const places = [];
  for (let i = 0; i < count; i++) {
    const angle = seededRandom(centerLat * 1000 + i, centerLng * 1000, 5) * 2 * Math.PI;
    const distanceDeg = 0.006 + seededRandom(i, centerLat, 6) * 0.02; // ~0.6km - 2.6km
    const lat = centerLat + Math.sin(angle) * distanceDeg;
    const lng = centerLng + Math.cos(angle) * distanceDeg;
    const type = i % 2 === 0 ? "police" : "hospital";
    places.push({
      id: `place_${Math.round(centerLat * 1000)}_${Math.round(centerLng * 1000)}_${i}`,
      type,
      name:
        type === "police"
          ? `Police Outpost ${String.fromCharCode(65 + i)} (Demo)`
          : `City Hospital ${String.fromCharCode(65 + i)} (Demo)`,
      lat,
      lng,
    });
  }
  return places;
}

module.exports = { generatePlacesNear };
