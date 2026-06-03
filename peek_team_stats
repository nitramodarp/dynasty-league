// peek_team_stats.js
// One-off diagnostic: fetches the Yahoo team-stats endpoint and prints its
// structure so we can see where category stats live and what stat_ids map to.
// Run it once, paste the output, then delete it.

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
  return league.league_key;
}

async function main() {
  const token     = await getAccessToken();
  const leagueKey = await getLeagueKey(token);

  // 1) Pull the league's stat-category definitions (maps stat_id -> name)
  console.log('========== STAT CATEGORY DEFINITIONS ==========');
  try {
    const settings = await yahooGet(`/league/${leagueKey}/settings`, token);
    const cats = settings.fantasy_content.league[1].settings[0].stat_categories.stats;
    for (const s of cats) {
      const st = s.stat;
      console.log(`  stat_id=${st.stat_id}  ${st.display_name || st.name}  (${st.name})`);
    }
  } catch (e) {
    console.log('  Could not read stat_categories:', e.message);
    console.log('  Dumping raw settings instead:');
    const settings = await yahooGet(`/league/${leagueKey}/settings`, token);
    console.log(JSON.stringify(settings, null, 2).slice(0, 4000));
  }

  // 2) Pull team stats for ONE team to see the structure (full dump, first team only)
  console.log('\n========== RAW TEAM STATS (first team, season totals) ==========');
  const stats = await yahooGet(`/league/${leagueKey}/teams/stats;type=season`, token);

  // Print the whole thing but truncated so it's pasteable
  const full = JSON.stringify(stats, null, 2);
  console.log(`(total length ${full.length} chars — showing first 6000)\n`);
  console.log(full.slice(0, 6000));

  console.log('\n\n========== JUST THE FIRST TEAM\'S STATS BLOCK ==========');
  try {
    const teams = stats.fantasy_content.league[1].teams;
    const firstTeam = teams[0].team;
    console.log('Team name:', firstTeam[0].find(x => x?.name)?.name);
    // team stats usually at index 1
    console.log('Stats block:');
    console.log(JSON.stringify(firstTeam[1], null, 2));
  } catch (e) {
    console.log('Could not isolate first team block:', e.message);
  }
}

main().catch(err => { console.error('✗ Error:', err.message); process.exit(1); });
