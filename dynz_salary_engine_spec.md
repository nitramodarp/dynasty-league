# DYN Z Salary Engine — Formula Spec (Current-Value)

**Purpose:** Compute each player's salary from *current value only*. No forward-looking
age discount in the salary path — aging lives in the trade lens, where Joe's information
advantage belongs.

**Core principle:** One engine, two lenses, mapped onto columns the Sheet already produces.

| Lens | Column | Formula | Use |
|---|---|---|---|
| **Salary (current value)** | `rawZ` (col 16) | pure category-VORP z, **no age factor** | drives salary tier |
| **Trade (forward value)** | `dynZ` (col 18) | `rawZ × ageFactor × pitchAdj` | owner-facing valuation only |

The salary engine consumes `rawZ`. The age/skill-curve research from this session
attaches to `ageFactor` in the trade lens and **never touches salary**.

---

## 1. Engine core

For each player `p`, for each of their 5 scoring categories `c`:

```
blendedValue[c]  = sampleGatedBlend( actual[c], expected[c], projection[c] )   # §3
vor[c]           = blendedValue[c] - replacementLevel[c][positionGroup]         # §2
z[c]             = ( vor[c] - poolMean[c] ) / poolSD[c]                         # §4
                   # invert sign for "lower is better" cats: ERA, WHIP

rawZ(p)          = Σ z[c]   over the player's 5 categories      # SALARY input (col 16)
dynZ(p)          = rawZ(p) × ageFactor(p) × pitchAdj(p)         # TRADE input (col 16→18)
```

Hitters and pitchers are scored within their own pools and never z-scored against each other.

**League category order — CONFIRMED** from the Sheet's team-category-totals tab header:

| Hitting | R · HR · RBI · SB · OPS |
| Pitching | K · ERA · WHIP · QS · SV+H |

> **QS, not W** — confirmed; the tab header literally reads QS. QS is ratio-skill core
> (earned-run side) + a workload piece — see §3.

The per-player `stat1..stat5` columns the engine reads **do not live in the Google Sheet** —
the Sheet's PLAYERS tab stores only a finished `dyn_z` + `salary_tier` per player. The raw
per-category stats live in the **draft-data CSV in the GitHub repo** (parsed positionally by
`index.html`). The order above is canonical; still verify the repo CSV writes its columns in
exactly this order before coding — a transposed column silently corrupts every salary.

---

## 2. Replacement level (positional)

Value-over-replacement, not value-over-zero, so a scarce-position player and a deep-position
player aren't graded against the same bar.

```
N_startable[pos] = leagueTeams × startingSlots[pos]      # 12 × slots
replacementLevel[c][pos] = value of category c for the N_startable-th best
                           player at that position (the first guy off the startable cliff)
```

- Compute replacement **per category, per position group**, from the live player pool.
- For ratio cats (OPS, ERA, WHIP) replacement is the ratio at that rank, not a counting total.
- Catcher and SS will show high VOR because replacement is low there — that is correct and
  intended (positional scarcity is real value).

---

## 3. Per-category data blend + sample gate

Each category pulls its **best-available signal**, blended by sample size. Three inputs:
`actual` (Yahoo YTD / trailing), `expected` (Savant de-luck), `projection` (preseason / ROS).

**Sample gate** decides actual-vs-projection weight per player, per category:

```
w_actual   = clamp( sample / sampleFull , 0 , 1 )     # sample = PA (hitter) or IP/appearances (pitcher)
w_project  = 1 - w_actual
# established vet → w_actual ≈ 1 ; 50-PA rookie → w_project dominates (actuals are noise)
```

**Per-category construction:**

*Hitting*
| Cat | Core signal | De-luck (Savant) | Notes |
|---|---|---|---|
| OPS | actual OPS | **xwOBA / xOBP / xSLG** | de-luck is current, not forward — keep it |
| HR  | actual HR × proj PA for volume | barrels/PA, exit velo, max EV | EV erodes before HR — but that's a *trade* flag, not salary |
| R   | actual + projection | — (light: own OBP) | opportunity-driven, ~not a skill, don't over-model |
| RBI | actual + projection | — | same as R |
| SB  | actual SB + attempt rate (role/green light) | **sprint speed** | sprint speed = leading indicator; full weight in trade lens |

*Pitching*
| Cat | Core signal | De-luck (Savant) | Notes |
|---|---|---|---|
| ERA | **xERA / xwOBA-against** | barrel%- / hard-hit%-against | down-weight actual ERA (luck+defense laden) |
| WHIP| walk% + xBA-against | hard-hit%-against | walk rate is stable → WHIP holds |
| K   | whiff% / K% / putaway% × proj IP | — | velo is the decline flag (trade lens) |
| QS  | xERA + GB% (earned-run side) | — | innings side from Yahoo: **IP/start, recent QS rate** |
| SV+H| **Yahoo actual SV+H (YTD/trailing), sample-gated** | light reliever-quality nudge (whiff%, xERA) | data-only, no manual roles — the actuals *are* the role signal |

> **De-luck stays in salary; decline-prediction does not.** "Strip BABIP noise off what he's
> doing now" = current value. "His EV is dropping so HR will fall next year" = forward value →
> trade lens only.

---

## 4. Z-score + aggregation

```
for each category c in pool:
    poolMean[c], poolSD[c] = mean/sd of vor[c] across the (hitter|pitcher) pool
    z[c] = (vor[c] - poolMean[c]) / poolSD[c]
    if c in {ERA, WHIP}: z[c] = -z[c]      # lower is better

rawZ(p) = Σ z[c]        # sum, not mean → elite ≈ 5–8, not ~0.6
```

**Scale note — CORRECTED after reading the live Sheet.** Earlier I worried the salary score and
the tier thresholds were on different scales. They're not. The salary `dyn_z` in the PLAYERS tab
already sits on the tier scale: Mason Miller 2.96, Misiorowski 2.49, Trout 2.46, Judge 2.42
(all Star), Skenes 1.84 (Solid), CJ Abrams 0.77 (Depth), Emerson −1.50 (Min). That's consistent
with Elite ≥3.0 / Star 2–2.9 / etc. So the ≥3.0 thresholds are usable as-is — percentile cuts are
*optional*, not required. (The draft app's separate ~0.6-scale `dynZ` is a **different** number —
that's the two-DYN-Z divergence. Keep them separate; the salary path uses the Sheet-scale one.)
The real calibration question is in §5.

---

## 5. Tier mapping (salary)

Tiers from `dyn_z` (live Sheet thresholds, confirmed in SETTINGS):

```
Elite  : dyn_z ≥ 3.0   → $40M
Star   : 2.0 – 2.9     → $30M
Solid  : 1.0 – 1.9     → $20M
Depth  : 0.0 – 0.9     → $10M
Min    : < 0.0         → $3M floor
```

**Calibration question (real, straight from live data): nobody is currently Elite.** The top
score in the whole league is Mason Miller at 2.96, then Misiorowski 2.49, Trout 2.46, Judge 2.42
— all capping out as Star. The $40M Elite tier is effectively unreachable at the current scale.
Decide: leave it as a rare ceiling (intended — Elite should mean a true outlier), or lower the
Elite cut to ~2.7 so the best 3–5 assets in the league actually land at $40M. Tuning call, not a
code blocker.

- If thresholds are kept, lock them for the season so salaries don't wobble on every CSV refresh.
- Escalation (12%/yr, compounding on current tier), trade-reset-to-Year-1, and the cap are
  **downstream** of this number and unchanged by this spec.

**By-design consequence:** prospects grade cheap (small sample → near replacement → Depth/Min).
Correct for current-value (Emerson graded Min in April). Upside you haven't banked isn't taxed —
that's the edge.

---

## 6. Open items / things to tune

1. **Confirm per-player stat-column order in the repo draft CSV** (not the Sheet — see §1). League
   category order is confirmed (R/HR/RBI/SB/OPS, K/ERA/WHIP/QS/SV+H); the CSV column positions
   that `index.html` reads still need a visual check against that order.
2. **Sample-gate thresholds** (`sampleFull` for PA and IP) need tuning — start ~450 PA / ~120 IP,
   adjust against how rookies grade.
3. **SV+H — RESOLVED: data-only.** Read accumulated SV+H from Yahoo (YTD/trailing), sample-gated
   like any counting cat. The actuals *are* the role signal — whoever banks the saves is the closer,
   empirically. Add a light reliever-quality nudge (whiff%, xERA) so two relievers with equal SV+H
   but different skill aren't identical. No manual role field. Known tradeoff: lags role changes by
   a few weeks (a new closer accumulates slowly) — accepted; role *forecasting* is the owners' job,
   not the ledger's.
4. **Monthly CSV fields.** The Savant export must carry the de-luck columns each category needs
   (xwOBA, xERA, sprint speed, barrels, GB%) — confirm the manual upload includes them.
5. **Tier cut calibration** — keep ≥3.0 Elite (rare ceiling) or lower to ~2.7 so top assets land
   there. Currently nobody is Elite (top = Miller 2.96). See §5.
6. **AGE-ROUTING — the critical one.** The Sheet stores a single `dyn_z` per player. It's not
   visible whether `savant_dynz.js` / the War Room already bakes the age factor into that number.
   Our whole current-value decision requires salary to read the **age-free** score. Action: confirm
   in the repo whether the pushed `dyn_z` includes age. If it does, split the output — push an
   age-free score to the salary column and the age-adjusted score to the trade lens. This is the
   single most important wiring fix; everything else is downstream.
7. **Tax-rate contradiction in the live data.** SETTINGS says `tax_rate_per_10m = 1.5`; the
   CHANGELOG ratification row says "$0.25 per $10M over." Cap is currently **370** (not 500/350).
   Reconcile which is live before any payroll/tax math is trusted. (At cap 370, no team is over
   today — top payroll is Chalk Dust at 347 — so the tax rate isn't yet biting, but the conflict
   should be resolved.)
