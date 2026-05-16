const { google } = require('googleapis');
const puppeteer = require('puppeteer');

const SHEET_ID = '1FtMDNhzSpCgS2IdOFs4SHO7-IHoG6uAsK-UGA2NCSAs';
const SCOPES    = ['https://www.googleapis.com/auth/spreadsheets'];

const SAVANT_URLS = {
  hitters: 'https://baseballsavant.mlb.com/leaderboard/custom?year=2026&type=batter&filter=&min=q&selections=pa%2Ck_percent%2Cbb_percent%2Cwoba%2Cxwoba%2Csweet_spot_percent%2Cbarrel_batted_rate%2Chard_hit_percent%2Cavg_best_speed%2Cavg_hyper_speed%2Cwhiff_percent%2Cswing_percent&chart=false&x=pa&y=pa&r=no&chartType=beeswarm&sort=xwoba&sortDir=desc',
  pitchers: 'https://baseballsavant.mlb.com/leaderboard/custom?year=2026&type=pitcher&filter=&min=q&selections=pa%2Ck_percent%2Cbb_percent%2Cwoba%2Cxwoba%2Csweet_spot_percent%2Cbarrel_batted_rate%2Chard_hit_percent%2Cavg_best_speed%2Cavg_hyper_speed%2Cwhiff_percent%2Cswing_percent&chart=false&x=pa&y=pa&r=no&chartType=beeswarm&sort=xwoba&sortDir=asc',
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

async function scrapeSavant(url, isPitcher) {
  console.log(`Scraping ${isPitcher?'pitchers':'hitters'} from Savant...`);
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('table', { timeout: 10000 });
    
    const data = await page.evaluate(() => {
      const rows = [];
      const table = document.querySelector('table');
      if (!table) return rows;
      
      const headerRow = table.querySelector('thead tr');
      const headers = Array.from(headerRow.querySelectorAll('th')).map(th => th.textContent.trim());
      const nameIdx = headers.findIndex(h => h.toLowerCase().includes('name'));
      const xwobaIdx = headers.findIndex(h => h.toLowerCase().includes('xwoba'));
      
      const bodyRows = table.querySelectorAll('tbody tr');
      bodyRows.forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
        if (cells[nameIdx] && cells[xwobaIdx]) {
          rows.push({
            name: cells[nameIdx],
            xwoba: parseFloat(cells[xwobaIdx]) || 0,
          });
        }
      });
      return rows;
    });
    
    await browser.close();
    console.log(`  Scraped ${data.length} players`);
    return data;
  } catch (err) {
    await browser.close();
    throw new Error(`Savant scrape failed: ${err.message}`);
  }
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
  const keyJson = JSON.parse(process.env.GOOGLE_KEY_JSON || '{}');
  const auth = new google.auth.GoogleAuth({ credentials: keyJson, scopes: SCOPES });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('\n=== Savant DYN Z Computation ===\n');

  const settingsRows = await getSheet(sheets, 'SETTINGS!A:B');
  const settingsMap = {};
  for (const row of settingsRows) {
    if (row[0]) settingsMap[row[0]] = row[1];
  }
  const taxDay = new Date(settingsMap.tax_day || '2026-09-01');
  const today = new Date();
  const isTaxDayPassed = today >= taxDay;
  console.log(`Tax Day: ${taxDay.toISOString().split('T')[0]}, passed: ${isTaxDayPassed}`);

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

  const hittersSavant = await scrapeSavant(SAVANT_URLS.hitters, false);
  const pitchersSavant = await scrapeSavant(SAVANT_URLS.pitchers, true);
  const savantMap = {};
  
  hittersSavant.forEach(s => { savantMap[cleanName(s.name)] = { xwoba: s.xwoba, isPitcher: false }; });
  pitchersSavant.forEach(s => { savantMap[cleanName(s.name)] = { xwoba: s.xwoba, isPitcher: true }; });
  console.log(`Savant map size: ${Object.keys(savantMap).length}`);

  console.log('\nComputing DYN Z and salaries...');
  const results = [];
  let matched = 0, unmatched = 0;

  for (const player of players) {
    const cleanedName = cleanName(player.name);
    const savantData = savantMap[cleanedName];
    
    let dynZ = null, salaryTier = 'Minimum', baseSalary = 3, currentSalary = 3;
    
    if (savantData) {
      const isPitcher = savantData.isPitcher;
      const ageMult = getAgeMult(player.age, isPitcher);
      const rawZ = (savantData.xwoba - 0.320) / 0.030;
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
    
    results.push([
      dynZ !== null ? dynZ : '',
      salaryTier,
      baseSalary,
      currentSalary,
    ]);
  }

  console.log(`  Matched: ${matched}/${players.length}`);
  console.log(`  Unmatched: ${unmatched}`);

  console.log('\nWriting to PLAYERS sheet...');
  await updateSheet(sheets, 'PLAYERS!H2', results.map(r => [r[0]]));
  await updateSheet(sheets, 'PLAYERS!I2', results.map(r => [r[1]]));
  await updateSheet(sheets, 'PLAYERS!J2', results.map(r => [r[2]]));
  await updateSheet(sheets, 'PLAYERS!M2', results.map(r => [r[3]]));

  console.log(`\nDone. Updated ${results.length} players.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
