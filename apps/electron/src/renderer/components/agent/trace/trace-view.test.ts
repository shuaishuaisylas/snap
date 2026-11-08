import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentTraceEvent } from '@snap/shared'
import { applyTraceFilter, initialTraceState, selectTraceEvent, traceSessionStateAtomFamily } from './trace-state'
import { buildTraceRows, buildTraceTimeline, filterTraceEvents, groupTraceRounds, isTraceException, mergeTraceEvents, moveTraceSelection, traceDuration, traceDurationLabel, traceModelContexts, traceRecordCounts, traceStatusLabel, traceValueEntries, traceValueText } from './trace-view'

function event(id: string, patch: Partial<AgentTraceEvent> = {}): AgentTraceEvent {
  return { id, sessionId: 'a', kind: 'tool', name: id, status: 'completed', source: 'live', ...patch }
}

describe('轨迹事件与搜索', () => {
  test('given a result arriving after its running event when merging then updates one row without changing order', () => {
    const running = event('one', { status: 'running' })
    const result = event('one', { output: '实际返回', durationMs: 73 })
    const other = event('two')
    expect(mergeTraceEvents([running, other], [result], 'a')).toEqual([result, other])
  })

  test('given a stale loading snapshot and newer live updates when hydrating then live evidence wins', () => {
    const snapshot = event('request', { status: 'running' })
    const buffered = event('request', { status: 'error', output: 'timeout' })
    expect(mergeTraceEvents([snapshot], [buffered], 'a')).toEqual([buffered])
  })

  test('given events from another session when merging then never exposes them in this session', () => {
    expect(mergeTraceEvents([event('own')], [event('foreign', { sessionId: 'b' })], 'a').map((item) => item.id)).toEqual(['own'])
  })

  test('given history and an unbound precise model in GET when a native binding update arrives then removes the historical duplicate and normalizes the call count', () => {
    const history = event('pi:native-one', { kind: 'model', source: 'history', metadata: { nativeEntryId: 'native-one', contextLayer: 'pi-transcript' } })
    const precise = event('request-one', { kind: 'model', runId: 'run-one', requestId: 'request-one', status: 'running' })
    const initial = mergeTraceEvents([history, precise], [], 'a')
    expect(traceRecordCounts(initial).modelCalls).toBe(2)
    const finished = { ...precise, status: 'completed' as const, metadata: { nativeEntryId: 'native-one' } }
    const merged = mergeTraceEvents(initial, [finished], 'a')
    expect(merged).toEqual([finished])
    expect(traceRecordCounts(merged).modelCalls).toBe(1)
    expect(mergeTraceEvents(merged, [history], 'a')).toEqual([finished])
  })

  test('given tools referencing their parent assistant native entry when merging then never deduplicates tools or treats tool metadata as a model binding', () => {
    const historyModel = event('pi:native-one', { kind: 'model', source: 'history', metadata: { nativeEntryId: 'native-one' } })
    const historyTool = event('pi:tool:one', { source: 'history', metadata: { nativeEntryId: 'native-one', toolCallId: 'tool-one' } })
    const preciseTool = event('tool-one', { runId: 'run-one', metadata: { nativeEntryId: 'native-one', toolCallId: 'tool-one' } })
    expect(mergeTraceEvents([historyModel, historyTool], [preciseTool], 'a')).toEqual([historyModel, historyTool, preciseTool])
    const preciseModel = event('request-one', { kind: 'model', runId: 'run-one', requestId: 'request-one', metadata: { nativeEntryId: 'native-one' } })
    expect(mergeTraceEvents([historyModel, historyTool, preciseTool], [preciseModel], 'a')).toEqual([historyTool, preciseTool, preciseModel])
  })

  test('given failed and successful precise requests sharing a display message when merging then preserves both requests even when their native bindings coincide', () => {
    const failed = event('request-failed', { kind: 'model', runId: 'run-one', requestId: 'failed', messageUuid: 'same-display', status: 'error', source: 'history', metadata: { nativeEntryId: 'native-one' } })
    const succeeded = event('request-succeeded', { kind: 'model', runId: 'run-one', requestId: 'succeeded', messageUuid: 'same-display', status: 'completed', metadata: { nativeEntryId: 'native-one' } })
    expect(mergeTraceEvents([failed], [succeeded], 'a')).toEqual([failed, succeeded])
    expect(traceRecordCounts(mergeTraceEvents([failed], [succeeded], 'a')).modelCalls).toBe(2)
  })

  test('given nested input output schema and metadata when searching then finds evidence beyond the visible preview', () => {
    const source = event('inspect', { input: { messages: [{ text: '上下文中的目标' }] }, output: 'x'.repeat(6000) + '真实尾部', schema: { properties: { 查询名称: { type: 'string' } } }, metadata: { provider: 'DeepSeek' } })
    for (const query of ['上下文中的目标', '真实尾部', '查询名称', 'deepseek']) expect(filterTraceEvents([source], query, false)).toEqual([source])
    expect(filterTraceEvents([source], '不存在', false)).toEqual([])
  })

  test('given success error interruption and unknown events when filtering exceptions then excludes unknown from failure claims', () => {
    const records = [event('ok'), event('bad', { status: 'error' }), event('stop', { status: 'interrupted' }), event('old', { status: 'unknown' })]
    expect(filterTraceEvents(records, '', true).map((item) => item.id)).toEqual(['bad', 'stop'])
    expect(isTraceException(records[3]!)).toBe(false)
    expect(traceStatusLabel(records[0]!)).toBe('已返回')
    expect(traceStatusLabel(event('model', { kind: 'model' }))).toBe('已结束')
  })

  test('given native calls and display-only historical replies when counting then never treats recovered replies as provider requests', () => {
    const records = [event('live', { kind: 'model' }), event('pi', { kind: 'model', source: 'history', metadata: { contextLayer: 'pi-transcript' } }), event('display', { kind: 'model', status: 'unknown', source: 'history', metadata: { contextLayer: 'display-message', historyIncomplete: true } }), event('tool')]
    expect(traceRecordCounts(records)).toEqual({ modelCalls: 2, toolCalls: 1, historyReplies: 1, historyIncomplete: true })
  })
})

describe('真实计时与三轨对齐', () => {
  test('given input model and tool timestamps when building a time axis then all lanes use the same domain', () => {
    const input = event('input', { kind: 'input', startedAt: 1000, endedAt: 1100 })
    const model = event('model', { kind: 'model', startedAt: 1100, endedAt: 1500 })
    const tool = event('tool', { startedAt: 1500, endedAt: 2000 })
    const timeline = buildTraceTimeline([input, model, tool], 'duration')
    expect(timeline.start).toBe(1000)
    expect(timeline.end).toBe(2000)
    expect(timeline.items.map((item) => [item.lane, item.left, item.width])).toEqual([['input', 0, 10], ['model', 10, 40], ['tool', 50, 50]])
  })

  test('given a search for one failure when applying visible ids then its full-axis position is retained', () => {
    const records = [event('input', { kind: 'input', startedAt: 0, endedAt: 10 }), event('failed', { status: 'error', startedAt: 50, endedAt: 100 }), event('other', { startedAt: 150, endedAt: 200 })]
    const matching = new Set(filterTraceEvents(records, '', true).map((item) => item.id))
    const timeline = buildTraceTimeline(records, 'duration')
    expect(timeline.items.filter((item) => matching.has(item.event.id)).map((item) => item.left)).toEqual([25])
    const ordered = buildTraceTimeline(records, 'order')
    expect(ordered.items.filter((item) => matching.has(item.event.id))[0]!.left).toBeCloseTo(100 / 3)
  })

  test('given legacy events without time when using duration mode then reports missing values and creates no fabricated bars', () => {
    const records = [event('legacy', { source: 'history' }), event('duration-only', { durationMs: 700 })]
    expect(buildTraceTimeline(records, 'duration')).toEqual({ items: [], missingCount: 2 })
    expect(traceDuration(records[0]!)).toBeUndefined()
    expect(traceDurationLabel(traceDuration(records[0]!))).toBe('未记录')
    expect(buildTraceTimeline(records, 'order').items).toHaveLength(2)
  })

  test('given an unfinished last tool when plotting then preserves a point at the endpoint without inventing duration', () => {
    const timeline = buildTraceTimeline([event('done', { startedAt: 100, endedAt: 300 }), event('running', { status: 'running', startedAt: 300 })], 'duration')
    const last = timeline.items.at(-1)!
    expect(last.left).toBe(100)
    expect(last.width).toBe(0)
    expect(last.point).toBe(true)
    expect(traceDuration(last.event)).toBeUndefined()
  })

  test('given invalid negative or reversed time when computing duration then does not present a negative or zero substitute', () => {
    expect(traceDuration(event('reverse', { startedAt: 500, endedAt: 200 }))).toBeUndefined()
    expect(traceDuration(event('invalid', { durationMs: Number.NaN }))).toBeUndefined()
    expect(traceDuration(event('zero', { durationMs: 0 }))).toBe(0)
  })
})

describe('轮次、上下文和大结果', () => {
  test('given two runs both numbered round one when grouping then labels and groups remain distinct through filters', () => {
    const records = [event('one', { runId: 'r1', roundIndex: 1 }), event('two', { runId: 'r2', roundIndex: 1 })]
    const rounds = groupTraceRounds(records)
    expect(rounds.map((round) => round.label)).toEqual(['执行 1 · 第 1 轮', '执行 2 · 第 1 轮'])
    expect(groupTraceRounds([records[1]!], records)[0]!.label).toBe('执行 2 · 第 1 轮')
  })

  test('given a collapsed round when reopening then all original calls become available', () => {
    const rounds = groupTraceRounds([event('one', { roundIndex: 1 }), event('two', { roundIndex: 1 })])
    expect(buildTraceRows(rounds, [rounds[0]!.id]).map((row) => row.type)).toEqual(['round'])
    expect(buildTraceRows(rounds, []).filter((row) => row.type === 'event')).toHaveLength(2)
  })

  test('given model contexts from different requests runs and sessions when viewing context then only links exact captured input', () => {
    const model = event('model', { kind: 'model', requestId: 'p1', runId: 'r1' })
    const own = event('own-context', { kind: 'context', requestId: 'p1', runId: 'r1', input: { messages: ['真实输入'] } })
    const records = [own, event('other-request', { kind: 'context', requestId: 'p2', runId: 'r1' }), event('other-run', { kind: 'context', requestId: 'p1', runId: 'r2' }), event('other-session', { sessionId: 'b', kind: 'context', requestId: 'p1', runId: 'r1' })]
    expect(traceModelContexts(model, records)).toEqual([own])
    expect(traceModelContexts(event('legacy', { kind: 'model' }), records)).toEqual([])
  })

  test('given a large nested result when paging fields then keeps full evidence available for copy without mutation', () => {
    const original = Object.fromEntries(Array.from({ length: 180 }, (_, i) => [`key${i}`, { text: `${i}` }]))
    expect(traceValueEntries(original, 60)).toHaveLength(60)
    expect(traceValueEntries(original, 160).at(-1)?.[0]).toBe('key159')
    expect(traceValueText(original)).toContain('key179')
    expect(Object.keys(original)).toHaveLength(180)
  })

  test('given keyboard navigation at the ends of a call list when moving then stays in bounds', () => {
    const records = [event('a'), event('b')]
    expect(moveTraceSelection(records, 'a', 'ArrowUp')).toBe('a')
    expect(moveTraceSelection(records, 'b', 'ArrowDown')).toBe('b')
    expect(moveTraceSelection(records, null, 'ArrowDown')).toBe('a')
    expect(moveTraceSelection(records, 'a', 'End')).toBe('b')
    expect(moveTraceSelection([], null, 'Home')).toBeNull()
  })
})

describe('会话级轨迹视图状态', () => {
  test('given two sessions when selecting filtering and scrolling one then does not modify the other', () => {
    const store = createStore()
    const a = traceSessionStateAtomFamily('a')
    const b = traceSessionStateAtomFamily('b')
    store.set(a, { ...selectTraceEvent(initialTraceState(), 'a-call'), query: 'only-a', scrollTop: 600, followLatest: false })
    expect(store.get(a).selectedId).toBe('a-call')
    expect(store.get(b)).toEqual(initialTraceState())
  })

  test('given a selected old call when new live evidence arrives then selection and manual follow setting are retained', () => {
    const previous = selectTraceEvent({ ...initialTraceState(), events: [event('old')] }, 'old')
    const updated = { ...previous, events: mergeTraceEvents(previous.events, [event('new')], 'a') }
    expect(updated.selectedId).toBe('old')
    expect(updated.followLatest).toBe(false)
  })

  test('given selected detail and scroll position when changing filter then returns to matching list and requests top position', () => {
    const previous = { ...selectTraceEvent(initialTraceState(), 'one'), scrollTop: 900 }
    const filtered = applyTraceFilter(previous, 'timeout', true)
    expect(filtered.selectedId).toBeNull()
    expect(filtered.scrollTop).toBe(0)
    expect(filtered.onlyExceptions).toBe(true)
  })

  test('given more than thirty cached sessions when opening another then evicts only old UI caches', () => {
    const store = createStore()
    for (let i = 0; i < 31; i++) store.set(traceSessionStateAtomFamily(`cache-${i}`), { ...initialTraceState(), query: `${i}` })
    expect(store.get(traceSessionStateAtomFamily('cache-0')).query).toBe('')
    expect(store.get(traceSessionStateAtomFamily('cache-30')).query).toBe('30')
  })
})
