const http = require('http');

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: 'localhost', port: 5000, path, method, headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
      }
    );
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  if (actual === expected) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗ ${label} — expected ${expected}, got ${actual}\x1b[0m`);
    failed++;
  }
}

async function login(email, password) {
  const res = await req('POST', '/api/auth/login', { email, password });
  return res.body.token;
}

(async () => {
  // ─── Setup: get tokens ───
  const adminToken = await login('admin@complianceguard.com', 'admin123');
  const analystToken = await login('analyst@test.com', 'test1234');
  const viewerToken = await login('viewer@test.com', 'test1234');

  // ─── Admin Tests ───
  console.log('\n\x1b[1m── Admin Role ──\x1b[0m');

  let r = await req('GET', '/api/users', null, { Authorization: `Bearer ${adminToken}` });
  assert('GET /api/users — 200', r.status, 200);
  assert('  returns users array', Array.isArray(r.body.users), true);

  r = await req('POST', '/api/tasks', { keyword: 'admin-test', pages: 1, method: 'MIMIC' }, { Authorization: `Bearer ${adminToken}` });
  assert('POST /api/tasks (MIMIC) — 200/201', r.status === 200 || r.status === 201, true);

  r = await req('DELETE', '/api/tasks/clear-completed', null, { Authorization: `Bearer ${adminToken}` });
  assert('DELETE /api/tasks/clear-completed — 200', r.status, 200);

  r = await req('GET', '/api/settings', null, { Authorization: `Bearer ${adminToken}` });
  assert('GET /api/settings — 200', r.status, 200);

  // ─── Analyst Tests ───
  console.log('\n\x1b[1m── Analyst Role ──\x1b[0m');

  r = await req('GET', '/api/users', null, { Authorization: `Bearer ${analystToken}` });
  assert('GET /api/users — 403 (no user mgmt)', r.status, 403);

  r = await req('POST', '/api/tasks', { keyword: 'analyst-test', pages: 1, method: 'MIMIC' }, { Authorization: `Bearer ${analystToken}` });
  assert('POST /api/tasks (MIMIC) — 200/201', r.status === 200 || r.status === 201, true);
  const analystTaskId = r.body.task?.id;

  r = await req('GET', '/api/tasks', null, { Authorization: `Bearer ${analystToken}` });
  assert('GET /api/tasks — 200', r.status, 200);

  if (analystTaskId) {
    r = await req('DELETE', `/api/tasks/${analystTaskId}`, null, { Authorization: `Bearer ${analystToken}` });
    assert('DELETE /api/tasks/:id — 200', r.status, 200);
  }

  r = await req('DELETE', '/api/tasks/clear-completed', null, { Authorization: `Bearer ${analystToken}` });
  assert('DELETE /api/tasks/clear-completed — 200', r.status, 200);

  r = await req('GET', '/api/settings', null, { Authorization: `Bearer ${analystToken}` });
  assert('GET /api/settings — 403 (no settings access)', r.status, 403);

  // ─── Viewer Tests ───
  console.log('\n\x1b[1m── Viewer Role ──\x1b[0m');

  r = await req('GET', '/api/users', null, { Authorization: `Bearer ${viewerToken}` });
  assert('GET /api/users — 403', r.status, 403);

  r = await req('POST', '/api/tasks', { keyword: 'viewer-test', pages: 1, method: 'MIMIC' }, { Authorization: `Bearer ${viewerToken}` });
  assert('POST /api/tasks — 403 (no task creation)', r.status, 403);

  r = await req('GET', '/api/tasks', null, { Authorization: `Bearer ${viewerToken}` });
  assert('GET /api/tasks — 200 (read-only ok)', r.status, 200);

  r = await req('DELETE', '/api/tasks/999', null, { Authorization: `Bearer ${viewerToken}` });
  assert('DELETE /api/tasks/:id — 403', r.status, 403);

  r = await req('DELETE', '/api/tasks/clear-completed', null, { Authorization: `Bearer ${viewerToken}` });
  assert('DELETE /api/tasks/clear-completed — 403', r.status, 403);

  r = await req('GET', '/api/settings', null, { Authorization: `Bearer ${viewerToken}` });
  assert('GET /api/settings — 403', r.status, 403);

  // ─── Unauthenticated Tests ───
  console.log('\n\x1b[1m── No Auth ──\x1b[0m');

  r = await req('GET', '/api/tasks', null, {});
  assert('GET /api/tasks — 401', r.status, 401);

  r = await req('POST', '/api/tasks', { keyword: 'anon', pages: 1, method: 'MIMIC' }, {});
  assert('POST /api/tasks — 401', r.status, 401);

  r = await req('GET', '/api/users', null, {});
  assert('GET /api/users — 401', r.status, 401);

  // ─── Settings: self-registration toggle ───
  console.log('\n\x1b[1m── Settings: Self-Registration Toggle ──\x1b[0m');

  r = await req('GET', '/api/settings/public', null, {});
  assert('GET /api/settings/public — 200', r.status, 200);
  assert('  self_registration default is true', r.body.self_registration, true);

  r = await req('PUT', '/api/settings', { settings: { self_registration: 'false' } }, { Authorization: `Bearer ${adminToken}` });
  assert('PUT /api/settings — disable self-reg', r.status, 200);

  r = await req('GET', '/api/settings/public', null, {});
  assert('  self_registration now false', r.body.self_registration, false);

  // Try registering when disabled
  r = await req('POST', '/api/auth/register', { name: 'Blocked', email: 'blocked@test.com', password: 'test1234' }, {});
  assert('POST /api/auth/register — 403 (disabled)', r.status, 403);

  // Re-enable
  r = await req('PUT', '/api/settings', { settings: { self_registration: 'true' } }, { Authorization: `Bearer ${adminToken}` });
  r = await req('POST', '/api/auth/register', { name: 'Re-enabled', email: 'reenabled@test.com', password: 'test1234' }, {});
  assert('POST /api/auth/register — 201 (re-enabled)', r.status, 201);

  // ─── Summary ───
  console.log(`\n\x1b[1m══ Results: ${passed} passed, ${failed} failed ══\x1b[0m\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
