import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta, AgentTraceEvent } from '@snap/shared'
import { getAdapter } from '@snap/core'
import { AgentTraceStore } from './agent-trace-store'
import { AgentTraceExplanationQueue } from './agent-trace-explanation-queue'
import { createTraceExplanationBatchGenerator } from './agent-trace-explanation-generator'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('步骤说明的离线完整链路', () => {
  test('Given 实际事件与假模型传输 When 运行结束补说明并重新打开 Then 使用同id事件且不重复请求或改写计时状态', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'snap-explanation-integration-'))
    directories.push(directory)
    const session: AgentSessionMeta = { id: 'session-1', title: '离线验证', createdAt: 1, updatedAt: 1 }
    const options = { directory: join(directory, 'traces'), artifactDirectory: join(directory, 'native'),
      getSession: (id: string) => id === session.id ? session : undefined }
    const store = new AgentTraceStore(options)
    let requests = 0
    let sentPrompt = ''
    const generate = createTraceExplanationBatchGenerator({
      getChannel: () => ({ id: 'channel-1', provider: 'deepseek', name: '离线', baseUrl: 'https://fixture.invalid',
        apiKey: 'encrypted', enabled: true, models: [{ id: 'model-1', name: '离线', enabled: true }], createdAt: 1, updatedAt: 1 }),
      resolveApiKey: async () => 'fake-key', getAdapter, getProxyUrl: async () => undefined,
      createFetch: () => ({ fetch: async (_url, init) => {
        requests += 1
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
        sentPrompt = body.messages[0]!.content
        const steps = JSON.parse(sentPrompt.slice(sentPrompt.indexOf('\n') + 1)) as Array<{ id: string }>
        return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(steps.map((step) => ({
          id: step.id, text: '执行项目中的检查脚本，是为了进一步定位启动问题。',
        }))) }] }))
      }, close: async () => undefined }),
    })
    const queue = new AgentTraceExplanationQueue({ delayMs: 0, generate, apply: (patches) => store.applyExplanations(patches), isAvailable: () => true })
    store.subscribe(({ event }) => queue.observe(event))
    const context = { sessionId: session.id, channelId: 'channel-1', modelId: 'model-1', task: '排查项目启动问题' }
    queue.setEnabled(session.id, true)
    queue.beginRun('run-1', context)
    store.beginRun('run-1')
    const event: AgentTraceEvent = { id: 'tool-1', sessionId: session.id, runId: 'run-1', name: 'bash', kind: 'tool',
      source: 'live', status: 'completed', startedAt: 100, endedAt: 120, durationMs: 20,
      input: { command: 'custom-command --inspect', api_key: 'fake-tool-secret' }, output: { content: '大量结果不应进入提示词' } }
    store.append(event)
    expect(store.read(session.id)[0]?.explanation?.status).toBe('pending')
    expect(requests).toBe(0)
    store.endRun('run-1')
    queue.endRun('run-1')
    for (let index = 0; index < 20 && store.read(session.id)[0]?.explanation?.status !== 'ready'; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const loaded = new AgentTraceStore(options).read(session.id)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({ id: event.id, status: 'completed', durationMs: 20, endedAt: 120,
      explanation: { source: 'model', status: 'ready' } })
    expect(sentPrompt).not.toContain('fake-tool-secret')
    expect(sentPrompt).toContain('大量结果不应进入提示词')
    loaded.forEach((item) => queue.observe(item, context))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(requests).toBe(1)
    queue.dispose()
  })
})
