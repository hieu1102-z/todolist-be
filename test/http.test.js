const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { once } = require('node:events');
const { deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { createBackend } = require('../src/server');
const { workspaceHttpServer } = require('../src/http');
const { workspace } = require('../src/workspace');

const emulator = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST);
const projectId = 'demo-todolist';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function signUp() {
  const response = await fetch('http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST +
    '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: randomUUID() + '@example.test', password: randomUUID(), returnSecureToken: true })
  });
  assert.equal(response.status, 200);
  return response.json();
}

// The Auth Emulator issues unsigned JWTs. Change claims in the fixture to exercise SDK validation.
function withClaims(token, claims) {
  const [header, body] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return header + '.' + Buffer.from(JSON.stringify({ ...payload, ...claims })).toString('base64url') + '.';
}

async function request(origin, data, token) {
  const response = await fetch(origin + '/v1/workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(data)
  });
  return { status: response.status, body: await response.json() };
}

test('production refuses Firebase emulator settings', () => {
  assert.throws(() => createBackend({
    NODE_ENV: 'production',
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099',
    FIRESTORE_EMULATOR_HOST: 'localhost:8080'
  }), /demo project in development only/);
});

test('workspace logs correlated timings without identity, token or task content', async () => {
  const events = [];
  const server = workspaceHttpServer({
    auth: { async verifyIdToken() { return { uid: 'private-user', email: 'private-email@example.test' }; } },
    service: { async call(actor, data, observe) { observe(12); return { seq: 7 }; } },
    logger: { info(event, fields) { events.push({ event, ...fields }); } }
  });
  const origin = await listen(server);
  try {
    const categoryId = randomUUID();
    const operationId = randomUUID();
    const response = await request(origin, {
      kind: 'TRASH', category_id: categoryId, operation_id: operationId, expected_uid: 'private-user',
      payload: { title: 'private-title' }
    }, 'private-token');
    assert.equal(response.status, 200);
    assert.equal(events.length, 1);
    const [log] = events;
    assert.equal(log.event, 'workspace_request');
    assert.equal(log.operation_id, operationId);
    assert.equal(log.category_hash, createHash('sha256').update(categoryId).digest('hex').slice(0, 12));
    assert.equal(log.server_seq, 7);
    assert.equal(log.firestore_ms, 12);
    assert.ok(log.auth_ms >= 0 && log.elapsed_ms >= 0 && log.received_at_ms > 0);
    assert.doesNotMatch(JSON.stringify(log), /private|expected_uid|payload/);
    assert.ok(!JSON.stringify(log).includes(categoryId));
  } finally {
    await close(server);
  }
});

test('HTTP verifies Firebase ID tokens and rejects invalid sessions', { skip: !emulator, timeout: 30_000 }, async () => {
  const backend = createBackend({ ...process.env, FIREBASE_PROJECT_ID: projectId });
  const origin = await listen(backend.server);
  try {
    const health = await fetch(origin + '/healthz');
    assert.deepEqual(await health.json(), { ok: true });
    assert.deepEqual(health.headers.get('X-Workspace-Features').split(', '),
      ['default-category-v1', 'category-icon-v1', 'sync-metadata-v1']);
    const user = await signUp();
    const read = { kind: 'LIST', expected_uid: user.localId };
    assert.equal((await request(origin, read)).status, 401);
    assert.equal((await request(origin, read, user.idToken)).status, 200);
    const expired = withClaims(user.idToken, { exp: Math.floor(Date.now() / 1000) - 10 });
    assert.deepEqual(await request(origin, read, expired), { status: 401, body: { business_code: 'TOKEN_EXPIRED' } });
    const foreign = withClaims(user.idToken, { aud: 'demo-other', iss: 'https://securetoken.google.com/demo-other' });
    assert.equal((await request(origin, read, foreign)).status, 401);
    const otherAccount = await request(origin, { ...read, expected_uid: 'another-account' }, user.idToken);
    assert.deepEqual(otherAccount, { status: 403, body: { business_code: 'ACCOUNT_CHANGED' } });

    await delay(1_100);
    await getAuth(backend.app).revokeRefreshTokens(user.localId);
    assert.deepEqual(await request(origin, read, user.idToken), {
      status: 401, body: { business_code: 'UNAUTHENTICATED' }
    });
  } finally {
    backend.worker.stop();
    await close(backend.server);
    await deleteApp(backend.app);
  }
});

test('pending purge survives HTTP server restart and replays its durable receipt', { skip: !emulator, timeout: 45_000 }, async () => {
  const settings = { ...process.env, FIREBASE_PROJECT_ID: projectId };
  let backend = createBackend(settings);
  let server = workspaceHttpServer({ auth: getAuth(backend.app), service: workspace(getFirestore(backend.app)) });
  let origin = await listen(server);
  try {
    const user = await signUp();
    const cid = randomUUID();
    const command = (kind, fields) => ({ kind, entity_type: 'CATEGORY', category_id: cid, expected_uid: user.localId,
      operation_id: randomUUID(), client_occurred_at: Date.now(), ...fields });
    const create = command('CREATE', { base_revision: 0, payload: { name: 'Purge after restart' } });
    assert.equal((await request(origin, create, user.idToken)).status, 200);
    assert.equal((await request(origin, command('TRASH', { base_revision: 1 }), user.idToken)).status, 200);
    const purge = command('PURGE', { base_revision: 2 });
    const accepted = await request(origin, purge, user.idToken);
    assert.deepEqual(accepted, { status: 202, body: { result: { pending: true } } });
    assert.equal((await getFirestore(backend.app).collection('cleanupJobs').get()).size, 1);
    assert.deepEqual(await request(origin, purge, user.idToken), accepted);
    const scope = { kind: 'SNAPSHOT', section: 'TASK', category_id: cid, expected_uid: user.localId };
    assert.deepEqual(await request(origin, scope, user.idToken), {
      status: 503, body: { business_code: 'CATEGORY_BUSY' }
    });
    const secondId = randomUUID();
    const other = { ...command('CREATE', { base_revision: 0, payload: { name: 'Unaffected category' } }), category_id: secondId };
    const otherCreate = await request(origin, other, user.idToken);
    assert.equal(otherCreate.status, 200);
    const otherSnapshot = await request(origin, { ...scope, category_id: secondId }, user.idToken);
    assert.equal(otherSnapshot.status, 200);
    assert.equal(otherSnapshot.body.result.seq, otherCreate.body.result.seq);
    const listed = await request(origin, { kind: 'LIST', expected_uid: user.localId, include_sync_metadata: true }, user.idToken);
    assert.deepEqual(listed.body.result.items.find(item => item.id === secondId), {
      id: secondId, role: 'OWNER', server_seq: otherCreate.body.result.seq
    });

    await close(server);
    server = undefined;
    backend.worker.stop();
    await deleteApp(backend.app);
    backend = createBackend(settings);
    server = backend.server;
    origin = await listen(server);
    backend.worker.kick();
    let result;
    for (let attempt = 0; attempt < 50; attempt++) {
      result = await request(origin, purge, user.idToken);
      if (result.status === 200) break;
      assert.equal(result.status, 202);
      await delay(200);
    }
    assert.equal(result.status, 200);
    assert.equal(result.body.result.ok, true);
    assert.deepEqual(await request(origin, purge, user.idToken), result);
    assert.equal((await getFirestore(backend.app).doc('categories/' + cid).get()).exists, false);
  } finally {
    backend.worker.stop();
    if (server?.listening) await close(server);
    await deleteApp(backend.app);
  }
});
