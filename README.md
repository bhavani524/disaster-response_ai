# Rivermont — AI Decision Intelligence Platform for Public Safety & Disaster Response

A working prototype of an AI-powered decision intelligence platform for a fictional city,
**Rivermont**, focused on the *Public Safety & Disaster Response* track. It ingests
incident data (fire, flood, medical, crime, hazmat, infrastructure, etc.), and gives
city operators:

- **Natural language Q&A** over live incident data (a small RAG pipeline)
- **Anomaly / pattern detection** — statistically unusual spikes per zone & incident type
- **Predictive forecasting** — short-term incident volume forecast per city
- **Resource recommendations** — rule-based utilization checks + anomaly-driven pre-positioning
- **Workflow automation** — a one-click "automation run" that evaluates conditions and
  would dispatch alerts to an ops channel in production
- A **command-center dashboard** (dark, radar/console-inspired UI) tying it all together

Everything runs **fully offline out of the box** with synthetic data and a template-based
assistant — no cloud account or API key required to demo it. Optional LLM keys upgrade
the assistant's phrasing (see below).

## Quick start

```bash
cd backend
npm install
npm start          # starts the API on http://localhost:4000
```

Then open `frontend/index.html` directly in a browser (double-click it, or serve it with
any static server). It talks to `http://localhost:4000` by default — edit `API_BASE` at
the top of the `<script>` block in `index.html` if you deploy the API elsewhere.

To regenerate the synthetic dataset (a new random 22-day incident history for Rivermont's
8 zones, with a deliberately injected flood-surge anomaly and a weekend crime-spike
anomaly baked in so the anomaly detector has something real to catch):

```bash
cd backend
npm run generate-data
```

## Optional: real LLM-backed assistant

By default `/api/chat` retrieves matching incidents + anomalies + forecast data and
composes an answer with a template engine — fully deterministic and offline. To have the
assistant phrase answers with a real LLM instead (still **grounded only in the retrieved
data**, so it can't hallucinate incidents that don't exist), copy `backend/.env.example`
to `backend/.env` and set **one** of:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...          # Gemini
```

The response's `mode` field tells you which path answered (`offline-template` vs
`llm:anthropic` / `llm:openai` / `llm:gemini`).

## Architecture

```
frontend/index.html          Single-file dashboard (vanilla JS + Chart.js, no build step)
backend/
  server.js                  Express API — the only integration surface
  data/
    generate.js              Synthetic data generator (Poisson-sampled incidents/zone/type)
    incidents.json           Generated dataset (city, zones, responder pool, incidents)
  services/
    analytics.js             Anomaly detection (z-score), forecasting (regression + MA),
                              resource recommendation engine
    assistant.js             NL query parsing + retrieval (RAG) + optional LLM call
```

### API surface

| Endpoint | Purpose |
|---|---|
| `GET /api/meta` | City, zones, responder pool sizes |
| `GET /api/incidents` | Filterable incident list (`zone`, `type`, `status`, `hours`, `limit`) |
| `GET /api/stats` | Rollup counts for the dashboard header |
| `GET /api/anomalies` | Statistically significant spikes per zone+type |
| `GET /api/forecast` | 14-day history + 3-day forecast of citywide incident volume |
| `GET /api/recommendations` | Resource utilization + anomaly-driven pre-positioning advice |
| `POST /api/chat` | `{ question }` → grounded natural-language answer |
| `POST /api/automation/run` | Evaluates conditions, returns alerts that would be dispatched |

### Why this design

- **Explainable over opaque**: anomaly detection uses a transparent z-score against a
  rolling baseline, and forecasting blends linear regression with a moving average —
  both are auditable by a human operator, which matters for public-safety decisions.
- **RAG, not free-form generation**: the assistant always retrieves and filters real
  incident records first, then either templates or LLM-phrases an answer *from that
  data*. It cannot fabricate incidents, and degrades gracefully to a fully offline mode.
- **Swappable substrate**: none of the analytics logic depends on a specific cloud
  provider. Every function documents where the production Google Cloud equivalent slots
  in (see below), so the prototype's *logic* survives a re-platforming exercise.

## Mapping to the Google Cloud ecosystem (production path)

| Prototype piece | Production upgrade |
|---|---|
| `incidents.json` + Express | BigQuery (ingest from 911/CAD, sensors, utility & citizen-feedback feeds) |
| `services/assistant.js` template/LLM call | Vertex AI + Gemini, grounded with Vertex AI Search / RAG over BigQuery |
| `services/analytics.js` anomaly z-score | BigQuery ML `ML.DETECT_ANOMALIES` or Vertex AI Forecast anomaly outputs |
| `forecastVolume` linear regression | BigQuery ML `ARIMA_PLUS` or Vertex AI Forecast |
| `recommendResources` rule engine | Vertex AI + Agent Development Kit (ADK) agent with tool-calling into dispatch systems |
| `/api/automation/run` | Cloud Workflows / Cloud Functions triggered on BigQuery scheduled queries or Pub/Sub |
| Dashboard | Looker / Looker Studio embedded panels, or keep the custom UI on Cloud Run |
| Hosting | Cloud Run (API) + Cloud Storage/Firebase Hosting (frontend) |

## Demo script (suggested)

1. Open the dashboard — point out the zone grid: **Riverside** and **Harbor District**
   are lit up (a storm-driven flood surge is baked into the seed data).
2. Scroll to **Anomaly Detection** — the flood surge and an Old Town weekend crime spike
   surface automatically with z-scores, not hardcoded rules.
3. Ask the assistant: *"What's happening in Riverside right now?"* and *"Any flood
   anomalies today?"* — show it's grounded in the same data as the panels.
2. Check **Recommendations** — resource utilization is over capacity in several
   categories; click **Run automation check** to show the alert-dispatch simulation.
3. Point to the **forecast chart** — 3-day citywide volume projection, useful for staffing
   decisions.

## Known limitations (be upfront about these in Q&A)

- Data is synthetic, generated with a Poisson model + two injected anomalies — not live
  sensor/CAD feeds.
- Anomaly thresholds (`zThreshold`, utilization `0.85`) are tuned for a good demo, not
  validated against real incident data — call this out as a tuning/calibration step for
  production.
- The forecast model is a simple regression/moving-average blend; production would use
  BigQuery ML or Vertex AI Forecast with weather/event calendar features.
- No authentication/authorization layer — add before handling real public-safety data.
