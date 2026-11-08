import * as React from 'react'
import type { AgentTraceEvent } from '@snap/shared'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { TraceValue } from './TraceValue'
import { TraceExplanationSummary } from './TraceExplanationSummary'
import { TRACE_KIND_LABELS, isTraceException, traceDuration, traceDurationLabel, traceModelContexts, traceStatusLabel, type TraceDetailTab } from './trace-view'

interface TraceDetailProps {
  event: AgentTraceEvent
  events: AgentTraceEvent[]
  tab: TraceDetailTab
  onTabChange: (tab: TraceDetailTab) => void
  onBack: () => void
  focusBack: boolean
  explanationsEnabled?: boolean
}

function recordedTime(time: number | undefined): string {
  return time === undefined || !Number.isFinite(time) ? '未记录' : new Date(time).toLocaleString('zh-CN', { hour12: false }) + `.${String(time % 1000).padStart(3, '0')}`
}

export const TraceDetail = React.memo(function TraceDetail({ event, events, tab, onTabChange, onBack, focusBack, explanationsEnabled = false }: TraceDetailProps): React.ReactElement {
  const backRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => { if (focusBack) backRef.current?.focus() }, [event.id, focusBack])
  const contextEvents = React.useMemo(() => traceModelContexts(event, events), [event, events])
  const context = contextEvents.length > 0
    ? contextEvents.map((item) => ({ name: item.name, input: item.input, metadata: item.metadata }))
    : undefined
  const tabs: Array<{ id: TraceDetailTab; label: string }> = [
    { id: 'overview', label: '概述' }, { id: 'input', label: event.kind === 'input' ? '输入' : '参数' },
    { id: 'output', label: '结果' }, { id: 'context', label: '上下文' },
    { id: 'schema', label: 'Schema' }, { id: 'timing', label: '计时' },
  ]
  return <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="轨迹事件详情" onKeyDown={(keyboard) => { if (keyboard.key === 'Escape') { keyboard.preventDefault(); onBack() } }}>
    <div className="shrink-0 border-b border-border/50 p-3 pb-2">
      <div className="mb-2 flex min-w-0 items-start gap-2">
        <Button ref={backRef} type="button" variant="ghost" size="icon-sm" className="shrink-0" aria-label="返回轨迹步骤" onClick={onBack}><ArrowLeft className="!size-3.5" /></Button>
        <div className="min-w-0"><h3 className="break-words text-sm font-medium">{event.name}</h3><p className={cn('mt-1 text-[11px] text-muted-foreground', isTraceException(event) && 'text-destructive')}>{TRACE_KIND_LABELS[event.kind]} · {traceStatusLabel(event)}</p></div>
      </div>
      <div role="tablist" aria-label="详情分类" className="flex flex-wrap gap-0.5">
        {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => onTabChange(item.id)} className={cn('rounded px-2 py-1 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', tab === item.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50')}>{item.label}</button>)}
      </div>
    </div>
    <div key={`${event.id}:${tab}`} role="tabpanel" aria-label={tabs.find((item) => item.id === tab)?.label} className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto p-3 scrollbar-thin">
      {tab === 'overview' && <TraceExplanationSummary event={event} enabled={explanationsEnabled} />}
      {event.metadata?.truncated === true && <p className="rounded border border-amber-500/30 p-2 text-[11px] text-muted-foreground">这条证据在采集或迁移时已截断；下方与复制内容均以已保存的记录为准。</p>}
      {event.metadata?.historyIncomplete === true && <p className="text-[11px] text-muted-foreground">此项由历史消息恢复，未保存的原始请求、Schema 和时间不会补造。</p>}
      {tab === 'overview' && <>
        <dl className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-2 text-xs">
          <dt className="text-muted-foreground">状态</dt><dd className={cn('break-all', isTraceException(event) && 'text-destructive')}>{traceStatusLabel(event)}</dd>
          <dt className="text-muted-foreground">轮次</dt><dd>{event.roundIndex === undefined ? '未记录' : `第 ${event.roundIndex} 轮`}</dd>
          <dt className="text-muted-foreground">耗时</dt><dd>{traceDurationLabel(traceDuration(event))}</dd>
          <dt className="text-muted-foreground">来源</dt><dd>{event.source === 'history' ? '历史记录' : '运行采集'}</dd>
          <dt className="text-muted-foreground">执行</dt><dd className="break-all font-mono text-[11px]">{event.runId ?? '未记录'}</dd>
          <dt className="text-muted-foreground">请求</dt><dd className="break-all font-mono text-[11px]">{event.requestId ?? '未记录'}</dd>
          <dt className="text-muted-foreground">父步骤</dt><dd className="break-all font-mono text-[11px]">{event.parentId ?? '未记录'}</dd>
        </dl>
        {event.kind === 'tool' && <p className="text-[11px] text-muted-foreground">工具返回表示调用结束，任务结果仍应根据实际产物或页面状态验证。</p>}
        <TraceValue value={event.output} label="结果" />
        <TraceValue value={event.metadata} label="采集元数据与用量" />
      </>}
      {tab === 'input' && <TraceValue value={event.input} label={event.kind === 'input' ? '用户输入' : '调用参数'} />}
      {tab === 'output' && <TraceValue value={event.output} label="已保存的完整结果" />}
      {tab === 'context' && <>
        <p className="text-[11px] text-muted-foreground">仅显示与本次请求关联的已保存输入快照。图片、文件及隐藏内容以记录中的引用或说明为准。</p>
        <TraceValue value={context} label="本次请求上下文" />
      </>}
      {tab === 'schema' && <>
        <p className="text-[11px] text-muted-foreground">使用采集时保存的定义；未保存时显示未记录。</p>
        <TraceValue value={event.schema} label="调用时 Schema" />
      </>}
      {tab === 'timing' && <>
        <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-3 text-xs">
          <dt className="text-muted-foreground">开始</dt><dd className="break-all">{recordedTime(event.startedAt)}</dd>
          <dt className="text-muted-foreground">结束</dt><dd className="break-all">{recordedTime(event.endedAt)}</dd>
          <dt className="text-muted-foreground">耗时</dt><dd>{traceDurationLabel(traceDuration(event))}</dd>
        </dl>
        <p className="text-[11px] text-muted-foreground">没有时间戳的历史步骤只按记录顺序显示。未结束的步骤不计作零耗时。</p>
        <TraceValue value={event.metadata} label="其他计时与调用信息（如已采集）" />
      </>}
    </div>
  </section>
})
