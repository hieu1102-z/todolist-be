const { createServer } = require('node:http');
const { WorkspaceError, statusByCode } = require('./errors');
const { uuidForTrace, categoryHash, elapsedMs } = require('./sync-trace');

const MAX_BODY = 65_536;
const SYNC_KINDS = new Set(['LIST', 'PROFILE', 'SNAPSHOT', 'TRASH', 'RESTORE', 'PURGE']);
const INVALID_AUTH = new Set([
  'auth/id-token-revoked', 'auth/invalid-id-token', 'auth/argument-error',
  'auth/invalid-argument', 'auth/user-disabled', 'auth/user-not-found'
]);

function send(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] ?? '')) {
    throw new WorkspaceError('invalid-argument', 'INVALID_ARGUMENT');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > MAX_BODY) {
      request.resume();
      throw new WorkspaceError('invalid-argument', 'REQUEST_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // Map malformed JSON and non-object bodies to the same error.
  }
  throw new WorkspaceError('invalid-argument', 'INVALID_ARGUMENT');
}

async function authenticate(request, auth) {
  const header = request.headers.authorization;
  const token = typeof header === 'string' && /^Bearer ([^\s,]+)$/i.exec(header)?.[1];
  if (!token || token.length > 8192) throw new WorkspaceError('unauthenticated', 'UNAUTHENTICATED');
  try {
    return await auth.verifyIdToken(token, true);
  } catch (error) {
    if (error.code === 'auth/id-token-expired') throw new WorkspaceError('unauthenticated', 'TOKEN_EXPIRED');
    if (INVALID_AUTH.has(error.code)) throw new WorkspaceError('unauthenticated', 'UNAUTHENTICATED');
    throw new WorkspaceError('unavailable', 'UNAVAILABLE');
  }
}

function workspaceHttpServer({ auth, service, onPending = () => {}, logger = console }) {
  return createServer({ headersTimeout: 10_000, requestTimeout: 30_000 }, async (request, response) => {
    const path = request.url?.split('?', 1)[0];
    if (path === '/healthz' && request.method === 'GET') {
      response.setHeader('X-Workspace-Features', 'default-category-v1, category-icon-v1, sync-metadata-v1');
      send(response, 200, { ok: true });
      return;
    }
    if (path !== '/v1/workspace' || request.method !== 'POST') {
      request.resume();
      send(response, 404, { business_code: 'NOT_FOUND' });
      return;
    }

    const started = performance.now();
    const timing = { received_at_ms: Date.now() };
    let status, body;
    try {
      // Parse a bounded body before spending an Admin SDK call on malformed input.
      const data = await readBody(request);
      timing.kind = SYNC_KINDS.has(data.kind) ? data.kind : undefined;
      timing.operation_id = uuidForTrace(data.operation_id);
      timing.category_hash = categoryHash(data.category_id);
      const authStarted = performance.now();
      let decoded;
      try {
        decoded = await authenticate(request, auth);
      } finally {
        timing.auth_ms = elapsedMs(authStarted);
      }
      const actor = { uid: decoded.uid, token: decoded, lookupEmail: email => auth.getUserByEmail(email) };
      const result = await service.call(actor, data, ms => { timing.firestore_ms = ms; });
      if (Number.isSafeInteger(result?.seq)) timing.server_seq = result.seq;
      if (result?.pending === true) onPending();
      status = result?.pending === true ? 202 : 200;
      body = { result };
    } catch (error) {
      request.resume();
      if (error instanceof WorkspaceError) {
        status = statusByCode[error.code] ?? 500;
        body = error.details;
      } else {
        status = 500;
        body = { business_code: 'INTERNAL' };
      }
    }
    send(response, status, body);
    const metadata = { ...timing, status, business_code: body.business_code, elapsed_ms: elapsedMs(started) };
    if (status >= 500) logger.warn('workspace_request_failed', metadata);
    else logger.info?.('workspace_request', metadata);
  });
}

module.exports = { workspaceHttpServer };
