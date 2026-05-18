const { google } = require('googleapis');
const fs = require('fs');

const SHEET_ID = '1FtMDNhzSpCgS2IdOFs4SHO7-IHoG6uAsK-UGA2NCSAs';
const SCOPES    = ['https://www.googleapis.com/auth/spreadsheets'];

const CSV_FILES = {
  hitters: './data/hitters.csv',
  pitchers: './data/pitchers.csv',
};

const HITTER_MULT  = {21:1.18,22:1.13,23:1.08,24:1.05,25:1.02,26:1.01,27:1.00,28:0.98,29:0.95,30:0.90,31:0.84,32:0.77,33:0.69,34:0.60,35:0.50};
const PITCHER_MULT = {21:1.15,22:1.10,23:1.06,24:1.03,25:1.01,26:1.00,27:0.97,28:0.93,29:0.88,30:0.82,31:0.75,32:0.67,33:0.58,34:0.49,35:0.38};

function cleanName(n) {
  if (!n) return '';
  return n.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\s+jr\.?$/,'').replace(/\s+sr\.?$/,'')
    .replace(/\s+ii+$/,'').replace(/\s+iii+$/,'')
    .replace(/['']/g,'').replace(/\./g,'')
    .replace(/[()]/g,'').replace(/\s+/g,' ').trim();
}

function getAgeMult(age, isPitcher) {
  const a = Math.round(age);
  if (isPitcher) { if(a<=21)return 1.15; if(a>=35)return 0.38; return PITCHER_MULT[a]||1.00; }
  else           { if(a<=21)return 1.18; if(a>=36)return 0.38; if(a===35)return 0.50; return HITTER_MULT[a]||1.00; }
}

function parseCSVManual(content) {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 1) return [];
  
  // Parse header
  const headerLine = lines[0];
  const headers = headerLine.split(',').map(h => h.replace(/"/g,'').trim());
  const playerIdx = headers.findIndex(h => h.toLowerCase().includes('player'));
  const xwobaIdx = headers.findIndex(h => h.toLowerCase().includes('xwoba') || h.toLowerCase().includes('xwoba'));
  
  if (playerIdx < 0 || xwobaIdx < 0) {
    console.log(`Headers: ${headers}`);
    return [];
  }
  
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Simple CSV parse: split by comma, handle quoted fields
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === ',' && !inQuotes) {
        fields.push(current.replace(/"/g,'').trim());
        current = '';
      } else {
        current += c;
      }
    }
    fields.push(current.replace(/"/g,'').trim());
    
    if (fields[playerIdx] && fields[xwobaIdx]) {
      const name = fields[playerIdx];
      const xwoba = parseFloat(fields[xwobaIdx]);
      if (!isNaN(xwoba) && name) {
        rows.push({ name, xwoba });
      }
    }
  }
  return rows;
}

function loadCSV(filePath, isPitcher) {
  console.log(`Loading ${isPitcher?'pitchers':'hitters'} from ${filePath}...`);
  if (!fs.existsSync(filePath)) {
    console.log(`  File not found: ${filePath}`);
    return [];
  }
  
  const content = fs.readFileSync(filePath, 'utf8');
  const rows = parseCSVManual(content);
  console.log(`  Parsed ${rows.length} players with xwoba`);
  return rows;
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

  console.log('\n=== DYN Z Computation from CSV ===\n');

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
  const nameIdx = headers.indexOf('player_name');
  const ageIdx = headers.indexOf('age');
  const posIdx = headers.indexOf('position');
  const yearHeldIdx = headers.indexOf('year_held');
  
  const players = playersRows.slice(1).map(row => ({
    name: row[nameIdx] || '',
    age: parseFloat(row[ageIdx]) || 27,
    position: row[posIdx] || '',
    year_held: parseFloat(row[yearHeldIdx]) || 0,
  }));
  console.log(`Fetched ${players.length} roster players`);

  const hittersCsv = loadCSV(CSV_FILES.hitters, false);
  const pitchersCsv = loadCSV(CSV_FILES.pitchers, true);
  const dataMap = {};
  
  hittersCsv.forEach(s => { dataMap[cleanName(s.name)] = { xwoba: s.xwoba, isPitcher: false }; });
  pitchersCsv.forEach(s => { dataMap[cleanName(s.name)] = { xwoba: s.xwoba, isPitcher: true }; });
  console.log(`Data map size: ${Object.keys(dataMap).length}`);

  const results = [];
  let matched = 0, unmatched = 0;

  for (const player of players) {
    const cleanedName = cleanName(player.name);
    const playerData = dataMap[cleanedName];
    
    let dynZ = null, salaryTier = 'Minimum', baseSalary = 3, currentSalary = 3;
    
    if (playerData) {
      const isPitcher = playerData.isPitcher;
      const ageMult = getAgeMult(player.age, isPitcher);
      const rawZ = (playerData.xwoba - 0.320) / 0.030;
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
    }
    
    results.push([dynZ !== null ? dynZ : '', salaryTier, baseSalary, currentSalary]);
  }

  console.log(`Matched: ${matched}/${players.length}, Unmatched: ${unmatched}`);

  console.log('Writing to PLAYERS sheet...');
  await updateSheet(sheets, 'PLAYERS!H2', results.map(r => [r[0]]));
  await updateSheet(sheets, 'PLAYERS!I2', results.map(r => [r[1]]));
  await updateSheet(sheets, 'PLAYERS!J2', results.map(r => [r[2]]));
  await updateSheet(sheets, 'PLAYERS!M2', results.map(r => [r[3]]));

  console.log(`Done. Updated ${results.length} players.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
