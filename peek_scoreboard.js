// peek_scoreboard.js
// One-off diagnostic: fetches last week's Yahoo scoreboard + recent
// transactions, prints structure so we can write the real sync correctly.
// Run once, paste output, then delete.

const CLIENT_ID  = 'dj0yJmk9NEM2YjFSV255NlA3JmQ9WVdrOWQxTlJWVVZvUTJZbWNHbzlNQT09JnM9Y29uc3VtZXJzZWNyZXQmc3Y9MCZ4PWY5';
const REDIRECT   = 'https://localhost:3000/callback';

async function getAccessToken() {
  const refreshToken = process.env.YAHOO_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('YAHOO_REFRESH_TOKEN env var not set');
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT,
  }).toString();
  const res = await fetch('https://api.login.yahoo.com/oauth2/get_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (data.error) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  console.log('✓ Access token refreshed\n');
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
  console.log(`✓ League: ${league.name} (${league.league_key})\n`);
  return { key: league.league_key, raw: league };
}

async function main() {
  const token = await getAccessToken();
  const { key: leagueKey } = await getLeagueKey(token);

  // 1) Get current week from league metadata
  console.log('========== LEAGUE METADATA (current week) ==========');
  const meta = await yahooGet(`/league/${leagueKey}`, token);
  const leagueInfo = meta.fantasy_content.league[0];
  console.log('current_week:', leagueInfo.current_week);
  console.log('start_week:', leagueInfo.start_week, 'end_week:', leagueInfo.end_week);
  const currentWeek = parseInt(leagueInfo.current_week);
  const lastCompletedWeek = currentWeek - 1;
  console.log(`Last completed week should be: ${lastCompletedWeek}\n`);

  // 2) Pull the scoreboard for last completed week
  console.log(`========== SCOREBOARD (week ${lastCompletedWeek}) ==========`);
  const sb = await yahooGet(`/league/${leagueKey}/scoreboard;week=${lastCompletedWeek}`, token);
  const full = JSON.stringify(sb, null, 2);
  console.log(`(total length ${full.length} chars — showing first 7000)\n`);
  console.log(full.slice(0, 7000));

  console.log('\n\n========== ISOLATED: FIRST MATCHUP ==========');
  try {
    const matchups = sb.fantasy_content.league[1].scoreboard[0].matchups;
    console.log('matchup count:', matchups.count);
    console.log(JSON.stringify(matchups[0].matchup, null, 2).slice(0, 6000));
  } catch (e) {
    console.log('Could not isolate first matchup:', e.message);
  }

  // 3) Pull recent transactions
  console.log('\n\n========== TRANSACTIONS (recent) ==========');
  try {
    const tx = await yahooGet(`/league/${leagueKey}/transactions;type=add,drop;count=10`, token);
    const txFull = JSON.stringify(tx, null, 2);
    console.log(`(total length ${txFull.length} chars — showing first 5000)\n`);
    console.log(txFull.slice(0, 5000));
  } catch (e) {
    console.log('Transactions fetch failed:', e.message);
  }
}

main().catch(err => { console.error('✗ Error:', err.message); process.exit(1); });
