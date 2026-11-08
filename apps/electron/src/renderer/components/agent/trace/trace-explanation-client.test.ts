import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentTraceEvent } from '@snap/shared'
import { TraceExplanationClient } from './trace-explanation-client'
import { initialTraceState, traceSessionStateAtomFamily } from './trace-state'

type Request = (sessionId: string, enabled: boolean, eventIds?: string[]) => Promise<AgentTraceEvent[]>
function fixture(request: Request = async () => []) {
  const store = createStore()
  const calls: Array<{ sessionId: string; enabled: boolean; eventIds: string[] | undefined }> = []
  const client = new TraceExplanationClient({
    request: async (sessionId, enabled, eventIds) => { calls.push({ sessionId, enabled, eventIds }); return request(sessionId, enabled, eventIds) },
    getState: (id) => store.get(traceSessionStateAtomFamily(id)),
    setState: (id, update) => store.set(traceSessionStateAtomFamily(id), update),
  })
  return { client, store, calls, state: (id = 'a') => store.get(traceSessionStateAtomFamily(id)) }
}

describe('AI说明开关与异步IPC', () => {
  test('given default off when selecting a missing step then performs no enable request', async () => {
    const { client, state, calls } = fixture()
    await client.requestMissing('a', 'old-step')
    expect(calls).toHaveLength(0)
    expect(state().explanationsEnabled).toBe(false)
  })

  test('given restoring off when synchronizing then sends false only and never implicitly enables generation', async () => {
    const { client, calls, state } = fixture()
    await client.setEnabled('a', false, [])
    expect(calls).toEqual([{ sessionId: 'a', enabled: false, eventIds: [] }])
    expect(state().explanationsEnabled).toBe(false)
    expect(state().explanationsSyncing).toBe(false)
  })

  test('given explicit enable and repeated selection when requesting then avoids duplicate IDs but can request one older missing step', async () => {
    const { client, calls, state } = fixture()
    await client.setEnabled('a', true, ['recent'])
    await client.requestMissing('a', 'recent')
    await client.requestMissing('a', 'old')
    await client.requestMissing('a', 'old')
    expect(calls).toEqual([{ sessionId: 'a', enabled: true, eventIds: ['recent'] }, { sessionId: 'a', enabled: true, eventIds: ['old'] }])
    expect(state().explanationsEnabled).toBe(true)
  })

  test('given enable still in flight when user turns off then immediately hides explanations and ignores the late enable response', async () => {
    let finish!: (events: AgentTraceEvent[]) => void
    const pending = new Promise<AgentTraceEvent[]>((resolve) => { finish = resolve })
    const { client, state, calls } = fixture(async (_id, enabled) => enabled ? pending : [])
    const enabled = client.setEnabled('a', true, ['one'])
    expect(state().explanationsEnabled).toBe(true)
    const disabled = client.setEnabled('a', false, [])
    expect(state().explanationsEnabled).toBe(false)
    await disabled
    finish([{ id: 'late', sessionId: 'a', kind: 'tool', name: 'late', source: 'live', status: 'completed' }])
    await enabled
    expect(state().explanationsEnabled).toBe(false)
    expect(state().events).toEqual([])
    expect(calls.map((call) => call.enabled)).toEqual([true, false])
  })

  test('given cancelling fails when turning off then keeps local visibility off and reports the uncertain backend state', async () => {
    const { client, state } = fixture(async () => { throw new Error('synthetic IPC failure') })
    await client.setEnabled('a', false, [])
    expect(state().explanationsEnabled).toBe(false)
    expect(state().explanationsError).toContain('未能确认后台已停止')
    expect(state().explanationsSyncing).toBe(false)
  })

  test('given an enable failure when explicitly toggling off and on then allows a fresh bounded attempt', async () => {
    let count = 0
    const { client, state, calls } = fixture(async (_id, enabled) => { if (enabled && count++ === 0) throw new Error('failed'); return [] })
    await client.setEnabled('a', true, ['one'])
    expect(state().explanationsError).toContain('开启失败')
    await client.setEnabled('a', false, [])
    await client.setEnabled('a', true, ['one'])
    expect(state().explanationsError).toBeNull()
    expect(calls.map((call) => call.enabled)).toEqual([true, false, true])
  })

  test('given cached enabled state when a pane remounts then can resynchronize it without enabling another session', async () => {
    const { client, store, state, calls } = fixture()
    store.set(traceSessionStateAtomFamily('a'), { ...initialTraceState(), explanationsEnabled: true })
    await client.setEnabled('a', state().explanationsEnabled, ['visible'])
    expect(calls[0]).toEqual({ sessionId: 'a', enabled: true, eventIds: ['visible'] })
    expect(state('b').explanationsEnabled).toBe(false)
  })

  test('given a stale complete snapshot after live evidence arrives when syncing then never rolls the event back', async () => {
    let finish!: (events: AgentTraceEvent[]) => void
    const pending = new Promise<AgentTraceEvent[]>((resolve) => { finish = resolve })
    const { client, store, state } = fixture(async () => pending)
    const before: AgentTraceEvent = { id: 'one', sessionId: 'a', kind: 'tool', name: 'read', status: 'running', source: 'live' }
    store.set(traceSessionStateAtomFamily('a'), { ...initialTraceState(), events: [before] })
    const syncing = client.setEnabled('a', true, ['one'])
    const completed = { ...before, status: 'completed' as const, output: 'new live result' }
    store.set(traceSessionStateAtomFamily('a'), (previous) => ({ ...previous, events: [completed] }))
    finish([before])
    await syncing
    expect(state().events).toEqual([completed])
  })

  test('given unmount invalidation when an old response arrives then does not write into a later pane', async () => {
    let finish!: (events: AgentTraceEvent[]) => void
    const pending = new Promise<AgentTraceEvent[]>((resolve) => { finish = resolve })
    const { client, state } = fixture(async () => pending)
    const syncing = client.setEnabled('a', true, [])
    client.invalidate()
    finish([{ id: 'old', sessionId: 'a', kind: 'tool', name: 'old', source: 'history', status: 'completed' }])
    await syncing
    expect(state().events).toEqual([])
    expect(state('b').explanationsEnabled).toBe(false)
  })
})
