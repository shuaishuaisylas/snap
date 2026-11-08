import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'
import type { AgentTraceEvent } from '@snap/shared'
import type { TraceDetailTab, TraceTimeMode } from './trace-view'

export interface TraceViewState {
  events: AgentTraceEvent[]
  loaded: boolean
  error: string | null
  query: string
  onlyExceptions: boolean
  selectedId: string | null
  detailTab: TraceDetailTab
  mode: TraceTimeMode
  timelineOpen: boolean
  roundsOpen: boolean
  callsOpen: boolean
  collapsedRounds: string[]
  followLatest: boolean
  scrollTop: number
  explanationsEnabled: boolean
  explanationsSyncing: boolean
  explanationsError: string | null
}

export function initialTraceState(): TraceViewState {
  return {
    events: [], loaded: false, error: null, query: '', onlyExceptions: false, selectedId: null,
    detailTab: 'overview', mode: 'order', timelineOpen: true, roundsOpen: true, callsOpen: true,
    collapsedRounds: [], followLatest: true, scrollTop: 0,
    explanationsEnabled: false, explanationsSyncing: false, explanationsError: null,
  }
}

/** 仅保存本次运行中的视图；最多缓存 30 个会话，历史证据由主进程保管。 */
const sessionStatesAtom = atom<Map<string, TraceViewState>>(new Map())
const emptyState = initialTraceState()
export const traceSessionStateAtomFamily = atomFamily((sessionId: string) => atom(
  (get) => get(sessionStatesAtom).get(sessionId) ?? emptyState,
  (get, set, update: TraceViewState | ((previous: TraceViewState) => TraceViewState)) => {
    const map = new Map(get(sessionStatesAtom))
    const previous = map.get(sessionId) ?? initialTraceState()
    const next = typeof update === 'function' ? update(previous) : update
    if (next === previous) return
    map.delete(sessionId)
    map.set(sessionId, next)
    while (map.size > 30) map.delete(map.keys().next().value!)
    set(sessionStatesAtom, map)
  },
))

export function applyTraceFilter(state: TraceViewState, query: string, onlyExceptions: boolean): TraceViewState {
  return { ...state, query, onlyExceptions, selectedId: null, scrollTop: 0, followLatest: false }
}

export function selectTraceEvent(state: TraceViewState, eventId: string): TraceViewState {
  return { ...state, selectedId: eventId, detailTab: 'overview', followLatest: false }
}
