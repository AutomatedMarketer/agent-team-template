// surplus-check.mjs — deterministic usage-surplus calculator for the surplus-burn skill.
// Reads local Claude Code transcripts via ccusage, buckets them into subscription
// weeks (anchored on the reset weekday), and emits a JSON verdict on stdout.
//
// Usage: node surplus-check.mjs
// Config: ./config.json { "resetWeekday": 1..7 (ISO, 1=Mon), "resetHour": 0-23 }

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
if (!Number.isInteger(cfg.resetWeekday) || cfg.resetWeekday < 1 || cfg.resetWeekday > 7) {
  console.log(JSON.stringify({ tier: 'NONE', error: 'surplus-burn is not calibrated: run the install-stack skill (step 4b) to write the reset weekday and hour into config.json' }));
  process.exit(0);
}

const since = new Date(Date.now() - 35 * 86400e3).toISOString().slice(0, 10).replaceAll('-', '');
const raw = execSync(`npx -y ccusage@latest daily --json --since ${since}`, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000,
});
const daily = JSON.parse(raw).daily ?? [];

// Anchor: most recent reset moment (resetWeekday at resetHour, local).
const now = new Date();
const anchor = new Date(now);
anchor.setHours(cfg.resetHour ?? 0, 0, 0, 0);
for (let i = 0; i < 14 && (anchor.getDay() !== (cfg.resetWeekday % 7) || anchor > now); i++) {
  anchor.setDate(anchor.getDate() - 1);
}
const nextReset = new Date(anchor.getTime() + 7 * 86400e3);

// Bucket days into windows relative to the anchor. Window 0 = current.
const windows = {};
for (const d of daily) {
  const day = new Date((d.period ?? d.date) + 'T12:00:00');
  if (Number.isNaN(day.getTime())) continue;
  const idx = day >= anchor ? 0 : Math.floor((anchor - day) / (7 * 86400e3)) + 1;
  const w = (windows[idx] ??= { fableCost: 0, models: {} });
  for (const m of d.modelBreakdowns ?? []) {
    if (!/claude/i.test(m.modelName)) continue; // subscription models only
    w.models[m.modelName] = (w.models[m.modelName] ?? 0) + (m.cost ?? 0);
    if (/fable/i.test(m.modelName)) w.fableCost += m.cost ?? 0;
  }
}

const cur = windows[0] ?? { fableCost: 0, models: {} };
const prior = [1, 2, 3].map((i) => windows[i]).filter(Boolean);
const clSum = (w) => Object.values(w.models).reduce((a, b) => a + b, 0);
const baseline = prior.length ? prior.reduce((a, w) => a + clSum(w), 0) / prior.length : 0;
const baselineFable = prior.length ? prior.reduce((a, w) => a + w.fableCost, 0) / prior.length : 0;

const elapsed = (now - anchor) / (7 * 86400e3); // 0..1 through the window
const expectedByNow = baseline * elapsed;
const paceRatio = expectedByNow > 0 ? clSum(cur) / expectedByNow : 1;
const daysLeft = (nextReset - now) / 86400e3;

let tier = 'NONE';
if (baseline > 0) {
  if (paceRatio < 0.6 && daysLeft <= 2.5) tier = 'HIGH';
  else if (paceRatio < 0.8 && daysLeft <= 4) tier = 'MODERATE';
}

console.log(JSON.stringify({
  tier,
  daysUntilReset: +daysLeft.toFixed(1),
  nextReset: nextReset.toISOString(),
  currentWindow: { claudeCostEquiv: +clSum(cur).toFixed(2), fableCostEquiv: +cur.fableCost.toFixed(2), models: cur.models },
  baselinePerWeek: { claudeCostEquiv: +baseline.toFixed(2), fableCostEquiv: +baselineFable.toFixed(2) },
  paceRatio: +paceRatio.toFixed(2),
  note: 'cost figures are API-cost EQUIVALENTS from ccusage (subscription pays $0/token); Anthropic does not expose the real weekly cap — baseline = trailing 3-window average of own usage. Calibrate with /usage.',
}, null, 2));
