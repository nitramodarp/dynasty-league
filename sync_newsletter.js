// sync_newsletter.js
// Pulls last completed week's matchups (with category breakdowns, winner,
// matchup-of-the-week flag) + that week's transactions. Writes a complete
// JSON data file for the AI generator. Structure confirmed against live API.

const fs = require('fs');

const CLIENT_ID = 'dj0yJmk9NEM2YjFSV255NlA3JmQ9WVdrOWQxTlJWVVZvUTJZbWNHbzlNQT09JnM9Y29uc3VtZXJzZWNyZXQmc3Y9MCZ4PWY5';
const REDIRECT  = 'https://localhost:3000/callback';

const STAT_NAMES = {
  '7': 'R', '12': 'HR', '13': 'RBI', '16': 'SB', '55': 'OPS',
  '42': 'K', '26': 'ERA', '27': 'WHIP', '83': 'QS', '89': 'SV+H',
};

// ── Eastern wall-clock → Unix epoch (seconds) ────────────────────────
// Yahoo week_start/week_end are calendar dates ("YYYY-MM-DD"). The recap
// window is [weekStart 00:00:00, weekEnd 23:59:59] Eastern. We resolve the
// real America/New_York offset for the date (handles EST -05:00 vs EDT
// -04:00 — a hardcoded offset is wrong half the year) and THROW on any
// unparseable input. The throw is the point: the old code silently produced
// NaN bounds, and `ts < NaN || ts > NaN` is always false, which disabled the
// filter entirely and let every transaction through. Failing loud beats a
// recap that quietly includes the wrong week.
function nyOffsetMinutes(utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(
    dtf.formatToParts(new Date(utcMs)).filter(x => x.type !== 'literal').map(x => [x.type, x.value])
  );
  const wallAsUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((wallAsUTC - utcMs) / 60000); // EDT => -240, EST => -300
}

function easternEpoch(dateStr, timeStr) {
  const m = String(dateStr == null ? '' : dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`week window: cannot parse date ${JSON.stringify(dateStr)}`);
  const [, Y, Mo, D] = m;
  const [h, mi, s] = String(timeStr).split(':').map(Number);
  const naiveUTC = Date.UTC(+Y, +Mo - 1, +D, h, mi, s);
  const off = nyOffsetMinutes(naiveUTC);
  let ms = naiveUTC - off * 60000;
  const off2 = nyOffsetMinutes(ms);            // stabilize across a DST edge
  if (off2 !== off) ms = naiveUTC - off2 * 60000;
  if (!Number.isFinite(ms)) throw new Error(`week window: non-finite epoch for ${dateStr} ${timeStr}`);
  return Math.floor(ms / 1000);
}

async function getAccessToken() {
  const rt = process.env.YAHOO_REFRESH_TOKEN;
  if (!rt) throw new Error('YAHOO_REFRESH_TOKEN not set');
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: rt,
    client_id: CLIENT_ID, redirect_uri: REDIRECT,
  }).toString();
  const res = await fetch('https://api.login.yahoo.com/oauth2/get_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const d = await res.json();
  if (d.error) throw new Error(`Token: ${d.error_description || d.error}`);
  console.log('✓ Access token refreshed');
  return d.access_token;
}

async function yget(path, token) {
  const res = await fetch(`https://fantasysports.yahooapis.com/fantasy/v2${path}?format=json`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Yahoo ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getLeagueKey(token) {
  const data = await yget('/users;use_login=1/games;game_keys=mlb/leagues', token);
  const league = data.fantasy_content.users[0].user[1].games[0].game[1].leagues[0].league[0];
  console.log(`✓ League: ${league.name} (${league.league_key})`);
  return league.league_key;
}

// Parse a team's weekly stat totals (the team_stats block)
function parseTeamStats(statsArr) {
  const out = {};
  if (!statsArr) return out;
  for (const s of statsArr) {
    const st = s.stat;
    if (st && STAT_NAMES[st.stat_id]) out[STAT_NAMES[st.stat_id]] = st.value;
  }
  return out;
}

function teamInfo(teamArr) {
  // teamArr[0] is an array of info objects; teamArr[1] holds stats/points
  const info = teamArr[0];
  const name = info.find(x => x && x.name)?.name || 'Unknown';
  const key  = info.find(x => x && x.team_key)?.team_key || '';
  const stats = parseTeamStats(teamArr[1]?.team_stats?.stats);
  return { name, key, stats };
}

async function fetchMatchups(leagueKey, token) {
  const meta = await yget(`/league/${leagueKey}`, token);
  const currentWeek = parseInt(meta.fantasy_content.league[0].current_week);
  const lastWeek = currentWeek - 1;
  console.log(`✓ Current week ${currentWeek} → recapping week ${lastWeek}`);

  const sb = await yget(`/league/${leagueKey}/scoreboard;week=${lastWeek}`, token);
  const scoreboard = sb.fantasy_content.league[1].scoreboard[0];
  const matchupsRaw = scoreboard.matchups;
  const count = matchupsRaw.count;

  let weekStart = null, weekEnd = null;
  const matchups = [];
  let matchupOfTheWeek = null;

  for (let i = 0; i < count; i++) {
    const m = matchupsRaw[String(i)].matchup;
    if (!weekStart) { weekStart = m.week_start; weekEnd = m.week_end; }

    const teams = m['0'].teams;
    const t0 = teamInfo(teams['0'].team);
    const t1 = teamInfo(teams['1'].team);

    // Category winners from stat_winners
    const cats0 = [], cats1 = [], tiedCats = [];
    for (const sw of (m.stat_winners || [])) {
      const s = sw.stat_winner;
      const nm = STAT_NAMES[s.stat_id];
      if (!nm) continue;
      if (s.is_tied === 1 || s.is_tied === '1') tiedCats.push(nm);
      else if (s.winner_team_key === t0.key) cats0.push(nm);
      else if (s.winner_team_key === t1.key) cats1.push(nm);
    }

    const isTied = (m.is_tied === 1 || m.is_tied === '1');
    const isMOTW = (m.is_matchup_of_the_week === '1' || m.is_matchup_of_the_week === 1);

    let winner, loser, winnerCats, loserCats, winnerStats, loserStats;
    if (isTied) {
      // No true winner — present in stored order
      winner = t0.name; loser = t1.name;
      winnerCats = cats0; loserCats = cats1;
      winnerStats = t0.stats; loserStats = t1.stats;
    } else if (m.winner_team_key === t0.key) {
      winner = t0.name; loser = t1.name;
      winnerCats = cats0; loserCats = cats1;
      winnerStats = t0.stats; loserStats = t1.stats;
    } else {
      winner = t1.name; loser = t0.name;
      winnerCats = cats1; loserCats = cats0;
      winnerStats = t1.stats; loserStats = t0.stats;
    }

    const w = winnerCats.length, l = loserCats.length, t = tiedCats.length;
    const score = t > 0 ? `${w}-${l}-${t}` : `${w}-${l}`;

    const entry = {
      winner, loser, score, isTied,
      isMatchupOfTheWeek: isMOTW,
      winnerCats, loserCats, tiedCats,
      winnerStats, loserStats,
    };
    matchups.push(entry);
    if (isMOTW) matchupOfTheWeek = entry;

    console.log(`  ${isMOTW ? '★ ' : '  '}${winner} def. ${loser}, ${score}`);
  }

  return { week: lastWeek, weekStart, weekEnd, matchups, matchupOfTheWeek };
}

async function fetchTransactions(leagueKey, token, weekStart, weekEnd) {
  // No type filter (the comma-list filter silently returns nothing). Pull a
  // generous count and filter to the recap week by timestamp (Eastern bounds).
  const data = await yget(`/league/${leagueKey}/transactions;count=50`, token);
  const txBlock = data.fantasy_content.league[1].transactions || {};
  const count = txBlock.count || 0;

  // Strict Eastern bounds. easternEpoch throws on bad input so a malformed
  // week_start/week_end can never collapse into NaN and silently disable the
  // filter (the original bug: NaN bounds => every transaction passed through).
  const startTs = easternEpoch(weekStart, '00:00:00');
  const endTs   = easternEpoch(weekEnd,   '23:59:59');
  console.log(`  Window [${weekStart} 00:00 → ${weekEnd} 23:59 ET]  ts ${startTs}–${endTs}`);

  const txns = [];
  for (let i = 0; i < count; i++) {
    try {
      const tr = txBlock[String(i)].transaction;
      const head = tr[0];
      if (head.status !== 'successful') continue;
      const ts = parseInt(head.timestamp);
      if (!Number.isFinite(ts) || ts < startTs || ts > endTs) continue;

      const playersObj = tr[1].players;
      const pcount = playersObj.count || 0;
      const moves = [];
      for (let j = 0; j < pcount; j++) {
        const p = playersObj[String(j)].player;
        const info = p[0];
        const name = info.find(x => x && x.name)?.name?.full || 'Unknown';
        const pos  = info.find(x => x && x.display_position)?.display_position || '';
        const mlb  = info.find(x => x && x.editorial_team_abbr)?.editorial_team_abbr || '';
        const tdArr = p[1].transaction_data;
        const td = Array.isArray(tdArr) ? tdArr[0] : tdArr;
        moves.push({
          name, pos, mlb,
          action: td.type, // 'add', 'drop', or 'trade'
          team: td.destination_team_name || td.source_team_name || '',
          sourceTeam: td.source_team_name || '',
          destTeam: td.destination_team_name || '',
        });
      }
      txns.push({ type: head.type, timestamp: ts, moves });
    } catch (e) {
      // Skip malformed transaction rather than crash the run
      console.log(`  (skipped a transaction: ${e.message})`);
    }
  }

  console.log(`✓ Transactions in week window: ${txns.length}`);
  return txns;
}

async function main() {
  console.log('── sync_newsletter.js ──────────────────────────');
  const token = await getAccessToken();
  const leagueKey = await getLeagueKey(token);
  const mu = await fetchMatchups(leagueKey, token);
  const txns = await fetchTransactions(leagueKey, token, mu.weekStart, mu.weekEnd);

  const output = {
    week: mu.week,
    weekStart: mu.weekStart,
    weekEnd: mu.weekEnd,
    matchups: mu.matchups,
    matchupOfTheWeek: mu.matchupOfTheWeek,
    transactions: txns,
    generatedAt: new Date().toISOString(),
  };

  if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
  fs.writeFileSync('./data/newsletter_data.json', JSON.stringify(output, null, 2));
  console.log(`✓ Wrote data/newsletter_data.json (week ${output.week}, ${output.matchups.length} matchups, ${txns.length} txns)`);
  console.log('── Done ────────────────────────────────────────');
}

main().catch(err => { console.error('✗ Error:', err.message); process.exit(1); });
