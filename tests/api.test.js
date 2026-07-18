const assert = require('assert');
const http = require('http');

const BASE_URL = 'http://localhost:5000';

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let passed = 0;
let failed = 0;
let adminToken;
let testUserId;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

async function run() {
  console.log('\n\x1b[1mCompliance Guard API Tests\x1b[0m\n');

  // --- Auth Tests ---
  console.log('Auth:');

  await test('POST /api/auth/login - success with valid credentials', async () => {
    const res = await request('POST', '/api/auth/login', {
      email: 'admin@complianceguard.com',
      password: 'admin123',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.message, 'Login successful');
    assert.ok(res.body.token);
    assert.strictEqual(res.body.user.email, 'admin@complianceguard.com');
    assert.strictEqual(res.body.user.role, 'Admin');
    adminToken = res.body.token;
  });

  await test('POST /api/auth/login - fail with wrong password', async () => {
    const res = await request('POST', '/api/auth/login', {
      email: 'admin@complianceguard.com',
      password: 'wrongpassword',
    });
    assert.strictEqual(res.status, 401);
    assert.ok(res.body.error);
  });

  await test('POST /api/auth/login - fail with missing fields', async () => {
    const res = await request('POST', '/api/auth/login', { email: 'test@test.com' });
    assert.strictEqual(res.status, 400);
  });

  await test('POST /api/auth/login - fail with nonexistent user', async () => {
    const res = await request('POST', '/api/auth/login', {
      email: 'nobody@example.com',
      password: 'test',
    });
    assert.strictEqual(res.status, 401);
  });

  await test('POST /api/auth/register - success', async () => {
    const res = await request('POST', '/api/auth/register', {
      name: 'Test User',
      email: `test_${Date.now()}@example.com`,
      password: 'testpass123',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.message, 'User registered successfully');
    assert.ok(res.body.user.id);
    testUserId = res.body.user.id;
  });

  await test('POST /api/auth/register - fail with missing fields', async () => {
    const res = await request('POST', '/api/auth/register', { name: 'No Email' });
    assert.strictEqual(res.status, 400);
  });

  // --- Auth Middleware Tests ---
  console.log('\nAuth Middleware:');

  await test('Protected route - fail without token', async () => {
    const res = await request('GET', '/api/tasks');
    assert.strictEqual(res.status, 401);
  });

  await test('Protected route - fail with invalid token', async () => {
    const res = await request('GET', '/api/tasks', null, 'invalid.token.here');
    assert.strictEqual(res.status, 401);
  });

  // --- Users Tests ---
  console.log('\nUsers:');

  await test('GET /api/users/me - success', async () => {
    const res = await request('GET', '/api/users/me', null, adminToken);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.user);
    assert.strictEqual(res.body.user.email, 'admin@complianceguard.com');
  });

  await test('GET /api/users - list all users', async () => {
    const res = await request('GET', '/api/users', null, adminToken);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.users));
    assert.ok(res.body.users.length >= 1);
  });

  await test('POST /api/users - create user (admin)', async () => {
    const res = await request(
      'POST',
      '/api/users',
      { name: 'Created User', email: `created_${Date.now()}@test.com`, password: 'pass123', role: 'Analyst' },
      adminToken
    );
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.user.id);
  });

  // --- Tasks Tests ---
  console.log('\nTasks:');

  await test('GET /api/tasks - list tasks', async () => {
    const res = await request('GET', '/api/tasks', null, adminToken);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.tasks));
  });

  await test('GET /api/tasks/queue-status - get counts', async () => {
    const res = await request('GET', '/api/tasks/queue-status', null, adminToken);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.queue_status);
    assert.strictEqual(typeof res.body.queue_status.PENDING, 'number');
    assert.strictEqual(typeof res.body.queue_status.COMPLETED, 'number');
  });

  await test('GET /api/tasks/evidences - get evidences', async () => {
    const res = await request('GET', '/api/tasks/evidences', null, adminToken);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.evidences));
  });

  await test('POST /api/tasks - fail without keyword', async () => {
    const res = await request('POST', '/api/tasks', { method: 'API' }, adminToken);
    assert.strictEqual(res.status, 400);
  });

  await test('POST /api/tasks - fail with invalid method', async () => {
    const res = await request('POST', '/api/tasks', { keyword: 'test', method: 'INVALID' }, adminToken);
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('Invalid method'));
  });

  await test('POST /api/tasks - fail with API mode without credentials', async () => {
    const res = await request('POST', '/api/tasks', { keyword: 'test', method: 'API' }, adminToken);
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('GOOGLE_API_KEY'));
  });

  await test('DELETE /api/tasks/clear-completed - success', async () => {
    const res = await request('DELETE', '/api/tasks/clear-completed', null, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.body.count, 'number');
  });

  // --- Swagger ---
  console.log('\nDocs:');

  await test('GET /api-docs/ - Swagger UI accessible', async () => {
    const res = await new Promise((resolve, reject) => {
      http.get(`${BASE_URL}/api-docs/`, (r) => {
        let data = '';
        r.on('data', (c) => (data += c));
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      }).on('error', reject);
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('swagger'));
  });

  // --- Cleanup test user ---
  if (testUserId) {
    await request('DELETE', `/api/users/${testUserId}`, null, adminToken);
  }

  console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
