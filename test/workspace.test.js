const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { doc, getDoc, setDoc } = require('firebase/firestore');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { workspace, requireRole, revision, defaultCategoryId } = require('../src/workspace');

test('authorization and optimistic revision reject stale or unauthorized changes', () => {
  assert.throws(() => requireRole({ status: 'ACTIVE', role: 'EDITOR' }, ['OWNER']), { code: 'permission-denied' });
  assert.throws(() => requireRole({ status: 'REMOVED', role: 'OWNER' }), { code: 'permission-denied' });
  assert.throws(() => revision({ revision: 7 }, 6), error => error.details.business_code === 'REVISION_CONFLICT');
});

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const projectId = 'demo-todolist';
  const owner = 'owner-test';
  const editor = 'editor-test';
  const viewer = 'viewer-test';
  const cid = randomUUID();
  const tid = randomUUID();
  const sid = randomUUID();
  let app, db, service, environment;
  const auth = (uid, verified = true) => ({
    uid,
    token: { email: uid + '@example.test', email_verified: verified, name: uid },
    lookupEmail: async email => ({ uid: email.split('@')[0] })
  });
  const call = (uid, kind, fields = {}, verified = true) => service.call(auth(uid, verified), {
    expected_uid: uid, operation_id: randomUUID(), client_occurred_at: Date.now(), kind, category_id: cid,
    membership_revision: 1, ...fields
  });
  const task = (fields = {}) => ({ entity_type: 'TASK', entity_id: tid, task_id: tid, base_revision: 1, ...fields });
  const member = (uid) => db.doc('categories/' + cid + '/members/' + uid);
  const taskRef = () => db.doc('categories/' + cid + '/tasks/' + tid);
  const business = code => error => error.details?.business_code === code;

  before(async () => {
    environment = await initializeTestEnvironment({
      projectId, firestore: { rules: readFileSync(join(__dirname, '../firestore.rules'), 'utf8') }
    });
    await environment.clearFirestore();
    app = initializeApp({ projectId });
    db = getFirestore(app);
    service = workspace(db);
  });

  after(async () => {
    if (environment) await environment.cleanup();
    if (app) await deleteApp(app);
  });


  test('private default categories synchronize without becoming shareable', async () => {
    const uid = 'default-test';
    const other = 'other-default-test';
    const defaultId = defaultCategoryId(uid);
    const otherId = defaultCategoryId(other);
    const oldTodo = randomUUID();
    const taskId = randomUUID();
    const target = { category_id: defaultId };
    const onlyTask = { ...target, entity_type: 'TASK', task_id: taskId, entity_id: taskId };
    const op = { ...target, operation_id: randomUUID(), client_occurred_at: Date.now() };

    await call(uid, 'CREATE', { category_id: oldTodo, entity_type: 'CATEGORY', payload: { name: 'to do' } });
    await assert.rejects(call(other, 'CREATE', { ...target, entity_type: 'CATEGORY', payload: { name: 'New' } }),
      business('RESERVED_CATEGORY_ID'));
    await assert.rejects(call(other, 'ENSURE_DEFAULT_CATEGORY', target), business('INVALID_ARGUMENT'));
    const [first, second] = await Promise.all([
      call(uid, 'ENSURE_DEFAULT_CATEGORY', op), call(uid, 'ENSURE_DEFAULT_CATEGORY', target)
    ]);
    assert.deepEqual(first, second);
    assert.deepEqual(await call(uid, 'ENSURE_DEFAULT_CATEGORY', op), first);
    await call(other, 'ENSURE_DEFAULT_CATEGORY', { category_id: otherId });

    assert.deepEqual((await call(uid, 'LIST')).items.map(item => item.id), [oldTodo]);
    assert.deepEqual(new Set((await call(uid, 'LIST', { include_default: true })).items.map(item => item.id)),
      new Set([defaultId, oldTodo]));
    assert.deepEqual((await call(other, 'LIST', { include_default: true })).items.map(item => item.id), [otherId]);
    await assert.rejects(call(other, 'SNAPSHOT', { ...target, section: 'TASK' }), business('PERMISSION_DENIED'));
    await assertFails(getDoc(doc(environment.authenticatedContext(other).firestore(), 'categories', defaultId)));
    for (const kind of ['UPDATE', 'TRASH', 'RESTORE', 'PURGE']) {
      await assert.rejects(call(uid, kind, { ...target, entity_type: 'CATEGORY', base_revision: 1 }),
        business('DEFAULT_CATEGORY_PROTECTED'));
    }
    await assert.rejects(call(uid, 'INVITE', { ...target, invitation_id: randomUUID(), role: 'EDITOR',
      email: other + '@example.test' }), business('DEFAULT_CATEGORY_PROTECTED'));

    const created = await call(uid, 'CREATE', { ...onlyTask, base_revision: 0, payload: { title: 'Draft' } });
    await call(uid, 'UPDATE', { ...onlyTask, base_revision: created.revision, payload: { title: 'Updated' } });
    assert.equal((await call(uid, 'SNAPSHOT', { ...target, section: 'TASK' })).rows[0].title, 'Updated');
    const trashed = await call(uid, 'TRASH', { ...onlyTask, base_revision: created.revision + 1 });
    await call(uid, 'RESTORE', { ...onlyTask, base_revision: trashed.revision });

    const occupiedUid = 'occupied-default-test';
    const occupiedId = defaultCategoryId(occupiedUid);
    const occupied = db.doc('categories/' + occupiedId);
    await occupied.set({ id: occupiedId, owner_uid: other, name: 'Existing', name_key: 'existing' });
    await assert.rejects(call(occupiedUid, 'ENSURE_DEFAULT_CATEGORY', { category_id: occupiedId }), business('OBJECT_ID_REUSED'));
    assert.equal((await occupied.get()).data().name, 'Existing');
  });

  test('category appearance is available in snapshots and survives legacy renames', async () => {
    const uid = 'category-style-test';
    const categoryId = randomUUID();
    const target = { category_id: categoryId, entity_type: 'CATEGORY' };
    const snapshot = async () => (await call(uid, 'SNAPSHOT', { ...target, section: 'MEMBER' })).category;

    await assert.rejects(call(uid, 'CREATE', { ...target, payload: { name: 'Styled', icon: 'invalid' } }),
      business('INVALID_ARGUMENT'));
    await assert.rejects(call(uid, 'CREATE', { ...target, payload: { name: 'Styled', color: ['#4F6BED'] } }),
      business('INVALID_ARGUMENT'));
    const created = await call(uid, 'CREATE', { ...target, payload: { name: 'Styled', icon: 'book', color: '#4F6BED' } });
    assert.equal((await snapshot()).icon, 'book');
    assert.equal((await snapshot()).color, '#4F6BED');

    const renamed = await call(uid, 'UPDATE', { ...target, base_revision: created.revision, payload: { name: 'Renamed' } });
    assert.equal((await snapshot()).icon, 'book');
    assert.equal((await snapshot()).color, '#4F6BED');
    await call(uid, 'UPDATE', { ...target, base_revision: renamed.revision, payload: { icon: null } });
    assert.equal((await snapshot()).icon, null);

    const legacy = randomUUID();
    await call(uid, 'CREATE', { ...target, category_id: legacy, payload: { name: 'Legacy' } });
    const category = (await call(uid, 'SNAPSHOT', { category_id: legacy, section: 'MEMBER' })).category;
    assert.equal(category.icon, undefined);
    assert.equal(category.color, null);
  });

  test('sharing, rules, revisions, trash and resumable cleanup on Firestore', async () => {
    await call(owner, 'PROFILE');
    await call(editor, 'PROFILE');
    await call(viewer, 'PROFILE');
    const create = { entity_type: 'CATEGORY', payload: { name: 'Học tập' } };
    await call(owner, 'CREATE', create);
    const creatorOperation = randomUUID();
    const payload = task({ base_revision: 0, payload: { title: 'Nộp bài', description: 'Bản gốc' }, operation_id: creatorOperation });
    // Replay sends precisely the same payload and original timestamp.
    payload.client_occurred_at = Date.now();
    const first = await call(owner, 'CREATE', payload);
    assert.deepEqual(await call(owner, 'CREATE', payload), first);
    for (const [uid, role] of [[editor, 'EDITOR'], [viewer, 'VIEWER']]) {
      const id = randomUUID();
      await call(owner, 'INVITE', { invitation_id: id, role, email: uid + '@example.test' });
      await assert.rejects(call(owner, 'INVITE', { invitation_id: randomUUID(), role, email: uid + '@example.test' }),
        business('INVITATION_ALREADY_PENDING'));
      await assert.rejects(call(uid, 'ACCEPT', { invitation_id: id, base_revision: 1 }, false),
        business('INVITATION_EMAIL_MISMATCH'));
      const acceptance = { invitation_id: id, base_revision: 1, operation_id: randomUUID(), client_occurred_at: Date.now() };
      await call(uid, 'ACCEPT', acceptance);
      assert.equal((await member(uid).get()).data().role, role);
    }

    const anonDb = environment.unauthenticatedContext().firestore();
    const editorDb = environment.authenticatedContext(editor).firestore();
    const ownerDb = environment.authenticatedContext(owner).firestore();
    assert.equal((await call(editor, 'LIST')).items[0].id, cid);
    await assertFails(getDoc(doc(anonDb, 'categories', cid)));
    await assertSucceeds(getDoc(doc(editorDb, 'categories', cid)));
    await assertFails(setDoc(doc(ownerDb, 'categories', cid, 'tasks', tid), { title: 'Bypass' }));
    await assertFails(getDoc(doc(editorDb, 'categoryInvitations', 'example')));
    await assert.rejects(call(viewer, 'UPDATE', task({ payload: { title: 'Không có quyền' } })), business('PERMISSION_DENIED'));
    await assert.rejects(call(owner, 'LIST', { expected_uid: editor }), business('ACCOUNT_CHANGED'));

    const update = await call(editor, 'UPDATE', task({ payload: { title: 'Nộp bài mới' } }));
    assert.equal(update.revision, 2);
    await assert.rejects(call(owner, 'UPDATE', task({ payload: { title: 'Bản cũ' } })), business('REVISION_CONFLICT'));
    const firstPage = await call(editor, 'SNAPSHOT', { section: 'TASK' });
    assert.equal(firstPage.rows[0].title, 'Nộp bài mới');

    const child = { entity_type: 'SUBTASK', task_id: tid, entity_id: sid, base_revision: 0, payload: { title: 'Việc con' } };
    await call(editor, 'CREATE', child);
    await assert.rejects(call(editor, 'SNAPSHOT', { section: 'SUBTASK', seq: firstPage.seq }), business('SNAPSHOT_CHANGED'));
    const subtrash = await call(editor, 'TRASH', { ...child, base_revision: 1 });
    const trashed = await call(editor, 'TRASH', task({ base_revision: 2 }));
    await assert.rejects(call(editor, 'PURGE', task({ base_revision: trashed.revision })), business('PERMISSION_DENIED'));
    assert.ok((await taskRef().get()).data().deleted_at);
    assert.equal((await call(viewer, 'SNAPSHOT', { section: 'TASK' })).rows.length, 0);
    const restored = await call(editor, 'RESTORE', task({ base_revision: trashed.revision }));
    assert.ok((await taskRef().collection('subtasks').doc(sid).get()).data().deleted_at);
    await assert.rejects(call(editor, 'PURGE', { ...child, base_revision: subtrash.revision, payload: null }),
      business('PERMISSION_DENIED'));

    for (const uid of [owner, editor]) {
      await call(uid, 'CREATE', task({ entity_type: 'PARTICIPANT', base_revision: 0, payload: {} }));
    }
    assert.equal((await taskRef().collection('participants').get()).size, 2);
    const leave = await call(editor, 'LEAVE');
    assert.equal(leave.pending, true);
    await assert.rejects(call(editor, 'SNAPSHOT', { section: 'TASK' }), business('PERMISSION_DENIED'));
    for (const job of (await db.collection('cleanupJobs').get()).docs) await service.cleanup(job.id);
    assert.equal((await taskRef().collection('participants').get()).size, 1);
    await assertFails(getDoc(doc(editorDb, 'categories', cid)));

    // More than one cleanup page and more than the previous 200-document cap.
    const batch = db.batch();
    for (let i = 0; i < 205; i++) {
      const id = randomUUID();
      batch.set(taskRef().collection('subtasks').doc(id), { id, category_id: cid, task_id: tid });
    }
    await batch.commit();
    await call(owner, 'TRASH', task({ base_revision: restored.revision }));
    const purge = task({ base_revision: restored.revision + 1, operation_id: randomUUID(), client_occurred_at: Date.now() });
    assert.equal((await call(owner, 'PURGE', purge)).pending, true);
    for (const job of (await db.collection('cleanupJobs').get()).docs) await service.cleanup(job.id);
    assert.equal((await call(owner, 'PURGE', purge)).ok, true);
    assert.equal((await taskRef().get()).exists, false);
    assert.equal((await taskRef().collection('subtasks').get()).empty, true);
    assert.deepEqual(await call(owner, 'CREATE', payload), first);
    assert.equal((await taskRef().get()).exists, false);
  });
}
