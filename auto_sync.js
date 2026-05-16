const { google } = require('googleapis');
const CLIENT_ID = 'dj0yJmk9NEM2YjFSV255NlA3JmQ9WVdrOWQxTlJWVVZvUTJZbWNHbzlNQT09JnM9Y29uc3VtZXJzZWNyZXQmc3Y9MCZ4PWY5';
const REDIRECT  = 'https://localhost:3000/callback';
const SHEET_ID  = '1FtMDNhzSpCgS2IdOFs4SHO7-IHoG6uAsK-UGA2NCSAs';

async function getAccessToken() {
  const refreshToken = process.env.YAHOO_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('YAHOO_REFRESH_TOKEN env var not set');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, redirect_uri: REDIRECT }).toString();
  const res = await fetch('https://api.login.yahoo.com/oauth2/get_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await res.json();
  if (data.error) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  console.log('✓ Access token refreshed');
  if (data.refresh_token && data.refresh_token !== refreshToken) { console.log('⚠ New refresh token — update YAHOO_REFRESH_TOKEN secret:'); console.log(data.refresh_token); }
  return data.access_token;
}

async function yahooGet(path, token) {
  const res = await fetch(`https://fantasysports.yahooapis.com/fantasy/v2${path}?format=json`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Yahoo API error: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getLeagueKey(token) {
  const data = await yahooGet('/users;use_login=1/games;game_keys=mlb/leagues', token);
  const league = data.fantasy_content.users[0].user[1].games[0].game[1].leagues[0].league[0];
  console.log(`✓ League: ${league.name} (${league.league_key})`);
  return league.league_key;
}

async function getAllRosters(leagueKey, token) {
  const data = await yahooGet(`/league/${leagueKey}/teams/roster`, token);
  const teams = data.fantasy_content.league[1].teams;
  const rows = [];
  for (let t = 0; t < teams.count; t++) {
    const team = teams[t].team;
    const teamId = team[0][1].team_id;
    const teamName = team[0][2].name;
    const roster = team[1].roster[0].players;
    console.log(`  → ${teamName} (${roster.count} players)`);
    for (let p = 0; p < roster.count; p++) {
      const player = roster[p].player;
      const info = player[0];
      const selPos = player[1]?.selected_position?.[1]?.position || '';
      const playerId = info[1]?.player_id || '';
      const playerName = info[2]?.name?.full || '';
      const mlbTeam = info[7]?.editorial_team_abbr || '';
      const position = info[11]?.display_position || '';
      let rosterSlot = 'Active';
      if (selPos === 'IL') rosterSlot = 'IL';
      if (selPos === 'NA') rosterSlot = 'NA';
      if (selPos === 'BN') rosterSlot = 'BN';
      rows.push([playerId, playerName, mlbTeam, position, teamId, teamName, rosterSlot]);
    }
  }
  console.log(`✓ ${rows.length} players fetched`);
  return rows;
}

async function writeToSheet(rows) {
  const keyJson = process.env.GOOGLE_KEY_JSON;
  if (!keyJson) throw new Error('GOOGLE_KEY_JSON env var not set');
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(keyJson), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: 'PLAYERS!A2:G500' });
  await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: 'PLAYERS!A2', valueInputOption: 'USER_ENTERED', requestBody: { values: rows } });
  console.log(`✓ Sheet updated — ${rows.length} rows written`);
}

async function main() {
  console.log(`\n=== Dynasty Ledger Daily Sync — ${new Date().toISOString()} ===\n`);
  const token = await getAccessToken();
  const leagueKey = await getLeagueKey(token);
  const rows = await getAllRosters(leagueKey, token);
  await writeToSheet(rows);
  console.log('\n✓ Sync complete.');
}

main().catch(err => { console.error('✗ Sync failed:', err.message); process.exit(1); });
