import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { AgentTraceEvent, AgentTraceExplanation } from '@snap/shared'
import { TraceDetail } from './TraceDetail'
import { TracePanel } from './TracePanel'
import { TraceEventPreview, TraceExplanationSummary } from './TraceExplanationSummary'
import { initialTraceState, traceSessionStateAtomFamily } from './trace-state'
import { traceExplanationRequestIds } from './trace-explanation-display'

function step(explanation?: AgentTraceExplanation): AgentTraceEvent {
  return { id: 'tool-one', sessionId: 'session-one', kind: 'tool', name: 'Read', status: 'completed', source: 'live',
    input: { file_path: '/project/index.html' }, output: '实际读取的页面内容', explanation }
}

function detail(event: AgentTraceEvent, enabled = false, tab: 'overview' | 'input' = 'overview'): string {
  return renderToStaticMarkup(<TraceDetail event={event} events={[event]} tab={tab} explanationsEnabled={enabled} focusBack={false} onTabChange={() => {}} onBack={() => {}} />)
}

describe('默认关闭、只接受模型产物的AI说明', () => {
  test('given a fresh session when rendering its trace then AI说明 is off and no explanation is displayed', () => {
    const html = renderToStaticMarkup(<TracePanel sessionId="fresh-off" width={320} />)
    expect(initialTraceState().explanationsEnabled).toBe(false)
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-label="AI说明"')
    expect(html).toContain('aria-checked="false"')
    expect(html).not.toContain('等待AI说明')
  })

  test('given a cached model result when AI说明 is off then hides it in overview and retains the raw list preview', () => {
    const event = step({ text: '读取页面文件，是为了确认提交按钮的结构。', source: 'model', status: 'ready', version: 2 })
    const html = detail(event)
    expect(html).not.toContain('aria-label="步骤说明"')
    expect(html).not.toContain(event.explanation!.text)
    expect(html).toContain('实际读取的页面内容')
    const preview = renderToStaticMarkup(<TraceEventPreview event={event} />)
    expect(preview).toContain('实际读取的页面内容')
    expect(preview).not.toContain(event.explanation!.text)
  })

  test('given old rule recorded or v1 model caches when enabled then ignores every old text and honestly waits for AI', () => {
    for (const source of ['rule', 'recorded', 'model'] as const) {
      const event = step({ text: '旧规则不应再次显示', source, status: 'ready', version: 1 })
      const html = detail(event, true)
      const preview = renderToStaticMarkup(<TraceEventPreview event={event} enabled />)
      expect(html).toContain('等待AI说明')
      expect(html).not.toContain('旧规则不应再次显示')
      expect(preview).toContain('等待AI说明')
      expect(preview).not.toContain('旧规则不应再次显示')
      expect(preview).not.toContain('实际读取的页面内容')
    }
  })

  test('given a current generated explanation when enabled then shows it first with an inference marker and uses it in list preview', () => {
    const event = step({ text: '读取页面文件，是为了确认提交按钮的结构。', source: 'model', status: 'ready', version: 2 })
    const html = detail(event, true)
    expect(html).toContain(event.explanation!.text)
    expect(html.indexOf('aria-label="步骤说明"')).toBeLessThan(html.indexOf('<dt'))
    expect(html).toContain('根据步骤推测')
    expect(html).toContain('实际读取的页面内容')
    expect(html).not.toContain('等待AI说明')
    const preview = renderToStaticMarkup(<TraceEventPreview event={event} enabled />)
    expect(preview).toContain(event.explanation!.text)
    expect(preview).not.toContain('实际读取的页面内容')
  })

  test('given a pending explanation when enabled then states that AI is waiting without inventing an action or purpose', () => {
    const html = detail(step(), true)
    expect(html).toContain('等待AI说明')
    expect(html).toContain('主任务运行时会排队')
    expect(html).not.toContain('已读取 index.html')
    expect(html).toContain('实际读取的页面内容')
  })

  test('given a model failure when enabled then shows an explicit retry route and keeps original evidence visible', () => {
    const event = step({ text: '', source: 'model', status: 'unavailable', version: 2 })
    const html = detail(event, true)
    expect(html).toContain('AI说明暂不可用，可关闭后重新开启')
    expect(html).toContain('实际读取的页面内容')
    expect(html).not.toContain('等待AI说明')
  })

  test('given generated markup when displaying an explanation then renders it as text', () => {
    const html = renderToStaticMarkup(<TraceExplanationSummary enabled event={step({ text: '读取页面，可能是为了检查 <button> 的布局。', source: 'model', status: 'ready', version: 2 })} />)
    expect(html).toContain('&lt;button&gt;')
    expect(html).not.toContain('<button> 的布局')
  })

  test('given a parameter tab while AI说明 is off then retains complete original parameters', () => {
    const html = detail(step(), false, 'input')
    expect(html).toContain('调用参数')
    expect(html).toContain('/project/index.html')
    expect(html).not.toContain('aria-label="步骤说明"')
  })

  test('given an enabled cached session and another fresh session when rendering then never inherits the switch', () => {
    const store = createStore()
    store.set(traceSessionStateAtomFamily('enabled-session'), { ...initialTraceState(), explanationsEnabled: true })
    const enabled = renderToStaticMarkup(<Provider store={store}><TracePanel sessionId="enabled-session" width={460} /></Provider>)
    const fresh = renderToStaticMarkup(<Provider store={store}><TracePanel sessionId="new-session" width={460} /></Provider>)
    expect(enabled).toContain('aria-checked="true"')
    expect(fresh).toContain('aria-checked="false"')
  })

  test('given a failed disable sync when rendering then keeps AI hidden and exposes a retry-off action', () => {
    const store = createStore()
    store.set(traceSessionStateAtomFamily('off-failure'), { ...initialTraceState(), explanationsError: '未能确认后台已停止，请重试关闭AI说明。' })
    const html = renderToStaticMarkup(<Provider store={store}><TracePanel sessionId="off-failure" width={460} /></Provider>)
    expect(html).toContain('role="alert"')
    expect(html).toContain('重试关闭AI说明')
    expect(html).toContain('aria-checked="false"')
  })

  test('given hundreds of filtered events and a selected old step when enabling then requests at most 120 with selection first', () => {
    const events = Array.from({ length: 500 }, (_, index) => ({ ...step(), id: `event-${index}` }))
    const ids = traceExplanationRequestIds(events, 'event-0')
    expect(ids).toHaveLength(120)
    expect(ids[0]).toBe('event-0')
    expect(ids[1]).toBe('event-499')
    expect(new Set(ids).size).toBe(120)
    expect(traceExplanationRequestIds([], null)).toEqual([])
  })
})
