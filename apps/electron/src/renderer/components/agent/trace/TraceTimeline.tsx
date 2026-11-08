import * as React from 'react'
import type { AgentTraceEvent } from '@snap/shared'
import { cn } from '@/lib/utils'
import { buildTraceTimeline, isTraceException, moveTraceSelection, traceDuration, traceDurationLabel, traceStatusLabel, type TraceLane, type TraceTimeMode } from './trace-view'

interface TraceTimelineProps {
  events: AgentTraceEvent[]
  visibleIds: ReadonlySet<string>
  selectedId: string | null
  mode: TraceTimeMode
  onModeChange: (mode: TraceTimeMode) => void
  onSelect: (id: string) => void
  onStopFollowing?: () => void
}

const LANES: Array<{ id: TraceLane; label: string; color: string }> = [
  { id: 'input', label: '输入', color: 'bg-sky-500/65' },
  { id: 'model', label: '模型', color: 'bg-violet-500/65' },
  { id: 'tool', label: '工具', color: 'bg-amber-500/75' },
]

export function TraceTimeline({ events, visibleIds, selectedId, mode, onModeChange, onSelect, onStopFollowing }: TraceTimelineProps): React.ReactElement {
  const timeline = React.useMemo(() => buildTraceTimeline(events, mode), [events, mode])
  const rootRef = React.useRef<HTMLDivElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = React.useState({ left: 0, width: 400 })
  const pendingFocus = React.useRef<string | null>(null)
  const timelineRef = React.useRef(timeline)
  timelineRef.current = timeline
  const plotWidth = Math.max(viewport.width, 220, timeline.items.length * (mode === 'order' ? 19 : 10))
  const plotWidthRef = React.useRef(plotWidth)
  plotWidthRef.current = plotWidth
  const readViewport = React.useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    setViewport((previous) => previous.left === element.scrollLeft && previous.width === element.clientWidth ? previous : { left: element.scrollLeft, width: element.clientWidth })
  }, [])
  React.useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(readViewport)
    observer.observe(element)
    readViewport()
    return () => observer.disconnect()
  }, [readViewport])
  const reveal = React.useCallback((id: string): void => {
    const item = timelineRef.current.items.find((candidate) => candidate.event.id === id)
    const element = scrollRef.current
    if (!item || !element) return
    const start = item.left / 100 * plotWidthRef.current
    const end = start + Math.max(3, item.width / 100 * plotWidthRef.current)
    if (start < element.scrollLeft || end > element.scrollLeft + element.clientWidth) {
      element.scrollLeft = Math.max(0, start - element.clientWidth / 2)
      readViewport()
    }
  }, [readViewport])
  React.useEffect(() => { if (selectedId) reveal(selectedId) }, [selectedId, mode, reveal])
  // 横向也只挂载视口附近的色块，5000 条历史不会生成 5000 个交互节点。
  const renderedItems = timeline.items.filter((item) => visibleIds.has(item.event.id)
    && item.left / 100 * plotWidth <= viewport.left + viewport.width + 100
    && (item.left + item.width) / 100 * plotWidth >= viewport.left - 100)
  React.useEffect(() => {
    if (!pendingFocus.current) return
    const button = rootRef.current?.querySelector<HTMLButtonElement>(`[data-trace-mark="${CSS.escape(pendingFocus.current)}"]`)
    if (button) { button.focus(); pendingFocus.current = null }
  }, [renderedItems])
  const handleKey = (event: React.KeyboardEvent, currentId: string): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const key = event.key === 'ArrowLeft' ? 'ArrowUp' : event.key === 'ArrowRight' ? 'ArrowDown' : event.key
    const id = moveTraceSelection(timeline.items.filter((item) => visibleIds.has(item.event.id)).map((item) => item.event), currentId, key)
    if (!id) return
    pendingFocus.current = id
    onSelect(id)
    reveal(id)
  }
  const selected = events.find((event) => event.id === selectedId)
  return <div ref={rootRef} className="border-b border-border/60 px-3 pb-2" aria-label="输入、模型和工具共享轨迹轴">
    <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
      <div className="inline-flex rounded bg-muted/50 p-0.5" aria-label="时间轴刻度">
        {(['order', 'duration'] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value} className={cn('rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', mode === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')} onClick={() => onModeChange(value)}>{value === 'order' ? '顺序' : '真实耗时'}</button>)}
      </div>
      <span className="text-muted-foreground">{mode === 'order' ? '按采集顺序' : timeline.start !== undefined && timeline.end !== undefined ? `可确认区间 ${traceDurationLabel(timeline.end - timeline.start)}` : '没有完整时间记录'}</span>
    </div>
    <div className="flex min-w-0">
      <div className="w-8 shrink-0 pt-5">{LANES.map((lane) => <div key={lane.id} className="flex h-8 items-center text-[11px] text-muted-foreground">{lane.label}</div>)}</div>
      <div ref={scrollRef} onScroll={readViewport} onWheel={onStopFollowing} onTouchMove={onStopFollowing} onPointerDown={(event) => { if (event.target === event.currentTarget) onStopFollowing?.() }} className="min-w-0 flex-1 overflow-x-auto scrollbar-thin">
        <div style={{ width: plotWidth }}>
          <div className="flex h-5 justify-between text-[10px] text-muted-foreground">
            <span>{mode === 'order' ? '开始' : timeline.start === undefined ? '未记录' : '0 秒'}</span>
            <span>{mode === 'order' ? `${events.length} 条记录` : timeline.start !== undefined && timeline.end !== undefined ? traceDurationLabel(timeline.end - timeline.start) : '未记录'}</span>
          </div>
          {LANES.map((lane) => <div key={lane.id} className="relative h-8 border-t border-border/25" aria-label={`${lane.label}轨道`}>
            {renderedItems.filter((item) => item.lane === lane.id).map((item) => <button
              key={item.event.id} type="button" data-trace-mark={item.event.id}
              aria-label={`${item.event.name}，${traceStatusLabel(item.event)}，${item.point && traceDuration(item.event) === undefined ? '仅记录开始时间' : `耗时${traceDurationLabel(traceDuration(item.event))}`}`}
              aria-pressed={selectedId === item.event.id}
              title={`${item.event.name} · ${traceStatusLabel(item.event)} · 耗时${traceDurationLabel(traceDuration(item.event))}`}
              className={cn('absolute top-1 h-6 rounded-sm border-2 border-transparent px-0 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', isTraceException(item.event) ? 'bg-destructive/75' : lane.color, selectedId === item.event.id && 'z-10 !border-foreground/80', item.event.status === 'running' && 'animate-pulse')}
              style={{ left: `min(${item.left}%, calc(100% - 3px))`, width: item.point ? 3 : `max(3px, calc(${item.width}% - 2px))`, maxWidth: `max(3px, ${100 - item.left}%)` }}
              onClick={() => onSelect(item.event.id)} onKeyDown={(event) => handleKey(event, item.event.id)}
            />)}
          </div>)}
        </div>
      </div>
    </div>
    {mode === 'duration' && timeline.missingCount > 0 && <p className="mt-1 text-[10px] text-muted-foreground">{timeline.missingCount} 条没有开始时间，保留在下方列表；未补造耗时。</p>}
    <p className="mt-1 min-h-4 truncate text-[11px] text-muted-foreground" aria-live="polite">{selected ? `${selected.name} · ${traceStatusLabel(selected)}` : '点击色块查看步骤 · 方向键移动'}</p>
  </div>
}
