// sync_team_stats.js
// Pulls each team's season category totals from Yahoo and writes them to the
// TEAM_STATS tab. 10 scored categories only:
//   Hitting:  R, HR, RBI, SB, OPS
//   Pitching: K, ERA, WHIP, QS, SV+H
// Mirrors the auto_sync.js OAuth pattern (refresh token, no browser needed).

const { google } = require('googleapis');

const CLIENT_ID  = 'dj0yJmk9NEM2YjFSV255NlA3JmQ9WVdrOWQxTlJWVVZvUTJZbWNHbzlNQT09JnM9Y29uc3VtZXJzZWNyZXQmc3Y9MCZ4PWY5';
const REDIRECT   = 'https://localhost:3000/callback';
const SHEET_ID   = '1FtMDNhzSpCgS2IdOFs4SHO7-IHoG6uAsK-UGA2NCSAs';
const KEY_PATH   = process.env.GOOGLE_KEY_PATH || './service-account.json';
const SCOPES     = ['https://www.googleapis.com/auth/spreadsheets'];

// stat_id -> column name, in the order we want them written.
// Confirmed from the league's stat_categories definitions.
const STAT_MAP = [
  { id: '7',  name: 'R'    },
  { id: '12', name: 'HR'   },
  { id: '13', name: 'RBI'  },
  { id: '16', name: 'SB'   },
  { id: '55', name: 'OPS'  },
  { id: '42', name: 'K'    },
  { id: '26', name: 'ERA'  },
  { id: '27', name: 'WHIP' },
  { id: '83', name: 'QS'   },
  { id: '89', name: 'SV+H' },
];

// ── YAHOO AUTH ────────────────────────────────────────────────────────────────

async function getAccessToken() {
  const refreshToken = process.env.YAHOO_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('YAHOO_REFRESH_TOKEN env var not set');

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT,
  }).toString();

  const res  = await fetch('https://api.login.yahoo.com/oauth2/get_token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (data.error) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);

  console.log('✓ Access token refreshed');
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.warn('⚠  New refresh token issued — update YAHOO_REFRESH_TOKEN secret:');
    console.warn(data.refresh_token);
  }
  return data.access_token;
}

async function yahooGet(path, token) {
  const res = await fetch(
    `https://fantasysports.yahooapis.com/fantasy/v2${path}?format=json`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Yahoo API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getLeagueKey(token) {
  const data   = await yahooGet('/users;use_login=1/games;game_keys=mlb/leagues', token);
  const league = data.fantasy_content.users[0].user[1].games[0].game[1].leagues[0].league[0];
  console.log(`✓ League: ${league.name} (${league.league_key})`);
  return league.league_key;
}

// ── TEAM STATS FETCH ──────────────────────────────────────────────────────────

async function fetchTeamStats(leagueKey, token) {
  const data    = await yahooGet(`/league/${leagueKey}/teams/stats;type=season`, token);
  const teamsObj = data.fantasy_content.league[1].teams;
  const teamCount = teamsObj.count || 0;
  console.log(`✓ Team stats fetched — ${teamCount} teams`);

  const rows = [];

  for (let i = 0; i < teamCount; i++) {
    const teamArr = teamsObj[i].team;
    const infoArr = teamArr[0];                 // array of info objects
    const statsBlock = teamArr[1].team_stats;   // { coverage_type, season, stats: [...] }

    const teamName = infoArr.find(x => x?.name)?.name || `Team ${i + 1}`;

    // Build a stat_id -> value lookup for this team
    const byId = {};
    for (const s of (statsBlock?.stats || [])) {
      const st = s.stat;
      if (st && st.stat_id != null) byId[String(st.stat_id)] = st.value;
    }

    // Pull our 10 scored categories in defined order
    const vals = STAT_MAP.map(m => {
      const raw = byId[m.id];
      if (raw === undefined || raw === '') return '';
      const num = parseFloat(raw);
      return isNaN(num) ? raw : num;
    });

    rows.push([teamName, ...vals]);
    console.log(`  → ${teamName}: ${STAT_MAP.map((m,idx)=>`${m.name}=${vals[idx]}`).join(' ')}`);
  }

  return rows;
}

// ── SHEETS WRITE ──────────────────────────────────────────────────────────────

async function writeTeamStats(rows) {
  const keyJson = process.env.GOOGLE_KEY_JSON;
  let auth;
  if (keyJson) {
    auth = new google.auth.GoogleAuth({ credentials: JSON.parse(keyJson), scopes: SCOPES });
  } else {
    auth = new google.auth.GoogleAuth({ keyFile: KEY_PATH, scopes: SCOPES });
  }
  const sheets = google.sheets({ version: 'v4', auth });

  // Ensure the TEAM_STATS tab exists; create it if missing.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === 'TEAM_STATS');
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: 'TEAM_STATS' } } }] },
    });
    console.log('✓ Created TEAM_STATS tab');
  }

  // Header row
  const header = ['team_name', ...STAT_MAP.map(m => m.name)];

  // Clear and rewrite
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: 'TEAM_STATS!A1:K50',
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'TEAM_STATS!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [header, ...rows] },
  });

  console.log(`✓ TEAM_STATS tab updated — ${rows.length} teams written`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('── sync_team_stats.js ──────────────────────────');
  const token     = await getAccessToken();
  const leagueKey = await getLeagueKey(token);
  const rows      = await fetchTeamStats(leagueKey, token);
  await writeTeamStats(rows);
  console.log('── Done ────────────────────────────────────────');
}

main().catch(err => { console.error('✗ Error:', err.message); process.exit(1); });
