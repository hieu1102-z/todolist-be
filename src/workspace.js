const { createHash } = require('node:crypto');
const { FieldPath } = require('firebase-admin/firestore');
const { WorkspaceError } = require('./errors');
const { elapsedMs } = require('./sync-trace');

const ROLES = ['OWNER', 'EDITOR', 'VIEWER'];
const CATEGORY_ICONS = ['plus', 'folder', 'check', 'star', 'book', 'work', 'shopping', 'heart'];
const TYPES = ['TASK', 'SUBTASK', 'PARTICIPANT', 'REMINDER'];
const COLLECTIONS = { TASK: 'tasks', SUBTASK: 'subtasks', PARTICIPANT: 'participants', REMINDER: 'reminders' };
const PAGE = 50;
const DAY = 86400000;

function reject(code, businessCode, extra = {}) {
  throw new WorkspaceError(code, businessCode, extra);
}

function check(condition, label = 'INVALID_ARGUMENT') {
  if (!condition) reject('invalid-argument', label);
}

function uuid(value) {
  check(typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value));
  return value;
}

function userId(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !value.includes('/') && value !== '.' && value !== '..' && !value.startsWith('local:'));
  return value;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function defaultCategoryId(uid) {
  const bytes = createHash('sha256').update('todolist/default-category/v1:' + uid).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const id = bytes.subarray(0, 16).toString('hex');
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-');
}

function isDefaultCategory(category) {
  return category?.name_key === '' && category.id === defaultCategoryId(category.owner_uid);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function commandHash(data) {
  const fields = { ...data };
  if (fields.kind === 'INVITE') delete fields.target_uid;
  return hash(canonical(fields));
}

function name(value, max) {
  check(typeof value === 'string');
  const result = value.trim().normalize('NFC');
  check(result.length >= 1 && result.length <= max);
  return result;
}
function emailKey(value) {
  check(typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()));
  return value.trim().toLowerCase();
}
function millis(value) {
  check(Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000);
  return value;
}
function flag(value) {
  check(value === 0 || value === 1);
  return value;
}
function requireRole(member, roles = ROLES) {
  if (member?.status !== 'ACTIVE' || !roles.includes(member.role)) {
    reject('permission-denied', 'PERMISSION_DENIED');
  }
}
function revision(data, base) {
  check(Number.isSafeInteger(base) && base >= 0);
  if (data.revision !== base) reject('failed-precondition', 'REVISION_CONFLICT', { current: data });
}
function must(data) {
  if (!data) reject('not-found', 'NOT_FOUND');
  return data;
}

function workspace(db) {
  const categories = db.collection('categories');
  const users = db.collection('users');
  const invitations = db.collection('categoryInvitations');
  const jobs = db.collection('cleanupJobs');
  const accessSignals = db.collection('accountSignals');
  const ownerName = (uid, key) => db.collection('categoryNameKeys').doc(hash([uid, key]));
  const inviteKey = (cid, email) => db.collection('pendingInvitationKeys').doc(hash([cid, email]));
  const sendSignal = (tx, uid, now, op) => tx.set(accessSignals.doc(uid), { changed_at: now, operation_id: op });
  const read = async (tx, ref) => (await tx.get(ref)).data();
  async function readAll(tx, refs) {
    const unique = new Map(refs.map(ref => [ref.path, ref]));
    if (unique.size === 0) return new Map();
    return new Map((await tx.getAll(...unique.values())).map(doc => [doc.ref.path, doc.data()]));
  }

  function route(cat, data, actor) {
    if (data.entity_type === 'CATEGORY') return [cat, null];
    check(TYPES.includes(data.entity_type));
    const task = cat.collection('tasks').doc(uuid(data.task_id ?? data.entity_id));
    const ref = data.entity_type === 'TASK' ? task :
      task.collection(COLLECTIONS[data.entity_type]).doc(data.entity_type === 'SUBTASK' ? uuid(data.entity_id) : actor);
    return [ref, data.entity_type === 'TASK' ? null : task];
  }

  function patch(type, payload, create) {
    const allowed = {
      CATEGORY: ['name', 'color', 'icon'],
      TASK: ['title', 'description', 'due_at', 'priority', 'repeat_type', 'timezone', 'repeat_anchor_day',
        ...(create ? ['is_done', 'completed_at', 'created_at'] : [])],
      SUBTASK: ['title', 'is_done', 'sort_order'],
      REMINDER: ['remind_at', 'is_enabled'],
      PARTICIPANT: []
    }[type];
    check(payload && !Array.isArray(payload) && typeof payload === 'object');
    check(Object.keys(payload).every(key => allowed.includes(key)));
    const fields = { ...payload };
    if ('name' in fields) {
      fields.name = name(fields.name, 100);
      fields.name_key = fields.name.toLowerCase();
    }
    if ('title' in fields) fields.title = name(fields.title, 200);
    if ('color' in fields) check(fields.color === null ||
      (typeof fields.color === 'string' && /^#[\da-f]{6}$/i.test(fields.color)));
    if ('icon' in fields) check(fields.icon === null || CATEGORY_ICONS.includes(fields.icon));
    if ('description' in fields) check(fields.description === null ||
      (typeof fields.description === 'string' && fields.description.length <= 10000));
    if ('due_at' in fields && fields.due_at !== null) millis(fields.due_at);
    if ('priority' in fields) check([1, 2, 3].includes(fields.priority));
    if ('repeat_type' in fields) check(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'].includes(fields.repeat_type));
    if ('timezone' in fields) {
      check(typeof fields.timezone === 'string' && fields.timezone.length <= 100);
      try { new Intl.DateTimeFormat('en', { timeZone: fields.timezone }); }
      catch { reject('invalid-argument', 'INVALID_TIMEZONE'); }
    }
    if ('repeat_anchor_day' in fields && fields.repeat_anchor_day !== null) {
      check(Number.isInteger(fields.repeat_anchor_day) && fields.repeat_anchor_day >= 1 && fields.repeat_anchor_day <= 31);
    }
    if ('sort_order' in fields) check(Number.isSafeInteger(fields.sort_order) && fields.sort_order >= 0);
    for (const key of ['is_done', 'is_enabled']) if (key in fields) flag(fields[key]);
    for (const key of ['created_at', 'completed_at', 'remind_at']) {
      if (key in fields && !(key === 'completed_at' && fields[key] === null)) millis(fields[key]);
    }
    if (create && type === 'CATEGORY') check('name' in fields);
    if (create && ['TASK', 'SUBTASK'].includes(type)) check('title' in fields);
    if (create && type === 'REMINDER') check('remind_at' in fields);
    return fields;
  }

  async function mutate(auth, data) {
    const uid = userId(auth.uid);
    const op = uuid(data.operation_id);
    const digest = commandHash(data);
    const receipt = db.collection('operationReceipts').doc(hash([uid, op]));
    const now = Date.now();
    return db.runTransaction(async tx => {
      const previous = await read(tx, receipt);
      if (previous) {
        if (previous.digest !== digest) reject('failed-precondition', 'OPERATION_ID_REUSED');
        return previous.result;
      }
      const result = await write(tx, auth, data, now, op);
      if (!result.pending) tx.create(receipt, { digest, result, accepted_at: now });
      return result;
    });
  }

  async function write(tx, auth, data, now, op) {
    const uid = auth.uid;
    let invite;
    let cid = data.category_id;
    if (['ACCEPT', 'DECLINE', 'CANCEL'].includes(data.kind)) {
      invite = must(await read(tx, invitations.doc(uuid(data.invitation_id))));
      if (data.kind !== 'CANCEL' && (auth.token.email_verified !== true ||
          invite.invitee_email_key !== emailKey(auth.token.email))) {
        reject('permission-denied', 'INVITATION_EMAIL_MISMATCH');
      }
      check(cid == null || cid === invite.category_id);
      cid = invite.category_id;
    }
    const cat = categories.doc(uuid(cid));
    const memberRef = cat.collection('members').doc(uid);
    const [category, member] = await Promise.all([read(tx, cat), read(tx, memberRef)]);
    const seq = (category?.server_seq ?? 0) + 1;
    const stamp = { server_seq: seq, server_updated_at: now };
    if (data.kind === 'ENSURE_DEFAULT_CATEGORY') {
      check(cid === defaultCategoryId(uid));
      if (category) {
        if (!isDefaultCategory(category) || category.owner_uid !== uid || category.deleted_at != null ||
            member?.role !== 'OWNER' || member.status !== 'ACTIVE') reject('already-exists', 'OBJECT_ID_REUSED');
        return { revision: category.revision, seq: category.server_seq };
      }
      const creation = db.collection('creationKeys').doc(hash(['CATEGORY', cid]));
      if (member || await read(tx, creation)) reject('already-exists', 'OBJECT_ID_REUSED');
      tx.create(creation, { id: cid });
      tx.create(cat, { id: cid, owner_uid: uid, name: 'Mặc định', name_key: '', color: null,
        deleted_at: null, created_at: now, client_updated_at: millis(data.client_occurred_at), revision: 1, ...stamp });
      tx.create(memberRef, { category_id: cid, user_uid: uid, role: 'OWNER', status: 'ACTIVE',
        joined_at: now, revision: 1, ...stamp });
      sendSignal(tx, uid, now, op);
      return { revision: 1, seq };
    }
    if (data.kind === 'CREATE' && data.entity_type === 'CATEGORY') {
      check(cid[14] !== '8', 'RESERVED_CATEGORY_ID');
      const fields = patch('CATEGORY', data.payload, true);
      const key = ownerName(uid, fields.name_key);
      const creation = db.collection('creationKeys').doc(hash(['CATEGORY', cid]));
      const [existing, used] = await Promise.all([read(tx, key), read(tx, creation)]);
      if (existing) reject('already-exists', 'NAME_ALREADY_EXISTS');
      if (category || used) reject('already-exists', 'OBJECT_ID_REUSED');
      tx.create(creation, { id: cid });
      tx.create(key, { category_id: cid });
      tx.create(cat, { id: cid, owner_uid: uid, color: null, deleted_at: null, created_at: now,
        client_updated_at: millis(data.client_occurred_at), revision: 1, ...fields, ...stamp });
      tx.create(memberRef, { category_id: cid, user_uid: uid, role: 'OWNER', status: 'ACTIVE',
        joined_at: now, revision: 1, ...stamp });
      sendSignal(tx, uid, now, op);
      return { revision: 1, seq };
    }

    must(category);
    if (isDefaultCategory(category)) {
      if (uid !== category.owner_uid) reject('permission-denied', 'PERMISSION_DENIED');
      if (data.entity_type === 'CATEGORY' || ['INVITE', 'ACCEPT', 'DECLINE', 'CANCEL', 'LEAVE', 'REMOVE_MEMBER', 'ROLE'].includes(data.kind)) {
        reject('failed-precondition', 'DEFAULT_CATEGORY_PROTECTED');
      }
    }
    if (category.cleanup_job) {
      if (category.cleanup_job === hash([uid, op])) {
        const job = must(await read(tx, jobs.doc(category.cleanup_job)));
        if (job.digest !== commandHash(data)) reject('failed-precondition', 'OPERATION_ID_REUSED');
        return { pending: true };
      }
      reject('unavailable', 'CATEGORY_BUSY');
    }
    if (data.kind !== 'ACCEPT' && data.kind !== 'DECLINE') requireRole(member);
    if (category.deleted_at != null && !(member?.role === 'OWNER' &&
        ['RESTORE', 'PURGE'].includes(data.kind) && data.entity_type === 'CATEGORY')) {
      reject('failed-precondition', 'CATEGORY_TRASHED');
    }
    const bump = () => tx.update(cat, stamp);

    switch (data.kind) {
      case 'INVITE': {
        requireRole(member, ['OWNER']);
        const keyEmail = emailKey(data.email);
        check(keyEmail !== emailKey(auth.token.email), 'SELF_INVITATION');
        check(['EDITOR', 'VIEWER'].includes(data.role));
        const id = uuid(data.invitation_id);
        const key = inviteKey(cid, keyEmail);
        const pending = await read(tx, key);
        const oldRef = pending && invitations.doc(pending.invitation_id);
        const old = oldRef && await read(tx, oldRef);
        const targetUid = data.target_uid;
        if (targetUid) {
          const targetMember = await read(tx, cat.collection('members').doc(userId(targetUid)));
          if (targetMember?.status === 'ACTIVE') reject('already-exists', 'ALREADY_ACTIVE_MEMBER');
        }
        if (old?.status === 'PENDING' && old.expires_at > now) {
          reject('already-exists', 'INVITATION_ALREADY_PENDING');
        }
        if (old?.status === 'PENDING') tx.update(oldRef, { status: 'EXPIRED', revision: old.revision + 1, ...stamp });
        tx.create(invitations.doc(id), { id, category_id: cid, inviter_uid: uid, invitee_email_key: keyEmail,
          invitee_uid: targetUid ?? null, offered_role: data.role, status: 'PENDING',
          created_at: now, expires_at: now + 7 * DAY, revision: 1, ...stamp });
        tx.set(key, { invitation_id: id, category_id: cid });
        if (targetUid) sendSignal(tx, targetUid, now, op);
        bump();
        return { revision: 1, seq };
      }
      case 'ACCEPT':
      case 'DECLINE':
      case 'CANCEL': {
        if (data.kind === 'CANCEL') requireRole(member, ['OWNER']);
        if (invite.status !== 'PENDING') reject('failed-precondition', 'INVITATION_NOT_PENDING');
        if (invite.expires_at <= now) reject('failed-precondition', 'INVITATION_EXPIRED');
        revision(invite, data.base_revision);
        const status = { ACCEPT: 'ACCEPTED', DECLINE: 'REJECTED', CANCEL: 'CANCELLED' }[data.kind];
        tx.update(invitations.doc(invite.id), { status, revision: invite.revision + 1,
          invitee_uid: data.kind === 'CANCEL' ? invite.invitee_uid : uid, ...stamp });
        tx.delete(inviteKey(cid, invite.invitee_email_key));
        if (status === 'ACCEPTED' && member?.status !== 'ACTIVE') {
          tx.set(memberRef, { category_id: cid, user_uid: uid, status: 'ACTIVE', role: invite.offered_role,
            joined_at: now, revision: (member?.revision ?? 0) + 1, ...stamp });
        }
        if (status === 'ACCEPTED') sendSignal(tx, uid, now, op);
        bump();
        return { status, seq };
      }
      case 'LEAVE':
      case 'REMOVE_MEMBER':
      case 'ROLE': {
        if (data.kind !== 'LEAVE') requireRole(member, ['OWNER']);
        const target = data.kind === 'LEAVE' ? uid : userId(data.target_uid);
        const targetRef = cat.collection('members').doc(target);
        const targetData = must(await read(tx, targetRef));
        requireRole(targetData, ['EDITOR', 'VIEWER']);
        if (data.kind !== 'LEAVE') revision(targetData, data.base_revision);
        const nextRole = data.kind === 'ROLE' ? data.role : targetData.role;
        check(['EDITOR', 'VIEWER'].includes(nextRole));
        const profile = await read(tx, users.doc(target));
        const key = profile?.email ? inviteKey(cid, emailKey(profile.email)) : null;
        const pending = key && await read(tx, key);
        const pendingByUid = await tx.get(invitations.where('category_id', '==', cid)
          .where('invitee_uid', '==', target).where('status', '==', 'PENDING'));
        const pendingRef = pending && invitations.doc(pending.invitation_id);
        const pendingData = pendingRef && await read(tx, pendingRef);
        const related = new Map(pendingByUid.docs.map(doc => [doc.id, doc.data()]));
        if (pendingData?.status === 'PENDING') related.set(pendingData.id, pendingData);
        const status = data.kind === 'ROLE' ? 'ACTIVE' : 'REMOVED';
        for (const item of related.values()) {
          tx.update(invitations.doc(item.id), { status: 'CANCELLED', revision: item.revision + 1, ...stamp });
          tx.delete(inviteKey(cid, item.invitee_email_key));
        }
        tx.update(targetRef, { role: nextRole, status, revision: targetData.revision + 1, ...stamp });
        sendSignal(tx, target, now, op);
        if (status === 'REMOVED' || nextRole === 'VIEWER') {
          const jobId = hash([uid, op]);
          tx.update(cat, { ...stamp, cleanup_job: jobId });
          tx.create(jobs.doc(jobId), {
            actor: uid, operation_id: op, digest: commandHash(data), category_id: cid,
            kind: 'MEMBER', user_uid: target, remove_reminders: status === 'REMOVED', status: 'PENDING'
          });
          return { pending: true };
        }
        bump();
        return { ok: true, seq };
      }
      default: break;
    }

    check(['CREATE', 'UPDATE', 'COMPLETE', 'TRASH', 'RESTORE', 'PURGE', 'REMOVE_REMINDER', 'WITHDRAW'].includes(data.kind));
    const type = data.entity_type;
    if (type === 'CATEGORY' || data.kind === 'PURGE') requireRole(member, ['OWNER']);
    else if (type !== 'REMINDER') requireRole(member, ['OWNER', 'EDITOR']);
    if (member.role !== 'OWNER' && data.membership_revision !== member.revision) {
      reject('failed-precondition', 'MEMBERSHIP_CHANGED');
    }
    if (type === 'PARTICIPANT') check(['CREATE', 'WITHDRAW'].includes(data.kind));
    const [ref, parentRef] = route(cat, data, uid);
    const [old, parent] = await Promise.all([
      ref === cat ? category : read(tx, ref), parentRef ? read(tx, parentRef) : null
    ]);
    if (parentRef) {
      must(parent);
      if (parent.deleted_at != null && data.kind !== 'PURGE') reject('failed-precondition', 'TASK_TRASHED');
    }

    if (data.kind === 'WITHDRAW' || data.kind === 'REMOVE_REMINDER') {
      check(type === (data.kind === 'WITHDRAW' ? 'PARTICIPANT' : 'REMINDER'));
      if (old) {
        if (type === 'REMINDER') revision(old, data.base_revision);
        tx.delete(ref);
        bump();
      }
      return { ok: true, seq: old ? seq : seq - 1 };
    }

    if (data.kind === 'PURGE') {
      check(['CATEGORY', 'TASK', 'SUBTASK'].includes(type));
      check(data.payload == null);
      must(old);
      if (old.deleted_at == null) reject('failed-precondition', 'NOT_IN_TRASH');
      revision(old, data.base_revision);
      const jobId = hash([uid, op]);
      tx.update(cat, { ...stamp, cleanup_job: jobId });
      tx.create(jobs.doc(jobId), {
        actor: uid, operation_id: op, digest: commandHash(data), category_id: cid,
        kind: type, path: ref.path, status: 'PENDING'
      });
      return { pending: true };
    }
    if (old?.deleted_at != null && !['RESTORE'].includes(data.kind)) reject('failed-precondition', 'IN_TRASH');
    if (data.kind === 'RESTORE' && old?.deleted_at == null) reject('failed-precondition', 'NOT_IN_TRASH');
    if (['TRASH', 'RESTORE'].includes(data.kind)) check(['CATEGORY', 'TASK', 'SUBTASK'].includes(type));

    if (data.kind === 'CREATE' && type === 'PARTICIPANT' && old) return { revision: old.revision, seq: seq - 1 };
    if (data.kind === 'CREATE') {
      if (old) reject('already-exists', 'OBJECT_ID_REUSED');
      check(data.base_revision === 0);
    } else revision(must(old), data.base_revision);
    const fields = ['CREATE', 'UPDATE'].includes(data.kind)
      ? patch(type, data.payload, data.kind === 'CREATE') : {};
    const common = { revision: (old?.revision ?? 0) + 1, ...stamp };
    const createdAt = millis(data.client_occurred_at);
    let creation;
    if (data.kind === 'CREATE' && ['TASK', 'SUBTASK'].includes(type)) {
      creation = db.collection('creationKeys').doc(hash([type, ref.id]));
      if (await read(tx, creation)) reject('already-exists', 'OBJECT_ID_REUSED');
    }
    if (type === 'CATEGORY') {
      if (data.kind === 'RESTORE' && data.payload?.name != null) Object.assign(fields, patch(type, { name: data.payload.name }, false));
      const nextKey = fields.name_key ?? old.name_key;
      const lock = ownerName(uid, nextKey);
      if (data.kind === 'RESTORE' || nextKey !== old.name_key) {
        const existing = await read(tx, lock);
        if (existing && existing.category_id !== cid) reject('already-exists', 'NAME_ALREADY_EXISTS');
        tx.set(lock, { category_id: cid });
      }
      if (data.kind === 'TRASH' || nextKey !== old.name_key && data.kind !== 'RESTORE') {
        tx.delete(ownerName(uid, old.name_key));
      }
    }
    if (creation) tx.create(creation, { id: ref.id });
    const deleted = data.kind === 'TRASH' ? { deleted_at: now } :
      data.kind === 'RESTORE' ? { deleted_at: null } : {};
    if (type === 'TASK') {
      if (data.kind === 'CREATE') {
        Object.assign(fields, { id: ref.id, category_id: cid, created_by_uid: uid,
          created_at: fields.created_at ?? now, deleted_at: null, is_done: fields.is_done ?? 0,
          completed_at: fields.completed_at ?? null });
      }
      if (data.kind === 'COMPLETE') {
        fields.is_done = flag(data.payload?.is_done);
        fields.completed_at = fields.is_done ? now : null;
      }
      const effective = { ...old, ...fields };
      check((effective.is_done === 1) === (effective.completed_at != null));
      check((effective.repeat_type ?? 'NONE') === 'NONE' || effective.due_at != null);
    } else if (data.kind === 'COMPLETE') check(false);
    if (data.kind === 'CREATE' && type !== 'TASK') {
      Object.assign(fields, { category_id: cid, task_id: parentRef.id });
      if (type === 'SUBTASK') Object.assign(fields, { id: ref.id, deleted_at: null });
      if (type === 'REMINDER') Object.assign(fields, { user_uid: uid, deleted_at: null });
      if (type === 'PARTICIPANT') Object.assign(fields, { user_uid: uid, joined_at: now });
    }
    tx.set(ref, { ...fields, ...deleted, ...common, client_updated_at: createdAt }, { merge: true });
    if (type !== 'CATEGORY') bump();
    return { revision: common.revision, seq };
  }
  async function listCategories(auth, data) {
    const uid = auth.uid;
    // The document path is the pagination cursor, scoped again to the authenticated UID.
    let query = db.collectionGroup('members').where('user_uid', '==', uid)
      .orderBy(FieldPath.documentId()).limit(PAGE);
    if (data.cursor) query = query.startAfter(db.doc(data.cursor));
    return db.runTransaction(async tx => {
      const rows = await tx.get(query);
      const active = rows.docs.filter(doc => doc.data().status === 'ACTIVE');
      const parents = await readAll(tx, active.map(doc => doc.ref.parent.parent));
      const items = [];
      for (const member of active) {
        const ref = member.ref.parent.parent;
        const category = parents.get(ref.path);
        const { role } = member.data();
        if (!category || (category.deleted_at != null && role !== 'OWNER')) continue;
        if (isDefaultCategory(category) && (data.include_default !== true || category.owner_uid !== uid)) continue;
        const item = { id: ref.id, role };
        if (data.include_sync_metadata === true && Number.isSafeInteger(category.server_seq)) {
          item.server_seq = category.server_seq;
        }
        items.push(item);
      }
      return { items, next: rows.size === PAGE ? rows.docs.at(-1).ref.path : null };
    }, { readOnly: true });
  }

  async function snapshot(auth, data) {
    const cat = categories.doc(uuid(data.category_id));
    const uid = auth.uid;
    return db.runTransaction(async tx => {
      const [category, member] = await Promise.all([read(tx, cat), read(tx, cat.collection('members').doc(uid))]);
      requireRole(member);
      if (!category || isDefaultCategory(category) && category.owner_uid !== uid ||
          category.deleted_at != null && member.role !== 'OWNER') {
        reject('permission-denied', 'PERMISSION_DENIED');
      }
      if (category.cleanup_job && (await read(tx, jobs.doc(category.cleanup_job)))?.kind !== 'MEMBER') {
        reject('unavailable', 'CATEGORY_BUSY');
      }
      const seq = category.server_seq;
      if (data.seq != null && data.seq !== seq) reject('aborted', 'SNAPSHOT_CHANGED');
      const kind = data.section;
      check(['MEMBER', ...TYPES].includes(kind));
      let query = (kind === 'MEMBER' ? cat.collection('members') :
        db.collectionGroup(COLLECTIONS[kind]).where('category_id', '==', cat.id));
      if (kind === 'REMINDER') query = query.where('user_uid', '==', uid);
      query = query.orderBy(FieldPath.documentId()).limit(PAGE);
      if (data.cursor) query = query.startAfter(kind === 'MEMBER' ? data.cursor : db.doc(data.cursor));
      const result = await tx.get(query);
      const candidates = result.docs.map(doc => ({ ref: doc.ref, row: doc.data() }))
        .filter(({ row }) => (kind !== 'MEMBER' || row.status === 'ACTIVE') &&
          (member.role !== 'VIEWER' || row.deleted_at == null));
      const needsParent = ['SUBTASK', 'PARTICIPANT', 'REMINDER'].includes(kind);
      const members = cat.collection('members');
      const relatedRefs = needsParent ? candidates.map(({ ref }) => ref.parent.parent) : [];
      if (kind === 'PARTICIPANT') relatedRefs.push(...candidates.map(({ row }) => members.doc(row.user_uid)));
      const related = await readAll(tx, relatedRefs);
      const visible = [];
      const profiles = new Set([category.owner_uid]);
      for (const { ref, row } of candidates) {
        if (needsParent) {
          const parent = related.get(ref.parent.parent.path);
          if (!parent || (member.role === 'VIEWER' && parent.deleted_at != null)) continue;
        }
        if (kind === 'PARTICIPANT') {
          const participant = related.get(members.doc(row.user_uid).path);
          if (participant?.status !== 'ACTIVE' || participant.role === 'VIEWER') continue;
        }
        visible.push(row);
        if (row.created_by_uid) profiles.add(row.created_by_uid);
        if (row.user_uid) profiles.add(row.user_uid);
      }
      const profileRefs = [...profiles].map(profileUid => users.doc(profileUid));
      const profilesByPath = await readAll(tx, profileRefs);
      const display = profileRefs.map(ref => {
        const profile = profilesByPath.get(ref.path);
        return { uid: ref.id, full_name: profile?.full_name || 'Thành viên', avatar_url: profile?.avatar_url ?? null };
      });
      const { cleanup_job, ...publicCategory } = category;
      return { seq, category: publicCategory, role: member.role, rows: visible, profiles: display,
        next: result.size === PAGE ? (kind === 'MEMBER' ? result.docs.at(-1).id : result.docs.at(-1).ref.path) : null };
    }, { readOnly: true });
  }

  async function inbox(auth, data, sent) {
    const uid = auth.uid;
    const cid = sent ? uuid(data.category_id) : null;
    if (!sent && auth.token.email_verified !== true) reject('failed-precondition', 'EMAIL_NOT_VERIFIED');
    return db.runTransaction(async tx => {
      if (sent) {
        const cat = categories.doc(cid);
        requireRole(await read(tx, cat.collection('members').doc(uid)), ['OWNER']);
        if (isDefaultCategory(await read(tx, cat))) reject('failed-precondition', 'DEFAULT_CATEGORY_PROTECTED');
      }
      const field = sent ? 'category_id' : 'invitee_email_key';
      const value = sent ? cid : emailKey(auth.token.email);
      let query = invitations.where(field, '==', value).orderBy(FieldPath.documentId()).limit(PAGE);
      if (data.cursor) query = query.startAfter(uuid(data.cursor));
      const page = await tx.get(query);
      const items = [];
      for (const doc of page.docs) {
        const row = doc.data();
        const category = await read(tx, categories.doc(row.category_id));
        if (!category || category.deleted_at != null) continue;
        const profile = await read(tx, users.doc(row.inviter_uid));
        items.push({ ...row, status: row.status === 'PENDING' && row.expires_at <= Date.now() ? 'EXPIRED' : row.status,
          category_name: category.name, inviter_name: profile?.full_name ?? '' });
      }
      return { items, next: page.size === PAGE ? page.docs.at(-1).id : null };
    }, { readOnly: true });
  }

  async function cleanupBatch(jobId) {
    const jobRef = jobs.doc(jobId);
    // Each page and the final receipt are guarded by the same durable lock.
      return db.runTransaction(async tx => {
        const job = await read(tx, jobRef);
        if (job?.status !== 'PENDING') return null;
        const cat = categories.doc(job.category_id);
        const category = await read(tx, cat);
        if (category?.cleanup_job !== jobId) throw new Error('Cleanup lock missing');
        const toDelete = [];
        if (job.kind === 'CATEGORY') {
          const invitePage = await tx.get(invitations.where('category_id', '==', cat.id).limit(PAGE));
          for (const doc of invitePage.docs) {
            const invite = doc.data();
            toDelete.push(doc.ref);
            if (invite.status === 'PENDING') toDelete.push(inviteKey(cat.id, invite.invitee_email_key));
          }
          const members = await tx.get(cat.collection('members').limit(PAGE));
          for (const doc of members.docs) toDelete.push(doc.ref);
        }
        if (['CATEGORY', 'TASK', 'MEMBER'].includes(job.kind)) {
          for (const group of ['participants', 'reminders', 'subtasks']) {
            if (job.kind === 'MEMBER' && (group === 'subtasks' || group === 'reminders' && !job.remove_reminders)) continue;
            let query = db.collectionGroup(group).where('category_id', '==', cat.id);
            if (job.kind === 'TASK') query = query.where('task_id', '==', db.doc(job.path).id);
            if (job.kind === 'MEMBER') query = query.where('user_uid', '==', job.user_uid);
            const rows = await tx.get(query.limit(PAGE));
            for (const doc of rows.docs) toDelete.push(doc.ref);
          }
        }
        if (job.kind === 'CATEGORY') {
          const tasks = await tx.get(cat.collection('tasks').limit(PAGE));
          for (const doc of tasks.docs) toDelete.push(doc.ref);
        }
        if (toDelete.length) {
          for (const ref of toDelete) tx.delete(ref);
          if (job.kind === 'CATEGORY') {
            for (const ref of toDelete.filter(ref => ref.parent.id === 'members')) {
              sendSignal(tx, ref.id, Date.now(), job.operation_id);
            }
          }
          return { more: true };
        }
        const now = Date.now();
        const result = { ok: true, seq: category.server_seq + 1 };
        if (job.kind !== 'MEMBER') tx.delete(db.doc(job.path));
        if (job.kind !== 'CATEGORY') tx.update(cat, { cleanup_job: null, server_seq: result.seq, server_updated_at: now });
        tx.create(db.collection('operationReceipts').doc(hash([job.actor, job.operation_id])),
          { digest: job.digest, result, accepted_at: now });
        tx.delete(jobRef);
        return { more: false, seq: result.seq };
      });
  }

  async function cleanup(jobId) {
    while ((await cleanupBatch(jobId))?.more) {
      // Tests and maintenance can wait for full completion; the worker uses one batch at a time.
    }
  }

  return {
    cleanup, cleanupBatch,
    async call(auth, data, onFirestoreElapsed) {
      if (!auth) reject('unauthenticated', 'UNAUTHENTICATED');
      userId(auth.uid);
      check(data && typeof data === 'object' && !Array.isArray(data) && JSON.stringify(data).length <= 65536);
      if (data.expected_uid !== auth.uid) reject('permission-denied', 'ACCOUNT_CHANGED');
      if (data.kind === 'INVITE') {
        // Resolve the recipient on the server. Do not accept a client-supplied target UID.
        let target;
        try { target = await auth.lookupEmail(emailKey(data.email)); }
        catch (error) { if (error.code !== 'auth/user-not-found') throw error; }
        data = { ...data, target_uid: target?.uid ?? null };
      }
      const started = performance.now();
      try {
        switch (data.kind) {
          case 'PROFILE': {
            const fields = {
              uid: auth.uid, email: auth.token.email ?? '', full_name: String(auth.token.name ?? '').slice(0, 100),
              avatar_url: auth.token.picture ?? null
            };
            const ref = users.doc(auth.uid);
            await db.runTransaction(async tx => {
              const previous = await read(tx, ref);
              if (!previous || Object.keys(fields).some(key => previous[key] !== fields[key])) tx.set(ref, fields);
            });
            return { ok: true };
          }
          case 'LIST': return await listCategories(auth, data);
          case 'SNAPSHOT': return await snapshot(auth, data);
          case 'INBOX': return await inbox(auth, data, false);
          case 'SENT': return await inbox(auth, data, true);
          default: return await mutate(auth, data);
        }
      } finally {
        onFirestoreElapsed?.(elapsedMs(started));
      }
    }
  };
}

module.exports = { workspace, canonical, requireRole, revision, defaultCategoryId };
