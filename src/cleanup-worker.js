const { FieldPath } = require('firebase-admin/firestore');

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
        try {
          if (await service.cleanupBatch(job.id)) more = true;
          failures.delete(job.id);
        } catch {
          const attempts = (prior?.attempts ?? 0) + 1;
          failures.set(job.id, { attempts, next: Date.now() + Math.min(300_000, pollMs * 2 ** Math.min(5, attempts - 1)) });
          logger.warn('cleanup_batch_failed', { job_id: job.id });
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
