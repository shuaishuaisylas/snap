import { join } from 'node:path'
import { getConfigDir, getSdkConfigDir } from './config-paths'
import { getAgentSessionMeta, getAgentSessionSDKMessages, isAgentSessionDeleting } from './agent-session-manager'
import { AgentTraceStore } from './agent-trace-store'
import { getTraceExplanation, getTraceExplanationContext, needsTraceModelExplanation } from '@snap/shared'
import type { AgentTraceEvent } from '@snap/shared'
import { AgentTraceExplanationQueue, traceExplanationFingerprint, type TraceExplanationContext, type TraceExplanationPatch } from './agent-trace-explanation-queue'
import { generateTraceExplanationBatch } from './agent-trace-explanation-generator'
import { sanitizeAgentTraceEvent } from './agent-trace-sanitize'

let store: AgentTraceStore | undefined
let explanations: AgentTraceExplanationQueue | undefined
export function getAgentTraceStore(): AgentTraceStore {
  if (store) return store
  store = new AgentTraceStore({
    directory: join(getConfigDir(), 'agent-traces'),
    artifactDirectory: join(getSdkConfigDir(), 'sessions'),
    getSession: getAgentSessionMeta,
    getMessages: getAgentSessionSDKMessages,
    isDeleting: isAgentSessionDeleting,
  })
  explanations = new AgentTraceExplanationQueue({
    generate: generateTraceExplanationBatch,
    apply: (patches) => store?.applyExplanations(patches.filter((patch) => explanations?.isEnabled(patch.sessionId))),
    isAvailable: (sessionId) => !!getAgentSessionMeta(sessionId) && !isAgentSessionDeleting(sessionId),
    getEvidence: (steps) => {
      const related = new Map<string, ReturnType<typeof getTraceExplanationContext>>()
      for (const sessionId of new Set(steps.map((step) => step.sessionId))) {
        const events = store?.read(sessionId) ?? []
        for (const step of steps.filter((item) => item.sessionId === sessionId)) {
          const event = events.find((item) => item.id === step.eventId)
          if (event) related.set(`${sessionId}:${event.id}`, getTraceExplanationContext(event, events))
        }
      }
      return related
    },
  })
  store.subscribe(({ event }) => explanations?.observe(event))
  return store
}

/** 任务正文先经过现有脱敏边界，后台不接收图片、凭据、完整历史或思考。 */
function safeTask(task: string): string {
  const event = sanitizeAgentTraceEvent({ id: 'task', sessionId: 'task', kind: 'input', name: '任务',
    status: 'completed', source: 'live', input: task.slice(0, 1_200) })
  return typeof event.input === 'string' ? event.input.slice(0, 600) : ''
}

export function beginAgentTraceRun(runId: string, context: TraceExplanationContext): void {
  const traceStore = getAgentTraceStore()
  explanations?.beginRun(runId, { ...context, task: safeTask(context.task) })
  traceStore.beginRun(runId)
}

export function endAgentTraceRun(runId: string): void {
  getAgentTraceStore().endRun(runId)
  explanations?.endRun(runId)
}

function inputText(input: unknown): string {
  if (typeof input === 'string') return input.slice(0, 600)
  if (Array.isArray(input)) return input.filter((block) => block && typeof block === 'object'
    && (block as Record<string, unknown>).type === 'text')
    .slice(0, 4).map((block) => String((block as Record<string, unknown>).text ?? '').slice(0, 600)).join(' ').slice(0, 600)
  return ''
}

/** 普通读取轨迹永远不产生模型请求；只有显式开关才安排说明。 */
export function readAgentTrace(sessionId: string): AgentTraceEvent[] { return getAgentTraceStore().read(sessionId) }

export function setAgentTraceExplanations(sessionId: string, enabled: boolean, eventIds?: string[]): AgentTraceEvent[] {
  const traceStore = getAgentTraceStore()
  const session = getAgentSessionMeta(sessionId)
  if (!session || isAgentSessionDeleting(sessionId)) throw new Error('会话不存在或已删除')
  explanations?.setEnabled(sessionId, enabled)
  const events = traceStore.read(sessionId)
  if (!enabled) return events
  const byId = new Map(events.map((event) => [event.id, event]))
  const requested = eventIds === undefined ? events.slice(-120)
    : [...new Set(eventIds)].map((id) => byId.get(id)).filter((event): event is AgentTraceEvent => !!event)
  const unavailable: TraceExplanationPatch[] = []
  for (const event of requested) {
    // 重新打开开关是显式重试失败项；已成功的同版本模型说明直接复用。
    const candidate = getTraceExplanation(event).status === 'unavailable' ? { ...event, explanation: undefined } : event
    if (!needsTraceModelExplanation(candidate)) continue
    if (!session.channelId || !session.modelId) {
      unavailable.push({ sessionId, eventId: event.id, fingerprint: traceExplanationFingerprint(event),
        explanation: { ...getTraceExplanation(candidate), text: '', status: 'unavailable' as const } })
      continue
    }
    const related = getTraceExplanationContext(candidate, events)
    explanations?.observe(candidate, { sessionId, channelId: session.channelId, modelId: session.modelId,
      task: related.task ?? (event.kind === 'input' ? safeTask(inputText(event.input ?? event.output)) : '') })
  }
  if (eventIds?.length) explanations?.prioritize(sessionId, eventIds)
  traceStore.applyExplanations(unavailable)
  return unavailable.length ? traceStore.read(sessionId) : events
}
