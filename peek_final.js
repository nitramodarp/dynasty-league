// peek_final.js — confirms the last two unknowns:
//   1) transaction object structure (the broken filter is removed)
//   2) matchup top-level metadata (winner_team_key, is_tied, any MOTW flag)
// Run once, paste output, delete.

const CLIENT_ID = 'dj0yJmk9NEM2YjFSV255NlA3JmQ9WVdrOWQxTlJWVVZvUTJZbWNHbzlNQT09JnM9Y29uc3VtZXJzZWNyZXQmc3Y9MCZ4PWY5';
const REDIRECT  = 'https://localhost:3000/callback';
const LK = '469.l.3862';

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
  console.log('✓ token refreshed\n');
  return d.access_token;
}
async function yget(path, token) {
  const res = await fetch(`https://fantasysports.yahooapis.com/fantasy/v2${path}?format=json`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Yahoo ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const token = await getAccessToken();

  // ── PART 1: TRANSACTIONS (no type filter) ──
  console.log('========== TRANSACTIONS (count=15, no filter) ==========');
  const tx = await yget(`/league/${LK}/transactions;count=15`, token);
  const txBlock = tx.fantasy_content.league[1].transactions;
  console.log('count field:', txBlock.count);
  console.log('\n--- FIRST TRANSACTION ---');
  if (txBlock['0']) console.log(JSON.stringify(txBlock['0'], null, 2).slice(0, 4000));
  else console.log('no [0] key:', JSON.stringify(txBlock, null, 2).slice(0, 2000));
  console.log('\n--- SECOND TRANSACTION ---');
  if (txBlock['1']) console.log(JSON.stringify(txBlock['1'], null, 2).slice(0, 4000));

  // ── PART 2: MATCHUP METADATA ──
  const meta = await yget(`/league/${LK}`, token);
  const lastWeek = parseInt(meta.fantasy_content.league[0].current_week) - 1;
  console.log(`\n\n========== MATCHUP METADATA (week ${lastWeek}) ==========`);
  const sb = await yget(`/league/${LK}/scoreboard;week=${lastWeek}`, token);
  const matchup = sb.fantasy_content.league[1].scoreboard[0].matchups['0'].matchup;
  // Print ONLY the non-teams keys (the metadata we couldn't see before)
  console.log('All top-level keys of matchup object:', Object.keys(matchup));
  console.log('\nMetadata values (excluding the "0"/teams blob):');
  for (const k of Object.keys(matchup)) {
    if (k === '0') continue; // skip the teams blob
    console.log(`  ${k}:`, JSON.stringify(matchup[k]));
  }
}
main().catch(e => { console.error('✗', e.message); process.exit(1); });
