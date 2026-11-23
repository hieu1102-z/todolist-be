const { applicationDefault, initializeApp, deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { workspace } = require('./workspace');
const { workspaceHttpServer } = require('./http');
const { cleanupWorker } = require('./cleanup-worker');

function createBackend(env = process.env) {
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is required');
  const emulator = Boolean(env.FIREBASE_AUTH_EMULATOR_HOST || env.FIRESTORE_EMULATOR_HOST);
  if (emulator && (env.NODE_ENV === 'production' || env.RENDER === 'true' ||
      !env.FIREBASE_AUTH_EMULATOR_HOST || !env.FIRESTORE_EMULATOR_HOST || !projectId.startsWith('demo-'))) {
    throw new Error('Use both emulators with a demo project in development only');
  }
  const app = initializeApp(emulator ? { projectId } : { projectId, credential: applicationDefault() });
  const db = getFirestore(app);
  const service = workspace(db);
  const worker = cleanupWorker(db, service);
  const server = workspaceHttpServer({ auth: getAuth(app), service, onPending: worker.kick });
  return { app, server, worker };
}

function main() {
  const port = Number(process.env.PORT ?? 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT is invalid');
  const { app, server, worker } = createBackend();
  server.on('error', () => {
    console.error('workspace_server_failed');
    worker.stop();
    process.exitCode = 1;
  });
  server.listen(port, '0.0.0.0', () => {
    console.log('workspace_server_ready', { port });
    worker.kick();
  });
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    worker.stop();
    server.close(async () => {
      try { await deleteApp(app); } catch { process.exitCode = 1; }
    });
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error('workspace_configuration_invalid', { reason: error.message });
    process.exitCode = 1;
  }
}

module.exports = { createBackend };
