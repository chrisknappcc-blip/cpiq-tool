# CPIQ — CarePath IQ Demo

Hosted analytics dashboard for Care Continuity sales demos.

## How it works

1. On load, `index.html` calls the **Map Tool router** (`state-load`) to fetch the shared Azure blob
2. Competitor systems are extracted from the `overrides` map
3. **CPIQEngine** (`data/engine.js`) generates a deterministic 50K-population dataset seeded on the target system name — anchored to published healthcare referral benchmarks + the CC ED-to-Specialist value model
4. The 8 dashboard tabs (`tabs/*.html`) are fetched lazily and receive data via `postMessage`

## Customizing for a prospect

**Option A — URL parameter (easiest):**
```
https://your-site.netlify.app/?sys=Baptist+Health
```
The engine seeds on the system name and pulls the logo + competitors from the Map Tool.

**Option B — Map Tool already has the system:**
If the Map Tool has been used for this prospect, CPIQ auto-detects the most common system name in the shared state.

## File sizes

| File | Size |
|------|------|
| index.html (shell) | ~36KB |
| data/engine.js | ~18KB |
| tabs/*.html (8 files) | ~412KB total |
| **Total** | **~466KB** |

*Original monolithic file was 1.93MB (1,930KB). This is **76% smaller.***

## Stat methodology

All statistics are randomized within clinically realistic ranges anchored to:
- **ED visit rate**: ~410/1,000 population (NCHS 2018)
- **Specialty referral rate**: 23% of ED discharges (CC model)
- **In-network completion baseline**: 40% (Advisory Board / PerfectServe)
- **OON leakage range**: 20–52% (Kythera Labs)
- **MTTA range**: 28–49 days (literature)
- **Downstream utilization & margin**: CC ED-to-Specialist Value Model (50K pop)
- **Specialty mix**: Ortho 28%, Cardio 16%, GI 18%, + spine/surg/urology/neuro/ENT

Same system name always produces the same numbers (seeded RNG).

## Deployment

Push to GitHub → Netlify auto-deploys. No build step required.
