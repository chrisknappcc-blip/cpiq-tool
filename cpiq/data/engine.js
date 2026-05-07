/**
 * CPIQ Data Engine
 * Randomizes all statistics anchored to real healthcare benchmarks from:
 *  - ED-to-Specialist Referral Value Model (Care Continuity, 50K population)
 *  - Published benchmarks: Kythera Labs, Advisory Board, PerfectServe (2024-2025)
 *
 * Benchmark anchors (50K population base):
 *   ED visits/yr          ~20,500   (410/1000 pop — NCHS 2018)
 *   ED discharges         ~16,800   (82% of visits)
 *   Referred to specialty ~  3,864  (23% of discharges)
 *   In-network completion    40%    (baseline; 55% for employed PCP mix)
 *   OON leakage rate       20-65%   (Kythera Labs; 30-40% typical)
 *   MTTA days              28-49    (literature; top performers 28-33)
 *
 * Specialty mix (% of targeted referrals):
 *   Ortho 28%, Cardio 16%, GI 18%, Spine 3%, ENT 5%, Gen Surg 8%, Urology 6%, Neuro 4%, Gen Med 12%
 */

(function(root) {

  // ── Seeded pseudo-random (Mulberry32) ────────────────────────────────────
  function seededRng(seed) {
    let s = seed >>> 0;
    return function() {
      s += 0x6D2B79F5;
      let t = s;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function strToSeed(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // ── Variation helpers ────────────────────────────────────────────────────
  function jitter(rng, base, pct) {
    return base * (1 + (rng() - 0.5) * 2 * pct);
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round1(v) { return Math.round(v * 10) / 10; }

  // ── Core benchmark constants (50K population) ────────────────────────────
  const BASE = {
    population: 50000,
    edVisits:   20500,
    edDischargeRate: 0.82,
    specialtyRefPct: 0.23,
    inNetworkCompletionBase: 0.40,
    inNetworkCompletionEmployed: 0.55, // Advisory Board: 55% for employed PCPs
    oonLeakageBase: 0.32,              // mid-range of 20-65% (Kythera)
    mttaBase: 38,                      // days, population mean
    mttaTop: 30,                       // top decile

    // Specialty mix (% of targeted referrals) — from Excel model
    specMix: {
      ortho:    0.28,
      cardio:   0.16,
      gi:       0.18,
      spine:    0.03,
      ent:      0.05,
      gensurg:  0.08,
      urology:  0.06,
      neuro:    0.04,
      genmed:   0.12
    },

    // Downstream utilization rates (OP visits, IP admits, surg procs) — from Excel model
    downstream: {
      ortho:   { op: 0.83, ip: 0.14, surg: 0.05 },
      cardio:  { op: 0.11, ip: 0.05, surg: 0.02 },
      gi:      { op: 0.12, ip: 0.09, surg: 0.06 },
      spine:   { op: 0.98, ip: 0.10, surg: 0.02 },
      ent:     { op: 0.04, ip: 0.02, surg: 0.02 },
      gensurg: { op: 0.14, ip: 0.22, surg: 0.08 },
      urology: { op: 0.61, ip: 0.09, surg: 0.09 },
      neuro:   { op: 0.52, ip: 0.37, surg: 0.02 },
      genmed:  { op: 0.36, ip: 0.06, surg: 0.05 }
    },

    // Average downstream margin per service ($) — from Excel model
    margin: {
      ortho:   { op: 239,  ip: 3865, surg: 1000 },
      cardio:  { op: 218,  ip: 7228, surg: 4749 },
      gi:      { op: 205,  ip: 6771, surg: 864  },
      spine:   { op: 212,  ip: 7201, surg: 7004 },
      ent:     { op: 121,  ip: 2500, surg: 2500 },
      gensurg: { op: 127,  ip: 8467, surg: 3968 },
      urology: { op: 110,  ip: 6344, surg: 2650 },
      neuro:   { op: 336,  ip: 5361, surg: 1000 },
      genmed:  { op: 96,   ip: 5001, surg: 1501 }
    },

    // Conv rate & OON proc rate anchors by tier
    tier: {
      t1:  { convRate: [0.70, 0.87], mttaMult: 0.90, oonProcRate: [0.04, 0.10] },
      t2:  { convRate: [0.55, 0.75], mttaMult: 1.05, oonProcRate: [0.10, 0.18] },
      oon: { convRate: [0.42, 0.65], mttaMult: 1.20, oonProcRate: [0.22, 0.42] }
    }
  };

  // ── Month seasonality weights (ortho peaks summer, cardio peaks winter) ──
  const MONTH_WEIGHTS = {
    ortho:  [0.082,0.082,0.086,0.090,0.092,0.096,0.096,0.090,0.088,0.084,0.082,0.072],
    cardio: [0.096,0.092,0.088,0.082,0.080,0.078,0.076,0.078,0.080,0.084,0.088,0.098],
    gi:     [0.082,0.083,0.086,0.088,0.088,0.086,0.086,0.086,0.086,0.085,0.084,0.080]
  };

  /**
   * generate(sysName, competitors, options)
   *
   * Returns { practices, referrers, specialists, patients, kpis, meta }
   * Everything is deterministic for a given sysName (seed).
   *
   * competitors: array of { name, tier } from Map Tool state-load
   * options: { specFilter: ['ortho','cardio','gi'] }
   */
  function generate(sysName, competitors, options) {
    options = options || {};
    const seed = strToSeed(sysName || 'Health System');
    const rng  = seededRng(seed);

    // ── 1. Volume math (50K pop base) ────────────────────────────────────
    const edVisits     = Math.round(jitter(rng, BASE.edVisits, 0.12));
    const edDischarges = Math.round(edVisits * BASE.edDischargeRate);
    const totalRefs    = Math.round(edDischarges * BASE.specialtyRefPct * jitter(rng, 1, 0.08));
    const inNetRate    = clamp(jitter(rng, BASE.inNetworkCompletionBase, 0.15), 0.28, 0.58);
    const oonLeakage   = clamp(jitter(rng, BASE.oonLeakageBase, 0.20), 0.18, 0.52);

    // ── 2. Specialty volumes ─────────────────────────────────────────────
    const specVols = {};
    const SPECS = ['ortho','cardio','gi'];
    let remaining = totalRefs;
    SPECS.forEach((sp, i) => {
      if (i === SPECS.length - 1) {
        specVols[sp] = remaining;
      } else {
        const mix = BASE.specMix[sp];
        specVols[sp] = Math.round(totalRefs * jitter(rng, mix, 0.10));
        remaining -= specVols[sp];
      }
    });

    // ── 3. Build competitor system list ──────────────────────────────────
    // competitors from Map Tool overrides (unique system names, excluding target)
    const compSystems = buildCompetitorList(sysName, competitors, rng);

    // ── 4. Build practices (destination specialists) ─────────────────────
    const practices = buildPractices(sysName, compSystems, specVols, inNetRate, oonLeakage, rng);

    // ── 5. Build referrer (source) physicians ────────────────────────────
    const referrers = buildReferrers(sysName, compSystems, specVols, rng);

    // ── 6. Build patient pool (50K → ~3,864 targeted referrals) ─────────
    const patients = buildPatients(totalRefs, practices, referrers, inNetRate, rng);

    // ── 7. KPIs ──────────────────────────────────────────────────────────
    const kpis = buildKpis(patients, specVols, inNetRate, oonLeakage, edVisits, edDischarges, totalRefs, rng);

    return {
      meta: {
        sysName: sysName || 'Health System',
        population: 50000,
        edVisits, edDischarges, totalRefs, inNetRate, oonLeakage,
        specVols, competitors: compSystems,
        generatedAt: new Date().toISOString()
      },
      practices,
      referrers,
      patients,
      kpis
    };
  }

  // ── Practice builder ─────────────────────────────────────────────────────
  function buildPractices(sysName, compSystems, specVols, inNetRate, oonLeakage, rng) {
    const practices = [];
    const CITIES = ['City A','City B','City C','City D','City E','City F'];
    const SPEC_LABELS = { ortho:'Orthopedics', cardio:'Cardiology', gi:'Digestive Health' };

    // T1 practices per specialty (employed)
    ['ortho','cardio','gi'].forEach(sp => {
      const total = specVols[sp] || 0;
      const numT1 = 2 + Math.floor(rng() * 3); // 2-4
      const t1Vol = Math.round(total * clamp(jitter(rng, inNetRate, 0.08), 0.30, 0.65));

      for (let i = 0; i < numT1; i++) {
        const city = CITIES[i % CITIES.length];
        const vol = Math.round(t1Vol * (1 / numT1) * jitter(rng, 1, 0.25));
        const cr  = clamp(rng() * (0.87 - 0.70) + 0.70, 0.65, 0.90);
        const mtta = Math.round(BASE.mttaBase * BASE.tier.t1.mttaMult * jitter(rng, 1, 0.12));
        const pr   = clamp(jitter(rng, BASE.downstream[sp].surg + BASE.downstream[sp].op * 0.3, 0.15), 0.08, 0.50);
        const oonPr = clamp(jitter(rng, 0.07, 0.3), 0.03, 0.12);

        practices.push({
          pid: `t1-${sp}-${city.toLowerCase().replace(' ','')}${i}`,
          name: `${sysName} ${SPEC_LABELS[sp]} – ${city}`,
          tier: 't1', spec: sp,
          totalRefs: vol,
          convRate: round1(cr * 10) / 10,
          mttaDays: mtta,
          procRate: round1(pr * 100) / 100,
          oonProcRate: round1(oonPr * 100) / 100,
          monthly: buildMonthly(vol, sp, rng),
          docs: buildDocs(sp, vol, rng, 't1')
        });
      }
    });

    // T2 (CIN partner) practices
    ['ortho','cardio','gi'].forEach(sp => {
      const total = specVols[sp] || 0;
      const numT2 = 1 + Math.floor(rng() * 3);
      const t2Vol = Math.round(total * clamp(jitter(rng, 0.20, 0.15), 0.10, 0.30));

      for (let i = 0; i < numT2; i++) {
        const city = CITIES[(i + 2) % CITIES.length];
        const comp = compSystems[Math.floor(rng() * compSystems.length)] || { name: 'Competitor' };
        const vol = Math.round(t2Vol * (1 / numT2) * jitter(rng, 1, 0.25));
        const cr  = clamp(rng() * (0.75 - 0.55) + 0.55, 0.50, 0.78);
        const mtta = Math.round(BASE.mttaBase * BASE.tier.t2.mttaMult * jitter(rng, 1, 0.12));
        const pr   = clamp(jitter(rng, BASE.downstream[sp].surg + BASE.downstream[sp].op * 0.25, 0.15), 0.06, 0.38);
        const oonPr = clamp(jitter(rng, 0.14, 0.3), 0.08, 0.22);

        practices.push({
          pid: `t2-${sp}-${city.toLowerCase().replace(' ','')}${i}`,
          name: `${comp.name} ${SPEC_LABELS[sp]} – ${city}`,
          tier: 't2', spec: sp,
          totalRefs: vol,
          convRate: round1(cr * 10) / 10,
          mttaDays: mtta,
          procRate: round1(pr * 100) / 100,
          oonProcRate: round1(oonPr * 100) / 100,
          monthly: buildMonthly(vol, sp, rng),
          docs: buildDocs(sp, vol, rng, 't2')
        });
      }
    });

    // OON (competitor) practices — allocated from leakage
    ['ortho','cardio','gi'].forEach(sp => {
      const total = specVols[sp] || 0;
      const numOon = 1 + Math.floor(rng() * 2);
      const oonVol = Math.round(total * clamp(jitter(rng, oonLeakage, 0.20), 0.15, 0.55));

      for (let i = 0; i < numOon; i++) {
        const comp = compSystems[i % compSystems.length] || { name: 'Regional Health' };
        const city = CITIES[(i + 4) % CITIES.length];
        const vol = Math.round(oonVol * (1 / numOon) * jitter(rng, 1, 0.30));
        const cr  = clamp(rng() * (0.65 - 0.42) + 0.42, 0.38, 0.68);
        const mtta = Math.round(BASE.mttaBase * BASE.tier.oon.mttaMult * jitter(rng, 1, 0.15));
        const pr   = clamp(jitter(rng, BASE.downstream[sp].surg + BASE.downstream[sp].op * 0.2, 0.15), 0.04, 0.28);
        const oonPr = clamp(jitter(rng, 0.30, 0.25), 0.18, 0.48);

        practices.push({
          pid: `oon-${sp}-${comp.name.toLowerCase().replace(/\s+/g,'').slice(0,8)}${i}`,
          name: `${comp.name} ${SPEC_LABELS[sp]} Group`,
          tier: 'oon', spec: sp,
          totalRefs: vol,
          convRate: round1(cr * 10) / 10,
          mttaDays: mtta,
          procRate: round1(pr * 100) / 100,
          oonProcRate: round1(oonPr * 100) / 100,
          monthly: buildMonthly(vol, sp, rng),
          docs: buildDocs(sp, vol, rng, 'oon')
        });
      }
    });

    return practices;
  }

  // ── Monthly distribution ─────────────────────────────────────────────────
  function buildMonthly(annualVol, spec, rng) {
    const wts = MONTH_WEIGHTS[spec] || MONTH_WEIGHTS.gi;
    return wts.map(w => Math.max(1, Math.round(annualVol * w * jitter(rng, 1, 0.06))));
  }

  // ── Physicians per practice ──────────────────────────────────────────────
  const FIRST = ['James','Susan','Robert','Patricia','Dennis','Marcus','Linda','Thomas','Angela','William'];
  const LAST  = ['Andrews','Schaefer','Hazel','Conway','Howell','Price','Kessler','Gallagher','Rhee','Foster','Martin','Coleman','Griffin'];
  const MI    = ['H','M','L','A','R','B','G','C','E','P','T','J','W'];

  function doctorName(rng) {
    const f = FIRST[Math.floor(rng() * FIRST.length)];
    const m = MI[Math.floor(rng() * MI.length)];
    const l = LAST[Math.floor(rng() * LAST.length)];
    return `Dr. ${f} ${m}. ${l}`;
  }

  function buildDocs(spec, practiceVol, rng, tier) {
    const n = tier === 't1' ? 3 + Math.floor(rng() * 3) : 2 + Math.floor(rng() * 2);
    const docs = [];
    const crRange = BASE.tier[tier]?.convRate || [0.55, 0.80];
    for (let i = 0; i < n; i++) {
      const shareDecay = 1 / (i + 1) * jitter(rng, 1, 0.3);
      const refs = Math.max(50, Math.round(practiceVol * shareDecay / n * 1.4));
      const cr   = clamp(rng() * (crRange[1] - crRange[0]) + crRange[0], 0.30, 0.92);
      const mtta = Math.round(BASE.mttaBase * jitter(rng, 1, 0.18));
      const pr   = clamp(BASE.downstream[spec]?.surg * jitter(rng, 1, 0.3) + 0.05, 0.04, 0.48);
      const oonPr = clamp(jitter(rng, tier === 'oon' ? 0.28 : 0.06, 0.35), 0.02, 0.50);
      docs.push({
        id: `doc-${spec}-${i}-${Math.floor(rng()*9999)}`,
        name: doctorName(rng),
        refs, convRate: round1(cr * 10)/10,
        mttaDays: mtta,
        procRate: round1(pr * 100)/100,
        oonProcRate: round1(oonPr * 100)/100
      });
    }
    return docs;
  }

  // ── Referrer (source) builders ───────────────────────────────────────────
  const PCP_TYPES = ['Family Medicine','Internal Medicine','Primary Care','General Practice'];
  const SPEC_TYPES = ['Hospitalist','Urgent Care','Emergency Medicine','Cardiology','Neurology'];

  function buildReferrers(sysName, compSystems, specVols, rng) {
    const referrers = [];
    const CITIES = ['City A','City B','City C','City D','City E'];
    const totalOrthoCd = (specVols.ortho||0) + (specVols.cardio||0) + (specVols.gi||0);

    // T1 PCP practices (employed)
    const numT1pcp = 4 + Math.floor(rng() * 4);
    for (let i = 0; i < numT1pcp; i++) {
      const city = CITIES[i % CITIES.length];
      const spec = PCP_TYPES[Math.floor(rng() * PCP_TYPES.length)];
      const shareBase = 1 / numT1pcp;
      const refs = {
        ortho: Math.round(specVols.ortho * shareBase * jitter(rng, 1, 0.4)),
        cardio: Math.round(specVols.cardio * shareBase * jitter(rng, 1, 0.4)),
        gi: Math.round(specVols.gi * shareBase * jitter(rng, 1, 0.4))
      };
      referrers.push({
        id: `r${String(i+1).padStart(3,'0')}`,
        name: doctorName(rng),
        practice: `${sysName} ${spec} – ${city}`,
        pid: `ph-pcp-${city.toLowerCase().replace(' ','')}${i}`,
        tier: 't1', ptype: 'pcp', specialty: spec,
        city: `${city}, ST`, refs
      });
    }

    // T2 (CIN / independent) referring PCPs
    const numT2 = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < numT2; i++) {
      const city = CITIES[(i+2) % CITIES.length];
      const comp = compSystems[i % compSystems.length] || { name: 'Community' };
      const spec = PCP_TYPES[Math.floor(rng() * PCP_TYPES.length)];
      const shareBase = 0.7 / numT2;
      referrers.push({
        id: `r${String(numT1pcp + i + 1).padStart(3,'0')}`,
        name: doctorName(rng),
        practice: `${comp.name} ${spec} – ${city}`,
        pid: `ph-t2-${city.toLowerCase().replace(' ','')}${i}`,
        tier: 't2', ptype: 'pcp', specialty: spec,
        city: `${city}, ST`,
        refs: {
          ortho:  Math.round(specVols.ortho  * shareBase * jitter(rng, 1, 0.5)),
          cardio: Math.round(specVols.cardio * shareBase * jitter(rng, 1, 0.5)),
          gi:     Math.round(specVols.gi     * shareBase * jitter(rng, 1, 0.5))
        }
      });
    }

    // Specialist referrers (hospitalists, ED)
    const numSpec = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < numSpec; i++) {
      const city = CITIES[i % CITIES.length];
      const spec = SPEC_TYPES[i % SPEC_TYPES.length];
      referrers.push({
        id: `r${String(numT1pcp + numT2 + i + 1).padStart(3,'0')}`,
        name: doctorName(rng),
        practice: `${sysName} ${spec} – ${city}`,
        pid: `ph-spec-${city.toLowerCase().replace(' ','')}${i}`,
        tier: 't1', ptype: 'spec', specialty: spec,
        city: `${city}, ST`,
        refs: {
          ortho:  Math.round(specVols.ortho  * 0.05 * jitter(rng, 1, 0.4)),
          cardio: Math.round(specVols.cardio * 0.08 * jitter(rng, 1, 0.4)),
          gi:     Math.round(specVols.gi     * 0.06 * jitter(rng, 1, 0.4))
        }
      });
    }

    return referrers;
  }

  // ── Patient pool builder ─────────────────────────────────────────────────
  function buildPatients(totalRefs, practices, referrers, inNetRate, rng) {
    const patients = [];
    const SPECS = ['ortho','cardio','gi'];
    const PROC_CODES = {
      ortho:  [['27447','Total Knee Arthroplasty'],['27130','Total Hip Arthroplasty'],['29881','Knee Arthroscopy w/ Meniscectomy'],['29827','Shoulder Arthroscopy / Rotator Cuff Repair'],['22612','Lumbar Spinal Fusion'],['20610','Joint Injection']],
      cardio: [['93306','Echocardiography'],['93000','ECG'],['93458','Coronary Angiography'],['33533','CABG'],['93571','FFR'],['92928','PCI']],
      gi:     [['45378','Colonoscopy'],['43239','EGD w/ Biopsy'],['43235','Upper Endoscopy'],['45380','Colonoscopy w/ Biopsy'],['43257','EGD w/ Dilation'],['91035','Esophageal Manometry']]
    };

    const pracBySpec = {};
    SPECS.forEach(sp => { pracBySpec[sp] = practices.filter(p => p.spec === sp); });
    const refArr = referrers;

    const startDate = new Date('2025-01-01');
    const endDate   = new Date('2025-12-31');

    for (let i = 0; i < totalRefs; i++) {
      // Pick specialty proportionally
      const roll = rng();
      const sp = roll < 0.28 ? 'ortho' : roll < 0.44 ? 'cardio' : 'gi';

      // Pick dest practice (weighted by totalRefs)
      const pracsForSp = pracBySpec[sp];
      const prac = weightedPick(pracsForSp, p => p.totalRefs, rng);

      // Pick referring physician
      const ref = refArr[Math.floor(rng() * refArr.length)];

      // Visit/proc simulation
      const visitDone = rng() < (prac ? prac.convRate : 0.65);
      const mtta = visitDone ? Math.round((prac ? prac.mttaDays : 38) * jitter(rng, 1, 0.30)) : null;
      const edVisit = rng() < 0.084; // ~8.4% of referrals have an associated ED visit
      const procDone = visitDone && rng() < (prac ? prac.procRate : 0.15);
      const procIsOon = procDone && rng() < (prac ? prac.oonProcRate : 0.15);
      const procs = PROC_CODES[sp];
      const procEntry = procDone ? procs[Math.floor(rng() * procs.length)] : null;

      // Dates
      const refDate = randomDate(startDate, endDate, rng);
      const visitDate = visitDone ? addDays(refDate, mtta) : null;
      const procDate = procDone ? addDays(visitDate, Math.round(jitter(rng, 6, 0.5))) : null;
      const daysFromRef = procDone ? daysBetween(refDate, procDate) : (visitDone ? mtta : null);

      patients.push({
        i:  `PT-${String(i+1).padStart(5,'0')}`,
        sp, rd: fmtDate(refDate),
        ri: ref ? ref.id : 'r001',
        rt: ref ? ref.tier : 't1',
        rp: ref ? ref.ptype : 'pcp',
        dp: prac ? prac.pid : 'unk',
        di: prac && prac.docs && prac.docs.length ? prac.docs[Math.floor(rng()*prac.docs.length)].id : 'doc-0',
        dt: prac ? prac.tier : 't1',
        v:  visitDone ? 1 : 0,
        m:  mtta,
        vd: visitDate ? fmtDate(visitDate) : null,
        e:  edVisit ? 1 : 0,
        pr: procDone ? 1 : 0,
        pc: procEntry ? procEntry[0] : null,
        pn: procDone ? (procIsOon ? 'oon' : 'in') : null,
        pd: procDate ? fmtDate(procDate) : null,
        df: daysFromRef
      });
    }
    return patients;
  }

  function weightedPick(arr, weightFn, rng) {
    if (!arr || !arr.length) return null;
    const total = arr.reduce((s, x) => s + weightFn(x), 0);
    let cursor = rng() * total;
    for (const x of arr) {
      cursor -= weightFn(x);
      if (cursor <= 0) return x;
    }
    return arr[arr.length - 1];
  }

  function randomDate(start, end, rng) {
    return new Date(start.getTime() + rng() * (end.getTime() - start.getTime()));
  }
  function addDays(d, n) { return new Date(d.getTime() + (n || 0) * 86400000); }
  function daysBetween(a, b) { return Math.round(Math.abs(b - a) / 86400000); }
  function fmtDate(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth()+1).padStart(2,'0') + '-' +
      String(d.getDate()).padStart(2,'0');
  }

  // ── KPI aggregation ──────────────────────────────────────────────────────
  function buildKpis(patients, specVols, inNetRate, oonLeakage, edVisits, edDischarges, totalRefs, rng) {
    const totalVisits = patients.filter(p => p.v).length;
    const totalProcs  = patients.filter(p => p.pr).length;
    const oonProcs    = patients.filter(p => p.pn === 'oon').length;
    const edPts       = patients.filter(p => p.e).length;
    const allMtta     = patients.filter(p => p.m).map(p => p.m);
    const avgMtta     = allMtta.length ? Math.round(allMtta.reduce((a,b)=>a+b,0)/allMtta.length) : 38;

    // Downstream margin (baseline vs Care Continuity target)
    // Based on Excel model: increasing completion 40→50% + 10% utilization uplift = 37.5% multiplier
    const specKeys = ['ortho','cardio','gi'];
    let baseMargin = 0, ccMargin = 0;
    specKeys.forEach(sp => {
      const vol = specVols[sp] || 0;
      const completed = Math.round(vol * inNetRate);
      const d = BASE.downstream[sp];
      const m = BASE.margin[sp];
      const spBase = completed * (d.op * m.op + d.ip * m.ip + d.surg * m.surg);
      baseMargin += spBase;
      ccMargin += spBase * 1.375; // CC value multiplier from Excel model
    });

    return {
      edVisits, edDischarges, totalRefs,
      inNetRate: round1(inNetRate * 1000)/1000,
      oonLeakage: round1(oonLeakage * 1000)/1000,
      totalVisits,
      visitCompletionRate: round1(totalVisits / patients.length * 1000)/1000,
      totalProcs, oonProcs,
      oonProcRate: round1(oonProcs / (totalProcs || 1) * 1000)/1000,
      edPatients: edPts,
      edRate: round1(edPts / patients.length * 1000)/1000,
      avgMtta,
      baselineMargin: Math.round(baseMargin),
      ccMargin: Math.round(ccMargin),
      ccValueAdd: Math.round(ccMargin - baseMargin),
      specVols
    };
  }

  // ── Competitor list extraction ───────────────────────────────────────────
  function buildCompetitorList(sysName, rawCompetitors, rng) {
    if (rawCompetitors && rawCompetitors.length) {
      return rawCompetitors.filter(c => c.name !== sysName && c.name !== 'Independent / Community').map(c => ({
        name: c.name,
        tier: c.tier || 'oon',
        logoKey: encodeURIComponent(c.name.toLowerCase().trim())
      }));
    }
    // Fallback synthetic competitors
    const fallbacks = ['Regional Medical Center','Community Health Partners','Metro Health System','University Health'];
    return fallbacks.slice(0, 3).map(name => ({ name, tier: 'oon', logoKey: encodeURIComponent(name.toLowerCase()) }));
  }

  // ── Public API ────────────────────────────────────────────────────────────
  const Engine = { generate, BASE, MONTH_WEIGHTS };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Engine;
  } else {
    root.CPIQEngine = Engine;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
