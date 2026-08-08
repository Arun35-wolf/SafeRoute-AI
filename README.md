# SafeRoute AI — Intelligent Personal Safety Navigation

A working hackathon prototype: instead of the *shortest* route, SafeRoute AI
recommends the **safest** one, scoring every candidate path on lighting,
crowd density, crime history, CCTV coverage, proximity to help, weather and
live community reports — then visualizes it as a glowing path on a dark map.

## Run it (one command)

```bash
npm install
npm start
```

Then open **http://localhost:3000** — that's it, frontend and backend are
served from the same process. No API keys, no build step, no `.env` file.

## Try it in 10 seconds

1. Click **"Try demo points"** in the sidebar (drops an origin/destination near Kolkata).
2. Click **"Find safest route"**.
3. Compare the three route cards, watch the Safety Score gauge and the
   factor breakdown update.
4. Click anywhere on the map, then **"Submit report"** — re-run the route
   and watch the score react to your report in real time.
5. Try the **SOS beacon** (bottom-right) — it's a full confirm → dispatch →
   result flow (clearly marked as demo-only, no real services contacted).
6. Add a **trusted contact** from the top bar to see it echoed back in the
   SOS result.

## What's real vs. simulated

This is a hackathon prototype, so it's transparent about its data:

| Feature | This prototype | Production swap-in |
|---|---|---|
| Street lighting | Deterministic geospatial simulation | Municipal GIS lighting layer |
| Crowd density | Simulated, time-of-day weighted | Footfall/mobility data (e.g. Google Popular Times) |
| Crime history | Simulated baseline + live community reports | Local police open-data crime feeds |
| CCTV coverage | Simulated | Public CCTV registries |
| Police/hospital markers | Procedurally generated, labeled "(Demo)" | Google Places / government facility APIs |
| Weather | Simulated, rotates every 30 min | OpenWeather or similar live API |
| Routing | 3 generated candidate paths (bezier offsets) between two points | Real street-network routing (OSRM/Mapbox/Google Directions) scored the same way |
| Live alerts | Simulated sensor feed + real community reports you submit | Real-time incident/report pipeline |

The scoring engine (`engine/safetyEngine.js`) is written so every layer is
a swappable function — replace the body of `lighting()`, `crowd()`,
`crimeSafety()`, `cctv()`, `proximityHelp()`, or `weather` logic with a real
API call and the rest of the app (routing, UI, live reactivity) keeps working
unchanged.

## Architecture

```
saferoute-ai/
├── server.js                 Express app + all REST endpoints
├── engine/
│   ├── safetyEngine.js       Multi-factor scoring model + route generation
│   ├── places.js             Synthetic police/hospital marker generator
│   └── store.js               In-memory reports & SOS log (swap for a DB)
└── public/
    ├── index.html             App shell
    ├── style.css               "Night patrol dashboard" design system
    └── app.js                  Leaflet map, routing UI, alerts, SOS, contacts
```

### API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/conditions` | Simulated live time-of-day + weather |
| `POST` | `/api/route` | `{origin, destination}` → 3 scored routes + recommendation |
| `GET` | `/api/alerts?lat&lng` | Live nearby incident feed (community + simulated) |
| `POST` | `/api/report` | Submit a community incident report (feeds back into scoring) |
| `POST` | `/api/sos` | Trigger emergency alert → nearest help + ticket |
| `GET` | `/api/health` | Health check |

### How the Safety Score is computed

For a candidate route, ~15 points are sampled along the path. Each point
gets a composite score from six weighted factors:

```
score = lighting×0.25 + crowd×0.20 + crime_safety×0.25
      + cctv×0.10 + proximity_to_help×0.15 + weather×0.05
```

The route score is `70% average + 30% minimum` of its point scores — a
single dark, high-risk block drags the whole route down, the same way a
real walker would weigh it.

## Notes for judges

- All "police station" / "hospital" markers are procedurally generated and
  explicitly labeled **(Demo)** — no real facility names or real crime data
  for real places are used or implied anywhere in the app.
- The SOS flow is fully wired end-to-end (confirm countdown → backend
  dispatch → nearest-help lookup → contact echo) but does not contact real
  emergency services — this is stated in the UI.
- Trusted contacts are stored in the browser's `localStorage` for this demo.
