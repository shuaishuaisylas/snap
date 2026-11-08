/** 独立于聊天展示协议的 Agent 运行证据；同 id 的实时更新按 upsert 处理。 */
export interface AgentTraceExplanation {
  text: string
  source: 'rule' | 'recorded' | 'model'
  status: 'pending' | 'ready' | 'unavailable'
  version: number
}

export interface AgentTraceEvent {
  id: string
  sessionId: string
  runId?: string
  kind: 'system' | 'context' | 'input' | 'model' | 'tool' | 'retry' | 'compaction' | 'error'
  name: string
  status: 'running' | 'completed' | 'error' | 'interrupted' | 'unknown'
  startedAt?: number
  endedAt?: number
  durationMs?: number
  roundIndex?: number
  requestId?: string
  parentId?: string
  input?: unknown
  output?: unknown
  schema?: unknown
  metadata?: Record<string, unknown>
  source: 'live' | 'history'
  messageUuid?: string
  /** 模型生成的动作与目的说明，基于可见记录，不是隐藏思维；开关默认关闭。 */
  explanation?: AgentTraceExplanation
}

export interface AgentTraceUpdate {
  sessionId: string
  event: AgentTraceEvent
}

export const AGENT_TRACE_IPC_CHANNELS = {
  GET: 'agent:trace:get',
  EVENT: 'agent:trace:event',
  SET_EXPLANATIONS: 'agent:trace:explanations:set',
} as const
