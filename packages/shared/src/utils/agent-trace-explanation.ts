import type { AgentTraceEvent, AgentTraceExplanation } from '../types/agent-trace'

export const TRACE_EXPLANATION_VERSION = 2

/** 助手已公开提出的工具调用；这是待执行动作，不能视为工具结果。 */
export interface AgentTracePlannedTool {
  name: string
  command?: string
  filePath?: string
  task?: string
  description?: string
}

/** 给说明模型的有界可见证据。字段顺序固定，不含说明自身与临时 live/history 标记。 */
export interface AgentTraceExplanationInput {
  kind: AgentTraceEvent['kind']
  name: string
  status: AgentTraceEvent['status']
  historyIncomplete?: boolean
  filePath?: string
  command?: string
  url?: string
  selector?: string
  query?: string
  stepName?: string
  toolTask?: string
  recordedPurpose?: string
  recordedDescription?: string
  error?: string
  exitCode?: number
  visibleInput?: string
  visibleResult?: string
  plannedTools?: AgentTracePlannedTool[]
}

export interface AgentTraceExplanationNeighbor {
  relation: 'before' | 'after'
  id: string
  name: string
  status: AgentTraceEvent['status']
  input?: string
  result?: string
}

export interface AgentTraceExplanationContext {
  task?: string
  /** 用户可见的上级/前序助手文字；不是隐藏思考，也不保证它本身是一份计划。 */
  plan?: string
  planSource?: 'visible-assistant-message'
  neighbors: AgentTraceExplanationNeighbor[]
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const SECRET_KEY = /(?:^|[_-])(?:authorization|proxy[_-]authorization|cookies?|set[_-]cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|credentials?|private[_-]?key|signature)$/i
const HIDDEN = '[凭据已隐藏]'

/** 摘录前就限制源字符串长度；防止大结果或说明中意外出现常见认证信息。 */
function visibleText(value: string, limit: number): string | undefined {
  const bounded = value.slice(0, limit * 2)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, HIDDEN)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, HIDDEN)
    .replace(/\b(https?:\/\/)[^/\s@]+@/gi, `$1${HIDDEN}@`)
    .replace(/data:image\/[^\s;,]+;base64,[A-Za-z0-9+/=]*/gi, '[图片数据未采集]')
    .replace(/(^|[\r\n])(\s*(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, `$1$2${HIDDEN}`)
    .replace(/((?:["'])([^"'\r\n]+)(?:["'])\s*:\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^,\s}\]]+)/g,
      (match: string, prefix: string, key: string) => SECRET_KEY.test(key) ? `${prefix}"${HIDDEN}"` : match)
    .replace(/(\b([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s"'&,;}\]]+)/g,
      (match: string, prefix: string, key: string) => SECRET_KEY.test(key) ? `${prefix}${HIDDEN}` : match)
  return bounded.slice(0, limit).trim() || undefined
}

function firstText(objects: readonly Record<string, unknown>[], keys: readonly string[], limit: number): string | undefined {
  for (const object of objects) for (const key of keys) {
    const value = object[key]
    if (typeof value === 'string') {
      const text = visibleText(value, limit)
      if (text) return text
    }
  }
  return undefined
}

/**
 * 只读取公开 text 内容块或已知的 content 包装。思考、图片、工具 arguments 及任意对象键
 * 都不会递归采集，读取上限同时约束字符、节点和深度。
 */
export function getTraceVisibleExcerpt(value: unknown, limit = 1200): string | undefined {
  const cap = Math.min(Math.max(0, limit), 1600)
  const parts: string[] = []
  let length = 0
  let nodes = 0
  const visit = (item: unknown, depth: number): void => {
    if (length >= cap || depth > 4 || nodes++ >= 48) return
    if (typeof item === 'string') {
      const text = visibleText(item, cap - length)
      if (text) { parts.push(text); length += text.length + 1 }
      return
    }
    if (Array.isArray(item)) {
      for (let i = 0; i < Math.min(item.length, 32) && length < cap; i += 1) visit(item[i], depth + 1)
      return
    }
    const row = record(item)
    if (row.type !== undefined) {
      if (row.type === 'text' || row.type === 'input_text' || row.type === 'output_text') visit(row.text, depth + 1)
      return
    }
    // 原生 tool result 的公开载荷在 content；details/reasoning/secret 等字段刻意不读取。
    if (row.role === 'assistant' || row.role === 'user' || row.role === 'toolResult' || row.role === undefined) {
      visit(row.content, depth + 1)
    }
  }
  if (cap > 0) visit(value, 0)
  return parts.join('\n').slice(0, cap) || undefined
}

/** 只看公开的调用内容块；不读取思考、Schema 或调用参数中的任意字段。 */
function plannedTools(value: unknown): AgentTracePlannedTool[] | undefined {
  const content = Array.isArray(value) ? value : record(value).content
  if (!Array.isArray(content)) return undefined
  const tools: AgentTracePlannedTool[] = []
  for (let index = 0; index < Math.min(content.length, 32) && tools.length < 4; index += 1) {
    const block = record(content[index])
    if (block.type !== 'toolCall' && block.type !== 'tool_use') continue
    const name = typeof block.name === 'string' ? visibleText(block.name, 100) : undefined
    if (!name) continue
    const input = record(block.type === 'toolCall' ? block.arguments : block.input)
    tools.push({
      name,
      command: firstText([input], ['command', 'cmd', 'command_line'], 320),
      filePath: firstText([input], ['path', 'file_path', 'filePath', 'filename'], 240),
      task: firstText([input], ['prompt', 'task', 'instruction'], 320),
      description: firstText([input, block], ['_intent', 'intent', 'description'], 160),
    })
  }
  return tools.length ? tools : undefined
}

export function getTraceExplanationInput(event: AgentTraceEvent): AgentTraceExplanationInput {
  const metadata = record(event.metadata)
  const input = event.kind === 'tool' || event.kind === 'retry' || event.kind === 'compaction' ? record(event.input) : {}
  const output = event.kind === 'tool' || event.kind === 'error' ? record(event.output) : {}
  const exitCode = typeof output.exitCode === 'number' ? output.exitCode
    : typeof output.exit_code === 'number' ? output.exit_code : undefined
  const allowVisibleInput = event.kind === 'input' || event.kind === 'tool'
  const allowVisibleResult = event.kind === 'tool' || event.kind === 'model' || event.kind === 'error'
  return {
    kind: event.kind,
    name: visibleText(event.name, 160) ?? '',
    status: event.status,
    historyIncomplete: metadata.historyIncomplete === true ? true : undefined,
    filePath: firstText([input], ['path', 'file_path', 'filePath', 'filename'], 320),
    command: firstText([input], ['command', 'cmd', 'command_line'], 640),
    url: firstText([input], ['url', 'href'], 320),
    selector: firstText([input], ['selector', 'target', 'label'], 180),
    query: firstText([input], ['query', 'pattern', 'search'], 180),
    stepName: firstText([input], ['name', 'action', 'title', 'skill'], 160),
    toolTask: firstText([input], ['prompt', 'task', 'instruction'], 480),
    recordedPurpose: firstText([metadata, input], ['purpose', 'why', '_purpose'], 240),
    recordedDescription: firstText([input, metadata], ['_intent', 'intent', 'description'], 240),
    error: firstText([metadata, output], ['error', 'errorMessage', 'error_message', 'message'], 240),
    exitCode: exitCode !== undefined && Number.isFinite(exitCode) ? exitCode : undefined,
    visibleInput: allowVisibleInput ? getTraceVisibleExcerpt(event.input, 1200) : undefined,
    visibleResult: allowVisibleResult ? getTraceVisibleExcerpt(event.output, 1200) : undefined,
    plannedTools: event.kind === 'model' ? plannedTools(event.output) : undefined,
  }
}

function artifact(event: AgentTraceEvent): string | undefined {
  const value = event.metadata?.artifactFile
  return typeof value === 'string' && value ? value : undefined
}

/** 无法证明运行/轮次/分支相同就不拼接，特别是没有 runId 的旧历史。 */
function sameScope(event: AgentTraceEvent, candidate: AgentTraceEvent): boolean {
  if (event.sessionId !== candidate.sessionId || !Number.isInteger(event.roundIndex)
    || event.roundIndex !== candidate.roundIndex) return false
  const left = artifact(event)
  const right = artifact(candidate)
  if ((left || right) && left !== right) return false
  if (event.runId) return candidate.runId === event.runId
  return !candidate.runId && !!left && left === right
}

function neighbor(event: AgentTraceEvent, relation: AgentTraceExplanationNeighbor['relation']): AgentTraceExplanationNeighbor {
  const input = getTraceExplanationInput(event)
  const args = [input.stepName && `动作：${input.stepName}`, input.toolTask && `任务：${input.toolTask}`,
    input.filePath && `文件：${input.filePath}`, input.command && `命令：${input.command}`,
    input.url && `网页：${input.url}`, input.selector && `目标：${input.selector}`, input.query && `搜索：${input.query}`,
    input.visibleInput].filter((value): value is string => !!value).join('\n')
  const result: AgentTraceExplanationNeighbor = {
    relation, id: event.id.slice(0, 100), name: input.name.slice(0, 80), status: event.status,
    input: args.slice(0, 160) || undefined,
    result: (input.visibleResult ?? input.error)?.slice(0, 160),
  }
  // 只 stringify 已经收敛到白名单的几百字符，控制 JSON 转义后的总量也不超过 600。
  while (JSON.stringify(result).length > 600 && (result.input || result.result)) {
    if ((result.input?.length ?? 0) >= (result.result?.length ?? 0)) result.input = result.input?.slice(0, Math.max(0, (result.input?.length ?? 0) - 32)) || undefined
    else result.result = result.result?.slice(0, Math.max(0, (result.result?.length ?? 0) - 32)) || undefined
  }
  return result
}

/** 只补本轮的可见任务/助手文字与最多前后各一步，不用其它会话或分支的文字解释当前动作。 */
export function getTraceExplanationContext(event: AgentTraceEvent, events: readonly AgentTraceEvent[]): AgentTraceExplanationContext {
  const context: AgentTraceExplanationContext = { neighbors: [] }
  const index = events.findIndex((candidate) => candidate.id === event.id && sameScope(event, candidate))
  if (index < 0) return context
  let taskIndex = -1
  for (let i = index; i >= 0; i -= 1) {
    const candidate = events[i]!
    if (candidate.kind !== 'input' || !sameScope(event, candidate)) continue
    taskIndex = i
    context.task = getTraceVisibleExcerpt(candidate.input, 1600)
    break
  }
  if (event.parentId) {
    for (let i = index - 1; i > taskIndex; i -= 1) {
      const candidate = events[i]!
      if (candidate.id !== event.parentId || candidate.kind !== 'model' || !sameScope(event, candidate)) continue
      context.plan = getTraceVisibleExcerpt(candidate.output, 1200)
      break
    }
  }
  if (!context.plan) {
    for (let i = index - 1; i > taskIndex; i -= 1) {
      const candidate = events[i]!
      if (candidate.kind !== 'model' || !sameScope(event, candidate)) continue
      context.plan = getTraceVisibleExcerpt(candidate.output, 1200)
      if (context.plan) break
    }
  }
  if (context.plan) context.planSource = 'visible-assistant-message'
  const isStep = (candidate: AgentTraceEvent): boolean => ['tool', 'model', 'retry', 'compaction', 'error'].includes(candidate.kind)
  for (let i = index - 1; i > taskIndex; i -= 1) {
    const candidate = events[i]!
    if (isStep(candidate) && sameScope(event, candidate)) { context.neighbors.push(neighbor(candidate, 'before')); break }
  }
  for (let i = index + 1; i < events.length; i += 1) {
    const candidate = events[i]!
    if (candidate.kind === 'input' && sameScope(event, candidate)) break
    if (isStep(candidate) && sameScope(event, candidate)) { context.neighbors.push(neighbor(candidate, 'after')); break }
  }
  return context
}

function validExplanation(value: AgentTraceExplanation | undefined): value is AgentTraceExplanation {
  return !!value && typeof value.text === 'string' && value.source === 'model'
    && ['pending', 'ready', 'unavailable'].includes(value.status)
    && value.version === TRACE_EXPLANATION_VERSION
    && (value.status !== 'ready' || value.text.trim().length > 0)
}

/** AI 说明默认由开关控制；没有模型产物时不生成任何本地规则文字。 */
export function getTraceExplanation(event: AgentTraceEvent): AgentTraceExplanation {
  return validExplanation(event.explanation) ? event.explanation
    : { text: '', source: 'model', status: 'pending', version: TRACE_EXPLANATION_VERSION }
}

export function needsTraceModelExplanation(event: AgentTraceEvent): boolean {
  if (event.status === 'running') return false
  return !validExplanation(event.explanation) || event.explanation.status === 'pending'
}
