const { google } = require('googleapis');
const fs = require('fs');

const SHEET_ID = '1FtMDNhzSpCgS2IdOFs4SHO7-IHoG6uAsK-UGA2NCSAs';
const SCOPES    = ['https://www.googleapis.com/auth/spreadsheets'];

const CSV_FILES = {
  hitters: './data/hitters.csv',
  pitchers: './data/pitchers.csv',
};

// ── DYN Z calibration ──────────────────────────────────────────────
const LEAGUE_MEAN_XWOBA = 0.315;   // regress toward this
const Z_ANCHOR          = 0.320;   // z-score center
const Z_SCALE           = 0.030;   // z-score spread
// Dynamic regression: k scales with the average sample size in each file.
// Early season (small samples) -> small k -> light regression.
// Late season (large samples)  -> large k -> heavy regression.
// k = REGRESSION_RATIO * mean_sample, computed per file.
const REGRESSION_RATIO  = 0.4;

const HITTER_MULT  = {21:1.18,22:1.13,23:1.08,24:1.05,25:1.02,26:1.01,27:1.00,28:0.98,29:0.95,30:0.90,31:0.84,32:0.77,33:0.69,34:0.60,35:0.50};
const PITCHER_MULT = {21:1.15,22:1.10,23:1.06,24:1.03,25:1.01,26:1.00,27:0.97,28:0.93,29:0.88,30:0.82,31:0.75,32:0.67,33:0.58,34:0.49,35:0.38};

// Manual name overrides for stubborn mismatches between Yahoo roster names
// and Savant CSV names. Key = cleaned roster name, Value = cleaned CSV name.
const NAME_OVERRIDES = {
  // 'luis robert jr': 'luis robert',   // example
};

function cleanName(n) {
  if (!n) return '';
  return n.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')    // strip accents
    .replace(/\s*\((batter|pitcher|hitter)\)\s*/gi,' ') // strip two-way tags
    .replace(/\s+jr\.?$/,'').replace(/\s+sr\.?$/,'')
    .replace(/\s+iv$/,'').replace(/\s+iii$/,'').replace(/\s+ii$/,'')
    .replace(/[''']/g,'').replace(/\./g,'')
    .replace(/[()]/g,'').replace(/,/g,'')
    .replace(/\s+/g,' ').trim();
}

function getAgeMult(age, isPitcher) {
  const a = Math.round(age);
  if (isPitcher) { if(a<=21)return 1.15; if(a>=35)return 0.38; return PITCHER_MULT[a]||1.00; }
  else           { if(a<=21)return 1.18; if(a>=36)return 0.38; if(a===35)return 0.50; return HITTER_MULT[a]||1.00; }
}

// Regress a raw xwOBA toward league mean using a dynamic k (passed in).
function regressXwoba(rawXwoba, sample, k) {
  const n = (!sample || isNaN(sample) || sample < 0) ? 0 : sample;
  return (rawXwoba * n + LEAGUE_MEAN_XWOBA * k) / (n + k);
}

// Parse a CSV line respecting quoted fields
function parseLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  fields.push(current.trim());
  return fields;
}

function loadCSV(filePath, isPitcher) {
  console.log(`Loading ${isPitcher?'pitchers':'hitters'} from ${filePath}...`);
  if (!fs.existsSync(filePath)) {
    console.log(`  File not found: ${filePath}`);
    return [];
  }

  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(/^\uFEFF/, '');   // strip BOM

  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseLine(lines[0]);
  const nameIdx   = headers.findIndex(h => h.includes('last_name') || h === 'name' || h.includes('name'));
  const xwobaIdx  = headers.findIndex(h => h.trim() === 'xwoba');
  const sampleIdx = headers.findIndex(h => h.trim() === 'pa' || h.trim() === 'bf');
  console.log(`  Headers: ${headers.slice(0,6).join(' | ')}`);
  console.log(`  nameIdx=${nameIdx}, xwobaIdx=${xwobaIdx}, sampleIdx=${sampleIdx}`);

  if (nameIdx < 0 || xwobaIdx < 0) {
    console.log(`  Could not find required columns`);
    return [];
  }

  const rows = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const fields = parseLine(lines[i]);
    const rawName = fields[nameIdx] || '';
    const xwoba   = parseFloat(fields[xwobaIdx]);
    const sample  = sampleIdx >= 0 ? parseFloat(fields[sampleIdx]) : 0;

    if (!rawName || isNaN(xwoba) || xwoba <= 0) { skipped++; continue; }

    let name = rawName;
    if (name.includes(',')) {
      const parts = name.split(',');
      name = parts[1].trim() + ' ' + parts[0].trim();
    }

    rows.push({ name, xwoba, sample: isNaN(sample) ? 0 : sample });
  }

  // Compute mean sample size across this file -> dynamic k
  const withSample = rows.filter(r => r.sample > 0);
  const meanSample = withSample.length
    ? withSample.reduce((a, r) => a + r.sample, 0) / withSample.length
    : 0;
  const k = Math.max(1, REGRESSION_RATIO * meanSample);
  console.log(`  Parsed ${rows.length} players with xwoba (skipped ${skipped})`);
  console.log(`  Mean sample=${meanSample.toFixed(1)} -> dynamic k=${k.toFixed(1)}`);

  return { rows, k };
}

async function getSheet(sheets, range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return res.data.values || [];
}

async function updateSheet(sheets, range, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

async function main() {
  const keyJsonStr = process.env.GOOGLE_KEY_JSON;
  if (!keyJsonStr) throw new Error('GOOGLE_KEY_JSON not set');
  const keyJson = JSON.parse(keyJsonStr);
  const auth = new google.auth.GoogleAuth({ credentials: keyJson, scopes: SCOPES });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('\n=== DYN Z Computation (name match + dynamic sample-size regression) ===');
  console.log(`    ratio=${REGRESSION_RATIO}, league_mean=${LEAGUE_MEAN_XWOBA}, anchor=${Z_ANCHOR}, scale=${Z_SCALE}\n`);

  const settingsRows = await getSheet(sheets, 'SETTINGS!A:B');
  const settingsMap = {};
  for (const row of settingsRows) {
    if (row[0]) settingsMap[row[0]] = row[1];
  }
  const taxDay = new Date(settingsMap.tax_day || '2026-09-01');
  const today = new Date();
  const isTaxDayPassed = today >= taxDay;

  const playersRows = await getSheet(sheets, 'PLAYERS!A1:Q500');
  const headers = playersRows[0];
  const nameIdx     = headers.indexOf('player_name');
  const ageIdx      = headers.indexOf('age');
  const yearHeldIdx = headers.indexOf('year_held');
  const slotIdx     = headers.indexOf('roster_slot');

  const players = playersRows.slice(1).map(row => ({
    name:      row[nameIdx] || '',
    age:       parseFloat(row[ageIdx]) || 27,
    year_held: parseFloat(row[yearHeldIdx]) || 0,
    slot:      row[slotIdx] || '',
  }));
  console.log(`Fetched ${players.length} roster players`);

  const hitters  = loadCSV(CSV_FILES.hitters, false);
  const pitchers = loadCSV(CSV_FILES.pitchers, true);
  const hittersCsv  = hitters.rows  || [];
  const pitchersCsv = pitchers.rows || [];
  const kHitter  = hitters.k  || 1;
  const kPitcher = pitchers.k || 1;

  // Build name-keyed maps, carrying xwoba + sample so we can regress at match time.
  const hitterMap = {}, pitcherMap = {}, dataMap = {};
  hittersCsv.forEach(s  => { const key = cleanName(s.name); hitterMap[key]  = { xwoba: s.xwoba, sample: s.sample }; dataMap[key] = { xwoba: s.xwoba, sample: s.sample, isPitcher: false }; });
  pitchersCsv.forEach(s => { const key = cleanName(s.name); pitcherMap[key] = { xwoba: s.xwoba, sample: s.sample }; if (!dataMap[key]) dataMap[key] = { xwoba: s.xwoba, sample: s.sample, isPitcher: true }; });

  console.log(`Hitter map: ${Object.keys(hitterMap).length}, Pitcher map: ${Object.keys(pitcherMap).length}, Combined: ${Object.keys(dataMap).length}`);

  const results = [];
  let matched = 0, unmatched = 0, unmatchedProspects = 0;
  const unmatchedReal = [];

  for (const player of players) {
    let cleaned = cleanName(player.name);
    if (NAME_OVERRIDES[cleaned]) cleaned = NAME_OVERRIDES[cleaned];

    let playerData = null;

    if (/\(pitcher\)/i.test(player.name)) {
      if (pitcherMap[cleaned]) playerData = { ...pitcherMap[cleaned], isPitcher: true };
    } else if (/\(batter\)/i.test(player.name) || /\(hitter\)/i.test(player.name)) {
      if (hitterMap[cleaned]) playerData = { ...hitterMap[cleaned], isPitcher: false };
    } else if (dataMap[cleaned]) {
      playerData = dataMap[cleaned];
    }

    let dynZ = null, salaryTier = 'Minimum', baseSalary = 3, currentSalary = 3;

    if (playerData) {
      const k = playerData.isPitcher ? kPitcher : kHitter;
      const regXwoba = regressXwoba(playerData.xwoba, playerData.sample, k);

      const ageMult = getAgeMult(player.age, playerData.isPitcher);
      const rawZ = playerData.isPitcher
        ? (Z_ANCHOR - regXwoba) / Z_SCALE   // pitchers: lower xwOBA = better
        : (regXwoba - Z_ANCHOR) / Z_SCALE;  // hitters: higher xwOBA = better
      dynZ = parseFloat((rawZ * ageMult).toFixed(3));

      if (dynZ >= 3.0) { salaryTier = 'Elite'; baseSalary = 40; }
      else if (dynZ >= 2.0) { salaryTier = 'Star'; baseSalary = 30; }
      else if (dynZ >= 1.0) { salaryTier = 'Solid'; baseSalary = 20; }
      else if (dynZ >= 0.0) { salaryTier = 'Depth'; baseSalary = 10; }
      else { salaryTier = 'Minimum'; baseSalary = 3; }

      if (isTaxDayPassed && player.year_held > 0) {
        const escalationRate = parseFloat(settingsMap.escalation_rate) || 0.12;
        currentSalary = parseFloat((baseSalary * Math.pow(1 + escalationRate, player.year_held)).toFixed(1));
      } else {
        currentSalary = baseSalary;
      }
      matched++;
    } else {
      unmatched++;
      if (player.slot === 'NA') {
        unmatchedProspects++;
      } else if (unmatchedReal.length < 50) {
        unmatchedReal.push(`${player.name} [${cleaned}]`);
      }
    }

    results.push([dynZ !== null ? dynZ : '', salaryTier, baseSalary, currentSalary]);
  }

  console.log(`\nMatched: ${matched}/${players.length}`);
  console.log(`Unmatched: ${unmatched} (of which ${unmatchedProspects} are NA prospects -- expected)`);
  console.log(`Real misses to investigate (${unmatchedReal.length}):`);
  unmatchedReal.forEach(n => console.log(`  x ${n}`));

  console.log('\nWriting to PLAYERS sheet...');
  await updateSheet(sheets, 'PLAYERS!H2', results.map(r => [r[0]]));
  await updateSheet(sheets, 'PLAYERS!I2', results.map(r => [r[1]]));
  await updateSheet(sheets, 'PLAYERS!J2', results.map(r => [r[2]]));
  await updateSheet(sheets, 'PLAYERS!M2', results.map(r => [r[3]]));

  console.log(`Done. Updated ${results.length} players.`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
