import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const managerModulePath = join(import.meta.dir, 'planning-manager.ts')
const repoRoot = dirname(dirname(dirname(dirname(dirname(import.meta.dir)))))
const electronBinary = createRequire(import.meta.url)('electron') as string

/**
 * planning-manager 的数据库连接是模块级单例，而 node:sqlite 仅由 Electron 的 Node 22 提供。
 * 因此用 Bun 打包 TypeScript 验证脚本，再用独立 Electron Node 进程执行真实 SQLite 回归。
 */
test('Given a fresh planning database When planning data changes Then isolation, transactions, reminders and optimistic versions stay correct', async () => {
  const home = mkdtempSync(join(tmpdir(), 'snap-planning-'))
  const sourcePath = join(home, 'verify-planning-manager.ts')
  const outputPath = join(home, 'verify-planning-manager.mjs')
  const source = `
    import assert from 'node:assert/strict'
    import { mkdirSync } from 'node:fs'
    import { join } from 'node:path'
    import { DatabaseSync } from 'node:sqlite'
    import * as manager from ${JSON.stringify(managerModulePath)}

    const configDir = join(process.env.HOME, '.snap-dev')
    mkdirSync(configDir, { recursive: true })
    const now = Date.now()

    // Given a fresh database, groups remain independent even when names match.
    const todoGroup = manager.createPlanningGroup({ scope: 'todo', name: '工作' })
    const calendarGroup = manager.createPlanningGroup({ scope: 'calendar', name: '工作' })
    assert.notEqual(todoGroup.id, calendarGroup.id)
    assert.equal(manager.listPlanningGroups('todo').length, 1)
    assert.equal(manager.listPlanningGroups('calendar').length, 1)
    assert.throws(() => manager.createTodo({ title: '错误 Todo', groupId: calendarGroup.id }), /Todo 分组不存在/)
    assert.throws(() => manager.createCalendarEvent({ title: '错误日程', startAt: now, groupId: todoGroup.id }), /日程分组不存在/)

    const tagged = manager.createPlanningTag({ name: '重要' })
    assert.throws(() => manager.createTodo({ title: '不应部分创建', tagIds: [tagged.id, 'missing-tag'] }), /标签不存在/)
    assert.equal(manager.listTodos().some((todo) => todo.title === '不应部分创建'), false)
    assert.throws(() => manager.createCalendarEvent({ title: '不应部分创建的日程', startAt: now, reminders: [{ triggerAt: Number.NaN }] }), /triggerAt/)
    assert.equal(manager.listCalendarEvents().some((event) => event.title === '不应部分创建的日程'), false)

    // Given a persisted Todo, an invalid tag update leaves every prior field intact.
    const todo = manager.createTodo({ title: '稳定 Todo', groupId: todoGroup.id, tagIds: [tagged.id] })
    assert.throws(() => manager.updateTodo({ id: todo.id, title: '不应写入', tagIds: ['missing-tag'], expectedUpdatedAt: todo.updatedAt }), /标签不存在/)
    const unchangedTodo = manager.getTodo(todo.id)
    assert.equal(unchangedTodo.title, '稳定 Todo')
    assert.deepEqual(unchangedTodo.tags.map((tag) => tag.id), [tagged.id])

    // Snoozing or manually moving a default reminder makes it user-owned.
    const dueAt = now + 2 * 60 * 60 * 1000
    const snoozedTodo = manager.createTodo({ title: '推迟提醒', dueAt })
    const defaultReminder = manager.getTodo(snoozedTodo.id).reminders.find((item) => item.origin === 'todo_due_at')
    assert.ok(defaultReminder)
    const snoozed = manager.snoozePlanningReminder(defaultReminder.id, 10)
    assert.equal(snoozed.origin, 'manual')
    manager.updateTodo({ id: snoozedTodo.id, dueAt: null, expectedUpdatedAt: snoozedTodo.updatedAt })
    assert.ok(manager.getTodo(snoozedTodo.id).reminders.some((item) => item.id === defaultReminder.id))

    const movedTodo = manager.createTodo({ title: '手动改期提醒', dueAt: dueAt + 60_000 })
    const movedDefault = manager.getTodo(movedTodo.id).reminders.find((item) => item.origin === 'todo_due_at')
    assert.ok(movedDefault)
    const manuallyMoved = manager.updatePlanningReminder(movedDefault.id, dueAt + 90 * 60_000)
    assert.equal(manuallyMoved.origin, 'manual')
    manager.updateTodo({ id: movedTodo.id, dueAt: dueAt + 3 * 60 * 60 * 1000, expectedUpdatedAt: movedTodo.updatedAt })
    assert.equal(manager.getTodo(movedTodo.id).reminders.find((item) => item.id === movedDefault.id).triggerAt, dueAt + 90 * 60_000)

    // An older window cannot overwrite a newer Todo or calendar event snapshot.
    const firstTodoUpdate = manager.updateTodo({ id: todo.id, title: 'Todo 新版本', expectedUpdatedAt: todo.updatedAt })
    assert.equal(firstTodoUpdate.title, 'Todo 新版本')
    assert.throws(() => manager.updateTodo({ id: todo.id, title: 'Todo 旧版本', expectedUpdatedAt: todo.updatedAt }), /其他窗口修改/)

    const calendarEvent = manager.createCalendarEvent({ title: '稳定日程', startAt: now, groupId: calendarGroup.id, tagIds: [tagged.id] })
    const firstEventUpdate = manager.updateCalendarEvent({ id: calendarEvent.id, title: '日程新版本', expectedUpdatedAt: calendarEvent.updatedAt })
    assert.equal(firstEventUpdate.title, '日程新版本')
    assert.throws(() => manager.updateCalendarEvent({ id: calendarEvent.id, title: '日程旧版本', expectedUpdatedAt: calendarEvent.updatedAt }), /其他窗口修改/)

    // Group deletes only detach their own scope and keep foreign keys consistent.
    assert.equal(manager.deletePlanningGroup('todo', todoGroup.id), true)
    assert.equal(manager.getTodo(todo.id).groupId, undefined)
    assert.equal(manager.getCalendarEvent(calendarEvent.id).groupId, calendarGroup.id)
    assert.equal(manager.deletePlanningGroup('calendar', calendarGroup.id), true)
    assert.equal(manager.getCalendarEvent(calendarEvent.id).groupId, undefined)

    // Deleting a Todo detaches linked events through the foreign key cascade.
    const linkedEvent = manager.createCalendarEvent({ title: '关联 Todo 的日程', startAt: now, todoId: todo.id })
    assert.equal(manager.deleteTodo(todo.id), true)
    assert.equal(manager.getCalendarEvent(linkedEvent.id).todoId, undefined)

    const db = new DatabaseSync(join(configDir, 'planning.db'))
    const eventColumns = db.prepare('PRAGMA table_info(calendar_events)').all().map((column) => column.name)
    assert.ok(eventColumns.includes('calendar_group_id'))
    assert.equal(eventColumns.includes('group_id'), false)
    assert.equal(eventColumns.includes('scratch_excerpt'), false)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11)
  `
  writeFileSync(sourcePath, source)

  try {
    // 每个验证脚本使用独立Bun进程，避免多文件测试共享打包缓存的句柄。
    const build = spawnSync(process.execPath, ['build', sourcePath, '--target=node', '--format=esm', '--external', 'electron', '--external', 'node:sqlite', '--outfile', outputPath], { cwd: repoRoot, encoding: 'utf8' })
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0)

    const result = spawnSync(electronBinary, [outputPath], {
      cwd: repoRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: home, SNAP_DEV: '1' },
      encoding: 'utf8',
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

const snapPlanningFixture = `
  const tables = ['planning_sync_bindings', 'planning_sync_outbox', 'planning_sync_cleanup', 'planning_native_bindings', 'planning_native_outbox', 'planning_native_sync_conflicts', 'planning_sync_profile_conflicts']
  const identity = '11111111-1111-4111-8111-111111111111'
  const snapSnapshot = JSON.stringify({ calendarItemIdentifier: 'native-locator', title: '既有事项', notes: '保留 snapIdentity 与 snap://planning/ 原文', snapIdentity: identity, lastModifiedAt: 123 })
  function createSnapDatabase(db, version = 10) {
    db.exec(\`PRAGMA foreign_keys = ON;
      CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT);
      CREATE TABLE planning_sync_profiles (id TEXT PRIMARY KEY);
      CREATE TABLE planning_native_connections (id TEXT PRIMARY KEY);
      INSERT INTO todos VALUES ('todo-user', '原 Todo', '用户备注 snap 不得替换');
      INSERT INTO planning_sync_profiles VALUES ('profile');
      INSERT INTO planning_native_connections VALUES ('connection');
      CREATE TABLE planning_sync_bindings (profile_id TEXT NOT NULL REFERENCES planning_sync_profiles(id), snap_entity_id TEXT NOT NULL, target_id TEXT, calendar_item_identifier TEXT, calendar_item_external_identifier TEXT, last_synced_hash TEXT, last_synced_at INTEGER, PRIMARY KEY(profile_id,snap_entity_id));
      CREATE TABLE planning_sync_outbox (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES planning_sync_profiles(id), target_id TEXT, operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')), snap_entity_id TEXT NOT NULL, native_start_at INTEGER, attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, last_error TEXT, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(profile_id,snap_entity_id));
      CREATE TABLE planning_sync_cleanup (id TEXT PRIMARY KEY, entity TEXT NOT NULL, target_id TEXT NOT NULL, snap_entity_id TEXT NOT NULL, calendar_item_identifier TEXT, native_start_at INTEGER, attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(entity,target_id,snap_entity_id));
      CREATE TABLE planning_native_bindings (connection_id TEXT NOT NULL REFERENCES planning_native_connections(id), snap_entity_id TEXT NOT NULL, calendar_item_identifier TEXT NOT NULL, due_date_only INTEGER NOT NULL DEFAULT 0, recreate_pending INTEGER NOT NULL DEFAULT 0, last_native_hash TEXT, last_synced_at INTEGER, PRIMARY KEY(connection_id,snap_entity_id), UNIQUE(connection_id,calendar_item_identifier));
      CREATE TABLE planning_native_outbox (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES planning_native_connections(id), operation TEXT NOT NULL CHECK(operation IN ('upsert','hide')), snap_entity_id TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, revision INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(connection_id,snap_entity_id));
      CREATE TABLE planning_native_sync_conflicts (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES planning_native_connections(id), entity TEXT NOT NULL, snap_entity_id TEXT NOT NULL, kind TEXT NOT NULL, native_item_json TEXT, detected_at INTEGER NOT NULL, resolved_at INTEGER, UNIQUE(connection_id,snap_entity_id));
      CREATE TABLE planning_sync_profile_conflicts (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES planning_sync_profiles(id), snap_entity_id TEXT NOT NULL, kind TEXT NOT NULL, native_item_json TEXT, detected_at INTEGER NOT NULL, UNIQUE(profile_id,snap_entity_id));
      CREATE INDEX old_entity_lookup ON planning_sync_outbox(snap_entity_id);
      INSERT INTO planning_sync_bindings VALUES ('profile', 'local-calendar', 'target', 'calendar-locator', 'external-locator', 'unchanged-content-hash', 123);
      INSERT INTO planning_sync_outbox VALUES ('sync-outbox','profile','target','upsert','local-calendar',120,2,500,'保留错误',4,1,2);
      INSERT INTO planning_sync_cleanup VALUES ('cleanup','calendar','old-target','obsolete-local','cleanup-locator',110,1,600,NULL,1,2);
      INSERT INTO planning_native_bindings VALUES ('connection','local-todo','reminder-locator',1,0,NULL,123);
      INSERT INTO planning_native_outbox VALUES ('native-outbox','connection','hide','local-todo',3,700,5,NULL,1,2);
      INSERT INTO planning_native_sync_conflicts VALUES ('native-conflict','connection','reminder','local-todo','changed',NULL,123,NULL);
      INSERT INTO planning_sync_profile_conflicts VALUES ('profile-conflict','profile','local-calendar','changed',NULL,124);
      PRAGMA user_version = 9;\`)
    db.exec('PRAGMA user_version = ' + version)
    db.prepare('UPDATE planning_native_bindings SET last_native_hash=?').run(snapSnapshot)
    db.prepare('UPDATE planning_native_sync_conflicts SET native_item_json=?').run(snapSnapshot)
    db.prepare('UPDATE planning_sync_profile_conflicts SET native_item_json=?').run(snapSnapshot)
  }
`

async function runPlanningSqliteScenario(scenario: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'snap-planning-migration-'))
  const sourcePath = join(home, 'scenario.ts')
  const outputPath = join(home, 'scenario.mjs')
  writeFileSync(sourcePath, `
    import assert from 'node:assert/strict'
    import { join } from 'node:path'
    import { DatabaseSync } from 'node:sqlite'
    import { migratePlanningDatabase } from ${JSON.stringify(managerModulePath)}
    ${snapPlanningFixture}
    ${scenario}
  `)
  try {
    const build = spawnSync(process.execPath, ['build', sourcePath, '--target=node', '--format=esm', '--external', 'electron', '--external', 'node:sqlite', '--outfile', outputPath], { cwd: repoRoot, encoding: 'utf8' })
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0)
    const result = spawnSync(electronBinary, [outputPath], {
      cwd: repoRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: home, SNAP_DEV: '1' },
      encoding: 'utf8',
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  } finally { rmSync(home, { recursive: true, force: true }) }
}

test.each([9, 10])('Given a populated Snap database at schema %s When reopened Then identities, pending work and snapshots remain unchanged', async (version) => {
  await runPlanningSqliteScenario(`
    const databasePath = join(process.env.HOME, 'snap-planning.db')
    const db = new DatabaseSync(databasePath)
    createSnapDatabase(db, ${version})
    const before = JSON.stringify(tables.map((table) => db.prepare('SELECT * FROM ' + table).all()))
    migratePlanningDatabase(db)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11)
    for (const table of tables) {
      const columns = db.prepare('PRAGMA table_info(' + table + ')').all().map((column) => column.name)
      assert.equal(columns.filter((name) => name === 'snap_entity_id').length, 1)
    }
    const binding = db.prepare('SELECT * FROM planning_sync_bindings').get()
    assert.equal(binding.snap_entity_id, 'local-calendar')
    assert.equal(binding.calendar_item_identifier, 'calendar-locator')
    assert.equal(db.prepare('SELECT revision FROM planning_sync_outbox').get().revision, 4)
    assert.equal(db.prepare('SELECT attempts FROM planning_native_outbox').get().attempts, 3)
    for (const [table,column] of [['planning_native_bindings','last_native_hash'],['planning_native_sync_conflicts','native_item_json'],['planning_sync_profile_conflicts','native_item_json']]) {
      assert.equal(db.prepare('SELECT ' + column + ' AS value FROM ' + table).get().value, snapSnapshot)
    }
    assert.equal(JSON.stringify(tables.map((table) => db.prepare('SELECT * FROM ' + table).all())), before)
    migratePlanningDatabase(db)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    db.close()
    const reopened = new DatabaseSync(databasePath)
    migratePlanningDatabase(reopened)
    assert.equal(JSON.stringify(tables.map((table) => reopened.prepare('SELECT * FROM ' + table).all())), before)
    reopened.close()
  `)
})

test('Given an unexpected identity column When checked Then schema version and persisted work roll back', async () => {
  await runPlanningSqliteScenario(`
    const db = new DatabaseSync(':memory:')
    createSnapDatabase(db)
    db.exec('ALTER TABLE planning_native_bindings RENAME COLUMN snap_entity_id TO unknown_entity_id')
    const before = JSON.stringify(tables.map((table) => db.prepare('SELECT * FROM ' + table).all()))
    assert.throws(() => migratePlanningDatabase(db), /缺少 Snap 身份列/)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10)
    assert.equal(JSON.stringify(tables.map((table) => db.prepare('SELECT * FROM ' + table).all())), before)
    db.exec('BEGIN IMMEDIATE; ROLLBACK;')
  `)
})

test('Given a newer database schema When opened Then user data is preserved and downgrade is rejected', async () => {
  await runPlanningSqliteScenario(`
    const db = new DatabaseSync(':memory:')
    createSnapDatabase(db, 12)
    assert.throws(() => migratePlanningDatabase(db), /版本高于当前 Snap/)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12)
    assert.equal(db.prepare('SELECT notes FROM todos').get().notes, '用户备注 snap 不得替换')
  `)
})

test.skipIf(process.platform !== 'darwin')('Given Snap native planning markers When reading them Then only matching UUIDs are recovered and existing URLs stay untouched', () => {
  const nativePath = join(import.meta.dir, '../../../native/eventkit/macos-eventkit-addon.mm')
  const nativeSource = readFileSync(nativePath, 'utf8')
  const extractFunction = (signature: string): string => {
    const start = nativeSource.indexOf(signature)
    if (start < 0) throw new Error(`未找到原生函数: ${signature}`)
    let depth = 0
    for (let index = nativeSource.indexOf('{', start); index < nativeSource.length; index++) {
      if (nativeSource[index] === '{') depth++
      if (nativeSource[index] === '}' && --depth === 0) return nativeSource.slice(start, index + 1)
    }
    throw new Error(`原生函数未闭合: ${signature}`)
  }
  const home = mkdtempSync(join(tmpdir(), 'snap-native-marker-'))
  const sourcePath = join(home, 'marker.mm')
  const executable = join(home, 'marker')
  writeFileSync(sourcePath, `
    #import <Foundation/Foundation.h>
    #import <EventKit/EventKit.h>
    #include <cassert>
    @interface FixtureItem : NSObject
    @property(nonatomic,strong) NSURL *URL;
    @end
    @implementation FixtureItem
    @end
    ${extractFunction('static NSURL *identityURL(')}
    ${extractFunction('static NSString *snapIdentity(')}
    ${extractFunction('static BOOL hasManagedIdentity(')}
    int main() { @autoreleasepool {
      NSString *identity = @"11111111-1111-4111-8111-111111111111";
      FixtureItem *item = [FixtureItem new];
      for (NSString *entity in @[@"calendar", @"reminder"]) {
      for (NSString *scheme in @[@"snap"]) {
        item.URL = [NSURL URLWithString:[NSString stringWithFormat:@"%@://planning/%@/%@", scheme, entity, identity]];
        NSURL *unchanged = item.URL;
        assert(hasManagedIdentity(entity, (EKCalendarItem *)item, identity));
        assert(!hasManagedIdentity([entity isEqualToString:@"calendar"] ? @"reminder" : @"calendar", (EKCalendarItem *)item, identity));
        assert(!hasManagedIdentity(entity, (EKCalendarItem *)item, @"22222222-2222-4222-8222-222222222222"));
        assert([item.URL isEqual:unchanged]);
      }
      }
      for (NSString *url in @[@"https://example.com", @"snap://planning/calendar/not-a-uuid", @"snap://planning/calendar/11111111-1111-4111-8111-111111111111?extra=1"]) {
        item.URL = [NSURL URLWithString:url];
        assert(!hasManagedIdentity(@"calendar", (EKCalendarItem *)item, identity));
      }
      item.URL = nil;
      assert(!hasManagedIdentity(@"calendar", (EKCalendarItem *)item, identity));
      assert(identityURL(@"calendar", @"invalid") == nil);
      assert([identityURL(@"calendar", identity).scheme isEqualToString:@"snap"]);
    } return 0; }
  `)
  try {
    const compile = spawnSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-framework', 'Foundation', '-framework', 'EventKit', sourcePath, '-o', executable], { encoding: 'utf8' })
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0)
    const result = spawnSync(executable, [], { encoding: 'utf8' })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
