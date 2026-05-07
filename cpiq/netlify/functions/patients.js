const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(status, obj) {
  return { statusCode: status, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(obj) };
}

function blobUrl(sas, blob) {
  return 'https://carepathiqdata.blob.core.windows.net/app-state/' + blob + sas;
}

function fetchText(url) {
  return new Promise(function(resolve, reject) {
    https.get(url, function(res) {
      let raw = '';
      res.on('data', function(c) { raw += c; });
      res.on('end', function() {
        if (res.statusCode === 200) resolve(raw);
        else reject(new Error(res.statusCode + ': ' + raw.substring(0, 200)));
      });
    }).on('error', reject);
  });
}

function putText(url, body) {
  return new Promise(function(resolve, reject) {
    const buf = Buffer.from(body, 'utf8');
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'x-ms-blob-type': 'BlockBlob' }
    }, function(res) {
      let raw = '';
      res.on('data', function(c) { raw += c; });
      res.on('end', function() {
        if (res.statusCode === 200 || res.statusCode === 201) resolve();
        else reject(new Error('PUT ' + res.statusCode + ': ' + raw.substring(0, 100)));
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const sas = process.env.AZURE_STORAGE_SAS_TOKEN || '';
  if (!sas) return json(500, { error: 'AZURE_STORAGE_SAS_TOKEN not set in Netlify env vars' });

  const action = (event.queryStringParameters || {}).action || '';
  const session = ((event.queryStringParameters || {}).session || 'default').replace(/[^a-z0-9-]/g, '_');
  const blob = 'cpiq-patients-' + session + '.json';

  // ── save ──────────────────────────────────────────────────────────────────
  if (action === 'save') {
    try {
      const body = event.body || '[]';
      JSON.parse(body); // validate JSON
      await putText(blobUrl(sas, blob), body);
      return json(200, { success: true, session });
    } catch(e) {
      return json(500, { error: 'Save failed', detail: e.message });
    }
  }

  // ── load ──────────────────────────────────────────────────────────────────
  if (action === 'load') {
    try {
      const raw = await fetchText(blobUrl(sas, blob));
      return { statusCode: 200, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS), body: raw };
    } catch(e) {
      if (e.message && e.message.startsWith('404')) return json(404, { error: 'Session not found', session });
      return json(502, { error: 'Load failed', detail: e.message });
    }
  }

  return json(400, { error: 'action must be save or load' });
};
