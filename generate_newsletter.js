// generate_newsletter.js
// Reads newsletter_context.md + data/newsletter_data.json, pulls current
// STANDINGS from the published Sheet (for power rankings), calls the Anthropic
// API, and writes the finished issue to data/newsletters/week_{N}.{md,txt}.

const fs = require('fs');

const SHEET_ID = '1FtMDNhzSpCgS2IdOFs4SHO7-IHoG6uAsK-UGA2NCSAs';
const STANDINGS_CSV = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=STANDINGS`;
const PLAYERS_CSV  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=PLAYERS`;
const SETTINGS_CSV = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=SETTINGS`;
const HISTORY_DIR  = './data/salary_history';

function parseCSV(t) {
  const lines = t.trim().split('\n');
  const split = (line) => {
    const r = []; let c = '', q = false;
    for (const ch of line) {
      if (ch === '"') { q = !q; continue; }
      if (ch === ',' && !q) { r.push(c); c = ''; continue; }
      c += ch;
    }
    r.push(c); return r;
  };
  const H = split(lines[0]);
  return lines.slice(1).map(l => {
    const v = split(l); const o = {};
    H.forEach((h, i) => o[h.trim()] = (v[i] || '').trim());
    return o;
  });
}

async function getStandings() {
  try {
    const res = await fetch(STANDINGS_CSV);
    const rows = parseCSV(await res.text());
    // Tolerant of column naming. rank is trusted from the sheet (it carries
    // Yahoo's real tiebreakers); w/l/t are used for the playoff math.
    return rows
      .filter(r => Object.values(r).some(v => v))
      .map(r => ({
        name: r.team_name || r.team || r.name || '',
        rank: parseInt(r.rank || r.Rank || r.seed || '', 10) || null,
        w: parseInt(r.wins || r.W || r.w || '0', 10) || 0,
        l: parseInt(r.losses || r.L || r.l || '0', 10) || 0,
        t: parseInt(r.ties || r.T || r.t || '0', 10) || 0,
      }))
      .filter(r => r.name);
  } catch (e) {
    console.log('  (standings fetch failed, power rankings will lean on matchup data):', e.message);
    return [];
  }
}

function standingsLines(rows) {
  if (!rows.length) return '(standings unavailable this run)';
  return [...rows]
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    .map(r => `${r.rank ?? '?'}. ${r.name} (${r.w}-${r.l}-${r.t})`)
    .join('\n');
}

// ── Salary layer: payroll, value awards, and the week-over-week ticker ──
// Numbers are FINAL here. The model only reproduces these blocks and adds color;
// it never computes a dollar figure (LLMs miscount). The ticker needs last
// week's prices, so we snapshot every run to data/salary_history/week_N.json.
async function fetchCsvRows(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CSV ${res.status}`);
  return parseCSV(await res.text());
}

function snum(v, d = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

function progressiveTax(over, S) {
  if (over <= 0) return 0;
  const bp = snum(S.tax_breakpoint, 50), r1 = snum(S.tax_rate_tier1, 1.15), r2 = snum(S.tax_rate_tier2, 2);
  const t1 = Math.min(over, bp) / 10 * r1;
  const t2 = Math.max(0, over - bp) / 10 * r2;
  return Math.round((t1 + t2) * 2) / 2;
}

// Most recent snapshot for a week strictly before `week` (robust to gaps).
function loadPrevSnapshot(week) {
  try {
    if (!fs.existsSync(HISTORY_DIR)) return null;
    const weeks = fs.readdirSync(HISTORY_DIR)
      .map(f => (f.match(/^week_(\d+)\.json$/) || [])[1])
      .filter(Boolean).map(Number).filter(w => w < week)
      .sort((a, b) => b - a);
    if (!weeks.length) return null;
    return (JSON.parse(fs.readFileSync(`${HISTORY_DIR}/week_${weeks[0]}.json`, 'utf8')).prices) || null;
  } catch (e) { return null; }
}

function saveSnapshot(week, prices) {
  try {
    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(`${HISTORY_DIR}/week_${week}.json`,
      JSON.stringify({ week, prices, savedAt: new Date().toISOString() }, null, 2));
  } catch (e) { console.log('  (salary snapshot write failed):', e.message); }
}

function rpad(v, n) { v = String(v); return v.length >= n ? v : v + ' '.repeat(n - v.length); }

async function buildSalaryLayer(standingsRows, week) {
  const [players, settingsRows] = await Promise.all([
    fetchCsvRows(PLAYERS_CSV), fetchCsvRows(SETTINGS_CSV),
  ]);
  const S = {};
  settingsRows.forEach(r => { if (r.Key) S[r.Key] = r.Value; });
  const cap = snum(S.cap_threshold, 360);
  const money = n => `$${n}M`;
  // Single source of truth for a player's salary — mirrors the website exactly.
  // Blank current_salary (IL/unscored) falls back to base_salary, then $3M floor.
  const salOf = p => snum(p.current_salary) || snum(p.base_salary) || 3;

  // Aggregate payroll + IL salary per team; capture every player's current price.
  const teams = {}, prices = {};
  players.forEach(p => {
    const id = p.player_id, team = p.fantasy_team_name;
    const sal = salOf(p);
    if (id) prices[id] = sal;
    if (!team) return;
    const t = teams[team] || (teams[team] = { name: team, payroll: 0, il: 0 });
    t.payroll += sal;
    if ((p.roster_slot || '').toUpperCase() === 'IL') t.il += sal;
  });

  // Efficiency (wins per $100M), tax, and rebate.
  const winByName = {};
  standingsRows.forEach(r => { winByName[r.name] = r.w; });
  const teamList = Object.values(teams);
  teamList.forEach(t => {
    t.wins = winByName[t.name] != null ? winByName[t.name] : 0;
    t.winsPer100M = t.payroll > 0 ? Math.round((t.wins / (t.payroll / 100)) * 10) / 10 : 0;
    t.room = Math.max(0, cap - t.payroll);
    t.tax = progressiveTax(Math.max(0, t.payroll - cap), S);
  });
  const totalTax = teamList.reduce((s, t) => s + t.tax, 0);
  const totalRoom = teamList.reduce((s, t) => s + t.room, 0);
  teamList.forEach(t => {
    t.rebate = (totalRoom > 0 && t.room > 0) ? Math.round(totalTax * (t.room / totalRoom) * 100) / 100 : 0;
  });

  // Week-over-week deltas vs the previous snapshot.
  const prev = loadPrevSnapshot(week);
  const hasBaseline = !!prev;
  const moves = [];
  if (hasBaseline) {
    players.forEach(p => {
      const id = p.player_id;
      if (!id || !(id in prev)) return;
      const to = salOf(p), from = snum(prev[id], 0), delta = to - from;
      if (delta !== 0) moves.push({ name: p.player_name, team: p.fantasy_team_name || '—', from, to, delta });
    });
  }
  const byMag = (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.to - a.to;
  const risers  = moves.filter(m => m.delta > 0).sort(byMag).slice(0, 5);
  const fallers = moves.filter(m => m.delta < 0).sort(byMag).slice(0, 5);

  // Awards.
  const ranked = teamList.filter(t => t.payroll > 0);
  let moneyball = null, sucker = null, deadMoney = null;
  ranked.forEach(t => {
    if (!moneyball || t.winsPer100M > moneyball.winsPer100M) moneyball = t;
    if (!sucker    || t.winsPer100M < sucker.winsPer100M)    sucker = t;
  });
  teamList.forEach(t => { if (!deadMoney || t.il > deadMoney.il) deadMoney = t; });
  let hero = null, ghost = null;
  moves.forEach(m => {
    if (m.from <= 3 && m.delta > 0 && (!hero  || m.delta > hero.delta))  hero  = m;
    if (m.from >= 40 && m.delta < 0 && (!ghost || m.delta < ghost.delta)) ghost = m;
  });

  saveSnapshot(week, prices); // persist for next week's diff

  // ── Deterministic render blocks ──
  let ticker;
  if (!hasBaseline) {
    ticker = `SALARY STOCK TICKER — WEEK ${week}\n(baseline set this week — price movement starts next issue.)`;
  } else if (!risers.length && !fallers.length) {
    ticker = `SALARY STOCK TICKER — WEEK ${week}\nNo tier changes this week. The market held.`;
  } else {
    const line = m => `  ${rpad(m.name, 20)} ${rpad(money(m.from) + ' -> ' + money(m.to), 16)} ${m.delta > 0 ? '▲' : '▼'} ${money(Math.abs(m.delta))}   ${m.team}`;
    ticker = `SALARY STOCK TICKER — WEEK ${week}\n(prices move with production; this is who re-rated)\n\n`
      + (risers.length  ? `RISERS ▲\n${risers.map(line).join('\n')}\n\n`  : '')
      + (fallers.length ? `FALLERS ▼\n${fallers.map(line).join('\n')}` : '');
  }

  const awards = [];
  if (moneyball) awards.push(`The Moneyball Award — ${moneyball.name}: ${moneyball.winsPer100M} wins per $100M (${money(moneyball.payroll)} payroll, ${moneyball.wins} wins)`);
  if (sucker && sucker !== moneyball) awards.push(`The Salary-Cap Sucker — ${sucker.name}: ${sucker.winsPer100M} wins per $100M (${money(sucker.payroll)} payroll, ${sucker.wins} wins)`);
  if (deadMoney && deadMoney.il > 0) awards.push(`Dead Money — ${deadMoney.name}: ${money(deadMoney.il)} of salary on the IL`);
  if (hero)  awards.push(`The $3M Hero — ${hero.name} (${hero.team}): up ${money(hero.delta)} this week`);
  if (ghost) awards.push(`The $40M Ghost — ${ghost.name} (${ghost.team}): down ${money(Math.abs(ghost.delta))} this week`);
  const awardsBlock = awards.length ? `THIS WEEK IN VALUE\n${awards.map(a => '  - ' + a).join('\n')}` : '';

  console.log(`✓ Salary layer: ${teamList.length} teams, ${moves.length} price moves, baseline=${hasBaseline}`);
  return { ticker, awardsBlock };
}

function describeMatchup(m) {
  const tie = m.tiedCats.length ? ` Tied: ${m.tiedCats.join(', ')}.` : '';
  return `${m.winner} def. ${m.loser}, ${m.score}. ` +
    `${m.winner} took: ${m.winnerCats.join(', ') || '—'}. ` +
    `${m.loser} took: ${m.loserCats.join(', ') || '—'}.${tie}`;
}

function fmtEt(ts) {
  // Readable Eastern timestamp so the model can anchor real sequence.
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ts * 1000));
}

function describeTransactions(txns) {
  if (!txns.length) return 'No transactions during the week.';
  // Yahoo returns transactions newest-first. Without sorting, the recap
  // describes a drop before the add that preceded it (e.g. "dropped Shota,
  // added Shota" when he was added at 11:42 then dropped at 11:43). Sort
  // oldest-first and stamp each line so sequence is unambiguous.
  const ordered = [...txns].sort((a, b) => a.timestamp - b.timestamp);
  return ordered.map(t => {
    if (t.type === 'trade') {
      // Group by receiving team: "TeamA receives X (POS, MLB) from TeamB"
      const byDest = {};
      t.moves.forEach(mv => {
        const dest = mv.destTeam || 'Unknown team';
        (byDest[dest] = byDest[dest] || []).push(mv);
      });
      const sides = Object.entries(byDest).map(([dest, mvs]) => {
        const src = mvs[0].sourceTeam || 'another team';
        const players = mvs.map(mv => `${mv.name} (${mv.pos}, ${mv.mlb})`).join(', ');
        return `${dest} receives ${players} from ${src}`;
      });
      return `[${fmtEt(t.timestamp)}] TRADE: ${sides.join('; ')}`;
    }
    const parts = t.moves.map(mv =>
      `${mv.action === 'add' ? 'added' : 'dropped'} ${mv.name} (${mv.pos}, ${mv.mlb})`);
    const team = t.moves[0]?.team || 'A team';
    return `[${fmtEt(t.timestamp)}] ${team}: ${parts.join('; ')}`;
  }).join('\n');
}

// ── Playoff picture ──────────────────────────────────────────────────
// Regular season = weeks 1–22; playoffs = weeks 23–25 (end Sun Sep 20).
// Top 6 of 12 qualify, seeded strictly by overall standings (divisions do
// NOT affect playoff seeding under this league's setting). Clinch/elimination
// use a conservative worst-case bound — effective wins (W + ½T, matching
// win%-style ranking), each remaining week worth at most one win. The tests
// use strict comparisons so the section NEVER declares CLINCHED or ELIMINATED
// unless it is mathematically certain regardless of tiebreakers. It will stay
// silent rather than guess.
const REG_SEASON_WEEKS = 22;
const PLAYOFF_SPOTS = 6;

function fmtGames(n) {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function describePlayoffPicture(rows, recapWeek, catsPerWeek) {
  const teams = rows.filter(r => r.rank != null).sort((a, b) => a.rank - b.rank);
  if (teams.length < PLAYOFF_SPOTS + 1) {
    return '(standings incomplete — playoff picture skipped this run)';
  }
  // Standings are cumulative CATEGORY records, so each remaining week is worth
  // up to catsPerWeek decisions (≈10), NOT one. Using weeks alone here made a
  // mid-season lead look insurmountable and triggered false clinch/elimination.
  const weeksLeft = Math.max(0, REG_SEASON_WEEKS - recapWeek);
  const remaining = weeksLeft * (catsPerWeek || 10);
  const eff   = r => r.w + 0.5 * r.t;       // effective category wins (tie = half)
  const ceil  = r => eff(r) + remaining;    // best case: win every remaining category
  const floor = r => eff(r);                // worst case: lose every remaining category
  const seed6 = teams[PLAYOFF_SPOTS - 1];
  const seed7 = teams[PLAYOFF_SPOTS];

  const out = [];
  out.push(`Format: top ${PLAYOFF_SPOTS} of ${teams.length} make the playoffs (weeks 23–25, ends Sun Sep 20). Seeding strictly by overall standings — divisions do not affect seeding. Bracket reseeds each round.`);
  out.push(`Through week ${recapWeek} of ${REG_SEASON_WEEKS}: ${weeksLeft} regular-season week${weeksLeft === 1 ? '' : 's'} left (~${remaining} category decisions still to play). Records below are cumulative category wins.`);
  out.push('');

  teams.forEach((r, i) => {
    const seed = i + 1;
    const above = seed <= PLAYOFF_SPOTS;
    let tag;
    if (weeksLeft === 0) {
      tag = above ? 'IN — locked (regular season complete)' : 'OUT — missed the playoffs';
    } else {
      const threats = teams.filter(u => u !== r && ceil(u) >= floor(r)).length;
      const clinched = threats <= PLAYOFF_SPOTS - 1;
      const locks = teams.filter(u => u !== r && floor(u) > ceil(r)).length;
      const eliminated = locks >= PLAYOFF_SPOTS;
      if (clinched && above) {
        tag = 'CLINCHED a playoff berth';
      } else if (eliminated) {
        tag = 'ELIMINATED from contention';
      } else if (above) {
        const cushion = eff(r) - eff(seed7);
        tag = `IN — ${fmtGames(cushion)} clear of the cut line`;
      } else {
        const back = eff(seed6) - eff(r);
        tag = back <= 0 ? 'OUT — tied at the cut line' : `OUT — ${fmtGames(back)} back of the 6th seed`;
      }
    }
    if (seed === PLAYOFF_SPOTS + 1) out.push('——— playoff cut line ———');
    out.push(`${seed}. ${r.name} (${r.w}-${r.l}-${r.t}) — ${tag}`);
  });

  return out.join('\n');
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const context = fs.readFileSync('./newsletter_context.md', 'utf8');
  const data = JSON.parse(fs.readFileSync('./data/newsletter_data.json', 'utf8'));
  console.log(`✓ Generating week ${data.week}: ${data.matchups.length} matchups, ${data.transactions.length} txns`);

  const standingsRows = await getStandings();
  const standings = standingsLines(standingsRows);
  // Categories per week = total categories decided in a matchup (won + lost + tied).
  // Drives how much movement remains; falls back to 10 if matchup data is thin.
  const m0 = data.matchups && data.matchups[0];
  const catsPerWeek = m0
    ? (m0.winnerCats.length + m0.loserCats.length + m0.tiedCats.length) || 10
    : 10;
  const playoffPicture = describePlayoffPicture(standingsRows, data.week, catsPerWeek);

  let salaryTicker = '', salaryAwards = '';
  try {
    const sl = await buildSalaryLayer(standingsRows, data.week);
    salaryTicker = sl.ticker;
    salaryAwards = sl.awardsBlock;
  } catch (e) {
    console.log('  (salary layer failed — ticker/awards skipped):', e.message);
  }

  const motw = data.matchupOfTheWeek
    ? `${data.matchupOfTheWeek.winner} def. ${data.matchupOfTheWeek.loser}, ${data.matchupOfTheWeek.score}`
    : '(none flagged by Yahoo this week)';

  const prompt = `You are writing the weekly newsletter for a fantasy baseball league.
Study the VOICE SPEC and the CONTEXT's gold-standard sample below, then write
THIS week's issue using ONLY the data provided. Match the structure, length, and
joke density of the sample, and follow the VOICE SPEC exactly.

=== VOICE SPEC ===
Register: mock-formal deadpan. Narrate trivial fantasy-baseball events with the
composed, slightly elevated diction of someone writing internal-memo minutes —
then puncture it. Think Ian Frazier's straight-faced elevation of the mundane
and the Onion's deadpan institutional authority. Dry, literate, confident. Being
funny is the point; accuracy is the floor, not the goal.

How the comedy works — VARY THE DEVICE. Rotate through several; never run the
same move twice in a row (illustrations only, do NOT reuse these lines):
  • Understatement / anticlimax — "second place has feelings too."
  • Mock-bureaucratic procedure — "We have reviewed this and can confirm it is
    accurate."
  • The confident absurd verdict stated as settled fact — "Eighth seems right."
  • The committed opinion that owns its own flaw — "A reasonable response. Wrong
    response, probably, but reasonable."
  • An occasional dry meta-aside about the newsletter itself.

The short clipped kicker is ONE tool, not the structure. MOST paragraphs should
NOT end on a clipped deflation. If every section lands on the same little
deadpan beat, the rhythm becomes a tic and the jokes die because the reader sees
them coming. Surprise beats consistency. Take a genuine swing once or twice per
issue and COMMIT to the bolder joke instead of hedging it.

Trust your lines. Never explain or soften a joke with a follow-up clause (cut
the "and mostly did" that defuses "a week that should have felt like progress").
Land it and move on. Give the single best joke in a section room to breathe
rather than burying it mid-paragraph; let a flat, factual sentence sit there
unjoked when that's funnier than forcing one.

Reference well: contemporary and mundane — corporate, suburban, administrative,
procedural. No classical, literary, historical, or philosophical allusions and
no Latin. Elevated diction is welcome; ornate sentences built to impress are not.

Stance: fond but unillusioned — affectionate, never cruel, no moral weight, no
profundity for its own sake. No hype words, exclamation points, emoji, or
fantasy-bro slang.

=== CONTEXT & VOICE GUIDE ===
${context}

=== THIS WEEK'S DATA — Week ${data.week} (${data.weekStart} to ${data.weekEnd}) ===

MATCHUP OF THE WEEK (Yahoo's official designation):
${motw}

ALL MATCHUPS (winner, final category score, and which categories each side won):
${data.matchups.map((m, i) => `${i + 1}. ${describeMatchup(m)}`).join('\n')}

CURRENT STANDINGS (for Power Rankings — reflect these, don't invent positions):
${standings}

PLAYOFF PICTURE (top 6 make it; the data already states each team's exact status — use these facts, do not compute your own clinch/elimination):
${playoffPicture}

TRANSACTIONS THIS WEEK (for Questionable Activity — listed oldest-first with [Eastern timestamps]; respect this exact order):
${describeTransactions(data.transactions)}

SALARY STOCK TICKER (reproduce VERBATIM — every name, team, and dollar figure is final; do not alter or recompute):
${salaryTicker || '(salary data unavailable this run — omit this section)'}

VALUE AWARDS (reproduce each award line VERBATIM; you may add one dry line of color per award):
${salaryAwards || '(salary data unavailable this run — omit this section)'}

=== TASK ===
Write "40s and Blunts Weekly Rolling Coverage" for Week ${data.week}. Structure:

1. A title header line and a short dry subtitle for the week.
2. **MATCHUP OF THE WEEK** — a short dedicated paragraph on the matchup Yahoo
   flagged above. If none was flagged, skip this segment entirely.
3. **LAST WEEK'S RESULTS** — one short paragraph per matchup. Use the category
   breakdowns for specific, accurate detail. Let boring matchups be brief.
4. **POWER RANKINGS** — 1 through 12, one dry line each, ordered by the current
   standings above.
5. **PLAYOFF PICTURE** — a short segment on the top-6 race using ONLY the playoff
   data above. Name who's in, who's on the bubble, and the gap at the cut line.
   State CLINCHED/ELIMINATED only where the data explicitly says so — never infer
   it yourself. Early in the season (many weeks left), keep it brief and note
   it's early; late in the season, let the stakes show. Don't restate all 12 in a
   list — the Power Rankings already did that; write it as prose.
6. **QUESTIONABLE ACTIVITY** — wry notes on the week's real transactions above.
   If there were none, say so dryly. Do not invent moves. The transactions are
   in chronological order — describe add/drop sequences in the order they
   actually happened (an add-then-drop is not a drop-then-re-add).
7. **SALARY STOCK TICKER** — reproduce the ticker block above EXACTLY as given
   (names, teams, dollar figures verbatim, in a code block so it stays aligned).
   You may add one short deadpan line before or after it. If it says baseline was
   just set, keep the note that movement starts next week. If data is
   unavailable, omit the section entirely.
8. **THIS WEEK IN VALUE** — reproduce the award lines above; for each you may add
   one dry sentence of commentary, but never change a name, team, or number. Omit
   the section if data is unavailable.

HARD RULES:
- Use ONLY the data above. Never invent scores, categories, players, or moves.
- Don't reuse jokes from the sample — fresh observations for this week.
- Brother matchups worth a wink if they occur: Chief Noc-A-Homa & Stone Jack
  Ballers; Thurgood Jenkins & Bad MoFo's.
- Only reference a family/sibling relationship that is EXPLICITLY listed in the
  rule above. Never infer who is related from team names, owners, standings, or
  seeds, and never make aggregate claims like "the family owns the top seeds" or
  "the brothers swept the week" — if it isn't stated above, don't assert it.
- The Salary Stock Ticker and Value Awards figures are FINAL — reproduce every
  name, team, and dollar amount exactly; never recompute, round, or invent them.
- No closing footer or meta-commentary. End after THIS WEEK IN VALUE.
- Output clean Markdown.`;

  console.log('Calling Anthropic API...');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 3800,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const result = await res.json();
  const content = result.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!content) throw new Error('Empty response from API');
  console.log('✓ Newsletter generated');

  if (!fs.existsSync('./data/newsletters')) fs.mkdirSync('./data/newsletters', { recursive: true });
  fs.writeFileSync(`./data/newsletters/week_${data.week}.md`, content);

  // Plain-text version for easy WhatsApp/email paste
  const plain = content
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*[-*]\s+/gm, '• ');
  fs.writeFileSync(`./data/newsletters/week_${data.week}.txt`, plain);

  console.log(`✓ Saved week_${data.week}.md and .txt`);
  console.log('── Done ────────────────────────────────────────');
}

main().catch(err => { console.error('✗ Error:', err.message); process.exit(1); });
