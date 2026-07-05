// Generates synthetic public-safety incident data for the demo city "Rivermont".
// Run: node generate.js  -> writes incidents.json in this folder.
const fs = require('fs');
const path = require('path');

const ZONES = [
  { id: 'Z1', name: 'Old Town',        pop: 18000, floodRisk: 'high' },
  { id: 'Z2', name: 'Riverside',       pop: 24000, floodRisk: 'high' },
  { id: 'Z3', name: 'Downtown Core',   pop: 31000, floodRisk: 'low'  },
  { id: 'Z4', name: 'Industrial Belt', pop: 9000,  floodRisk: 'medium' },
  { id: 'Z5', name: 'Hillcrest',       pop: 15000, floodRisk: 'low'  },
  { id: 'Z6', name: 'North Suburbs',   pop: 27000, floodRisk: 'low'  },
  { id: 'Z7', name: 'Harbor District', pop: 12000, floodRisk: 'high' },
  { id: 'Z8', name: 'East Commons',    pop: 21000, floodRisk: 'medium' },
];

const TYPES = [
  { type: 'Fire',                 base: 0.9,  severities: [2,3,4,5] },
  { type: 'Flood',                base: 0.5,  severities: [2,3,4,5] },
  { type: 'Medical Emergency',    base: 2.4,  severities: [1,2,3,4] },
  { type: 'Traffic Accident',     base: 1.8,  severities: [1,2,3] },
  { type: 'Crime - Property',     base: 1.6,  severities: [1,2,3] },
  { type: 'Crime - Violent',      base: 0.5,  severities: [3,4,5] },
  { type: 'Infrastructure Failure', base: 0.6, severities: [1,2,3,4] },
  { type: 'Hazmat',               base: 0.15, severities: [3,4,5] },
  { type: 'Missing Person',       base: 0.3,  severities: [2,3,4] },
  { type: 'Public Disturbance',   base: 1.0,  severities: [1,2,3] },
];

const STATUS_BY_AGE = (hoursAgo, severity) => {
  if (hoursAgo < 0.5) return 'reported';
  if (hoursAgo < 2) return severity >= 4 ? 'responding' : 'in_progress';
  if (hoursAgo < 6) return 'in_progress';
  return Math.random() < 0.92 ? 'resolved' : 'in_progress';
};

function poissonSample(lambda) {
  // Knuth's algorithm, fine for small lambda used here
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const NOW = new Date('2026-07-05T09:00:00Z');
const DAYS_BACK = 21;
const incidents = [];
let seq = 1000;

// Inject a deliberate anomaly: a flood surge in Riverside + Harbor over the last 36 hours
// (storm event) and a crime spike in Old Town on weekdays evenings — used to validate
// the anomaly-detection engine end-to-end.
for (let dayOffset = DAYS_BACK; dayOffset >= 0; dayOffset--) {
  const day = new Date(NOW.getTime() - dayOffset * 24 * 3600 * 1000);
  const isWeekend = [0, 6].includes(day.getUTCDay());

  ZONES.forEach((zone) => {
    TYPES.forEach((t) => {
      let lambda = t.base * (zone.pop / 20000);

      // storm surge anomaly: last 1.5 days, high-flood-risk zones, Flood + Infrastructure spike
      const hoursBeforeNow = dayOffset * 24;
      const stormWindow = hoursBeforeNow <= 36;
      if (stormWindow && zone.floodRisk === 'high' && (t.type === 'Flood' || t.type === 'Infrastructure Failure')) {
        lambda *= 6.5;
      }
      // Old Town weekend-evening violent/property crime spike anomaly (recent 2 weekends)
      if (zone.id === 'Z1' && isWeekend && dayOffset <= 14 && (t.type === 'Crime - Violent' || t.type === 'Crime - Property')) {
        lambda *= 3.2;
      }
      // weekend traffic accidents slightly down, medical slightly up (normal seasonal pattern, not anomaly)
      if (isWeekend && t.type === 'Traffic Accident') lambda *= 0.8;
      if (isWeekend && t.type === 'Medical Emergency') lambda *= 1.15;

      const count = poissonSample(lambda);
      for (let i = 0; i < count; i++) {
        const hourOfDay = Math.random() * 24;
        const ts = new Date(day.getTime() + hourOfDay * 3600 * 1000);
        if (ts > NOW) continue;
        const hoursAgo = (NOW - ts) / 3600000;
        const severity = pick(t.severities);
        incidents.push({
          id: `INC-${seq++}`,
          type: t.type,
          zoneId: zone.id,
          zone: zone.name,
          severity,
          status: STATUS_BY_AGE(hoursAgo, severity),
          reportedAt: ts.toISOString(),
          respondersAssigned: severity >= 4 ? 3 + Math.round(Math.random()) : severity === 3 ? 2 : 1,
          description: `${t.type} reported in ${zone.name}`,
        });
      }
    });
  });
}

incidents.sort((a, b) => new Date(b.reportedAt) - new Date(a.reportedAt));

const responderPool = {
  fire_units: 14,
  medical_units: 20,
  police_units: 26,
  hazmat_units: 3,
  flood_response_teams: 6,
};

const out = {
  city: 'Rivermont',
  generatedAt: NOW.toISOString(),
  zones: ZONES,
  responderPool,
  incidents,
};

fs.writeFileSync(path.join(__dirname, 'incidents.json'), JSON.stringify(out, null, 2));
console.log(`Generated ${incidents.length} incidents across ${ZONES.length} zones.`);
