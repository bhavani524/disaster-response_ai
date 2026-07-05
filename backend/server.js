require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { detectAnomalies, forecastVolume, recommendResources } = require('./services/analytics');
const { askAssistant } = require('./services/assistant');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_PATH = path.join(__dirname, 'data', 'incidents.json');
let DB = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));

function reload() {
  DB = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
}

// ---- Read endpoints -------------------------------------------------------

app.get('/api/meta', (req, res) => {
  res.json({ city: DB.city, zones: DB.zones, responderPool: DB.responderPool, generatedAt: DB.generatedAt, totalIncidents: DB.incidents.length });
});

app.get('/api/incidents', (req, res) => {
  const { zone, type, status, hours, limit } = req.query;
  let list = DB.incidents;
  if (zone) list = list.filter((i) => i.zone === zone);
  if (type) list = list.filter((i) => i.type === type);
  if (status) list = list.filter((i) => i.status === status);
  if (hours) {
    const now = new Date(Math.max(...DB.incidents.map((i) => new Date(i.reportedAt).getTime())));
    const cutoff = new Date(now.getTime() - Number(hours) * 3600000);
    list = list.filter((i) => new Date(i.reportedAt) >= cutoff);
  }
  res.json({ count: list.length, incidents: list.slice(0, limit ? Number(limit) : 200) });
});

app.get('/api/stats', (req, res) => {
  const now = new Date(Math.max(...DB.incidents.map((i) => new Date(i.reportedAt).getTime())));
  const last24 = DB.incidents.filter((i) => now - new Date(i.reportedAt) <= 24 * 3600000);
  const active = DB.incidents.filter((i) => i.status !== 'resolved');
  const critical = DB.incidents.filter((i) => i.severity >= 4 && i.status !== 'resolved');

  const byType = {};
  for (const i of last24) byType[i.type] = (byType[i.type] || 0) + 1;
  const byZone = {};
  for (const i of active) byZone[i.zone] = (byZone[i.zone] || 0) + 1;

  res.json({
    asOf: now.toISOString(),
    last24hCount: last24.length,
    activeCount: active.length,
    criticalActiveCount: critical.length,
    last24hByType: byType,
    activeByZone: byZone,
  });
});

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
  const recommendations = recommendResources(DB.incidents, DB.responderPool, anomalies);
  res.json({ recommendations, responderPool: DB.responderPool });
});

// ---- AI assistant (RAG-style NL Q&A) --------------------------------------

app.post('/api/chat', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ error: 'question is required' });

    const anomalies = detectAnomalies(DB.incidents);
    const forecastData = forecastVolume(DB.incidents);
    const result = await askAssistant({ question, incidents: DB.incidents, zones: DB.zones, anomalies, forecastData });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'assistant_failed', message: err.message });
  }
});

// ---- Simulated automation workflow -----------------------------------------
// Demonstrates "workflow automation": when called, evaluates current anomalies +
// resource utilization and returns the alert(s) that would be dispatched
// (e.g. to a Slack/SMS/PagerDuty webhook) in a production deployment.

app.post('/api/automation/run', (req, res) => {
  const anomalies = detectAnomalies(DB.incidents);
  const recommendations = recommendResources(DB.incidents, DB.responderPool, anomalies);
  const criticalRecs = recommendations.filter((r) => r.priority === 'critical');

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

app.post('/api/admin/reload', (req, res) => {
  reload();
  res.json({ reloaded: true, totalIncidents: DB.incidents.length });
});

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`Rivermont Decision Intelligence API running on http://localhost:${port}`);
    console.log(`Loaded ${DB.incidents.length} incidents for ${DB.city}.`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const fallbackPort = port + 1;
      console.warn(`Port ${port} is busy. Trying ${fallbackPort} instead...`);
      if (server.listening) {
        server.close(() => startServer(fallbackPort));
      } else {
        startServer(fallbackPort);
      }
      return;
    }

    console.error(err);
    process.exit(1);
  });
}

startServer(Number(process.env.PORT) || 4000);
