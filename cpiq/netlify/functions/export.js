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

  const { sysName, cpiqState, logoDataUrl, patients, tabs } = body;
  if (!cpiqState) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'cpiqState required' }) };
  if (!tabs || !tabs.carepathiq) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'tabs required' }) };

  const html = buildExport({ sysName, cpiqState, logoDataUrl, patients, tabs });
  const filename = 'CPIQ-' + (sysName || 'Export').replace(/[^a-z0-9]/gi, '-') + '.html';

  return {
    statusCode: 200,
    headers: Object.assign({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + filename + '"'
    }, CORS),
    body: html
  };
};

function buildExport({ sysName, cpiqState, logoDataUrl, patients, tabs }) {
  const slimState = {
    meta: cpiqState.meta, practices: cpiqState.practices,
    referrers: cpiqState.referrers, kpis: cpiqState.kpis,
    sessionKey: 'export', patients: null
  };

  const stateAndPatients = '<script>window.__cpiqStateCache=' + JSON.stringify(slimState) +
    ';window.CPIQ=window.__cpiqStateCache;window.__exportPatients=' +
    JSON.stringify(patients || []) + ';<\/script>';

  const tabsInjected = {};
  for (const [name, html] of Object.entries(tabs)) {
    tabsInjected[name] = html.replace('<head>', '<head>' + stateAndPatients);
  }

  const tabLabels = [
    ['carepathiq','CarePath IQ'],['insights','Patient Insights'],
    ['cycle','Pathway Intelligence'],['scorecard','Provider Scorecard'],
    ['source','Referral Sources'],['destination','Referral Outcomes'],
    ['procedure','Downstream Procedures'],['journeys','Patient Journeys']
  ];

  const exportDate = new Date().toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'});
  const logoHtml = logoDataUrl
    ? '<img src="' + esc(logoDataUrl) + '" alt="' + esc(sysName||'') + '" style="height:34px;max-width:150px;object-fit:contain">'
    : '<span style="font-family:'DM Serif Display',serif;font-size:14px;color:#0f1e2e">' + esc(sysName||'Health System') + '</span>';

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CarePath IQ — ${esc(sysName||'Health System')}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@400;500&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--teal:#007d6e;--text:#0f1e2e;--text2:#3a4f6a;--text3:#8aa0b8;--bg:#f7f9fc;--surface:#fff;--border:#dce6f0}
body{font-family:'Outfit',sans-serif;background:var(--bg);overflow:hidden;height:100vh}
nav{position:fixed;top:0;left:0;right:0;z-index:1000;background:rgba(255,255,255,.98);
  backdrop-filter:blur(16px);border-bottom:2px solid var(--border);height:50px;
  display:flex;align-items:center;padding:0 10px;gap:0;box-shadow:0 2px 12px rgba(15,30,60,.07)}
.logo{display:flex;align-items:center;gap:8px;margin-right:10px;flex-shrink:0}
.badge{font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  background:var(--teal);color:#fff;padding:2px 6px;border-radius:20px;font-family:'Outfit',sans-serif}
.tabs{display:flex;align-items:center;gap:1px;flex:1;overflow:hidden}
.t{display:flex;align-items:center;gap:4px;padding:0 7px;height:32px;border:1px solid transparent;
  cursor:pointer;font-family:'Outfit',sans-serif;font-size:11px;font-weight:500;border-radius:7px;
  color:var(--text2);background:transparent;white-space:nowrap;flex-shrink:0;transition:all .15s}
.t:hover{background:rgba(15,30,60,.04)}.t.on{color:var(--text);border-color:var(--border);background:#fff}
.n{font-family:'DM Mono',monospace;font-size:8px;font-weight:700;width:16px;height:16px;
  border-radius:4px;display:flex;align-items:center;justify-content:center;background:var(--border);color:var(--text2)}
.t.on .n{background:var(--teal);color:#fff}
.meta{font-size:9px;color:var(--text3);font-family:'DM Mono',monospace;margin-left:auto;padding-right:4px;white-space:nowrap;flex-shrink:0}
.wrap{position:fixed;top:50px;left:0;right:0;bottom:0}
iframe{width:100%;height:100%;border:none;display:none;background:var(--bg)}
iframe.on{display:block}
</style></head><body>
<nav>
  <div class="logo">${logoHtml}<span class="badge">CarePath IQ</span></div>
  <div class="tabs">
${tabLabels.map(([id,label],i)=>`    <button class="t${i===0?' on':''}" id="t-${id}" onclick="sw('${id}')"><div class="n">0${i}</div>${esc(label)}</button>`).join('
')}
  </div>
  <div class="meta">Export · ${esc(sysName||'Health System')} · ${exportDate}</div>
</nav>
<div class="wrap">
${tabLabels.map(([id],i)=>`<iframe${i===0?' class="on"':''} id="f-${id}" sandbox="allow-scripts allow-same-origin"></iframe>`).join('
')}
</div>
<script>
var T=${JSON.stringify(tabsInjected)},cur='carepathiq',done={};
function ld(id){if(done[id])return;done[id]=1;document.getElementById('f-'+id).srcdoc=T[id]||'';}
function sw(id){
  if(id===cur)return;
  document.getElementById('f-'+cur).className='';document.getElementById('t-'+cur).className='t';
  cur=id;document.getElementById('f-'+id).className='on';document.getElementById('t-'+id).className='t on';
  ld(id);
}
ld('carepathiq');
<\/script>
</body></html>`;
}

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
