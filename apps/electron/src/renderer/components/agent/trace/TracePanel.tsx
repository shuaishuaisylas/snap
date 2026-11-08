import * as React from 'react'
import { useAtom, useStore } from 'jotai'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDownToLine, ChevronDown, ChevronRight, Loader2, RefreshCw, Search, X } from 'lucide-react'
import type { AgentTraceEvent } from '@snap/shared'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { TraceDetail } from './TraceDetail'
import { TraceTimeline } from './TraceTimeline'
import { TraceEventPreview } from './TraceExplanationSummary'
import { TraceExplanationClient } from './trace-explanation-client'
import { traceExplanationDisplay, traceExplanationRequestIds } from './trace-explanation-display'
import { applyTraceFilter, selectTraceEvent, traceSessionStateAtomFamily } from './trace-state'
import { TRACE_KIND_LABELS, buildTraceRows, filterTraceEvents, groupTraceRounds, isTraceException, mergeTraceEvents, moveTraceSelection, traceDuration, traceDurationLabel, traceRecordCounts, traceRoundId, traceStatusLabel, type TraceListRow } from './trace-view'

interface TracePanelProps { sessionId: string; width: number }

interface TraceEventListProps {
  sessionId: string
  rows: TraceListRow[]
  selectedId: string | null
  followLatest: boolean
  scrollTop: number
  collapsedRounds: string[]
  filterKey: string
  focusEventId: string | null
  explanationsEnabled: boolean
  onSelect: (id: string) => void
  onToggleRound: (id: string) => void
  onScrollTop: (top: number) => void
  onStopFollowing: () => void
}

function TraceEventList({ sessionId, rows, selectedId, followLatest, scrollTop, collapsedRounds, filterKey, focusEventId, explanationsEnabled, onSelect, onToggleRound, onScrollTop, onStopFollowing }: TraceEventListProps): React.ReactElement {
  const parentRef = React.useRef<HTMLDivElement>(null)
  const initialOffset = React.useRef(scrollTop)
  const scrollFrame = React.useRef<number | null>(null)
  const rowsRef = React.useRef(rows)
  rowsRef.current = rows
  const previousFilter = React.useRef(filterKey)
  const virtualizer = useVirtualizer({
    count: rows.length, getScrollElement: () => parentRef.current,
    estimateSize: (index) => rows[index]?.type === 'round' ? 38 : 66,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 7, initialOffset: initialOffset.current,
  })
  React.useEffect(() => () => { if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current) }, [])
  React.useLayoutEffect(() => {
    if (followLatest && rows.length) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' })
  }, [followLatest, rows.length, virtualizer])
  React.useEffect(() => {
    if (!selectedId) return
    const index = rowsRef.current.findIndex((row) => row.type === 'event' && row.event.id === selectedId)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' })
    // 仅显式选择时定位。实时更新不能把用户拉回旧的手选事件。
  }, [selectedId, virtualizer])
  React.useLayoutEffect(() => {
    if (previousFilter.current === filterKey) return
    previousFilter.current = filterKey
    virtualizer.scrollToOffset(0)
  }, [filterKey, virtualizer])
  React.useEffect(() => {
    if (!focusEventId) return
    const index = rowsRef.current.findIndex((row) => row.type === 'event' && row.event.id === focusEventId)
    if (index < 0) return
    virtualizer.scrollToIndex(index, { align: 'auto' })
    const frame = window.requestAnimationFrame(() => parentRef.current?.querySelector<HTMLButtonElement>(`[data-trace-event="${CSS.escape(focusEventId)}"]`)?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [focusEventId, virtualizer])
  const keyboard = (event: React.KeyboardEvent, id: string): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const visible = rows.flatMap((row) => row.type === 'event' ? [row.event] : [])
    const next = moveTraceSelection(visible, id, event.key)
    if (!next) return
    onSelect(next)
    const index = rows.findIndex((row) => row.type === 'event' && row.event.id === next)
    virtualizer.scrollToIndex(index, { align: 'auto' })
    window.requestAnimationFrame(() => parentRef.current?.querySelector<HTMLButtonElement>(`[data-trace-event="${CSS.escape(next)}"]`)?.focus())
  }
  return <div ref={parentRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-2 scrollbar-thin" aria-label="轨迹轮次和步骤" data-trace-session={sessionId}
    onWheel={onStopFollowing} onTouchMove={onStopFollowing}
    onPointerDown={(event) => { if (event.target === event.currentTarget) onStopFollowing() }}
    onKeyDownCapture={(event) => { if (['PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) onStopFollowing() }}
    onScroll={() => {
      if (scrollFrame.current !== null) return
      scrollFrame.current = window.requestAnimationFrame(() => { scrollFrame.current = null; onScrollTop(parentRef.current?.scrollTop ?? 0) })
    }}>
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index]
        if (!row) return null
        return <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${item.start}px)` }}>
          {row.type === 'round' ? <button type="button" className="mt-1 flex min-h-8 w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={!collapsedRounds.includes(row.round.id)} onClick={() => onToggleRound(row.round.id)}>
            {collapsedRounds.includes(row.round.id) ? <ChevronRight className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{row.round.label}</span><span className="shrink-0 text-[10px]">{row.round.events.length} 条</span>
          </button> : <button type="button" data-trace-event={row.event.id} aria-pressed={selectedId === row.event.id} onClick={() => onSelect(row.event.id)} onKeyDown={(event) => keyboard(event, row.event.id)}
            className={cn('my-0.5 grid min-h-[62px] w-full grid-cols-[24px_minmax(0,1fr)] items-start gap-1 rounded-md px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', selectedId === row.event.id ? 'bg-primary/10' : 'hover:bg-muted/40')}>
            <span className={cn('pt-0.5 text-[10px] text-muted-foreground', isTraceException(row.event) && 'text-destructive')}>{TRACE_KIND_LABELS[row.event.kind]}</span>
            <span className="min-w-0">
              <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs font-medium">{row.event.name}</span><span className={cn('shrink-0 text-[10px] text-muted-foreground', isTraceException(row.event) && 'text-destructive')}>{row.event.status === 'running' && <Loader2 className="mr-1 inline size-3 animate-spin" />}{traceStatusLabel(row.event)}</span></span>
              <TraceEventPreview event={row.event} enabled={explanationsEnabled} />
              <span className="mt-0.5 block text-[10px] text-muted-foreground/70">{traceDuration(row.event) === undefined ? '耗时未记录' : traceDurationLabel(traceDuration(row.event))}{row.event.source === 'history' ? ' · 历史恢复' : ''}</span>
            </span>
          </button>}
        </div>
      })}
    </div>
  </div>
}

export function TracePanel({ sessionId, width }: TracePanelProps): React.ReactElement {
  const [state, setState] = useAtom(traceSessionStateAtomFamily(sessionId))
  const store = useStore()
  const aiSwitchId = React.useId()
  const explanationClient = React.useMemo(() => new TraceExplanationClient({
    request: (id, enabled, eventIds) => window.electronAPI.agentSetTraceExplanations(id, enabled, eventIds),
    getState: (id) => store.get(traceSessionStateAtomFamily(id)),
    setState: (id, update) => store.set(traceSessionStateAtomFamily(id), update),
  }), [store])
  const [reload, setReload] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [restoreFocusId, setRestoreFocusId] = React.useState<string | null>(null)
  const detailFocusRef = React.useRef(false)
  const narrow = width <= 540
  React.useEffect(() => {
    explanationClient.invalidate()
    return () => explanationClient.invalidate()
  }, [explanationClient, sessionId])
  React.useEffect(() => {
    const current = store.get(traceSessionStateAtomFamily(sessionId))
    // 默认关闭也同步后台；恢复已开启的面板时，等历史加载后只请求有限的可见步骤。
    if (current.explanationsEnabled && !current.loaded) return
    const shown = filterTraceEvents(current.events, current.query, current.onlyExceptions)
    void explanationClient.setEnabled(sessionId, current.explanationsEnabled,
      current.explanationsEnabled ? traceExplanationRequestIds(shown, current.selectedId) : [])
    // 刻意不依赖新事件：启用后由后台订阅安排新增步骤，避免 token 更新频繁 IPC。
  }, [explanationClient, sessionId, state.loaded, store])
  React.useEffect(() => {
    if (!state.explanationsEnabled || !state.selectedId) return
    const event = store.get(traceSessionStateAtomFamily(sessionId)).events.find((item) => item.id === state.selectedId)
    if (event && traceExplanationDisplay(event, true).status === 'pending') void explanationClient.requestMissing(sessionId, event.id)
  }, [explanationClient, sessionId, state.explanationsEnabled, state.selectedId, store])
  React.useEffect(() => {
    setRestoreFocusId(null)
    detailFocusRef.current = false
    let active = true
    const receivedDuringLoad: AgentTraceEvent[] = []
    let fetching = true
    setLoading(true)
    const unsubscribe = window.electronAPI.onAgentTraceEvent(({ sessionId: eventSessionId, event }) => {
      if (!active || eventSessionId !== sessionId || event.sessionId !== sessionId) return
      if (fetching) receivedDuringLoad.push(event)
      setState((previous) => ({ ...previous, events: mergeTraceEvents(previous.events, [event], sessionId) }))
    })
    void window.electronAPI.agentGetTrace(sessionId).then((events) => {
      if (!active) return
      fetching = false
      setState((previous) => ({ ...previous, events: mergeTraceEvents(events, receivedDuringLoad, sessionId), loaded: true, error: null }))
    }).catch((error: unknown) => {
      if (!active) return
      fetching = false
      setState((previous) => ({ ...previous, loaded: true, error: error instanceof Error ? error.message : '无法读取轨迹' }))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; unsubscribe() }
  }, [reload, sessionId, setState])
  const visible = React.useMemo(() => filterTraceEvents(state.events, state.query, state.onlyExceptions), [state.events, state.query, state.onlyExceptions])
  const visibleIds = React.useMemo(() => new Set(visible.map((event) => event.id)), [visible])
  const rounds = React.useMemo(() => groupTraceRounds(visible, state.events), [visible, state.events])
  const rows = React.useMemo(() => buildTraceRows(rounds, state.callsOpen ? state.collapsedRounds : rounds.map((round) => round.id)), [rounds, state.callsOpen, state.collapsedRounds])
  const selected = state.events.find((event) => event.id === state.selectedId && visibleIds.has(event.id))
  const select = React.useCallback((id: string) => {
    setRestoreFocusId(null)
    detailFocusRef.current = false
    setState((previous) => {
      const event = previous.events.find((candidate) => candidate.id === id)
      return { ...selectTraceEvent(previous, id), roundsOpen: true, callsOpen: true, collapsedRounds: event ? previous.collapsedRounds.filter((round) => round !== traceRoundId(event)) : previous.collapsedRounds }
    })
  }, [setState])
  const selectFromList = React.useCallback((id: string) => {
    select(id)
    detailFocusRef.current = true
  }, [select])
  const onStopFollowing = React.useCallback(() => setState((previous) => previous.followLatest ? { ...previous, followLatest: false } : previous), [setState])
  const onScrollTop = React.useCallback((scrollTop: number) => setState((previous) => Math.abs(previous.scrollTop - scrollTop) < 1 ? previous : { ...previous, scrollTop }), [setState])
  const onToggleRound = React.useCallback((id: string) => setState((previous) => ({ ...previous, collapsedRounds: previous.collapsedRounds.includes(id) ? previous.collapsedRounds.filter((candidate) => candidate !== id) : [...previous.collapsedRounds, id] })), [setState])
  const counts = React.useMemo(() => traceRecordCounts(state.events), [state.events])
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-content-area" aria-label="执行轨迹">
    <div className="shrink-0 space-y-2 px-3 pb-2 pt-3">
      <div className={cn('grid min-w-0 gap-2', width < 360 ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_auto]')}>
        <label className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-background/60 px-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input value={state.query} maxLength={512} onChange={(event) => setState((previous) => applyTraceFilter(previous, event.target.value, previous.onlyExceptions))} aria-label="搜索轨迹步骤、参数、结果和 Schema" placeholder="搜索步骤、参数或结果" className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" />
          {state.query && <button type="button" aria-label="清空轨迹搜索" className="rounded p-1 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setState((previous) => applyTraceFilter(previous, '', previous.onlyExceptions))}><X className="size-3" /></button>}
        </label>
        <select aria-label="轨迹事件筛选" value={state.onlyExceptions ? 'exceptions' : 'all'} onChange={(event) => setState((previous) => applyTraceFilter(previous, previous.query, event.target.value === 'exceptions'))} className="min-w-0 rounded-md border border-border/70 bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="all">全部事件</option><option value="exceptions">仅异常</option></select>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {([{ key: 'timelineOpen', label: '时长' }, { key: 'roundsOpen', label: '轮次' }, { key: 'callsOpen', label: '调用' }] as const).map((toggle) => <button key={toggle.key} type="button" aria-expanded={state[toggle.key]} className="inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setState((previous) => ({ ...previous, [toggle.key]: !previous[toggle.key] }))}>{state[toggle.key] ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}{toggle.label}</button>)}
        <span className="flex-1" />
        <label htmlFor={aiSwitchId} className="inline-flex h-7 cursor-pointer items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          {state.explanationsSyncing && <Loader2 className="size-3 animate-spin" aria-label="正在同步AI说明开关" />}
          AI说明
          <Switch id={aiSwitchId} checked={state.explanationsEnabled} aria-label="AI说明" onCheckedChange={(enabled) => {
            const current = store.get(traceSessionStateAtomFamily(sessionId))
            const shown = filterTraceEvents(current.events, current.query, current.onlyExceptions)
            void explanationClient.setEnabled(sessionId, enabled, enabled ? traceExplanationRequestIds(shown, current.selectedId) : [])
          }} className="scale-[.8]" />
        </label>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="刷新轨迹" disabled={loading} onClick={() => setReload((previous) => previous + 1)}><RefreshCw className={cn('!size-3', loading && 'animate-spin')} /></Button>
        <Button type="button" size="sm" variant="ghost" aria-pressed={state.followLatest} className={cn('h-7 px-1.5 text-[11px]', state.followLatest && 'bg-muted')} onClick={() => setState((previous) => ({ ...previous, followLatest: !previous.followLatest, selectedId: previous.followLatest ? previous.selectedId : null, roundsOpen: true, callsOpen: true }))}><ArrowDownToLine className="!size-3" />跟随</Button>
      </div>
    </div>
    {state.explanationsError && <div role="alert" className="mx-3 mb-2 rounded-md border border-amber-500/30 p-2 text-[11px] text-muted-foreground"><p>{state.explanationsError}</p>{!state.explanationsEnabled && <Button type="button" variant="ghost" size="sm" className="mt-1 h-6 px-1 text-[11px]" onClick={() => void explanationClient.setEnabled(sessionId, false, [])}>重试关闭AI说明</Button>}</div>}
    {state.timelineOpen && state.events.length > 0 && <TraceTimeline events={state.events} visibleIds={visibleIds} selectedId={selected?.id ?? (state.followLatest ? visible.at(-1)?.id ?? null : null)} mode={state.mode} onModeChange={(mode) => setState((previous) => ({ ...previous, mode }))} onSelect={select} onStopFollowing={onStopFollowing} />}
    {state.error && <div role="alert" className="m-3 shrink-0 rounded-md border border-destructive/25 bg-destructive/5 p-2 text-xs"><p className="break-all text-destructive">轨迹读取失败：{state.error}</p><Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => setReload((previous) => previous + 1)}>重新读取</Button></div>}
    {loading && !state.loaded && state.events.length === 0 ? <div role="status" className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在读取轨迹…</div>
      : state.events.length === 0 ? <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground"><p>这段会话还没有轨迹记录</p><p className="text-[11px]">开始任务后可查看真实调用；旧会话可恢复的步骤也会显示在这里。</p></div>
        : <>
          <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 border-b border-border/40 px-3 py-2 text-[10px] text-muted-foreground"><span>{visible.length} / {state.events.length} 条</span><span>{counts.modelCalls} 次模型调用</span><span>{counts.toolCalls} 次工具调用</span>{counts.historyReplies > 0 && <span>{counts.historyReplies} 条历史回复</span>}{counts.historyIncomplete && <span>部分历史字段未记录</span>}</div>
          <div className={cn('flex min-h-0 min-w-0 flex-1 overflow-hidden', !narrow && selected && 'grid grid-cols-[minmax(180px,.85fr)_minmax(0,1.15fr)]')}>
            {(!narrow || !selected) && <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {visible.length === 0 ? <div className="p-4 text-center text-xs text-muted-foreground">没有匹配的事件</div> : !state.roundsOpen ? <button type="button" className="m-3 rounded bg-muted/30 p-3 text-left text-xs text-muted-foreground" onClick={() => setState((previous) => ({ ...previous, roundsOpen: true }))}>展开 {rounds.length} 组轮次 · {visible.length} 条匹配记录</button> : <>
                {!state.callsOpen && <button type="button" className="m-2 rounded bg-muted/30 p-2 text-left text-xs text-muted-foreground" onClick={() => setState((previous) => ({ ...previous, callsOpen: true }))}>调用已折叠 · 展开 {visible.length} 条匹配记录</button>}
                <TraceEventList key={sessionId} sessionId={sessionId} rows={rows} selectedId={selected?.id ?? null} collapsedRounds={state.callsOpen ? state.collapsedRounds : rounds.map((round) => round.id)} followLatest={state.followLatest} scrollTop={state.scrollTop} filterKey={JSON.stringify([state.query, state.onlyExceptions])} focusEventId={restoreFocusId} explanationsEnabled={state.explanationsEnabled} onSelect={selectFromList} onToggleRound={(id) => { if (!state.callsOpen) setState((previous) => ({ ...previous, callsOpen: true, collapsedRounds: previous.collapsedRounds.filter((candidate) => candidate !== id) })); else onToggleRound(id) }} onScrollTop={onScrollTop} onStopFollowing={onStopFollowing} />
              </>}
            </div>}
            {selected && <div className={cn('flex min-h-0 min-w-0 flex-1 overflow-hidden', !narrow && 'border-l border-border/60')}><TraceDetail event={selected} events={state.events} tab={state.detailTab} focusBack={narrow && detailFocusRef.current} explanationsEnabled={state.explanationsEnabled} onTabChange={(detailTab) => setState((previous) => ({ ...previous, detailTab }))} onBack={() => { setRestoreFocusId(selected.id); setState((previous) => ({ ...previous, selectedId: null })) }} /></div>}
          </div>
        </>}
  </div>
}
