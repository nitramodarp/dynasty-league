// sync_standings.js
// Pulls league standings from Yahoo and writes to the STANDINGS tab.
// Mirrors the auto_sync.js OAuth pattern (refresh token, no browser needed).
// Run manually or via GitHub Actions on Mondays at 7 AM ET.

const { google } = require('googleapis');

const CLIENT_ID  = 'dj0yJmk9NEM2YjFSV255NlA3JmQ9WVdrOWQxTlJWVVZvUTJZbWNHbzlNQT09JnM9Y29uc3VtZXJzZWNyZXQmc3Y9MCZ4PWY5';
const REDIRECT   = 'https://localhost:3000/callback';
const SHEET_ID   = '1FtMDNhzSpCgS2IdOFs4SHO7-IHoG6uAsK-UGA2NCSAs';
const KEY_PATH   = process.env.GOOGLE_KEY_PATH || './service-account.json';
const SCOPES     = ['https://www.googleapis.com/auth/spreadsheets'];

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

  // Warn if Yahoo rotated the refresh token (update GitHub Secret if so)
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

// ── LEAGUE KEY ────────────────────────────────────────────────────────────────

async function getLeagueKey(token) {
  const data    = await yahooGet('/users;use_login=1/games;game_keys=mlb/leagues', token);
  const league  = data.fantasy_content.users[0].user[1].games[0].game[1].leagues[0].league[0];
  console.log(`✓ League: ${league.name} (${league.league_key})`);
  return league.league_key;
}

// ── STANDINGS FETCH ───────────────────────────────────────────────────────────

async function fetchStandings(leagueKey, token) {
  // /standings returns team records + outcome totals
  const data     = await yahooGet(`/league/${leagueKey}/standings`, token);
  const leagueEl = data.fantasy_content.league;

  // League-level metadata lives at index 0
  const leagueMeta = leagueEl[0];

  // Standings live at index 1
  const teamsObj   = leagueEl[1].standings[0].teams;
  const teamCount  = teamsObj.count || 0;

  console.log(`✓ Standings fetched — ${teamCount} teams`);

  const rows = [];

  for (let i = 0; i < teamCount; i++) {
    const teamArr  = teamsObj[i].team;
    const infoArr  = teamArr[0];   // array of info objects
    const statsArr = teamArr[2];   // team_standings object

    // ── Basic team info ──────────────────────────────────────────
    const teamName = infoArr.find(x => x?.name)?.name || `Team ${i + 1}`;

    // ── Standings record ─────────────────────────────────────────
    const standings = statsArr?.team_standings;
    const rank      = standings?.rank                    || i + 1;
    const wins      = standings?.outcome_totals?.wins    || 0;
    const losses    = standings?.outcome_totals?.losses  || 0;
    const ties      = standings?.outcome_totals?.ties    || 0;
    const winPct    = standings?.outcome_totals?.percentage || '0.000';

    // ── Games behind (Yahoo provides this directly) ───────────────
    // Returns '-' for first place, numeric string otherwise
    const gamesBehind = standings?.games_back ?? '-';

    // ── Last-week WLT ─────────────────────────────────────────────
    // Yahoo exposes this under team_standings.streak or
    // team_points/team_stats depending on league type.
    // For H2H category leagues the field is:
    //   standings.last_week_standings.outcome_totals
    const lastWeekObj = standings?.last_week_standings?.outcome_totals;
    const lwW = lastWeekObj?.wins   ?? '';
    const lwL = lastWeekObj?.losses ?? '';
    const lwT = lastWeekObj?.ties   ?? '';
    const lastWeekWLT = (lwW !== '' && lwL !== '')
      ? `${lwW}-${lwL}${lwT !== '' && lwT !== '0' ? `-${lwT}` : ''}`
      : '';

    // ── Categories won (if available) ────────────────────────────
    // Yahoo doesn't surface this directly in /standings; leave blank
    // for now — can be computed from scoreboards if needed later.
    const categoriesWon  = '';
    const playoffClinch  = standings?.clinched_playoffs === 1 ? 'Y' : '';

    // Columns match STANDINGS tab header row (A through J):
    // rank | team_name | wins | losses | ties | win_pct |
    // categories_won | playoff_clinched | last_week_wlt | games_back |
    // luxury_tax_owed | prize_pool_contrib | total_prize_pool
    // (tax/prize cols stay blank — managed by PAYROLL tab formulas)
    rows.push([
      rank,
      teamName,
      wins,
      losses,
      ties,
      winPct,
      categoriesWon,
      playoffClinch,
      lastWeekWLT,
      gamesBehind,
    ]);
  }

  // Sort by rank ascending before writing
  rows.sort((a, b) => Number(a[0]) - Number(b[0]));

  return rows;
}

// ── SHEETS WRITE ──────────────────────────────────────────────────────────────

async function writeStandings(rows) {
  const auth   = new google.auth.GoogleAuth({ keyFile: KEY_PATH, scopes: SCOPES });
  const sheets = google.sheets({ version: 'v4', auth });

  // Clear data rows only — leave header row (row 1) intact
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range:         'STANDINGS!A2:J50',
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId:     SHEET_ID,
    range:             'STANDINGS!A2',
    valueInputOption:  'USER_ENTERED',
    requestBody:       { values: rows },
  });

  console.log(`✓ STANDINGS tab updated — ${rows.length} rows written`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('── sync_standings.js ──────────────────────────');

  const token      = await getAccessToken();
  const leagueKey  = await getLeagueKey(token);
  const rows       = await fetchStandings(leagueKey, token);

  await writeStandings(rows);

  console.log('── Done ────────────────────────────────────────');
}

main().catch(err => {
  console.error('✗ Error:', err.message);
  process.exit(1);
});
