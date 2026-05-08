const https = require('https');
const path  = require('path');
const fs    = require('fs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'POST only' };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { sysName, zipCode, cpiqState, logoDataUrl, patients } = body;
  if (!cpiqState) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'cpiqState required' }) };

  // Read all tab HTML files
  const tabDir = path.join(__dirname, '../../tabs');
  const tabNames = ['carepathiq','source','destination','procedure','scorecard','insights','journeys','cycle'];
  const tabs = {};
  for (const name of tabNames) {
    try {
      tabs[name] = fs.readFileSync(path.join(tabDir, name + '.html'), 'utf8');
    } catch(e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not read tab: ' + name }) };
    }
  }

  // Build the export HTML
  const html = buildExport({ sysName, zipCode, cpiqState, logoDataUrl, patients, tabs });

  return {
    statusCode: 200,
    headers: Object.assign({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'attachment; filename="CPIQ-' + (sysName || 'Export').replace(/[^a-z0-9]/gi, '-') + '.html"'
    }, CORS),
    body: html
  };
};

function buildExport({ sysName, zipCode, cpiqState, logoDataUrl, patients, tabs }) {
  // Inject state into each tab HTML
  const slimState = {
    meta:       cpiqState.meta,
    practices:  cpiqState.practices,
    referrers:  cpiqState.referrers,
    kpis:       cpiqState.kpis,
    sessionKey: cpiqState._sessionKey || 'export',
    patients:   null
  };

  const tabsInjected = {};
  for (const [name, html] of Object.entries(tabs)) {
    const stateScript = `<script>
window.__cpiqStateCache = ${JSON.stringify(slimState)};
window.CPIQ = window.__cpiqStateCache;
// Export mode: patients available directly
window.__exportPatients = ${JSON.stringify(patients || [])};
</script>`;
    tabsInjected[name] = html.replace('<head>', '<head>' + stateScript);
  }

  const tabLabels = {
    carepathiq: 'CarePath IQ',
    insights:   'Patient Insights',
    cycle:      'Pathway Intelligence',
    scorecard:  'Provider Scorecard',
    source:     'Referral Sources',
    destination:'Referral Outcomes',
    procedure:  'Downstream Procedures',
    journeys:   'Patient Journeys'
  };

  const logoSrc = logoDataUrl || '';
  const exportDate = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CarePath IQ — ${escHtml(sysName || 'Health System')}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@400;500&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --teal:#007d6e;--rose:#c8354a;--blue:#1a56b0;--gold:#d4a017;
  --text:#0f1e2e;--text2:#3a4f6a;--text3:#8aa0b8;
  --bg:#f7f9fc;--surface:#fff;--border:#dce6f0;
  --grid:rgba(220,230,240,.6);--tick:#8aa0b8;
}
body{font-family:'Outfit',sans-serif;background:var(--bg);overflow:hidden;height:100vh}
.ex-nav{
  position:fixed;top:0;left:0;right:0;z-index:1000;
  background:rgba(255,255,255,.98);backdrop-filter:blur(16px);
  border-bottom:2px solid var(--border);height:50px;
  display:flex;align-items:center;padding:0 10px;gap:0;
  box-shadow:0 2px 12px rgba(15,30,60,.07);
}
.ex-logo{display:flex;align-items:center;gap:8px;margin-right:12px;flex-shrink:0;cursor:default}
.ex-logo img{height:36px;max-width:160px;object-fit:contain}
.ex-badge{
  font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  background:var(--teal);color:#fff;padding:2px 7px;border-radius:20px;margin-left:4px;
  font-family:'Outfit',sans-serif;
}
.ex-tabs{display:flex;align-items:center;gap:2px;flex:1;overflow:hidden}
.tab-btn{
  display:flex;align-items:center;gap:4px;padding:0 7px;height:32px;
  border:1px solid transparent;cursor:pointer;
  font-family:'Outfit',sans-serif;font-size:11px;font-weight:500;border-radius:7px;
  color:var(--text2);background:transparent;white-space:nowrap;flex-shrink:0;
  transition:all .15s;
}
.tab-btn:hover{background:rgba(15,30,60,.04);color:var(--text)}
.tab-btn.active{color:var(--text);border-color:var(--border);background:var(--surface)}
.tab-num{
  font-family:'DM Mono',monospace;font-size:8px;font-weight:700;
  width:16px;height:16px;border-radius:4px;
  display:flex;align-items:center;justify-content:center;
  background:var(--border);color:var(--text2);flex-shrink:0;
}
.tab-btn.active .tab-num{background:var(--teal);color:#fff}
.ex-meta{
  font-size:10px;color:var(--text3);font-family:'DM Mono',monospace;
  margin-left:auto;padding-right:4px;white-space:nowrap;flex-shrink:0;
}
.frame-wrap{position:fixed;top:50px;left:0;right:0;bottom:0}
.dash-frame{width:100%;height:100%;border:none;display:none;background:var(--bg)}
.dash-frame.visible{display:block}
</style>
</head>
<body>

<nav class="ex-nav">
  <div class="ex-logo">
    ${logoSrc ? `<img src="${escHtml(logoSrc)}" alt="${escHtml(sysName || 'Health System')}">` : `<span style="font-family:'DM Serif Display',serif;font-size:15px;color:var(--text)">${escHtml(sysName || 'Health System')}</span>`}
    <span class="ex-badge">CarePath IQ</span>
  </div>
  <div class="ex-tabs" id="tab-strip">
${Object.entries(tabLabels).map(([id, label], i) => `    <button class="tab-btn${i===0?' active':''}" id="tab-${id}" onclick="switchTab('${id}')">
      <div class="tab-num">0${i}</div>
      <span>${label}</span>
    </button>`).join('\n')}
  </div>
  <div class="ex-meta">Export · ${escHtml(sysName || 'Health System')} · ${exportDate}</div>
</nav>

<div class="frame-wrap">
${Object.keys(tabLabels).map((id, i) => `  <iframe class="dash-frame${i===0?' visible':''}" id="frame-${id}" sandbox="allow-scripts allow-same-origin"></iframe>`).join('\n')}
</div>

<script>
// ── Tab HTML (baked in) ────────────────────────────────────────────────────
var TABS = ${JSON.stringify(tabsInjected)};

// ── Patient data (baked in) ────────────────────────────────────────────────
var EXPORT_PATIENTS = ${JSON.stringify(patients || [])};

// ── Tab management ─────────────────────────────────────────────────────────
var loaded = {};
var current = 'carepathiq';

function loadFrame(id) {
  if (loaded[id]) return;
  loaded[id] = true;
  var frame = document.getElementById('frame-' + id);
  var html = TABS[id];
  if (!html) return;
  // Patch sessionStorage reads to use baked-in patients
  var patch = '<script>window.__exportPatients=' + JSON.stringify(EXPORT_PATIENTS) + ';<\\/script>';
  html = html.replace('<head>', '<head>' + patch);
  frame.srcdoc = html;
}

function switchTab(id) {
  if (id === current) return;
  document.getElementById('frame-' + current).classList.remove('visible');
  document.getElementById('tab-'   + current).classList.remove('active');
  current = id;
  document.getElementById('frame-' + id).classList.add('visible');
  document.getElementById('tab-'   + id).classList.add('active');
  loadFrame(id);
}

// Override sessionStorage reads in iframes to use baked-in data
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'tab-ready') {
    var loader = document.getElementById('loading-' + e.data.tab);
    if (loader) loader.classList.add('done');
  }
});

// Load first tab
loadFrame('carepathiq');
</script>

</body>
</html>`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
