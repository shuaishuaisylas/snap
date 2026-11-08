import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { AgentTraceEvent } from '@snap/shared'
import { TraceTimeline } from './TraceTimeline'
import { TraceValue } from './TraceValue'
import { TracePanel } from './TracePanel'
import { initialTraceState, traceSessionStateAtomFamily } from './trace-state'

describe('轨迹可视证据边界', () => {
  test('given a point at the end of a real time axis when rendering then retains a visible nonzero width', () => {
    const events: AgentTraceEvent[] = [
      { id: 'done', sessionId: 'a', kind: 'model', name: '请求', status: 'completed', source: 'live', startedAt: 100, endedAt: 300 },
      { id: 'running', sessionId: 'a', kind: 'tool', name: '正在运行', status: 'running', source: 'live', startedAt: 300 },
    ]
    const html = renderToStaticMarkup(<TraceTimeline events={events} visibleIds={new Set(['running'])} selectedId="running" mode="duration" onModeChange={() => {}} onSelect={() => {}} />)
    expect(html).toContain('data-trace-mark="running"')
    expect(html).not.toContain('data-trace-mark="done"')
    expect(html).toContain('calc(100% - 3px)')
    expect(html).toContain('max-width:max(3px, 0%)')
    expect(html).toContain('仅记录开始时间')
  })

  test('given a recorded zero-duration event when rendering its point then announces zero rather than a missing finish', () => {
    const event: AgentTraceEvent = { id: 'zero', sessionId: 'a', kind: 'tool', name: '零时长返回', status: 'completed', source: 'live', startedAt: 100, endedAt: 100, durationMs: 0 }
    const html = renderToStaticMarkup(<TraceTimeline events={[event]} visibleIds={new Set(['zero'])} selectedId={null} mode="duration" onModeChange={() => {}} onSelect={() => {}} />)
    expect(html).toContain('耗时0 毫秒')
    expect(html).not.toContain('仅记录开始时间')
  })

  test('given a selected event in a narrow pane when rendering then presents inline detail with an accessible return control', () => {
    const store = createStore()
    const record: AgentTraceEvent = { id: 'selected', sessionId: 'narrow', kind: 'tool', name: '已选步骤', status: 'completed', source: 'live', input: { target: '页面按钮' } }
    store.set(traceSessionStateAtomFamily('narrow'), { ...initialTraceState(), events: [record], loaded: true, selectedId: record.id, timelineOpen: false })
    const html = renderToStaticMarkup(<Provider store={store}><TracePanel sessionId="narrow" width={320} /></Provider>)
    expect(html).toContain('aria-label="返回轨迹步骤"')
    expect(html).toContain('aria-label="轨迹事件详情"')
    expect(html).not.toContain('data-trace-session="narrow"')
  })

  test('given a very long single-line result when rendering then limits mounted text while retaining an expand action', () => {
    const text = 'x'.repeat(9000) + 'final-evidence'
    const html = renderToStaticMarkup(<TraceValue value={text} label="结果" />)
    expect(html).toContain('再显示一段')
    expect(html).toContain('复制全文')
    expect(html).not.toContain('final-evidence')
    expect(text).toEndWith('final-evidence')
  })

  test('given five thousand events when rendering the timeline then mounts only viewport marks while keeping the whole shared domain', () => {
    const events: AgentTraceEvent[] = Array.from({ length: 5000 }, (_, index) => ({
      id: `event-${index}`, sessionId: 'a', kind: 'tool', name: `步骤 ${index}`, status: 'completed', source: 'history',
    }))
    const html = renderToStaticMarkup(<TraceTimeline events={events} visibleIds={new Set(events.map((event) => event.id))} selectedId={null} mode="order" onModeChange={() => {}} onSelect={() => {}} />)
    expect((html.match(/data-trace-mark=/g) ?? []).length).toBeLessThan(40)
    expect(html).toContain('5000 条记录')
    expect(html).toContain('width:95000px')
  })

  test('given many nested JSON fields when rendering then paginates root and does not mount unopened child evidence', () => {
    const value = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key-${i}`, { nested: 'hidden-value' }]))
    const html = renderToStaticMarkup(<TraceValue value={value} label="Schema" />)
    expect(html).toContain('key-59')
    expect(html).not.toContain('key-60')
    expect(html).not.toContain('hidden-value')
    expect(html).toContain('再展开 40 项')
    expect(html).toContain('aria-expanded="false"')
  })
})
