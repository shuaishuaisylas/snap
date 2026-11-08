import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { AgentSessionMeta, AgentTraceEvent, AgentTraceUpdate, SDKMessage } from '@snap/shared'
import { getTraceExplanation } from '@snap/shared'
import { sanitizeAgentTraceEvent } from './agent-trace-sanitize'
import { traceExplanationFingerprint, type TraceExplanationPatch } from './agent-trace-explanation-queue'

interface TraceStoreOptions {
  directory: string
  artifactDirectory: string
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  getMessages?: (sessionId: string) => SDKMessage[]
  isDeleting?: (sessionId: string) => boolean
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
export const TRACE_JOURNAL_READ_BYTES = 16 * 1024 * 1024
interface TraceRows { rows: Record<string, unknown>[]; limited: boolean }
function readRows(path: string, tail = false): TraceRows {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return { rows: [], limited: false }
  const size = statSync(path).size
  if (!tail && size > 64 * 1024 * 1024) return { rows: [], limited: true }
  let content: string
  const limited = tail && size > TRACE_JOURNAL_READ_BYTES
  if (limited) {
    const descriptor = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(TRACE_JOURNAL_READ_BYTES)
      const count = readSync(descriptor, buffer, 0, buffer.length, size - buffer.length)
      const raw = buffer.subarray(0, count).toString('utf8')
      content = raw.slice(raw.indexOf('\n') + 1)
    } finally { closeSync(descriptor) }
  } else content = readFileSync(path, 'utf8')
  const rows: Record<string, unknown>[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(record(JSON.parse(line))) } catch { /* 容忍崩溃时未完成的末行。 */ }
  }
  return { rows, limited }
}

/** 只沿当前 leaf 的 parent 链读取，绝不把其它 branch 的后续消息带入轨迹。 */
export function selectTraceArtifactBranch(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const entries = rows.filter((row) => typeof row.id === 'string' && row.type !== 'session')
  const byId = new Map(entries.map((row) => [row.id as string, row]))
  const branch: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let current = entries[entries.length - 1]
  while (current) {
    const id = current.id as string
    if (seen.has(id)) return []
    seen.add(id)
    branch.unshift(current)
    if (current.parentId == null) break
    if (typeof current.parentId !== 'string' || !byId.has(current.parentId)) return []
    current = byId.get(current.parentId)!
  }
  return branch
}

export function normalizeTraceArtifact(sessionId: string, rows: Record<string, unknown>[]): AgentTraceEvent[] {
  const branch = selectTraceArtifactBranch(rows)
  const events: AgentTraceEvent[] = []
  const toolEvents = new Map<string, AgentTraceEvent>()
  const toolSchemas = new Map<string, unknown>()
  let roundIndex = 0
  for (const row of branch) {
    const message = record(row.message)
    const metadata = { nativeEntryId: row.id, nativeTimestamp: message.timestamp ?? row.timestamp,
      historyIncomplete: true, contextLayer: 'pi-transcript', timing: 'not-recorded' }
    const base = { id: `pi:${String(row.id)}`, sessionId, source: 'history' as const,
      roundIndex: Math.max(1, roundIndex), metadata }
    if (row.type === 'compaction') {
      events.push({ ...base, kind: 'compaction', name: '历史上下文压缩', status: 'completed', output: row.summary,
        metadata: { ...metadata, tokensBefore: row.tokensBefore, firstKeptEntryId: row.firstKeptEntryId } })
    } else if (row.type === 'context_edit') {
      // 只展示发生过修改及其目标；不把后续删除的旧正文重新当作当前模型输入。
      events.push({ ...base, kind: 'context', name: '历史上下文调整', status: 'completed',
        input: { targetId: row.targetId, omitted: row.replacement === null } })
    } else if (row.type === 'message' && message.role === 'system') {
      for (const value of Array.isArray(message.toolsAdded) ? message.toolsAdded : []) {
        const tool = record(value)
        if (typeof tool.name === 'string') toolSchemas.set(tool.name, value)
      }
      for (const value of Array.isArray(message.toolsRemoved) ? message.toolsRemoved : []) {
        const name = record(value).name
        if (typeof name === 'string') toolSchemas.delete(name)
      }
      events.push({ ...base, kind: 'system', name: '历史系统提示词', status: 'completed', input: message,
        schema: [...toolSchemas.values()] })
    } else if (row.type === 'message' && message.role === 'user') {
      roundIndex += 1
      events.push({ ...base, roundIndex, kind: 'input', name: '历史输入', status: 'completed', input: message.content })
    } else if (row.type === 'message' && message.role === 'assistant') {
      const status = message.stopReason === 'error' ? 'error' : message.stopReason === 'aborted' ? 'interrupted' : 'completed'
      events.push({ ...base, kind: 'model', name: String(message.model ?? '历史模型调用'), status, output: message.content,
        metadata: { ...metadata, model: message.model, provider: message.provider, usage: message.usage,
          stopReason: message.stopReason, error: message.errorMessage } })
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const call = record(block)
        if (call.type !== 'toolCall' || typeof call.id !== 'string') continue
        const event: AgentTraceEvent = { ...base, id: `pi:tool:${call.id}`, kind: 'tool', name: String(call.name),
          status: 'unknown', input: call.arguments, parentId: base.id, schema: toolSchemas.get(String(call.name)),
          metadata: { ...metadata, toolCallId: call.id } }
        events.push(event)
        toolEvents.set(call.id, event)
      }
    } else if (row.type === 'message' && message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const tool = toolEvents.get(message.toolCallId)
      if (tool) {
        tool.status = message.isError ? 'error' : 'completed'
        tool.output = { content: message.content, details: message.details }
      }
    }
  }
  return events.map(sanitizeAgentTraceEvent)
}

/** 追加的是事件快照；相同 id 的终态替换开始态，旧会话原文从不改写。 */
export class AgentTraceStore {
  private readonly listeners = new Set<(update: AgentTraceUpdate) => void>()
  private readonly activeRuns = new Set<string>()
  private readonly openSpans = new Map<string, Map<string, AgentTraceEvent>>()
  constructor(private readonly options: TraceStoreOptions) {}

  private path(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('无效会话 ID')
    return join(this.options.directory, `${sessionId}.jsonl`)
  }

  beginRun(runId: string): void { this.activeRuns.add(runId) }
  endRun(runId: string): void {
    this.activeRuns.delete(runId)
    const spans = this.openSpans.get(runId)
    this.openSpans.delete(runId)
    for (const span of spans?.values() ?? []) this.append({ ...span, status: 'interrupted',
      metadata: { ...span.metadata, historyIncomplete: true, interruption: '运行已结束但未收到该步骤终态；结束时间未记录' } })
  }

  subscribe(listener: (update: AgentTraceUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  append(value: AgentTraceEvent): void {
    try {
      if (!this.options.getSession(value.sessionId) || this.options.isDeleting?.(value.sessionId)) return
      const path = this.path(value.sessionId)
      mkdirSync(this.options.directory, { recursive: true, mode: 0o700 })
      if (lstatSync(this.options.directory).isSymbolicLink() || (existsSync(path) && lstatSync(path).isSymbolicLink())) return
      const event = sanitizeAgentTraceEvent({ ...value, explanation: getTraceExplanation(value) })
      if (event.runId) {
        if (event.status === 'running') {
          const spans = this.openSpans.get(event.runId) ?? new Map<string, AgentTraceEvent>()
          spans.set(event.id, event)
          this.openSpans.set(event.runId, spans)
        } else this.openSpans.get(event.runId)?.delete(event.id)
      }
      appendFileSync(path, JSON.stringify({ version: 1, event }) + '\n', { encoding: 'utf8', mode: 0o600 })
      for (const listener of this.listeners) {
        try { listener({ sessionId: event.sessionId, event }) } catch { /* 独立订阅器不能影响运行。 */ }
      }
    } catch (error) { console.warn('[Agent 轨迹] 无法记录事件:', error instanceof Error ? error.message : '未知错误') }
  }

  /** 后台只补充解释；重新读取当前快照，保留期间后补的 entry 绑定、结果及分支边界。 */
  applyExplanations(patches: TraceExplanationPatch[]): void {
    const sessions = new Set(patches.map((patch) => patch.sessionId))
    for (const sessionId of sessions) {
      const current = new Map(this.read(sessionId).map((event) => [event.id, event]))
      for (const patch of patches.filter((item) => item.sessionId === sessionId)) {
        const event = current.get(patch.eventId)
        if (!event || traceExplanationFingerprint(event) !== patch.fingerprint || getTraceExplanation(event).status === 'ready') continue
        try {
          if (!this.options.getSession(sessionId) || this.options.isDeleting?.(sessionId)) continue
          const path = this.path(sessionId)
          mkdirSync(this.options.directory, { recursive: true, mode: 0o700 })
          if (lstatSync(this.options.directory).isSymbolicLink() || (existsSync(path) && lstatSync(path).isSymbolicLink())) continue
          const updated = sanitizeAgentTraceEvent({ ...event, explanation: patch.explanation })
          // 派生说明单独存储，不能成为新的历史证据或覆盖已更新的原始 span。
          appendFileSync(path, JSON.stringify({ version: 1, explanation: { sessionId, eventId: event.id,
            artifactFile: this.options.getSession(sessionId)?.piSessionFile,
            fingerprint: patch.fingerprint, value: updated.explanation } }) + '\n', { encoding: 'utf8', mode: 0o600 })
          for (const listener of this.listeners) {
            try { listener({ sessionId, event: updated }) } catch { /* 辅助展示监听器不能打断写入。 */ }
          }
        } catch { /* 解释持久化失败不影响原始轨迹。 */ }
      }
    }
  }

  read(sessionId: string): AgentTraceEvent[] {
    const path = this.path(sessionId)
    const session = this.options.getSession(sessionId)
    if (!session || this.options.isDeleting?.(sessionId)) return []
    let artifact: string | undefined
    try {
      if (session.piSessionFile && existsSync(session.piSessionFile) && existsSync(this.options.artifactDirectory)) {
        const resolved = realpathSync(session.piSessionFile)
        const rel = relative(realpathSync(this.options.artifactDirectory), resolved)
        if (rel && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)) artifact = resolved
      }
    } catch { /* 原生记录已丢失时回退展示消息。 */ }
    const latest = new Map<string, AgentTraceEvent>()
    const explanations = new Map<string, { fingerprint: string; value: AgentTraceEvent['explanation'] }>()
    const journal = readRows(path, true)
    for (const row of journal.rows) {
      const explanation = record(row.explanation)
      if (explanation.sessionId === sessionId && typeof explanation.eventId === 'string' && typeof explanation.fingerprint === 'string') {
        if (explanation.artifactFile === session.piSessionFile) explanations.set(explanation.eventId, {
          fingerprint: explanation.fingerprint, value: explanation.value as AgentTraceEvent['explanation'],
        })
        continue
      }
      const event = record(row.event) as unknown as AgentTraceEvent
      if (event.sessionId !== sessionId || typeof event.id !== 'string' || !event.kind) continue
      const recordedArtifact = event.metadata?.artifactFile
      // rewind 会产生新的 artifact；fork 不会复制此日志。只读当前 artifact 的记录。
      if (artifact && recordedArtifact !== session.piSessionFile && recordedArtifact !== artifact) continue
      if (!artifact && session.piSessionFile && recordedArtifact && recordedArtifact !== session.piSessionFile) continue
      const isActive = !!event.runId && this.activeRuns.has(event.runId)
      latest.set(event.id, sanitizeAgentTraceEvent({ ...event, source: isActive ? 'live' : 'history',
        ...(event.status === 'running' && !isActive ? { status: 'interrupted' as const,
          metadata: { ...event.metadata, historyIncomplete: true, interruption: '未收到终态，运行已结束或应用曾重启' } } : {}) }))
    }
    let history: AgentTraceEvent[] = []
    let artifactLimited = false
    if (artifact) {
      const native = readRows(artifact)
      artifactLimited = native.limited
      history = normalizeTraceArtifact(sessionId, native.rows).map((event) => ({ ...event,
        metadata: { ...event.metadata, artifactFile: artifact } }))
    }
    else if (latest.size === 0) {
      // 旧展示记录不包含真实系统/上下文/计时；明确降级，不把聊天历史伪装成 provider 输入。
      history = (this.options.getMessages?.(sessionId) ?? []).flatMap((message, index): AgentTraceEvent[] => {
        if (message.type !== 'assistant' && message.type !== 'user') return []
        const row = message as SDKMessage & { message?: { content?: unknown }; uuid?: string }
        return [{ id: `legacy:${row.uuid ?? index}`, sessionId, kind: message.type === 'assistant' ? 'model' : 'input',
          name: message.type === 'assistant' ? '历史回复（仅展示记录）' : '历史输入（仅展示记录）', status: 'unknown',
          output: row.message?.content, messageUuid: row.uuid, source: 'history',
          metadata: { historyIncomplete: true, contextLayer: 'display-message', timing: 'not-recorded' } }]
      })
    }
    const coveredEntries = new Set<string>()
    const coveredToolCalls = new Set<string>()
    const coveredInputTimestamps = new Set<number>()
    for (const event of latest.values()) {
      const entry = typeof event.metadata?.nativeEntryId === 'string' ? event.metadata.nativeEntryId
        : event.status === 'completed' && event.messageUuid ? session.piEntryBindings?.[event.messageUuid] : undefined
      if (entry) coveredEntries.add(entry)
      if (event.kind === 'tool' && typeof event.metadata?.toolCallId === 'string') coveredToolCalls.add(event.metadata.toolCallId)
      if (event.kind === 'input' && typeof event.metadata?.nativeTimestamp === 'number') coveredInputTimestamps.add(event.metadata.nativeTimestamp)
    }
    history = history.filter((event) => !coveredEntries.has(String(event.metadata?.nativeEntryId))
      && !(event.kind === 'tool' && coveredToolCalls.has(String(event.metadata?.toolCallId)))
      && !(event.kind === 'input' && coveredInputTimestamps.has(Number(event.metadata?.nativeTimestamp))))
    // 历史 branch 消息保持原有顺序；新采集的完整 span 按开始顺序显示。
    const all = [...history, ...[...latest.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))]
      .map((event) => {
        const saved = explanations.get(event.id)
        const matching = saved && saved.fingerprint === traceExplanationFingerprint(event)
          ? sanitizeAgentTraceEvent({ ...event, explanation: saved.value }) : event
        return { ...matching, explanation: getTraceExplanation(matching) }
      })
    if (all.length <= 5000 && !journal.limited && !artifactLimited) return all
    return [{ id: 'trace:history-limit', sessionId, kind: 'context', name: '部分历史轨迹未加载', status: 'unknown', source: 'history',
      metadata: { historyIncomplete: true, omittedEvents: Math.max(0, all.length - 5000), limit: 5000,
        journalTailOnly: journal.limited, nativeArtifactTooLarge: artifactLimited,
        note: artifactLimited ? '原生记录超过64MiB，未加载历史分支；新轨迹仍可读取' : '仅加载最近16MiB或最近5000条轨迹' } }, ...all.slice(-5000)]
  }
}
