class WorkspaceError extends Error {
  constructor(code, businessCode, details = {}) {
    super(businessCode);
    this.name = 'WorkspaceError';
    this.code = code;
    this.details = { ...details, business_code: businessCode };
  }
}

const statusByCode = {
  'invalid-argument': 400,
  unauthenticated: 401,
  'permission-denied': 403,
  'not-found': 404,
  'already-exists': 409,
  aborted: 409,
  'failed-precondition': 409,
  'resource-exhausted': 429,
  'deadline-exceeded': 504,
  unavailable: 503,
  internal: 500
};

module.exports = { WorkspaceError, statusByCode };
