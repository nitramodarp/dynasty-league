// generate_newsletter.js
// Reads newsletter_context.md + data/newsletter_data.json, pulls current
// STANDINGS from the published Sheet (for power rankings), calls the Anthropic
// API, and writes the finished issue to data/newsletters/week_{N}.{md,txt}.

const fs = require('fs');

const SHEET_ID = '1FtMDNhzSpCgS2IdOFs4SHO7-IHoG6uAsK-UGA2NCSAs';
const STANDINGS_CSV = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=STANDINGS`;

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
    // Expect columns like rank, team_name, wins, losses, ties (tolerant of naming)
    return rows
      .filter(r => Object.values(r).some(v => v))
      .map(r => {
        const name = r.team_name || r.team || r.name || '';
        const rank = r.rank || '';
        const w = r.wins || r.W || r.w || '';
        const l = r.losses || r.L || r.l || '';
        const t = r.ties || r.T || r.t || '';
        return `${rank}. ${name} (${w}-${l}-${t})`;
      })
      .filter(s => s.trim() !== '. ()')
      .join('\n');
  } catch (e) {
    console.log('  (standings fetch failed, power rankings will lean on matchup data):', e.message);
    return '(standings unavailable this run)';
  }
}

function describeMatchup(m) {
  const tie = m.tiedCats.length ? ` Tied: ${m.tiedCats.join(', ')}.` : '';
  return `${m.winner} def. ${m.loser}, ${m.score}. ` +
    `${m.winner} took: ${m.winnerCats.join(', ') || '—'}. ` +
    `${m.loser} took: ${m.loserCats.join(', ') || '—'}.${tie}`;
}

function describeTransactions(txns) {
  if (!txns.length) return 'No transactions during the week.';
  return txns.map(t => {
    const parts = t.moves.map(mv => `${t === null ? '' : ''}${mv.action === 'add' ? 'added' : 'dropped'} ${mv.name} (${mv.pos}, ${mv.mlb})`);
    const team = t.moves[0]?.team || 'A team';
    return `${team}: ${parts.join('; ')}`;
  }).join('\n');
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const context = fs.readFileSync('./newsletter_context.md', 'utf8');
  const data = JSON.parse(fs.readFileSync('./data/newsletter_data.json', 'utf8'));
  console.log(`✓ Generating week ${data.week}: ${data.matchups.length} matchups, ${data.transactions.length} txns`);

  const standings = await getStandings();

  const motw = data.matchupOfTheWeek
    ? `${data.matchupOfTheWeek.winner} def. ${data.matchupOfTheWeek.loser}, ${data.matchupOfTheWeek.score}`
    : '(none flagged by Yahoo this week)';

  const prompt = `You are writing the weekly newsletter for a fantasy baseball league.
Study the CONTEXT & VOICE GUIDE below — especially the gold-standard sample —
then write THIS week's issue using ONLY the data provided. Match the voice,
structure, length, and joke density of the sample exactly.

=== CONTEXT & VOICE GUIDE ===
${context}

=== THIS WEEK'S DATA — Week ${data.week} (${data.weekStart} to ${data.weekEnd}) ===

MATCHUP OF THE WEEK (Yahoo's official designation):
${motw}

ALL MATCHUPS (winner, final category score, and which categories each side won):
${data.matchups.map((m, i) => `${i + 1}. ${describeMatchup(m)}`).join('\n')}

CURRENT STANDINGS (for Power Rankings — reflect these, don't invent positions):
${standings}

TRANSACTIONS THIS WEEK (for Questionable Activity):
${describeTransactions(data.transactions)}

=== TASK ===
Write "40s and Blunts Weekly Rolling Coverage" for Week ${data.week}. Structure:

1. A title header line and a short dry subtitle for the week.
2. **MATCHUP OF THE WEEK** — a short dedicated paragraph on the matchup Yahoo
   flagged above. If none was flagged, skip this segment entirely.
3. **LAST WEEK'S RESULTS** — one short paragraph per matchup. Use the category
   breakdowns for specific, accurate detail. Let boring matchups be brief.
4. **POWER RANKINGS** — 1 through 12, one dry line each, ordered by the current
   standings above.
5. **QUESTIONABLE ACTIVITY** — wry notes on the week's real transactions above.
   If there were none, say so dryly. Do not invent moves.

HARD RULES:
- Use ONLY the data above. Never invent scores, categories, players, or moves.
- Don't reuse jokes from the sample — fresh observations for this week.
- Brother matchups worth a wink if they occur: Chief Noc-A-Homa & Stone Jack
  Ballers; Thurgood Jenkins & Bad MoFo's.
- No closing footer or meta-commentary. End after QUESTIONABLE ACTIVITY.
- Output clean Markdown.`;

  console.log('Calling Anthropic API...');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
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
