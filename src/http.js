const { createServer } = require('node:http');
const { WorkspaceError, statusByCode } = require('./errors');

const MAX_BODY = 65_536;
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
      response.setHeader('X-Workspace-Features', 'default-category-v1, category-icon-v1');
      send(response, 200, { ok: true });
      return;
    }
    if (path !== '/v1/workspace' || request.method !== 'POST') {
      request.resume();
      send(response, 404, { business_code: 'NOT_FOUND' });
      return;
    }

    let operationId;
    try {
      // Parse a bounded body before spending an Admin SDK call on malformed input.
      const data = await readBody(request);
      if (typeof data.operation_id === 'string' && /^[0-9a-f-]{36}$/.test(data.operation_id)) operationId = data.operation_id;
      const decoded = await authenticate(request, auth);
      const actor = { uid: decoded.uid, token: decoded, lookupEmail: email => auth.getUserByEmail(email) };
      const result = await service.call(actor, data);
      if (result?.pending === true) onPending();
      send(response, result?.pending === true ? 202 : 200, { result });
    } catch (error) {
      request.resume();
      if (error instanceof WorkspaceError) {
        const status = statusByCode[error.code] ?? 500;
        if (status >= 500) logger.warn('workspace_request_failed', {
          business_code: error.details.business_code, operation_id: operationId
        });
        send(response, status, error.details);
      } else {
        logger.error('workspace_request_failed', { business_code: 'INTERNAL', operation_id: operationId });
        send(response, 500, { business_code: 'INTERNAL' });
      }
    }
  });
}

module.exports = { workspaceHttpServer };
