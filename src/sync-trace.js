const { createHash } = require('node:crypto');

function uuidForTrace(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)
    ? value : undefined;
}

function categoryHash(value) {
  const id = uuidForTrace(value);
  return id && createHash('sha256').update(id).digest('hex').slice(0, 12);
}

function elapsedMs(started) {
  return Math.round(performance.now() - started);
}

module.exports = { uuidForTrace, categoryHash, elapsedMs };
