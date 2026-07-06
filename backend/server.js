require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const {
  detectAnomalies,
  forecastVolume,
  recommendResources,
} = require('./services/analytics');
const { askAssistant } = require('./services/assistant');

const app = express();

app.use(cors());
app.use(express.json());

const DATA_PATH = path.join(__dirname, 'data', 'incidents.json');

let DB = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

function reload() {
  DB = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
}

// -----------------------------------------------------------------------------
// META
// -----------------------------------------------------------------------------

app.get('/api/meta', (req, res) => {
  res.json({
    city: DB.city,
    zones: DB.zones,
    responderPool: DB.responderPool,
    generatedAt: DB.generatedAt,
    totalIncidents: DB.incidents.length,
  });
});

// -----------------------------------------------------------------------------
// INCIDENTS
// -----------------------------------------------------------------------------

app.get('/api/incidents', (req, res) => {
  const { zone, type, status, hours, limit } = req.query;

  let list = DB.incidents;

  if (zone) list = list.filter((i) => i.zone === zone);
  if (type) list = list.filter((i) => i.type === type);
  if (status) list = list.filter((i) => i.status === status);

  if (hours) {
    const now = new Date(
      Math.max(...DB.incidents.map((i) => new Date(i.reportedAt).getTime()))
    );

    const cutoff = new Date(now.getTime() - Number(hours) * 60 * 60 * 1000);

    list = list.filter((i) => new Date(i.reportedAt) >= cutoff);
  }

  res.json({
    count: list.length,
    incidents: list.slice(0, limit ? Number(limit) : 200),
  });
});

// -----------------------------------------------------------------------------
// STATS
// -----------------------------------------------------------------------------

app.get('/api/stats', (req, res) => {
  const now = new Date(
    Math.max(...DB.incidents.map((i) => new Date(i.reportedAt).getTime()))
  );

  const last24 = DB.incidents.filter(
    (i) => now - new Date(i.reportedAt) <= 24 * 60 * 60 * 1000
  );

  const active = DB.incidents.filter((i) => i.status !== 'resolved');

  const critical = DB.incidents.filter(
    (i) => i.severity >= 4 && i.status !== 'resolved'
  );

  const byType = {};

  last24.forEach((i) => {
    byType[i.type] = (byType[i.type] || 0) + 1;
  });

  const byZone = {};

  active.forEach((i) => {
    byZone[i.zone] = (byZone[i.zone] || 0) + 1;
  });

  res.json({
    asOf: now.toISOString(),
    last24hCount: last24.length,
    activeCount: active.length,
    criticalActiveCount: critical.length,
    last24hByType: byType,
    activeByZone: byZone,
  });
});

// -----------------------------------------------------------------------------
// ANALYTICS
// -----------------------------------------------------------------------------

app.get('/api/anomalies', (req, res) => {
  const anomalies = detectAnomalies(DB.incidents);
  res.json({ anomalies });
});

app.get('/api/forecast', (req, res) => {
  const forecastData = forecastVolume(DB.incidents);
  res.json(forecastData);
});

app.get('/api/recommendations', (req, res) => {
  const anomalies = detectAnomalies(DB.incidents);

  const recommendations = recommendResources(
    DB.incidents,
    DB.responderPool,
    anomalies
  );

  res.json({
    recommendations,
    responderPool: DB.responderPool,
  });
});

// -----------------------------------------------------------------------------
// AI CHAT
// -----------------------------------------------------------------------------

app.post('/api/chat', async (req, res) => {
  try {
    const { question } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({
        error: 'question is required',
      });
    }

    const anomalies = detectAnomalies(DB.incidents);

    const forecastData = forecastVolume(DB.incidents);

    const result = await askAssistant({
      question,
      incidents: DB.incidents,
      zones: DB.zones,
      anomalies,
      forecastData,
    });

    res.json(result);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: 'assistant_failed',
      message: err.message,
    });
  }
});

// -----------------------------------------------------------------------------
// AUTOMATION
// -----------------------------------------------------------------------------

app.post('/api/automation/run', (req, res) => {
  const anomalies = detectAnomalies(DB.incidents);

  const recommendations = recommendResources(
    DB.incidents,
    DB.responderPool,
    anomalies
  );

  const criticalRecs = recommendations.filter(
    (r) => r.priority === 'critical'
  );

  const alerts = criticalRecs.map((r) => ({
    channel: 'ops-alerts',
    severity: 'critical',
    message: r.action,
    triggeredAt: new Date().toISOString(),
  }));

  res.json({
    evaluated: true,
    anomaliesFound: anomalies.length,
    alertsDispatched: alerts.length,
    alerts,
  });
});

// -----------------------------------------------------------------------------
// ADMIN
// -----------------------------------------------------------------------------

app.post('/api/admin/reload', (req, res) => {
  reload();

  res.json({
    reloaded: true,
    totalIncidents: DB.incidents.length,
  });
});

// -----------------------------------------------------------------------------
// HEALTH CHECK
// -----------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.json({
    status: 'API is running',
    service: 'Rivermont Decision Intelligence API',
  });
});

// -----------------------------------------------------------------------------
// START SERVER (Render Compatible)
// -----------------------------------------------------------------------------

const PORT = process.env.PORT || 4000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Rivermont Decision Intelligence API running on port ${PORT}`);
  console.log(`Loaded ${DB.incidents.length} incidents for ${DB.city}.`);
});