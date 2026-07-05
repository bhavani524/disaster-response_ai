// Core "decision intelligence" logic: pattern/anomaly detection, short-term forecasting,
// and rule-based resource recommendations. Kept dependency-free (no ML libs) so the
// prototype runs anywhere with plain Node — swap in BigQuery ML / Vertex AI Forecast
// in production without changing the API surface below.

function dayKey(iso) {
  return iso.slice(0, 10); // YYYY-MM-DD
}

function groupCounts(incidents, keyFn) {
  const map = new Map();
  for (const inc of incidents) {
    const k = keyFn(inc);
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / (arr.length || 1); }
function stddev(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
}

/**
 * Detects statistically unusual spikes per zone+type over the trailing window,
 * comparing the most recent `recentDays` against the `baselineDays` before that,
 * using a z-score on daily counts. This is the "identify patterns and anomalies"
 * requirement — simple, explainable, and fast enough to run on every request.
 */
function detectAnomalies(incidents, { baselineDays = 14, recentDays = 2, zThreshold = 1.8 } = {}) {
  const now = new Date(Math.max(...incidents.map((i) => new Date(i.reportedAt).getTime())));
  const cutoffRecent = new Date(now.getTime() - recentDays * 86400000);
  const cutoffBaseline = new Date(now.getTime() - (recentDays + baselineDays) * 86400000);

  const segmentKey = (inc) => `${inc.zone}||${inc.type}`;
  const bySegment = new Map();

  for (const inc of incidents) {
    const ts = new Date(inc.reportedAt);
    if (ts < cutoffBaseline) continue;
    const key = segmentKey(inc);
    if (!bySegment.has(key)) bySegment.set(key, { baselineDayCounts: new Map(), recentCount: 0 });
    const seg = bySegment.get(key);
    if (ts >= cutoffRecent) {
      seg.recentCount += 1;
    } else {
      const dk = dayKey(inc.reportedAt);
      seg.baselineDayCounts.set(dk, (seg.baselineDayCounts.get(dk) || 0) + 1);
    }
  }

  const anomalies = [];
  for (const [key, seg] of bySegment.entries()) {
    const [zone, type] = key.split('||');
    const dailyCounts = [];
    for (let i = 0; i < baselineDays; i++) {
      const d = dayKey(new Date(cutoffBaseline.getTime() + i * 86400000).toISOString());
      dailyCounts.push(seg.baselineDayCounts.get(d) || 0);
    }
    const baselineMean = mean(dailyCounts);
    const baselineStd = Math.max(stddev(dailyCounts), 0.35); // floor to avoid divide-by-near-zero noise
    const recentDailyRate = seg.recentCount / recentDays;
    const z = (recentDailyRate - baselineMean) / baselineStd;

    if (z >= zThreshold && seg.recentCount >= 3) {
      anomalies.push({
        zone,
        type,
        recentCount: seg.recentCount,
        recentDailyRate: Number(recentDailyRate.toFixed(2)),
        baselineDailyAvg: Number(baselineMean.toFixed(2)),
        zScore: Number(z.toFixed(2)),
        severity: z >= 3.5 ? 'critical' : z >= 2.5 ? 'high' : 'moderate',
      });
    }
  }

  return anomalies.sort((a, b) => b.zScore - a.zScore);
}

/**
 * Short-term forecast of total daily incident volume using linear regression
 * over the trailing window, blended with a 3-day moving average for stability.
 * Swap for Vertex AI Forecast / BigQuery ML ARIMA_PLUS for production accuracy.
 */
function forecastVolume(incidents, { historyDays = 14, horizonDays = 3 } = {}) {
  const now = new Date(Math.max(...incidents.map((i) => new Date(i.reportedAt).getTime())));
  const cutoff = new Date(now.getTime() - historyDays * 86400000);
  const daily = new Map();
  for (let i = 0; i < historyDays; i++) {
    const d = dayKey(new Date(cutoff.getTime() + i * 86400000).toISOString());
    daily.set(d, 0);
  }
  for (const inc of incidents) {
    const ts = new Date(inc.reportedAt);
    if (ts < cutoff) continue;
    const dk = dayKey(inc.reportedAt);
    if (daily.has(dk)) daily.set(dk, daily.get(dk) + 1);
  }

  const series = Array.from(daily.values());
  const n = series.length;
  const xs = series.map((_, i) => i);
  const xMean = mean(xs);
  const yMean = mean(series);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (series[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;

  const movingAvgWindow = series.slice(-3);
  const maBase = mean(movingAvgWindow);

  const forecast = [];
  for (let h = 1; h <= horizonDays; h++) {
    const trendPoint = intercept + slope * (n - 1 + h);
    const blended = 0.6 * trendPoint + 0.4 * maBase;
    const predicted = Math.max(0, Math.round(blended));
    const date = dayKey(new Date(now.getTime() + h * 86400000).toISOString());
    forecast.push({ date, predictedIncidents: predicted, trend: slope > 0.15 ? 'rising' : slope < -0.15 ? 'falling' : 'stable' });
  }

  return {
    history: Array.from(daily.entries()).map(([date, count]) => ({ date, count })),
    forecast,
    trendSlopePerDay: Number(slope.toFixed(2)),
  };
}

/**
 * Rule-based resource recommendation: compares currently open/active incidents
 * requiring each responder category against the available pool, and factors in
 * the forecast + anomalies to recommend pre-positioning.
 */
function recommendResources(incidents, responderPool, anomalies) {
  const active = incidents.filter((i) => i.status === 'reported' || i.status === 'responding' || i.status === 'in_progress');

  const demandByCategory = { fire_units: 0, medical_units: 0, police_units: 0, hazmat_units: 0, flood_response_teams: 0 };
  const categoryForType = (type) => {
    if (type === 'Fire') return 'fire_units';
    if (type === 'Flood') return 'flood_response_teams';
    if (type === 'Medical Emergency') return 'medical_units';
    if (type.startsWith('Crime') || type === 'Public Disturbance') return 'police_units';
    if (type === 'Hazmat') return 'hazmat_units';
    if (type === 'Traffic Accident') return 'police_units';
    if (type === 'Missing Person') return 'police_units';
    if (type === 'Infrastructure Failure') return 'flood_response_teams';
    return null;
  };

  for (const inc of active) {
    const cat = categoryForType(inc.type);
    if (cat) demandByCategory[cat] += inc.respondersAssigned || 1;
  }

  const recommendations = [];
  for (const [cat, demand] of Object.entries(demandByCategory)) {
    const available = responderPool[cat] || 0;
    const utilization = available === 0 ? 0 : demand / available;
    if (utilization >= 0.85) {
      recommendations.push({
        category: cat,
        demand,
        available,
        utilization: Number(utilization.toFixed(2)),
        action: `Utilization at ${(utilization * 100).toFixed(0)}%. Request mutual aid or activate reserve ${cat.replace('_', ' ')}.`,
        priority: utilization >= 1 ? 'critical' : 'high',
      });
    }
  }

  // Anomaly-driven pre-positioning advice
  for (const a of anomalies.slice(0, 5)) {
    const cat = categoryForType(a.type);
    if (!cat) continue;
    recommendations.push({
      category: cat,
      zone: a.zone,
      action: `Pre-position additional ${cat.replace('_', ' ')} near ${a.zone}: ${a.type} incidents running ${a.recentDailyRate}/day vs a ${a.baselineDailyAvg}/day baseline (z=${a.zScore}).`,
      priority: a.severity === 'critical' ? 'critical' : 'high',
    });
  }

  return recommendations;
}

module.exports = { detectAnomalies, forecastVolume, recommendResources };
