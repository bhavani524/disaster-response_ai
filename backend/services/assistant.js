// Natural-language Q&A over the incident dataset.
//
// Pattern: this is a small RAG pipeline —
//   1. RETRIEVE: parse the question into structured filters and pull matching
//      records + pre-computed analytics (the "grounding context").
//   2. GENERATE: if an LLM key is configured (ANTHROPIC_API_KEY, OPENAI_API_KEY,
//      or GOOGLE_API_KEY for Gemini), send the grounding context + question to
//      the model so the answer reads naturally. If no key is set, a template
//      engine composes the answer directly from the retrieved data so the demo
//      works fully offline with zero configuration.
//
// In production this retrieval step is what Vertex AI Search / BigQuery +
// a RAG-tuned Gemini call would do; the interface (askAssistant) doesn't change.

const ZONE_ALIASES_CACHE = new WeakMap();

function buildZoneIndex(zones) {
  const idx = new Map();
  for (const z of zones) idx.set(z.name.toLowerCase(), z.name);
  return idx;
}

function parseTimeWindow(q) {
  const now = new Date();
  if (/today/.test(q)) return { label: 'today', hours: 24 };
  if (/last (\d+) hours?/.test(q)) return { label: RegExp.$1 + 'h', hours: Number(RegExp.$1) };
  if (/last (\d+) days?/.test(q)) return { label: RegExp.$1 + 'd', hours: Number(RegExp.$1) * 24 };
  if (/this week|last 7 days|past week/.test(q)) return { label: '7d', hours: 24 * 7 };
  if (/yesterday/.test(q)) return { label: 'yesterday', hours: 48, yesterdayOnly: true };
  return { label: '48h', hours: 48 }; // default recency window
}

function parseFilters(question, zones, incidentTypes) {
  const q = question.toLowerCase();
  const zoneIdx = buildZoneIndex(zones);
  let zone = null;
  for (const [lower, proper] of zoneIdx.entries()) {
    if (q.includes(lower)) { zone = proper; break; }
  }

  let type = null;
  for (const t of incidentTypes) {
    if (q.includes(t.toLowerCase().split(' - ')[0].toLowerCase())) { type = t; break; }
  }
  if (/flood/.test(q)) type = 'Flood';
  if (/fire/.test(q)) type = type || 'Fire';
  if (/crime|robbery|assault|theft|violent/.test(q)) type = type || (/violent|assault/.test(q) ? 'Crime - Violent' : 'Crime - Property');
  if (/medical|ambulance|injur/.test(q)) type = type || 'Medical Emergency';
  if (/hazmat|chemical|spill/.test(q)) type = type || 'Hazmat';
  if (/missing/.test(q)) type = type || 'Missing Person';
  if (/traffic|accident|crash/.test(q)) type = type || 'Traffic Accident';
  if (/infrastructure|power|water main|utility/.test(q)) type = type || 'Infrastructure Failure';

  let severityMin = null;
  if (/critical|severe/.test(q)) severityMin = 4;
  if (/high severity/.test(q)) severityMin = 3;

  let status = null;
  if (/unresolved|open|active|ongoing/.test(q)) status = ['reported', 'responding', 'in_progress'];
  if (/resolved|closed/.test(q)) status = ['resolved'];

  const timeWindow = parseTimeWindow(q);

  return { zone, type, severityMin, status, timeWindow };
}

function applyFilters(incidents, filters, now) {
  const cutoff = new Date(now.getTime() - filters.timeWindow.hours * 3600000);
  return incidents.filter((inc) => {
    const ts = new Date(inc.reportedAt);
    if (ts < cutoff) return false;
    if (filters.zone && inc.zone !== filters.zone) return false;
    if (filters.type && inc.type !== filters.type) return false;
    if (filters.severityMin && inc.severity < filters.severityMin) return false;
    if (filters.status && !filters.status.includes(inc.status)) return false;
    return true;
  });
}

function templateAnswer(question, filters, matches, extra) {
  const parts = [];
  const scopeBits = [];
  if (filters.zone) scopeBits.push(`in ${filters.zone}`);
  if (filters.type) scopeBits.push(`of type "${filters.type}"`);
  if (filters.severityMin) scopeBits.push(`severity ${filters.severityMin}+`);
  if (filters.status) scopeBits.push(`(${filters.status.join('/')})`);
  const scope = scopeBits.length ? ' ' + scopeBits.join(' ') : '';

  parts.push(`Found ${matches.length} incident${matches.length === 1 ? '' : 's'}${scope} in the last ${filters.timeWindow.label === '48h' ? '48 hours' : filters.timeWindow.label}.`);

  if (matches.length) {
    const bySeverity = {};
    for (const m of matches) bySeverity[m.severity] = (bySeverity[m.severity] || 0) + 1;
    const sevSummary = Object.entries(bySeverity).sort((a, b) => b[0] - a[0]).map(([s, c]) => `${c} at severity ${s}`).join(', ');
    parts.push(`Severity breakdown: ${sevSummary}.`);

    const byZone = {};
    for (const m of matches) byZone[m.zone] = (byZone[m.zone] || 0) + 1;
    const topZone = Object.entries(byZone).sort((a, b) => b[1] - a[1])[0];
    if (topZone && !filters.zone) parts.push(`Most affected zone: ${topZone[0]} (${topZone[1]} incidents).`);
  }

  if (extra?.relevantAnomalies?.length) {
    const a = extra.relevantAnomalies[0];
    parts.push(`Note: ${a.type} in ${a.zone} is running at ${a.recentDailyRate}/day vs a ${a.baselineDailyAvg}/day baseline — flagged as a ${a.severity} anomaly.`);
  }
  if (extra?.relevantForecast) {
    const f = extra.relevantForecast.forecast[0];
    parts.push(`Tomorrow's forecast: ~${f.predictedIncidents} incidents citywide (trend: ${f.trend}).`);
  }

  return parts.join(' ');
}

async function callLLM({ provider, apiKey, question, groundingContext }) {
  const systemPrompt = `You are a public-safety decision-support assistant for the city of Rivermont. Answer the question ONLY using the grounding data provided as JSON. Be concise (2-4 sentences), cite concrete numbers from the data, and never invent incidents not present in the data. If the data doesn't contain the answer, say so plainly.`;
  const userPrompt = `Grounding data (JSON):\n${JSON.stringify(groundingContext).slice(0, 12000)}\n\nQuestion: ${question}`;

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'Anthropic API error');
    return data.content?.map((c) => c.text || '').join('\n').trim();
  }

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 400,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'OpenAI API error');
    return data.choices?.[0]?.message?.content?.trim();
  }

  if (provider === 'gemini') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'Gemini API error');
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n').trim();
  }

  throw new Error('Unknown provider');
}

function resolveProvider() {
  if (process.env.ANTHROPIC_API_KEY) return { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', apiKey: process.env.OPENAI_API_KEY };
  if (process.env.GOOGLE_API_KEY) return { provider: 'gemini', apiKey: process.env.GOOGLE_API_KEY };
  return null;
}

async function askAssistant({ question, incidents, zones, anomalies, forecastData }) {
  const incidentTypes = [...new Set(incidents.map((i) => i.type))];
  const now = new Date(Math.max(...incidents.map((i) => new Date(i.reportedAt).getTime())));
  const filters = parseFilters(question, zones, incidentTypes);
  const matches = applyFilters(incidents, filters, now);

  const relevantAnomalies = anomalies.filter((a) => (!filters.zone || a.zone === filters.zone) && (!filters.type || a.type === filters.type));

  const groundingContext = {
    scopeFilters: filters,
    matchCount: matches.length,
    sampleIncidents: matches.slice(0, 12).map(({ id, type, zone, severity, status, reportedAt }) => ({ id, type, zone, severity, status, reportedAt })),
    relevantAnomalies: relevantAnomalies.slice(0, 5),
    forecastNextDays: forecastData.forecast,
  };

  const llmConfig = resolveProvider();
  let answer;
  let mode = 'offline-template';
  if (llmConfig) {
    try {
      answer = await callLLM({ ...llmConfig, question, groundingContext });
      mode = `llm:${llmConfig.provider}`;
    } catch (err) {
      answer = templateAnswer(question, filters, matches, { relevantAnomalies, relevantForecast: forecastData }) +
        ` (LLM call failed: ${err.message}; falling back to grounded summary.)`;
      mode = 'offline-template-fallback';
    }
  } else {
    answer = templateAnswer(question, filters, matches, { relevantAnomalies, relevantForecast: forecastData });
  }

  return {
    answer,
    mode,
    filters,
    matchCount: matches.length,
    matches: matches.slice(0, 25),
  };
}

module.exports = { askAssistant };
