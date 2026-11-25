const { FieldPath } = require('firebase-admin/firestore');
const { uuidForTrace, categoryHash, elapsedMs } = require('./sync-trace');

function cleanupWorker(db, service, { logger = console, pollMs = 30_000 } = {}) {
  const failures = new Map();
  let timer;
  let cursor;
  let running = false;
  let stopped = false;
  let requested = false;

  function schedule(delay) {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(tick, delay);
  }

  function kick() {
    if (stopped) return;
    if (running) requested = true;
    else schedule(0);
  }

  async function tick() {
    if (stopped) return;
    running = true;
    let more = false;
    try {
      let query = db.collection('cleanupJobs').where('status', '==', 'PENDING')
        .orderBy(FieldPath.documentId()).limit(8);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const job of page.docs) {
        if (stopped) break;
        const prior = failures.get(job.id);
        if (prior?.next > Date.now()) continue;
        const data = job.data();
        const metadata = {
          job_id: job.id, operation_id: uuidForTrace(data.operation_id), category_hash: categoryHash(data.category_id)
        };
        const started = performance.now();
        try {
          const batch = await service.cleanupBatch(job.id);
          if (batch?.more) more = true;
          else if (batch) logger.info?.('cleanup_receipt_committed', {
            ...metadata, server_seq: batch.seq, elapsed_ms: elapsedMs(started)
          });
          failures.delete(job.id);
        } catch {
          const attempts = (prior?.attempts ?? 0) + 1;
          failures.set(job.id, { attempts, next: Date.now() + Math.min(300_000, pollMs * 2 ** Math.min(5, attempts - 1)) });
          logger.warn('cleanup_batch_failed', { ...metadata, elapsed_ms: elapsedMs(started), attempts });
        }
      }
      cursor = page.size === 8 ? page.docs.at(-1).id : undefined;
      for (const [id, failure] of failures) {
        if (Date.now() - failure.next > 300_000) failures.delete(id);
      }
    } catch {
      cursor = undefined;
      logger.warn('cleanup_scan_failed');
    } finally {
      running = false;
      const soon = requested || more || cursor !== undefined;
      requested = false;
      schedule(soon ? 200 : pollMs);
    }
  }

  return {
    kick,
    stop() {
      stopped = true;
      clearTimeout(timer);
    }
  };
}

module.exports = { cleanupWorker };
