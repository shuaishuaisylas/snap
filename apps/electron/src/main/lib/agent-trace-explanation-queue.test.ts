import { describe, expect, test } from 'bun:test'
import type { AgentTraceEvent } from '@snap/shared'
import { AgentTraceExplanationQueue, parseTraceExplanationBatch, traceExplanationFingerprint, type TraceExplanationPatch } from './agent-trace-explanation-queue'

const context = { sessionId: 'session-test', channelId: 'channel-1', modelId: 'model-1', task: '修复项目启动问题' }
function step(id = 'step-1'): AgentTraceEvent {
  return { id, sessionId: context.sessionId, runId: 'run-1', kind: 'tool', name: 'bash', source: 'live',
    status: 'completed', input: { command: `custom-command --check ${id}` } }
}
function reply(prompt: string): string {
  const rows = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as Array<{ id: string }>
  return JSON.stringify(rows.map((row) => ({ id: row.id, text: '执行指定的检查命令，是为了进一步排查项目启动问题。' })))
}
async function tick(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 15)) }
function enabledQueue(options: ConstructorParameters<typeof AgentTraceExplanationQueue>[0]): AgentTraceExplanationQueue {
  const queue = new AgentTraceExplanationQueue(options)
  queue.setEnabled(context.sessionId, true)
  return queue
}

describe('轨迹大白话低优先级队列', () => {
  test('Given 默认关闭 When 读取和观察轨迹 Then 零模型调用且按会话隔离', async () => {
    let calls = 0
    const queue = new AgentTraceExplanationQueue({ delayMs: 0, isAvailable: () => true, apply: () => undefined,
      generate: async ({ prompt }) => { calls += 1; return reply(prompt) } })
    queue.observe(step(), context)
    await tick()
    expect(calls).toBe(0)
    queue.setEnabled('another-session', true)
    queue.observe(step(), context)
    await tick()
    expect(calls).toBe(0)
    queue.setEnabled(context.sessionId, true)
    queue.observe(step(), context)
    await tick()
    expect(calls).toBe(1)
    queue.setEnabled(context.sessionId, false)
    queue.observe(step('after-off'), context)
    await tick()
    expect(calls).toBe(1)
    queue.dispose()
  })

  test('Given 模型正在生成 When 用户关闭开关 Then 取消并丢弃迟到结果且不自动重试', async () => {
    let finish: (() => void) | undefined
    let observedSignal: AbortSignal | undefined
    let calls = 0
    const patches: TraceExplanationPatch[] = []
    const queue = enabledQueue({ delayMs: 0, isAvailable: () => true, apply: (items) => patches.push(...items),
      generate: async ({ prompt, signal }) => {
        calls += 1
        observedSignal = signal
        await new Promise<void>((resolve) => { finish = resolve })
        return reply(prompt)
      } })
    queue.observe(step(), context)
    await tick()
    queue.setEnabled(context.sessionId, false)
    expect(observedSignal?.aborted).toBe(true)
    finish?.()
    await tick()
    expect(patches).toHaveLength(0)
    expect(calls).toBe(1)
    queue.dispose()
  })

  test('Given 普通读取步骤与同轮可见上下文 When 模型生成 Then 任务计划邻近结果均进入请求且不走规则', async () => {
    let prompt = ''
    const event = { ...step(), name: 'read', input: { path: '/project/package.json' }, output: [{ type: 'text', text: 'dev脚本引用了不存在的入口' }] }
    const queue = enabledQueue({ delayMs: 0, isAvailable: () => true, apply: () => undefined,
      getEvidence: () => new Map([[`${event.sessionId}:${event.id}`, {
        task: '修复开发服务启动时找不到入口的问题', plan: '先核对dev命令，再检查入口文件',
        neighbors: [{ relation: 'before', id: 'earlier', name: 'bash', status: 'error', result: '入口文件不存在' }],
      }]]),
      generate: async (input) => { prompt = input.prompt; return reply(input.prompt) } })
    queue.observe(event, context)
    await tick()
    expect(prompt).toContain('修复开发服务启动时找不到入口的问题')
    expect(prompt).toContain('先核对dev命令')
    expect(prompt).toContain('入口文件不存在')
    expect(prompt).toContain('dev脚本引用了不存在的入口')
    queue.dispose()
  })

  test('Given 模型仅计划调用工具 When 解释当前步骤 Then 传公开计划但不把后续工具结果混成已知结果', async () => {
    let prompt = ''
    const event: AgentTraceEvent = { ...step(), kind: 'model', name: 'deepseek-flash', input: undefined,
      output: [{ type: 'toolCall', name: 'bash', arguments: { command: 'git status' } }] }
    const queue = enabledQueue({ delayMs: 0, isAvailable: () => true, apply: () => undefined,
      getEvidence: () => new Map([[`${event.sessionId}:${event.id}`, { task: '解释worktree', neighbors: [
        { relation: 'after', id: 'next-tool', name: 'bash', status: 'error', result: '未来才会出现的工具结果' },
      ] }]]), generate: async (input) => { prompt = input.prompt; return reply(input.prompt) } })
    queue.observe(event, context)
    await tick()
    expect(prompt).toContain('plannedTools')
    expect(prompt).toContain('git status')
    expect(prompt).not.toContain('未来才会出现的工具结果')
    expect(prompt).toContain('不能说当前步骤已经收到after的结果')
    queue.dispose()
  })
  test('Given 正在执行的Agent与8步复杂操作 When 结束运行 Then 不等待解释且批量单并发生成', async () => {
    const patches: TraceExplanationPatch[] = []
    let calls = 0
    let concurrency = 0
    let maxConcurrency = 0
    const queue = enabledQueue({ delayMs: 0, isAvailable: () => true, apply: (items) => patches.push(...items),
      generate: async ({ prompt }) => {
        calls += 1
        concurrency += 1
        maxConcurrency = Math.max(maxConcurrency, concurrency)
        await tick()
        concurrency -= 1
        return reply(prompt)
      } })
    queue.beginRun('run-1', context)
    for (let index = 0; index < 8; index++) queue.observe(step(`step-${index}`))
    await tick()
    expect(calls).toBe(0)
    expect(patches).toHaveLength(0)
    queue.endRun('run-1')
    for (let index = 0; index < 8 && patches.length < 8; index++) await tick()
    expect(calls).toBe(2)
    expect(maxConcurrency).toBe(1)
    expect(patches).toHaveLength(8)
    expect(patches.every((patch) => patch.explanation.source === 'model')).toBe(true)
    queue.dispose()
  })

  test('Given 读取配置测试及同一步重复事件 When 开启说明 Then 全部走模型且重复步骤使用缓存', async () => {
    let calls = 0
    const patches: TraceExplanationPatch[] = []
    const queue = enabledQueue({ delayMs: 0, isAvailable: () => true, apply: (items) => patches.push(...items),
      generate: async ({ prompt }) => { calls += 1; return reply(prompt) } })
    queue.beginRun('run-1', context)
    queue.observe({ ...step('read'), name: 'read', input: { path: '/project/package.json' } })
    queue.observe({ ...step('test'), input: { command: 'bun test' } })
    queue.observe(step())
    queue.observe(step())
    queue.endRun('run-1')
    await tick()
    expect(calls).toBe(1)
    queue.observe(step(), context)
    await tick()
    expect(calls).toBe(1)
    expect(patches).toHaveLength(4)
    queue.dispose()
  })

  test('Given 后台请求在途 When 新Agent开始并收到迟到结果 Then 取消并丢弃结果且等待旧请求收束', async () => {
    let finish: (() => void) | undefined
    let signal: AbortSignal | undefined
    let calls = 0
    const patches: TraceExplanationPatch[] = []
    const queue = enabledQueue({ delayMs: 0, isAvailable: () => true, apply: (items) => patches.push(...items),
      generate: async (input) => {
        calls += 1
        signal = input.signal
        if (calls === 1) await new Promise<void>((resolve) => { finish = resolve })
        return reply(input.prompt)
      } })
    queue.observe(step(), context)
    await tick()
    expect(calls).toBe(1)
    queue.beginRun('run-2', context)
    expect(signal?.aborted).toBe(true)
    queue.endRun('run-2')
    await tick()
    expect(calls).toBe(1)
    finish?.()
    for (let index = 0; index < 5 && patches.length === 0; index++) await tick()
    expect(calls).toBe(2)
    expect(patches).toHaveLength(1)
    queue.dispose()
  })

  test('Given 请求失败与同渠道剩余步骤 When 继续处理 Then 暂停同渠道额外请求并明确降级', async () => {
    let calls = 0
    const patches: TraceExplanationPatch[] = []
    const queue = enabledQueue({ delayMs: 0, isAvailable: () => true, apply: (items) => patches.push(...items),
      generate: async () => { calls += 1; throw new Error('rate limited') } })
    queue.beginRun('run-1', context)
    for (let index = 0; index < 8; index++) queue.observe(step(`failed-${index}`))
    queue.endRun('run-1')
    for (let index = 0; index < 5 && patches.length < 8; index++) await tick()
    expect(calls).toBe(1)
    expect(patches).toHaveLength(8)
    expect(patches.every((patch) => patch.explanation.status === 'unavailable')).toBe(true)
    queue.dispose()
  })

  test('Given 会话已删除或步骤已更新 When 迟到解释返回 Then 不回写旧说明', async () => {
    let finish: (() => void) | undefined
    const patches: TraceExplanationPatch[] = []
    let available = true
    const queue = enabledQueue({ delayMs: 0, isAvailable: () => available,
      apply: (items) => patches.push(...items.filter(() => available)),
      generate: async ({ prompt }) => { await new Promise<void>((resolve) => { finish = resolve }); return reply(prompt) } })
    queue.observe(step(), context)
    await tick()
    available = false
    finish?.()
    await tick()
    expect(patches).toHaveLength(0)
    queue.dispose()
  })

  test('Given Schema图片思考与大结果 When 计算去重快照 Then 不进入指纹内容且绑定补写不重算', () => {
    const event = step()
    expect(traceExplanationFingerprint(event)).toBe(traceExplanationFingerprint({ ...event,
      source: 'history', schema: { secret: 'not needed' }, output: { content: [{ type: 'thinking', thinking: 'x'.repeat(1_000_000) }, { type: 'image', data: 'x'.repeat(1_000_000) }] },
      metadata: { nativeEntryId: 'late-entry' }, explanation: { text: '已保存', source: 'model', status: 'ready', version: 2 } }))
    expect(traceExplanationFingerprint(event)).not.toBe(traceExplanationFingerprint({ ...event, input: { command: 'different-command' } }))
  })

  test('Given 无效JSON重复未知ID或只有动作 When 校验回复 Then 不接受不完整或错位说明', () => {
    const ids = new Set(['0'])
    expect(parseTraceExplanationBatch('[{"id":"0","text":"运行命令"}]', ids).size).toBe(0)
    expect(parseTraceExplanationBatch('[{"id":"wrong","text":"运行命令，是为了检查问题。"}]', ids).size).toBe(0)
    expect(parseTraceExplanationBatch('[{"id":"0","text":"运行命令，是为了检查问题。"},{"id":"0","text":"运行命令，是为了检查问题。"}]', ids).size).toBe(0)
    expect(parseTraceExplanationBatch('```json\n[{"id":"0","text":"运行命令，是为了检查项目问题。"}]\n```', ids).get('0')).toContain('为了')
  })
})
