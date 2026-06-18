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

**Category → stat-column map (CONFIRM against the Sheet generator before coding).**
Pitching order is inferred from the Ohtani-SP synthetic row
(`stat1=165 K, stat2=2.85 ERA, stat3=1.02 WHIP, stat4=20 QS, stat5=0 SV+H`):

| | stat1 | stat2 | stat3 | stat4 | stat5 |
|---|---|---|---|---|---|
| Hitter | R | HR | RBI | SB | OPS | *(order UNCONFIRMED — verify)* |
| Pitcher | K | ERA | WHIP | QS | SV+H |

> Note categories: **QS, not W** (corrected this session). QS is ratio-skill core
> (earned-run side) + a workload piece — see §3.

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

**Scale-calibration flag (must resolve before tiers).** The current `dynZ` in the draft app
runs ~0.6 for an ace, but the salary tiers in the constitution use Elite ≥ 3.0. Those are two
different scales — summing five category z-scores does **not** land on the same axis as the
draft app's normalized 0.6. **Do not hard-code the ≥3.0 / 2.0 / 1.0 thresholds.** Define tiers
as cuts of the *live `rawZ` distribution* (see §5) so they self-calibrate every recompute.

---

## 5. Tier mapping (salary)

Tiers from `rawZ` percentile/SD cuts, not magic numbers:

```
Elite  : rawZ ≥ p90  (or ≥ +2.0 SD of pool)   → $40M
Star   : p75–p90                               → $30M
Solid  : p50–p75                               → $20M
Depth  : p25–p50                               → $10M
Min    : < p25  (or rawZ < 0)                  → $3M floor
```

- Calibrate the cut points once against the live distribution, then lock for the season so
  salaries don't wobble on every CSV refresh.
- Escalation (12%/yr, compounding on current tier), trade-reset-to-Year-1, and the cap are
  **downstream** of this number and unchanged by this spec.

**By-design consequence:** prospects grade cheap (small sample → near replacement → Depth/Min).
Correct for current-value (Emerson graded Min in April). Upside you haven't banked isn't taxed —
that's the edge.

---

## 6. Open items / things to tune

1. **Confirm hitter stat-column order** (R/HR/RBI/SB/OPS) against the Sheet generator. Pitching
   order is inferred, not confirmed.
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
5. **Tier cut calibration** — pick percentile vs SD cuts, run once on live data, lock for season.
