import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Agent, type StreamFn } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import type { AgentTraceEvent, AgentSessionMeta } from '@snap/shared'
import { AgentTraceCollector, observeAgentTraceStream } from './agent-trace-collector'
import { AgentTraceStore } from './agent-trace-store'

const model: Model<'openai-completions'> = { id: 'offline-script', name: 'Offline script', api: 'openai-completions',
  provider: 'offline', baseUrl: 'http://127.0.0.1:1/unused', reasoning: false, input: ['text'],
  contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: Date.now(),
    usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('Pi real Engine offline trace integration', () => {
  test('Given actual Pi retry and a blocked tool When reading during retry wait or tool execution Then native history never duplicates precise requests', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'snap-trace-native-retry-'))
    directories.push(directory)
    const nativeDirectory = join(directory, 'native')
    const agentDir = join(directory, 'pi')
    mkdirSync(nativeDirectory)
    mkdirSync(agentDir)
    const settingsManager = SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 50, maxAgentDelayMs: 50 } })
    const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true })
    await resourceLoader.reload()
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, modelsStorePath: join(directory, 'models-cache.json'),
      allowModelNetwork: false, refreshOnCreate: false, credentials: {
        async read() { return undefined }, async list() { return [] },
        async modify() { throw new Error('offline test must not write credentials') },
        async delete() { throw new Error('offline test must not delete credentials') },
      } })
    modelRuntime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl,
      apiKey: 'offline-fixture-key', models: [model] })
    const manager = SessionManager.create(directory, nativeDirectory)
    let enteredTool!: () => void
    let releaseTool!: () => void
    const toolEntered = new Promise<void>((resolve) => { enteredTool = resolve })
    const toolGate = new Promise<void>((resolve) => { releaseTool = resolve })
    const { session: pi } = await createAgentSession({ cwd: directory, agentDir, settingsManager, resourceLoader,
      modelRuntime, model, sessionManager: manager, noTools: 'builtin', thinkingLevel: 'off', customTools: [{
        name: 'wait_fixture', label: '离线暂停工具', description: 'test gate', parameters: Type.Object({}),
        execute: async () => { enteredTool(); await toolGate; return { content: [{ type: 'text', text: 'gate released' }], details: {} } },
      }] })
    const session: AgentSessionMeta = { id: 'native-retry', title: '离线重试', createdAt: 1, updatedAt: 1,
      piSessionFile: manager.getSessionFile(), piEntryBindings: {} }
    const options = { directory: join(directory, 'traces'), artifactDirectory: nativeDirectory,
      getSession: (id: string) => id === session.id ? session : undefined }
    const store = new AgentTraceStore(options)
    store.beginRun('retry-run')
    const trace = new AgentTraceCollector(session.id, (event) => store.append(event), Date.now, 'retry-run')
    trace.bindArtifact(manager.getSessionFile())
    let calls = 0
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream()
      const failed = ++calls === 1
      const message = failed ? { ...assistant([], 'error'), errorMessage: 'TypeError: Failed to fetch' }
        : calls === 3 ? assistant([{ type: 'toolCall', id: 'blocked-fixture', name: 'wait_fixture', arguments: {} }], 'toolUse')
          : assistant([{ type: 'text', text: 'retry-recovered' }], 'stop')
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message })
        if (failed) stream.push({ type: 'error', reason: 'error', error: message })
        else stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message })
      })
      return stream
    }
    pi.agent.streamFunction = observeAgentTraceStream(streamFn, trace)
    const nativeRetryEvents: string[] = []
    let enteredRetry!: () => void
    const retryEntered = new Promise<void>((resolve) => { enteredRetry = resolve })
    const unsubscribe = pi.subscribe((event) => {
      if (event.type === 'auto_retry_start' || event.type === 'tool_execution_start') trace.bindNativeEntries(manager.getEntries())
      if (event.type === 'auto_retry_start' || event.type === 'auto_retry_end') nativeRetryEvents.push(event.type)
      trace.onPiEvent(event, event.type === 'message_end' && event.message.role === 'assistant' ? 'shared-ui-uuid' : undefined)
      if (event.type === 'auto_retry_start') enteredRetry()
    })
    try {
      const prompt = pi.prompt('offline retry')
      await retryEntered
      await Bun.sleep(1)
      const duringRetry = store.read(session.id).filter((row) => row.kind === 'model')
      expect(calls).toBe(1)
      expect(duringRetry).toHaveLength(1)
      expect(duringRetry[0]?.status).toBe('error')
      expect(duringRetry[0]?.metadata?.nativeEntryId).toBeDefined()
      await prompt
      const entries = manager.getEntries()
      trace.bindNativeEntries(entries)
      const successful = entries.findLast((entry) => entry.type === 'message' && entry.message.role === 'assistant'
        && entry.message.stopReason === 'stop')
      session.piEntryBindings = successful ? { 'shared-ui-uuid': successful.id } : {}
      trace.finish(false)
      store.endRun('retry-run')
      const read = new AgentTraceStore(options).read(session.id)
      const models = read.filter((row) => row.kind === 'model')
      expect(calls).toBe(2)
      expect(nativeRetryEvents).toEqual(['auto_retry_start', 'auto_retry_end'])
      expect(models).toHaveLength(2)
      expect(models.map((row) => row.status)).toEqual(['error', 'completed'])
      expect(models.every((row) => row.source === 'history' && typeof row.metadata?.nativeEntryId === 'string')).toBe(true)
      expect(new Set(models.map((row) => row.metadata?.nativeEntryId)).size).toBe(2)
      unsubscribe()

      const toolTrace = new AgentTraceCollector(session.id, (event) => store.append(event), Date.now, 'tool-run')
      toolTrace.bindArtifact(manager.getSessionFile())
      store.beginRun('tool-run')
      pi.agent.streamFunction = observeAgentTraceStream(streamFn, toolTrace)
      pi.subscribe((event) => {
        if (event.type === 'auto_retry_start' || event.type === 'tool_execution_start') toolTrace.bindNativeEntries(manager.getEntries())
        toolTrace.onPiEvent(event, event.type === 'message_end' && event.message.role === 'assistant' ? `tool-ui-${calls}` : undefined)
      })
      const toolPrompt = pi.prompt('offline tool pause')
      await toolEntered
      const duringTool = store.read(session.id)
      expect(calls).toBe(3)
      expect(duringTool.filter((row) => row.kind === 'model')).toHaveLength(3)
      expect(duringTool.filter((row) => row.kind === 'tool')).toHaveLength(1)
      expect(duringTool.find((row) => row.kind === 'tool')?.status).toBe('running')
      releaseTool()
      await toolPrompt
      toolTrace.bindNativeEntries(manager.getEntries())
      toolTrace.finish(false)
      store.endRun('tool-run')
      expect(new AgentTraceStore(options).read(session.id).filter((row) => row.kind === 'model')).toHaveLength(4)
    } finally { releaseTool(); pi.dispose() }
  })

  test('Given actual Pi loop with two model calls and failed/successful tools When completing Then captures real boundaries and reloads without duplicate calls', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'snap-trace-engine-'))
    directories.push(directory)
    const nativeDirectory = join(directory, 'native')
    mkdirSync(nativeDirectory)
    const artifact = join(nativeDirectory, 'session.jsonl')
    const session: AgentSessionMeta = { id: 'session-test', title: '离线测试', createdAt: 1, updatedAt: 1,
      piSessionFile: artifact, piEntryBindings: {} }
    const options = { directory: join(directory, 'traces'), artifactDirectory: nativeDirectory,
      getSession: (id: string) => id === session.id ? session : undefined }
    const store = new AgentTraceStore(options)
    store.beginRun('run-offline')
    const trace = new AgentTraceCollector(session.id, (event) => store.append(event), Date.now, 'run-offline')
    trace.bindArtifact(artifact)
    let calls = 0
    const requests: unknown[] = []
    const streamFn: StreamFn = (_model, context) => {
      requests.push(structuredClone(context))
      calls += 1
      const message = calls === 1 ? assistant([
        { type: 'toolCall', id: 'failed-tool', name: 'read_fixture', arguments: { fail: true } },
        { type: 'toolCall', id: 'success-tool', name: 'read_fixture', arguments: { fail: false } },
      ], 'toolUse') : assistant([{ type: 'text', text: 'offline-complete' }], 'stop')
      const stream = createAssistantMessageEventStream()
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }) })
      return stream
    }
    const agent = new Agent({ initialState: { model, systemPrompt: 'offline-system', tools: [{
      name: 'read_fixture', label: 'Read fixture', description: 'offline fixture only', parameters: Type.Object({ fail: Type.Boolean() }),
      execute: async (_id, params) => {
        await Bun.sleep(2)
        if ((params as { fail: boolean }).fail) throw new Error('expected fixture failure')
        return { content: [{ type: 'text', text: 'fixture-ok' }], details: { path: 'fixture' } }
      },
    }] }, streamFn: observeAgentTraceStream(streamFn, trace), toolExecution: 'sequential' })
    const nativeRows: Record<string, unknown>[] = [{ type: 'session', id: 'header' }]
    let parentId: string | null = null
    let assistantIndex = 0
    agent.subscribe((event) => {
      let uuid: string | undefined
      if (event.type === 'message_end') {
        const id = `entry-${nativeRows.length}`
        if (event.message.role === 'assistant') {
          uuid = `assistant-${++assistantIndex}`
          session.piEntryBindings![uuid] = id
        }
        nativeRows.push({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message: event.message })
        parentId = id
      }
      trace.onPiEvent(event, uuid)
    })
    await agent.prompt('perform offline fixture check')
    trace.finish(false)
    store.endRun('run-offline')
    writeFileSync(artifact, nativeRows.map((row) => JSON.stringify(row)).join('\n'))
    const read = new AgentTraceStore(options).read(session.id)
    const models = read.filter((row) => row.kind === 'model')
    const tools = read.filter((row) => row.kind === 'tool')
    expect(calls).toBe(2)
    expect(models).toHaveLength(2)
    expect(models.every((row) => row.status === 'completed' && row.messageUuid && row.durationMs != null)).toBe(true)
    expect(tools.map((row) => row.status)).toEqual(['error', 'completed'])
    expect(tools.every((row) => row.durationMs != null && row.schema)).toBe(true)
    expect(read.some((row) => row.kind === 'system' && JSON.stringify(row.input).includes('offline-system'))).toBe(true)
    expect(read.filter((row) => row.kind === 'context')).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain('expected fixture failure')
    expect(JSON.stringify(requests[1])).toContain('fixture-ok')
    expect(models[0]?.metadata?.usage).toMatchObject({ input: 10, output: 3 })
  })

  test('Given a real Pi stream blocked until abort When aborting Then model is interrupted rather than completed', async () => {
    const events: AgentTraceEvent[] = []
    const trace = new AgentTraceCollector('session-abort', (event) => events.push(event))
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const streamFn: StreamFn = (_model, _context, options) => {
      const stream = createAssistantMessageEventStream()
      const message = assistant([], 'aborted')
      options?.signal?.addEventListener('abort', () => { stream.push({ type: 'error', reason: 'aborted', error: message }) }, { once: true })
      started()
      return stream
    }
    const agent = new Agent({ initialState: { model, systemPrompt: 'offline' }, streamFn: observeAgentTraceStream(streamFn, trace) })
    agent.subscribe((event) => trace.onPiEvent(event))
    const prompt = agent.prompt('wait offline')
    await ready
    agent.abort()
    await prompt
    trace.finish(true)
    const final = events.filter((event) => event.kind === 'model').at(-1)
    expect(final?.status).toBe('interrupted')
    expect(final?.endedAt).toBeDefined()
  })

  test('Given retry attempts hidden by chat UI and an observer throwing When collecting Then records attempt one and does not throw', () => {
    const rows: AgentTraceEvent[] = []
    const trace = new AgentTraceCollector('session-retry', (event) => rows.push(event))
    trace.onPiEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts: 14, delayMs: 1000, errorMessage: 'offline transient' })
    trace.onPiEvent({ type: 'auto_retry_end', attempt: 1, success: true })
    expect(rows.map((row) => row.status)).toEqual(['running', 'completed'])
    const throwing = new AgentTraceCollector('session-throw', () => { throw new Error('observer failure') })
    expect(() => throwing.onPiEvent({ type: 'message_start', message: { role: 'user', content: 'hello' } })).not.toThrow()
  })

  test('Given Pi emits multiple retry starts and one final end When requests begin Then waits close at the actual request boundary', () => {
    const rows: AgentTraceEvent[] = []
    let clock = 10
    const trace = new AgentTraceCollector('retry-cycle', (event) => rows.push(event), () => clock)
    trace.onPiEvent({ type: 'auto_retry_start', attempt: 1, delayMs: 5, errorMessage: 'temporary' })
    clock = 15
    const first = trace.startRequest(model, { messages: [] })
    trace.finishRequest(first, assistant([], 'error'))
    clock = 20
    trace.onPiEvent({ type: 'auto_retry_start', attempt: 2, delayMs: 10, errorMessage: 'temporary again' })
    clock = 30
    const second = trace.startRequest(model, { messages: [] })
    trace.finishRequest(second, assistant([], 'stop'))
    trace.onPiEvent({ type: 'auto_retry_end', attempt: 2, success: true })
    trace.finish(false)
    const latest = new Map(rows.filter((event) => event.kind === 'retry').map((event) => [event.id, event]))
    expect([...latest.values()].map((event) => event.status)).toEqual(['completed', 'completed', 'completed'])
    expect([...latest.values()].filter((event) => event.name === '重试等待').map((event) => event.durationMs)).toEqual([5, 10])
  })

  test('Given cancellation or missing terminal When finishing Then never reports success or invents a measured end', () => {
    const rows: AgentTraceEvent[] = []
    const trace = new AgentTraceCollector('retry-cancel', (event) => rows.push(event))
    trace.onPiEvent({ type: 'auto_retry_start', attempt: 1, delayMs: 1000 })
    trace.onPiEvent({ type: 'auto_retry_end', attempt: 1, success: false, finalError: 'Retry cancelled' })
    const requestId = trace.startRequest(model, { messages: [] })
    trace.finish(true)
    const retry = rows.filter((event) => event.kind === 'retry').at(-1)
    const modelEvent = rows.filter((event) => event.id === requestId).at(-1)
    expect(retry?.status).toBe('interrupted')
    expect(modelEvent?.status).toBe('interrupted')
    expect(modelEvent?.endedAt).toBeUndefined()
    expect(modelEvent?.durationMs).toBeUndefined()
  })
})
