import * as React from 'react'
import type { AgentTraceEvent } from '@snap/shared'
import { traceExplanationDisplay } from './trace-explanation-display'
import { tracePreview } from './trace-view'

/** 说明只依赖已采集记录；后台补充时不遮挡原始详情。 */
export function TraceExplanationSummary({ event, enabled = false }: { event: AgentTraceEvent; enabled?: boolean }): React.ReactElement | null {
  const explanation = React.useMemo(() => traceExplanationDisplay(event, enabled), [event, enabled])
  if (explanation.status === 'hidden') return null
  return <section aria-label="步骤说明" aria-live="polite" aria-atomic="true" className="rounded-md border border-border/60 bg-muted/20 p-3">
    <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      <h4 className="font-medium text-foreground/80">这一步在做什么</h4>
      {explanation.status === 'ready' && <span>根据步骤推测</span>}
    </div>
    {explanation.status === 'ready' && <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">{explanation.text}</p>}
    {explanation.status === 'pending' && <p role="status" className="text-xs leading-relaxed text-muted-foreground">等待AI说明；主任务运行时会排队，结束后生成。</p>}
    {explanation.status === 'unavailable' && <p role="status" className="text-xs leading-relaxed text-muted-foreground">AI说明暂不可用，可关闭后重新开启。原始步骤详情仍可查看。</p>}
  </section>
}

export function TraceEventPreview({ event, enabled = false }: { event: AgentTraceEvent; enabled?: boolean }): React.ReactElement {
  const explanation = traceExplanationDisplay(event, enabled)
  const text = !enabled ? tracePreview(event) : explanation.status === 'ready' ? explanation.text
    : explanation.status === 'unavailable' ? 'AI说明暂不可用，可关闭后重新开启' : '等待AI说明'
  return <span className="mt-1 block truncate text-[11px] text-muted-foreground" title={enabled && explanation.status === 'ready' ? `根据步骤推测：${text}` : undefined}>{text}</span>
}
