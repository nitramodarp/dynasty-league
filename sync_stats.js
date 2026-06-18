// sync_stats.js
// PHASE A of the category-VORP rebuild.
// Pulls each rostered player's SEASON actuals for all 10 league categories
// from Yahoo and writes them to a raw STATS tab. This is the foundation the
// category-VORP scoring (Phase B) will consume — it's what finally puts SB,
// SV+H, QS, and counting-stat volume into the salary engine.
//
// Auth mirrors the existing scripts exactly:
//   - Yahoo:  YAHOO_REFRESH_TOKEN  (same as sync_standings.js)
//   - Sheets: GOOGLE_KEY_JSON      (same as savant_dynz.js)
//
// FIRST-RUN BEHAVIOUR: this script logs a diagnostic block to the Actions log
// (the stat-id map it built, any categories it could NOT map, and a sample
// player's raw + parsed stats). Yahoo's JSON shape is finicky and untestable
// from outside, so run it once, paste the diagnostic lines back, and we fix
// any alias/parse mismatch in one pass. It still writes whatever it parses.

const { google } = require('googleapis');

const CLIENT_ID = 'dj0yJmk9NEM2YjFSV255NlA3JmQ9WVdrOWQxTlJWVVZvUTJZbWNHbzlNQT09JnM9Y29uc3VtZXJzZWNyZXQmc3Y9MCZ4PWY5';
const REDIRECT  = 'https://localhost:3000/callback';
const SHEET_ID  = '1FtMDNhzSpCgS2IdOFs4SHO7-IHoG6uAsK-UGA2NCSAs';
const SCOPES    = ['https://www.googleapis.com/auth/spreadsheets'];

// Canonical category keys → the Yahoo stat names/abbreviations they might appear
// as. We resolve stat_ids from the league SETTINGS at runtime (never hardcode an
// id — Yahoo ids are game-specific and rotate each season). If a category fails
// to map, the diagnostic block will flag it and we add the alias here.
const CAT_ALIASES = {
  R:    ['r', 'runs'],
  HR:   ['hr', 'home runs'],
  RBI:  ['rbi', 'runs batted in'],
  SB:   ['sb', 'stolen bases'],
  OPS:  ['ops', 'on-base + slugging', 'on base plus slugging'],
  K:    ['k', 'so', 'strikeouts', 'strikeouts (pitcher)'],
  ERA:  ['era', 'earned run average'],
  WHIP: ['whip', 'walks + hits / innings pitched'],
  QS:   ['qs', 'quality starts'],
  SVH:  ['sv+h', 'svh', 's+h', 'saves + holds', 'saves plus holds', 'sv+hld', 'sv + h'],
  // sample-size fields (not scoring cats, but needed for the Phase D sample gate).
  // This league has no PA stat — it exposes H/AB instead, so we derive AB
  // (the denominator) as the hitter sample. IP is the pitcher sample.
  HAB:  ['h/ab'],
  IP:   ['ip', 'innings pitched', 'innings'],
};

// Column order for the STATS tab (header must match — see deploy notes).
const OUT_COLS = ['player_id','player_name','R','HR','RBI','SB','OPS','K','ERA','WHIP','QS','SVH','AB','IP'];

// ── YAHOO AUTH (mirrors sync_standings.js) ──────────────────────────────────
async function getAccessToken() {
  const refreshToken = process.env.YAHOO_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('YAHOO_REFRESH_TOKEN env var not set');
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: refreshToken,
    client_id: CLIENT_ID, redirect_uri: REDIRECT,
  }).toString();
  const res  = await fetch('https://api.login.yahoo.com/oauth2/get_token', {
    method: 'POST',
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

// ── SHEETS (mirrors savant_dynz.js GOOGLE_KEY_JSON pattern) ──────────────────
function getSheetsClient() {
  const keyJsonStr = process.env.GOOGLE_KEY_JSON;
  if (!keyJsonStr) throw new Error('GOOGLE_KEY_JSON not set');
  const keyJson = JSON.parse(keyJsonStr);
  const auth = new google.auth.GoogleAuth({ credentials: keyJson, scopes: SCOPES });
  return google.sheets({ version: 'v4', auth });
}
async function getRange(sheets, range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return res.data.values || [];
}

// ── PARSE HELPERS (Yahoo's JSON is arrays-of-objects-with-numeric-keys) ──────
// Walk an array of small objects and return the first value found for `field`.
function pluck(arr, field) {
  if (!Array.isArray(arr)) return undefined;
  for (const item of arr) {
    if (item && typeof item === 'object' && field in item) return item[field];
  }
  return undefined;
}

// Build { stat_id(string) -> canonicalKey } from the league settings response.
function buildStatMap(settingsJson) {
  // Settings live at league[1].settings[0].stat_categories.stats
  const league = settingsJson.fantasy_content.league;
  const stats  = league[1].settings[0].stat_categories.stats;
  const idToCat = {};
  const matchedCats = new Set();
  const allStats = [];

  for (const s of stats) {
    const st = s.stat;
    const id = String(st.stat_id);
    const name = (st.display_name || st.name || '').toLowerCase().trim();
    allStats.push({ id, name: st.display_name || st.name });
    for (const [cat, aliases] of Object.entries(CAT_ALIASES)) {
      if (aliases.includes(name)) { idToCat[id] = cat; matchedCats.add(cat); break; }
    }
  }

  // Diagnostic: what mapped, what didn't.
  console.log('── STAT MAP (from league settings) ──');
  allStats.forEach(s => console.log(`   id ${s.id.padStart(3)} = "${s.name}"  ${idToCat[s.id] ? '→ '+idToCat[s.id] : ''}`));
  const wanted = Object.keys(CAT_ALIASES);
  const missing = wanted.filter(c => !matchedCats.has(c));
  if (missing.length) {
    console.warn(`⚠  UNMAPPED categories: ${missing.join(', ')} — add the Yahoo name above to CAT_ALIASES.`);
  } else {
    console.log('✓ All 10 categories + PA + IP mapped.');
  }
  return idToCat;
}

// Parse one player node from a players;.../stats response into a stat object.
function parsePlayer(playerNode, idToCat) {
  // playerNode.player is [ metaArray, { player_stats: { stats: [...] } } ]
  const p = playerNode.player;
  const meta = p[0];
  const playerId = String(pluck(meta, 'player_id') ?? '');
  const nameObj  = pluck(meta, 'name');
  const fullName = (nameObj && nameObj.full) ? nameObj.full : '';
  const statsArr = (p[1] && p[1].player_stats && p[1].player_stats.stats) || [];

  const out = { player_id: playerId, player_name: fullName };
  for (const sWrap of statsArr) {
    const st = sWrap.stat;
    if (!st) continue;
    const cat = idToCat[String(st.stat_id)];
    if (cat) out[cat] = st.value;
  }
  // Derive hitter sample (AB) from the H/AB composite (e.g. "59/198" → 198).
  if (out.HAB && typeof out.HAB === 'string' && out.HAB.includes('/')) {
    const ab = parseInt(out.HAB.split('/')[1], 10);
    if (!isNaN(ab)) out.AB = ab;
  }
  delete out.HAB;
  return out;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('── sync_stats.js (Phase A) ──────────────────────');
  const token     = await getAccessToken();
  const leagueKey = await getLeagueKey(token);
  const gameKey   = leagueKey.split('.l.')[0];   // e.g. "458" from "458.l.12345"

  // 1) Resolve stat_id → category from settings
  const settings = await yahooGet(`/league/${leagueKey}/settings`, token);
  const idToCat  = buildStatMap(settings);

  // 2) Player list comes from the PLAYERS tab (guarantees STATS aligns 1:1)
  const sheets   = getSheetsClient();
  const playerRows = await getRange(sheets, 'PLAYERS!A2:B');
  const players = playerRows
    .map(r => ({ id: String(r[0] || '').trim(), name: (r[1] || '').trim() }))
    .filter(p => p.id && /^\d+$/.test(p.id)); // include high two-way ids (e.g. Ohtani pitcher 1000002); genuinely-bad ids get skipped by the per-batch fallback
  console.log(`✓ ${players.length} Yahoo player ids from PLAYERS tab`);

  // 3) Batch-fetch season stats (25 player_keys per call)
  const byId = {};
  const batches = chunk(players, 25);
  let firstDumpDone = false;
  for (let b = 0; b < batches.length; b++) {
    const keys = batches[b].map(p => `${gameKey}.p.${p.id}`).join(',');
    try {
      const resp = await yahooGet(`/league/${leagueKey}/players;player_keys=${keys}/stats;type=season`, token);
      const playersObj = resp.fantasy_content.league[1].players;
      const count = Number(playersObj.count || 0);
      for (let i = 0; i < count; i++) {
        const node = playersObj[i];
        if (!node) continue;
        const parsed = parsePlayer(node, idToCat);
        if (parsed.player_id) byId[parsed.player_id] = parsed;

        // First-player diagnostic dump (raw + parsed) so we can verify the shape
        if (!firstDumpDone) {
          console.log('── SAMPLE PLAYER (raw stats array) ──');
          console.log(JSON.stringify(node.player[1]?.player_stats?.stats || node.player, null, 1).slice(0, 1500));
          console.log('── SAMPLE PLAYER (parsed) ──');
          console.log(JSON.stringify(parsed));
          firstDumpDone = true;
        }
      }
      console.log(`  batch ${b + 1}/${batches.length}: parsed ${count}`);
    } catch (e) {
      // One invalid player_key 400s the whole batch. Recover the good ones by
      // retrying this batch a single player at a time, skipping the offender.
      console.warn(`  batch ${b + 1} failed (${e.message.slice(0, 70)}). Retrying individually...`);
      for (const p of batches[b]) {
        try {
          const r = await yahooGet(`/league/${leagueKey}/players;player_keys=${gameKey}.p.${p.id}/stats;type=season`, token);
          const po = r.fantasy_content.league[1].players;
          const node = po && po[0];
          if (node) {
            const parsed = parsePlayer(node, idToCat);
            if (parsed.player_id) byId[parsed.player_id] = parsed;
          }
        } catch (e2) {
          // ID didn't resolve in Yahoo's namespace (e.g. a Savant/MLBAM id got
          // into the PLAYERS row, as with Ohtani's batter entry). Self-heal:
          // look the player up by NAME, then store under the ORIGINAL PLAYERS id
          // so the STATS row still aligns. Strip any "(Batter)"/"(Pitcher)" tag.
          const q = p.name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
          try {
            const sr = await yahooGet(`/league/${leagueKey}/players;search=${encodeURIComponent(q)}/stats;type=season`, token);
            const po = sr.fantasy_content.league[1].players;
            const node = po && po[0];
            if (node) {
              const parsed = parsePlayer(node, idToCat);
              // keep the PLAYERS id/name so STATS stays keyed to your tab
              byId[p.id] = { ...parsed, player_id: p.id, player_name: p.name };
              console.log(`    ↻ recovered "${p.name}" via name search (PLAYERS id ${p.id})`);
            } else {
              console.warn(`    ✗ no name match for "${p.name}" (id ${p.id})`);
            }
          } catch (e3) {
            console.warn(`    ✗ skipping "${p.name}" (id ${p.id}): ${e3.message.slice(0, 50)}`);
          }
        }
      }
    }
  }

  // 4) Build rows in PLAYERS order, write to STATS tab
  const rows = players.map(p => {
    const s = byId[p.id] || {};
    return OUT_COLS.map(c => {
      if (c === 'player_id') return p.id;
      if (c === 'player_name') return p.name;
      return (s[c] === undefined || s[c] === null) ? '' : s[c];
    });
  });

  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: 'STATS!A2:N500' });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'STATS!A2',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  const matched = rows.filter(r => r.slice(2).some(v => v !== '')).length;
  console.log(`✓ STATS tab updated — ${rows.length} rows, ${matched} with stat data`);
  if (matched < rows.length * 0.5) {
    console.warn('⚠  Fewer than half the players got stats — check the SAMPLE PLAYER dump and stat map above.');
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
