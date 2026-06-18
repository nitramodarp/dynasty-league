// category_vorp.js
// PHASE B of the rebuild — pool-wide v1.
// Computes each player's salary from REAL category production (the STATS tab),
// not xwOBA. For each player we z-score their five categories against the
// rostered pool, sum them into rawZ, map to a tier, and write the salary
// columns. This SUPERSEDES the salary write that savant_dynz.js did — remove
// the savant_dynz.js step from the workflow (see deploy notes).
//
// Current-value by design: scores raw season totals (playing time counts), no
// age factor (age is the trade lens). Hitters scored on R/HR/RBI/SB/OPS,
// pitchers on K/ERA/WHIP/QS/SV+H (ERA & WHIP inverted — lower is better).
//
// Auth: GOOGLE_KEY_JSON (same as savant_dynz.js).
//
// SCALE NOTE: rawZ = sum of five z-scores, so it runs wider than the old
// xwOBA dynZ. The old 3.0/2.0/1.0 tier cuts will NOT fit. This script logs the
// live distribution + SUGGESTED tier cuts; copy those into SETTINGS, then it's
// self-calibrating from then on.

const { google } = require('googleapis');

const SHEET_ID = '1FtMDNhzSpCgS2IdOFs4SHO7-IHoG6uAsK-UGA2NCSAs';
const SCOPES   = ['https://www.googleapis.com/auth/spreadsheets'];

// Pool inclusion floors (for computing mean/SD off a stable pool). Players below
// the floor are still SCORED against the pool — they just don't define it.
const MIN_AB_POOL = 50;   // hitter sample floor
const MIN_IP_POOL = 15;   // pitcher sample floor (low enough to include relievers)

// Classify by sample: a real hitter has AB; a pitcher has IP and ~no AB. Position
// players who mop-up-pitch keep their AB and stay hitters.
const HITTER_AB_MIN = 10;

const HIT_CATS  = ['R', 'HR', 'RBI', 'SB', 'OPS'];
const PIT_CATS  = ['K', 'ERA', 'WHIP', 'QS', 'SVH'];
const LOWER_BETTER = new Set(['ERA', 'WHIP']);

// ── SHEETS (mirrors savant_dynz.js) ─────────────────────────────────────────
function getSheets() {
  const keyJsonStr = process.env.GOOGLE_KEY_JSON;
  if (!keyJsonStr) throw new Error('GOOGLE_KEY_JSON not set');
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(keyJsonStr), scopes: SCOPES });
  return google.sheets({ version: 'v4', auth });
}
async function getRange(sheets, range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return res.data.values || [];
}
async function updateCol(sheets, range, colValues) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: colValues.map(v => [v]) },
  });
}

// ── STATS HELPERS ────────────────────────────────────────────────────────────
const num = (v, d = NaN) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function sd(a, m) {
  if (a.length < 2) return 0;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
function zsc(v, m, s) { return s > 0 ? (v - m) / s : 0; }

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('── category_vorp.js (Phase B, pool-wide v1) ──────');
  const sheets = getSheets();

  // Settings
  const settingsRows = await getRange(sheets, 'SETTINGS!A:B');
  const S = {}; settingsRows.forEach(r => { if (r[0]) S[r[0]] = r[1]; });
  const escalationRate = num(S.escalation_rate, 0.12);
  const taxDay = new Date(S.tax_day || '2026-09-01');
  const taxPassed = new Date() >= taxDay;
  const tierMins = {
    Elite: num(S.tier_elite_min, 3.0), Star: num(S.tier_star_min, 2.0),
    Solid: num(S.tier_solid_min, 1.0), Depth: num(S.tier_depth_min, 0.0),
  };
  const tierSal = {
    Elite: num(S.salary_elite, 40), Star: num(S.salary_star, 30),
    Solid: num(S.salary_solid, 20), Depth: num(S.salary_depth, 10), Minimum: num(S.salary_minimum, 3),
  };

  // STATS → by id (numeric)
  const statsRows = await getRange(sheets, 'STATS!A2:N');
  const byId = {};
  for (const r of statsRows) {
    const id = String(r[0] || '').trim();
    if (!id) continue;
    byId[id] = {
      R: num(r[2]), HR: num(r[3]), RBI: num(r[4]), SB: num(r[5]), OPS: num(r[6]),
      K: num(r[7]), ERA: num(r[8]), WHIP: num(r[9]), QS: num(r[10]), SVH: num(r[11]),
      AB: num(r[12]), IP: num(r[13]),
    };
  }
  console.log(`✓ STATS: ${Object.keys(byId).length} players`);

  // Classify
  const classify = s => {
    if (Number.isFinite(s.AB) && s.AB >= HITTER_AB_MIN) return 'H';
    if (Number.isFinite(s.IP) && s.IP > 0) return 'P';
    if (Number.isFinite(s.AB) && s.AB > 0) return 'H';
    return null;
  };

  // Build pools (above floor) and compute per-category mean/SD
  const hitPool = Object.values(byId).filter(s => classify(s) === 'H' && s.AB >= MIN_AB_POOL);
  const pitPool = Object.values(byId).filter(s => classify(s) === 'P' && s.IP >= MIN_IP_POOL);
  console.log(`✓ Pools — hitters: ${hitPool.length}, pitchers: ${pitPool.length}`);

  const stat = {};
  for (const c of HIT_CATS) { const v = hitPool.map(p => p[c]).filter(Number.isFinite); const m = mean(v); stat[c] = { m, s: sd(v, m) }; }
  for (const c of PIT_CATS) { const v = pitPool.map(p => p[c]).filter(Number.isFinite); const m = mean(v); stat[c] = { m, s: sd(v, m) }; }

  const rawZof = (s, type) => {
    const cats = type === 'H' ? HIT_CATS : PIT_CATS;
    let total = 0;
    for (const c of cats) {
      const v = Number.isFinite(s[c]) ? s[c] : stat[c].m;     // missing → neutral
      let z = zsc(v, stat[c].m, stat[c].s);
      if (LOWER_BETTER.has(c)) z = -z;
      total += z;
    }
    return total;
  };

  // Score every player, keyed by id, and collect the distribution
  const scored = {};
  const allRaw = [];
  for (const [id, s] of Object.entries(byId)) {
    const type = classify(s);
    if (!type) continue;
    const raw = parseFloat(rawZof(s, type).toFixed(3));
    scored[id] = raw;
    allRaw.push(raw);
  }

  // ── Distribution + suggested cuts (so SETTINGS can be calibrated) ──
  const sorted = [...allRaw].sort((a, b) => a - b);
  const sg = { p90: pct(sorted, 90), p75: pct(sorted, 75), p50: pct(sorted, 50), p25: pct(sorted, 25) };
  console.log('── rawZ DISTRIBUTION (all scored players) ──');
  console.log(`   n=${sorted.length}  min=${sorted[0]?.toFixed(2)}  p25=${sg.p25.toFixed(2)}  p50=${sg.p50.toFixed(2)}  p75=${sg.p75.toFixed(2)}  p90=${sg.p90.toFixed(2)}  max=${sorted[sorted.length-1]?.toFixed(2)}`);
  console.log('── SUGGESTED tier cuts → paste into SETTINGS ──');
  console.log(`   tier_elite_min = ${sg.p90.toFixed(2)}   (top 10%)`);
  console.log(`   tier_star_min  = ${sg.p75.toFixed(2)}   (top 25%)`);
  console.log(`   tier_solid_min = ${sg.p50.toFixed(2)}   (top 50%)`);
  console.log(`   tier_depth_min = ${sg.p25.toFixed(2)}   (top 75%)`);
  console.log(`   (current SETTINGS: elite ${tierMins.Elite}, star ${tierMins.Star}, solid ${tierMins.Solid}, depth ${tierMins.Depth})`);

  const tierFor = raw => {
    if (raw >= tierMins.Elite) return 'Elite';
    if (raw >= tierMins.Star)  return 'Star';
    if (raw >= tierMins.Solid) return 'Solid';
    if (raw >= tierMins.Depth) return 'Depth';
    return 'Minimum';
  };

  // Build write columns aligned to PLAYERS row order
  const players = await getRange(sheets, 'PLAYERS!A2:K');
  const dynZCol = [], tierCol = [], baseCol = [], curCol = [];
  let scoredCount = 0;
  for (const r of players) {
    const id = String(r[0] || '').trim();
    const yearHeld = num(r[10], 0);
    if (id && id in scored) {
      const raw = scored[id];
      const tier = tierFor(raw);
      const base = tierSal[tier];
      const cur = (taxPassed && yearHeld > 0)
        ? parseFloat((base * Math.pow(1 + escalationRate, yearHeld)).toFixed(1))
        : base;
      dynZCol.push(raw); tierCol.push(tier); baseCol.push(base); curCol.push(cur);
      scoredCount++;
    } else {
      // No actuals (unmatched / synthetic / below sample) → Minimum
      dynZCol.push(''); tierCol.push('Minimum'); baseCol.push(tierSal.Minimum);
      curCol.push(tierSal.Minimum);
    }
  }

  // Write salary columns (mirrors savant_dynz.js targets: H/I/J/M)
  await updateCol(sheets, 'PLAYERS!H2', dynZCol);
  await updateCol(sheets, 'PLAYERS!I2', tierCol);
  await updateCol(sheets, 'PLAYERS!J2', baseCol);
  await updateCol(sheets, 'PLAYERS!M2', curCol);

  console.log(`✓ PLAYERS updated — ${players.length} rows, ${scoredCount} scored from category VORP`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
