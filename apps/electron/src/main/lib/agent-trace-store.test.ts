import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta, AgentTraceEvent } from '@snap/shared'
import { AgentTraceStore, normalizeTraceArtifact, selectTraceArtifactBranch, TRACE_JOURNAL_READ_BYTES } from './agent-trace-store'
import { traceExplanationFingerprint } from './agent-trace-explanation-queue'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'snap-trace-test-'))
  directories.push(directory)
  const artifactDirectory = join(directory, 'native')
  mkdirSync(artifactDirectory)
  const session: AgentSessionMeta = { id: 'session-test', title: '测试', createdAt: 1, updatedAt: 1 }
  const options = { directory: join(directory, 'traces'), artifactDirectory,
    getSession: (id: string) => id === session.id ? session : undefined }
  return { directory, artifactDirectory, session, options, store: new AgentTraceStore(options) }
}
function event(input: Partial<AgentTraceEvent> = {}): AgentTraceEvent {
  return { id: 'span-1', sessionId: 'session-test', runId: 'run-1', kind: 'tool', name: 'read',
    source: 'live', status: 'running', startedAt: 10, ...input }
}

describe('Agent trace JSONL and branch evidence', () => {
  test('Given 实时复杂步骤结束 When 后台写解释并重开 Then 只补说明且保留后补绑定和真实状态', () => {
    const { store, options } = fixture()
    const original = event({ status: 'completed', input: { command: 'custom-command --check' }, endedAt: 22, durationMs: 12 })
    store.beginRun('run-1')
    store.append(original)
    store.endRun('run-1')
    store.append({ ...original, metadata: { nativeEntryId: 'late-native-entry' } })
    const explanation = { text: '执行指定的检查命令，是为了进一步定位项目问题。', source: 'model' as const, status: 'ready' as const, version: 2 }
    store.applyExplanations([{ sessionId: original.sessionId, eventId: original.id,
      fingerprint: traceExplanationFingerprint(original), explanation }])
    const loaded = new AgentTraceStore(options).read(original.sessionId)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({ status: 'completed', source: 'history', endedAt: 22, durationMs: 12,
      metadata: { nativeEntryId: 'late-native-entry' }, explanation })
    // 后续原始快照仍不能抹掉已缓存说明。
    store.append({ ...original, metadata: { nativeEntryId: 'late-native-entry', extra: true } })
    expect(store.read(original.sessionId)[0]?.explanation).toEqual(explanation)
  })

  test('Given 原生历史工具与模型共享entry When 补工具解释 Then 不吞掉父模型或同entry其他工具', () => {
    const { store, session, artifactDirectory, options } = fixture()
    const artifact = join(artifactDirectory, 'session.jsonl')
    session.piSessionFile = artifact
    const rows = [
      { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: '检查项目' } },
      { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'custom-command --check' } },
        { type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: '/p/package.json' } },
      ] } },
      { type: 'message', id: 't', parentId: 'a', message: { role: 'toolResult', toolCallId: 'call-1', content: 'ok' } },
    ]
    writeFileSync(artifact, rows.map((row) => JSON.stringify(row)).join('\n'))
    const before = store.read(session.id)
    const tool = before.find((item) => item.id === 'pi:tool:call-1')!
    const explanation = { text: '执行指定的检查命令，是为了进一步定位项目问题。', source: 'model' as const, status: 'ready' as const, version: 2 }
    store.applyExplanations([{ sessionId: session.id, eventId: tool.id, fingerprint: traceExplanationFingerprint(tool), explanation }])
    const loaded = new AgentTraceStore(options).read(session.id)
    expect(loaded.map((item) => item.id)).toEqual(before.map((item) => item.id))
    expect(loaded.find((item) => item.id === tool.id)?.explanation).toEqual(explanation)
    // 复制保留相同native entry的另一份artifact也不能接收原分支排队的说明。
    session.piSessionFile = join(artifactDirectory, 'copied.jsonl')
    writeFileSync(session.piSessionFile, rows.map((row) => JSON.stringify(row)).join('\n'))
    store.applyExplanations([{ sessionId: session.id, eventId: tool.id, fingerprint: traceExplanationFingerprint(tool), explanation }])
    expect(store.read(session.id).find((item) => item.id === tool.id)?.explanation?.status).toBe('pending')
    session.piSessionFile = join(artifactDirectory, 'rewound.jsonl')
    writeFileSync(session.piSessionFile, rows.slice(0, 1).map((row) => JSON.stringify(row)).join('\n'))
    expect(store.read(session.id).map((item) => item.id)).toEqual(['pi:u'])
  })

  test('Given 旧参数或已删除会话 When 解释迟到 Then 不覆盖新版动作且不恢复会话', () => {
    const { session, options } = fixture()
    let deleting = false
    const store = new AgentTraceStore({ ...options, isDeleting: () => deleting })
    const original = event({ status: 'completed', input: { command: 'old-command' } })
    store.append(original)
    store.append({ ...original, input: { command: 'new-command' } })
    const patch = { sessionId: session.id, eventId: original.id, fingerprint: traceExplanationFingerprint(original),
      explanation: { text: '执行旧命令，是为了检查原来的问题。', source: 'model' as const, status: 'ready' as const, version: 2 } }
    store.applyExplanations([patch])
    expect(store.read(session.id)[0]?.explanation?.status).toBe('pending')
    deleting = true
    store.applyExplanations([patch])
    expect(store.read(session.id)).toEqual([])
  })
  test('Given running then completed snapshots When reopening Then upserts one span with its measured times', () => {
    const { store, options } = fixture()
    const updates: AgentTraceEvent[] = []
    store.subscribe((update) => updates.push(update.event))
    store.beginRun('run-1')
    store.append(event())
    store.append(event({ status: 'completed', endedAt: 22, durationMs: 12, output: 'done' }))
    store.endRun('run-1')
    const read = new AgentTraceStore(options).read('session-test')
    expect(updates).toHaveLength(2)
    expect(read).toHaveLength(1)
    expect(read[0]).toMatchObject({ status: 'completed', source: 'history', startedAt: 10, endedAt: 22, durationMs: 12 })
  })

  test('Given a crashed run When reopening Then marks incomplete and never invents an end time', () => {
    const { store, options } = fixture()
    store.beginRun('run-1')
    store.append(event())
    const [read] = new AgentTraceStore(options).read('session-test')
    expect(read?.status).toBe('interrupted')
    expect(read?.endedAt).toBeUndefined()
    expect(read?.durationMs).toBeUndefined()
    expect(read?.metadata?.historyIncomplete).toBe(true)
  })

  test('Given a branched artifact When selecting history Then excludes the abandoned future', () => {
    const rows = [{ type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'start' } },
      { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: 'abandoned' } },
      { type: 'message', id: 'c', parentId: 'a', message: { role: 'assistant', content: 'retained' } }]
    expect(selectTraceArtifactBranch(rows).map((row) => row.id)).toEqual(['a', 'c'])
    expect(JSON.stringify(normalizeTraceArtifact('session-test', rows))).not.toContain('abandoned')
    expect(normalizeTraceArtifact('session-test', rows).every((row) => row.startedAt === undefined)).toBe(true)
    expect(selectTraceArtifactBranch([{ id: 'a', parentId: 'a', type: 'message' }])).toEqual([])
  })

  test('Given rewind replaced the artifact When reading Then never leaks old precise trace beyond the branch', () => {
    const { store, session, artifactDirectory } = fixture()
    const oldArtifact = join(artifactDirectory, 'old.jsonl')
    const currentArtifact = join(artifactDirectory, 'branch.jsonl')
    writeFileSync(oldArtifact, JSON.stringify({ type: 'session', id: 'header' }) + '\n')
    session.piSessionFile = oldArtifact
    store.append(event({ status: 'completed', output: 'removed-future', metadata: { artifactFile: oldArtifact } }))
    writeFileSync(currentArtifact, [
      { type: 'session', id: 'header' },
      { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'retained' } },
    ].map((row) => JSON.stringify(row)).join('\n'))
    session.piSessionFile = currentArtifact
    const read = store.read(session.id)
    expect(JSON.stringify(read)).not.toContain('removed-future')
    expect(read).toHaveLength(1)
    expect(read[0]?.input).toBe('retained')
  })

  test('Given native Schema and failed tool result When reading Then preserves evidence without invented timing', () => {
    const history = normalizeTraceArtifact('session-test', [
      { id: 'sys', parentId: null, type: 'message', message: { role: 'system', content: 'system', toolsAdded: [{ name: 'read', parameters: { type: 'object' } }] } },
      { id: 'a', parentId: 'sys', type: 'message', message: { role: 'assistant', model: 'offline', timestamp: 123,
        content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'missing' } }], stopReason: 'toolUse' } },
      { id: 'r', parentId: 'a', type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'not found' }], isError: true } },
    ])
    expect(history.find((row) => row.kind === 'system')?.schema).toEqual([{ name: 'read', parameters: { type: 'object' } }])
    expect(history.find((row) => row.kind === 'tool')?.status).toBe('error')
    expect(history.find((row) => row.kind === 'tool')?.schema).toEqual({ name: 'read', parameters: { type: 'object' } })
    expect(history.every((row) => row.durationMs === undefined && row.startedAt === undefined)).toBe(true)
  })

  test('Given unknown session or unsafe id When reading Then refuses unrelated paths', () => {
    const { store } = fixture()
    expect(store.read('missing')).toEqual([])
    expect(() => store.read('../secret')).toThrow('无效会话 ID')
  })

  test('Given a journal exceeds the read budget When reading Then retains recent precise events and explicitly marks the missing prefix', () => {
    const { store, options } = fixture()
    mkdirSync(options.directory)
    writeFileSync(join(options.directory, 'session-test.jsonl'), 'x'.repeat(TRACE_JOURNAL_READ_BYTES + 10) + '\n'
      + JSON.stringify({ version: 1, event: event({ status: 'completed', durationMs: 7, endedAt: 17 }) }) + '\n')
    const read = store.read('session-test')
    expect(read).toHaveLength(2)
    expect(read[0]?.metadata?.journalTailOnly).toBe(true)
    expect(read[1]?.durationMs).toBe(7)
  })

  test('Given tools are changed on a branch When reading old calls Then uses the schema active at that exact entry', () => {
    const history = normalizeTraceArtifact('session-test', [
      { id: 's1', parentId: null, type: 'message', message: { role: 'system', toolsAdded: [{ name: 'read', parameters: { version: 2 } }] } },
      { id: 'a1', parentId: 's1', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }] } },
      { id: 's2', parentId: 'a1', type: 'message', message: { role: 'system', toolsAdded: [{ name: 'read', parameters: { version: 2 } }] } },
      { id: 'a2', parentId: 's2', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'read', arguments: {} }] } },
      { id: 's3', parentId: 'a2', type: 'message', message: { role: 'system', toolsRemoved: [{ name: 'read' }] } },
      { id: 'a3', parentId: 's3', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c3', name: 'read', arguments: {} }] } },
    ]).filter((row) => row.kind === 'tool')
    expect(history[0]?.schema).toEqual({ name: 'read', parameters: { version: 2 } })
    expect(history[1]?.schema).toEqual({ name: 'read', parameters: { version: 2 } })
    expect(history[2]?.schema).toBeUndefined()
  })
})
