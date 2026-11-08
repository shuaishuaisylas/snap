import { describe, expect, test } from 'bun:test'
import type { AgentTraceEvent, AgentTraceExplanation } from '../types/agent-trace'
import {
  getTraceExplanation, getTraceExplanationInput, getTraceExplanationContext,
  getTraceVisibleExcerpt, needsTraceModelExplanation, TRACE_EXPLANATION_VERSION,
} from './agent-trace-explanation'

function event(input: Partial<AgentTraceEvent> = {}): AgentTraceEvent {
  return { id: 'step', sessionId: 'session', runId: 'run', roundIndex: 1, kind: 'tool', name: 'read',
    status: 'completed', source: 'live', metadata: { artifactFile: '/isolated/current.jsonl' }, ...input }
}

describe('Agent 轨迹仅模型说明 v2', () => {
  test.each(['system', 'context', 'input', 'model', 'tool', 'retry', 'compaction', 'error'] as const)(
    'Given %s 步骤没有模型说明 When 本地展示 Then 返回空文字pending且不生成规则说明', (kind) => {
      const step = event({ kind, input: { path: 'package.json', command: 'bun test' } })
      expect(getTraceExplanation(step)).toEqual({ text: '', source: 'model', status: 'pending', version: 2 })
      expect(needsTraceModelExplanation(step)).toBe(true)
    },
  )

  test.each(['ready', 'pending', 'unavailable'] as const)(
    'Given 当前版本模型说明为%s When 读取 Then 原样返回并避免终态回写循环', (status) => {
      const explanation: AgentTraceExplanation = { text: status === 'unavailable' ? '' : '根据可见步骤推测的说明', source: 'model', status, version: 2 }
      const step = event({ explanation })
      expect(getTraceExplanation(step)).toEqual(explanation)
      expect(needsTraceModelExplanation(step)).toBe(status === 'pending')
    },
  )

  test.each([
    { source: 'rule' as const, version: 1 }, { source: 'recorded' as const, version: 1 },
    { source: 'model' as const, version: 1 }, { source: 'rule' as const, version: 2 },
  ])('Given 旧版本或非模型说明 %j When 展示 Then 不再展示旧规则文字', ({ source, version }) => {
    const step = event({ explanation: { text: '旧规则文字不应继续显示', source, status: 'ready', version } })
    expect(getTraceExplanation(step)).toEqual({ text: '', source: 'model', status: 'pending', version: TRACE_EXPLANATION_VERSION })
    expect(needsTraceModelExplanation(step)).toBe(true)
  })

  test('Given 正在运行的步骤 When 判定补充 Then 不调说明模型', () => {
    expect(needsTraceModelExplanation(event({ status: 'running' }))).toBe(false)
  })

  test('Given 空文字unavailable是模型终态 When 再次读取 Then 不因空串反复调模型', () => {
    const step = event({ explanation: { text: '', source: 'model', status: 'unavailable', version: 2 } })
    expect(getTraceExplanation(step).status).toBe('unavailable')
    expect(needsTraceModelExplanation(step)).toBe(false)
  })

  test.each(['', '   \n\t'])('Given ready只有空白文字 %j When 再次读取 Then 视为pending允许后台补齐而非永久空白', (text) => {
    const step = event({ explanation: { text, source: 'model', status: 'ready', version: 2 } })
    expect(getTraceExplanation(step)).toEqual({ text: '', source: 'model', status: 'pending', version: 2 })
    expect(needsTraceModelExplanation(step)).toBe(true)
  })
})

describe('说明模型可见证据与开销边界', () => {
  test('Given 工具输入和公开结果 When 提取 Then 只保留有界白名单与公开文字', () => {
    const step = event({ input: { path: '/project/main.ts', command: 'custom-command', query: 'button', _intent: '核对按钮位置',
      password: 'input-secret', arbitrary: { secret: 'nested-secret' } },
    output: { content: [{ type: 'text', text: 'visible tool result' }], details: { secret: 'details-secret' }, exitCode: 2 },
    schema: { doNotRead: true } })
    const input = getTraceExplanationInput(step)
    expect(input).toMatchObject({ filePath: '/project/main.ts', command: 'custom-command', query: 'button',
      recordedDescription: '核对按钮位置', exitCode: 2, visibleResult: 'visible tool result' })
    const json = JSON.stringify(input)
    expect(json).not.toContain('input-secret')
    expect(json).not.toContain('nested-secret')
    expect(json).not.toContain('details-secret')
    expect(json).not.toContain('doNotRead')
  })

  test('Given Task/Agent/Skill工具的公开任务参数 When 提取 Then 保留有界动作和任务而不遍历其它字段', () => {
    const task = '检查登录表单的提交路径。'.repeat(1000)
    const input = getTraceExplanationInput(event({ name: 'Agent', input: {
      action: '排查登录流程', prompt: task,
      get thinking() { throw new Error('不得读取隐藏思考') },
      get reasoning() { throw new Error('不得读取隐藏推理') },
      arbitrary: { secret: 'do-not-read' },
    } }))
    expect(input.stepName).toBe('排查登录流程')
    expect(input.toolTask?.length).toBe(480)
    expect(input.toolTask).toContain('登录表单')
    expect(JSON.stringify(input)).not.toContain('do-not-read')
    expect(getTraceExplanationInput(event({ name: 'Skill', input: { skill: 'debug-workflow', instruction: '核对报错日志' } })))
      .toMatchObject({ stepName: 'debug-workflow', toolTask: '核对报错日志' })
  })

  test('Given 模型输出中有公开计划和隐藏思考/图片 When 提取 Then 只读取text且不访问隐藏字段', () => {
    const blocked = (): never => { throw new Error('不应读取隐藏内容') }
    const thinking = { type: 'thinking', get thinking() { return blocked() }, get text() { return blocked() } }
    const reasoning = { type: 'reasoning', get reasoning() { return blocked() }, get text() { return blocked() } }
    const image = { type: 'image', get data() { return blocked() }, get source() { return blocked() }, get text() { return blocked() } }
    const schema = new Proxy({}, { get: blocked, ownKeys: blocked })
    const step = event({ kind: 'model', input: schema, output: [thinking, reasoning, image,
      { type: 'text', text: '先检查用户指出的按钮，再验证点击结果。' }], schema })
    const input = getTraceExplanationInput(step)
    expect(input.visibleResult).toBe('先检查用户指出的按钮，再验证点击结果。')
    expect(input.visibleInput).toBeUndefined()
    expect(JSON.stringify(input)).not.toContain('thinking')
  })

  test('Given 首个模型回复只有公开toolCall而没有text When 解释证据提取 Then 保留待执行计划而不是误称已经拿到结果', () => {
    const input = getTraceExplanationInput(event({ kind: 'model', output: [
      { type: 'toolCall', id: 'read-plan', name: 'read', arguments: { path: '/project/package.json', _intent: '核对开发启动脚本' } },
      { type: 'toolCall', id: 'bash-plan', name: 'bash', arguments: { command: 'bun run dev', description: '观察开发服务是否启动' } },
    ] }))
    expect(input.visibleResult).toBeUndefined()
    expect(input.plannedTools).toEqual([
      { name: 'read', command: undefined, filePath: '/project/package.json', task: undefined, description: '核对开发启动脚本' },
      { name: 'bash', command: 'bun run dev', filePath: undefined, task: undefined, description: '观察开发服务是否启动' },
    ])
  })

  test('Given legacy tool_use与思考/Schema混合 When 提取调用计划 Then 仅白名单参数进入计划且后续公开回复仍保留', () => {
    const blocked = (): never => { throw new Error('不得读取隐藏或完整载荷') }
    const input = getTraceExplanationInput(event({ kind: 'model', output: [
      { type: 'thinking', get thinking() { return blocked() }, get arguments() { return blocked() } },
      { type: 'tool_use', name: 'Agent', input: { prompt: '核对登录流程', description: '检查表单提交',
        get secret() { return blocked() }, get reasoning() { return blocked() }, schema: { secret: 'never-read' } } },
      { type: 'text', text: '已经汇总这轮公开检查结果，但没有发布。' },
    ], schema: new Proxy({}, { get: blocked, ownKeys: blocked }) }))
    expect(input.plannedTools).toEqual([{ name: 'Agent', command: undefined, filePath: undefined,
      task: '核对登录流程', description: '检查表单提交' }])
    expect(input.visibleResult).toBe('已经汇总这轮公开检查结果，但没有发布。')
    expect(JSON.stringify(input)).not.toContain('never-read')
    const final = getTraceExplanationInput(event({ kind: 'model', output: [{ type: 'text', text: '这是最终的公开答复。' }] }))
    expect(final.visibleResult).toBe('这是最终的公开答复。')
    expect(final.plannedTools).toBeUndefined()
  })

  test('Given 大量或巨大的公开工具调用 When 提取 Then 最多4项且逐字段截断，不处理工具结果中的伪计划', () => {
    const output = Array.from({ length: 1000 }, (_, index) => ({ type: 'toolCall', name: `tool-${index}`,
      arguments: { command: 'x'.repeat(10000), path: 'p'.repeat(10000), task: 't'.repeat(10000), description: 'd'.repeat(10000) } }))
    const input = getTraceExplanationInput(event({ kind: 'model', output }))
    expect(input.plannedTools).toHaveLength(4)
    expect(input.plannedTools![0]!.command?.length).toBe(320)
    expect(input.plannedTools![0]!.filePath?.length).toBe(240)
    expect(input.plannedTools![0]!.task?.length).toBe(320)
    expect(input.plannedTools![0]!.description?.length).toBe(160)
    expect(getTraceExplanationInput(event({ kind: 'tool', output })).plannedTools).toBeUndefined()
  })

  test('Given 工具结果含JSON/env/URL凭据 When 提取公开摘录 Then 常见认证值不进入说明输入', () => {
    const step = event({ input: { command: 'API_KEY="fake-command-secret" custom-command',
      url: 'https://user:fake-url-secret@example.test/path?access_token=fake-query-secret' },
    output: '{"password":"fake-json-secret","visible":"normal diagnostic"}\nAuthorization: Bearer fake-bearer-secret' })
    const serialized = JSON.stringify(getTraceExplanationInput(step))
    for (const secret of ['fake-command-secret', 'fake-url-secret', 'fake-query-secret', 'fake-json-secret', 'fake-bearer-secret']) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).toContain('normal diagnostic')
  })

  test('Given 大型公开输入/结果与深层任意对象 When 提取 Then 摘录有界且不遍历任意字段', () => {
    const huge = 'a'.repeat(100000)
    const step = event({ kind: 'input', input: huge })
    expect(getTraceExplanationInput(step).visibleInput?.length).toBe(1200)
    expect(getTraceVisibleExcerpt(huge, 1600)?.length).toBe(1600)
    const nested = { content: [{ type: 'text', text: huge }], get secret() { throw new Error('不能读secret') } }
    expect(getTraceExplanationInput(event({ output: nested })).visibleResult?.length).toBe(1200)
    expect(getTraceVisibleExcerpt({ arbitrary: { content: 'do-not-walk' }, secret: 'do-not-read' })).toBeUndefined()
    expect(getTraceVisibleExcerpt({ type: 'image', source: { data: huge } })).toBeUndefined()
  })

  test('Given 引号凭据的闭合位置超出摘录边界 When 取有界摘要 Then 仍隐藏整个已截取值', () => {
    const secret = 'truncated secret '.repeat(1000)
    const input = getTraceExplanationInput(event({ input: { command: `API_KEY="${secret}" custom` },
      output: `{"password":"${secret}","normal":"diagnostic"}` }))
    expect(input.command).not.toContain('truncated secret')
    expect(input.visibleResult).not.toContain('truncated secret')
  })

  test('Given 说明/瞬时source变化 When 计算输入摘要 Then 内容稳定且不包含说明本身', () => {
    const step = event({ input: { command: 'custom' }, output: { content: [{ type: 'text', text: 'public' }] } })
    const input = getTraceExplanationInput(step)
    expect(getTraceExplanationInput({ ...step, source: 'history', explanation: { text: 'new explanation', source: 'model', status: 'ready', version: 2 } })).toEqual(input)
    expect(JSON.stringify(input)).not.toContain('explanation')
  })
})

describe('说明上下文的会话/运行/轮次/分支边界', () => {
  function scoped() {
    const user = event({ id: 'user', kind: 'input', input: '请修改登录按钮的位置，并检查点击后的页面。' })
    const plan = event({ id: 'plan', kind: 'model', output: [{ type: 'thinking', thinking: 'never-use' },
      { type: 'text', text: '我先读取组件，再检查页面。' }] })
    const before = event({ id: 'before', name: 'read', input: { path: 'Button.tsx' }, output: [{ type: 'text', text: 'public component' }] })
    const target = event({ id: 'target', parentId: 'plan', name: 'edit', input: { path: 'Button.tsx' } })
    const after = event({ id: 'after', name: 'bash', input: { command: 'bun test' }, output: [{ type: 'text', text: 'check output' }] })
    return { user, plan, before, target, after, events: [user, plan, before, target, after] }
  }

  test('Given 同一轮的用户任务/公开助手计划/相邻步骤 When 提取 Then 得到最多两个有界邻居', () => {
    const fixture = scoped()
    const context = getTraceExplanationContext(fixture.target, fixture.events)
    expect(context.task).toContain('登录按钮')
    expect(context.plan).toBe('我先读取组件，再检查页面。')
    expect(context.planSource).toBe('visible-assistant-message')
    expect(context.neighbors.map((row) => [row.relation, row.id])).toEqual([['before', 'before'], ['after', 'after']])
    expect(context.neighbors[0]?.input).toContain('Button.tsx')
    expect(context.neighbors[1]?.result).toContain('check output')
    expect(JSON.stringify(context)).not.toContain('never-use')
  })

  test.each([
    { sessionId: 'other-session' }, { runId: 'other-run' }, { roundIndex: 2 },
    { metadata: { artifactFile: '/isolated/abandoned-branch.jsonl' } },
  ])('Given 相邻文字来自其它范围 %j When 提取 Then 不串入任务/计划/邻居', (mismatch) => {
    const fixture = scoped()
    const context = getTraceExplanationContext(fixture.target, fixture.events.map((row) => row.id === fixture.target.id ? row : { ...row, ...mismatch }))
    expect(context).toEqual({ neighbors: [] })
  })

  test('Given 旧历史没有runId但有同分支/同轮 When 提取 Then 可用；缺分支证据则拒绝拼接', () => {
    const fixture = scoped()
    const history = fixture.events.map((row) => ({ ...row, source: 'history' as const, runId: undefined }))
    expect(getTraceExplanationContext(history[3]!, history).task).toContain('登录按钮')
    const unbound = history.map((row) => ({ ...row, metadata: {} }))
    expect(getTraceExplanationContext(unbound[3]!, unbound)).toEqual({ neighbors: [] })
    const unknownRound = history.map((row) => ({ ...row, roundIndex: undefined }))
    expect(getTraceExplanationContext(unknownRound[3]!, unknownRound)).toEqual({ neighbors: [] })
  })

  test('Given 之前有多轮任务或后续才出现用户输入 When 提取 Then 只取当前目标之前最近的同轮输入', () => {
    const fixture = scoped()
    const older = event({ id: 'old-input', kind: 'input', roundIndex: 0, input: 'other task' })
    const newInput = event({ id: 'latest-input', kind: 'input', input: '本轮最新任务' })
    const future = event({ id: 'future-input', kind: 'input', input: 'future task' })
    const rows = [older, fixture.user, fixture.plan, newInput, fixture.before, fixture.target, future, fixture.after]
    expect(getTraceExplanationContext(fixture.target, rows).task).toBe('本轮最新任务')
  })

  test('Given 没有parent或parent只有隐藏思考 When 提取 Then 只回看同轮可见助手文字', () => {
    const fixture = scoped()
    const hiddenParent = event({ id: 'hidden', kind: 'model', output: [{ type: 'thinking', thinking: 'never-use-this' }] })
    const target = { ...fixture.target, parentId: 'hidden' }
    const context = getTraceExplanationContext(target, [fixture.user, fixture.plan, hiddenParent, target])
    expect(context.plan).toBe('我先读取组件，再检查页面。')
    expect(JSON.stringify(context)).not.toContain('never-use-this')
  })

  test('Given 同轮标记下出现更新的无文字输入 When 提取 Then 不沿用输入前的旧任务或旧计划，也不跨越后续新输入找邻居', () => {
    const fixture = scoped()
    const currentInput = event({ id: 'image-input', kind: 'input', input: [{ type: 'image', data: 'not-for-model-explanation' }] })
    const nextInput = event({ id: 'next-input', kind: 'input', input: '另一项任务' })
    const context = getTraceExplanationContext(fixture.target,
      [fixture.user, fixture.plan, currentInput, fixture.target, nextInput, fixture.after])
    expect(context.task).toBeUndefined()
    expect(context.plan).toBeUndefined()
    expect(context.neighbors).toEqual([])
  })

  test('Given 超长任务/计划/邻居和旧模型说明 When 提取 Then 全部有界且解释不会进入下一次模型输入', () => {
    const fixture = scoped()
    const huge = '\n"x'.repeat(100000)
    const rows = fixture.events.map((row) => ({ ...row,
      input: row.kind === 'input' ? huge : { path: huge, command: huge },
      output: [{ type: 'text', text: huge }], explanation: { text: 'previous-explanation', source: 'model' as const, status: 'ready' as const, version: 2 },
    }))
    const context = getTraceExplanationContext(rows[3]!, rows)
    expect(context.task!.length).toBeLessThanOrEqual(1600)
    expect(context.plan!.length).toBeLessThanOrEqual(1200)
    expect(context.neighbors).toHaveLength(2)
    expect(context.neighbors.every((row) => JSON.stringify(row).length <= 600)).toBe(true)
    expect(JSON.stringify(context)).not.toContain('previous-explanation')
  })

  test('Given 目标没有出现在这份范围内的列表 When 提取 Then 不猜测其邻近上下文', () => {
    const fixture = scoped()
    expect(getTraceExplanationContext({ ...fixture.target, id: 'missing' }, fixture.events)).toEqual({ neighbors: [] })
  })
})
