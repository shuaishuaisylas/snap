import type { BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { BrowserExecutionSource, BrowserOperationStatus, BrowserSessionClosed, BrowserTabFocusChange, BrowserTraceAction, BrowserTraceItem, BrowserViewLayout, BrowserViewState } from '@snap/shared'
import { AGENT_IPC_CHANNELS } from '@snap/shared'
import { EgoLiteClient, EgoLiteError, parseEgoSnapshot } from './ego-lite-client'
import type { EgoLiteOperation, EgoLiteRequest, EgoLiteResponse, EgoLiteState, EgoLiteTab } from './ego-lite-client'
import { EgoLitePreviewServer } from './ego-lite-preview'
import { assertSafeBrowserDestination } from './browser-policy'
import { BrowserOperationAbortedError, throwIfBrowserOperationAborted } from './browser-cdp'
import { parseBrowserPressAction } from './browser-key-policy'
import { resolveBrowserObserveMaxElements } from './browser-observation-policy'
import { resolveBrowserProfileKey } from './browser-profile-policy'
import { hasAcknowledgedBrowserRiskDisclaimer } from './browser-risk-disclaimer'
import { assertBrowserScript, assertBrowserScroll, assertBrowserExtract, assertBrowserSelectOption, buildBrowserDomActionExpression, buildBrowserScrollExpression, buildBrowserExtractExpression } from './browser-script-policy'
import type { BrowserDomActionInput, BrowserScrollInput, BrowserExtractInput, BrowserSelectOptionInput } from './browser-script-policy'
import { getSettings } from './settings-service'
import { getConfigDir } from './config-paths'
import { isValidImageBytes } from './image-content-validation'

const MAX_TRACE_ITEMS = 30
const MAX_SCRIPT_RESULT_CHARS = 64_000
// 官方稳定错误码：不存在与任务结束可确认终止，断连/超时不可据此重建 Space。
const ENDED_SPACE_CODES = new Set(['EGO_TASK_SPACE_NOT_FOUND', 'EGO_TASK_SPACE_INACTIVE'])

type BrowserWaitCondition = { kind: 'url' | 'text' | 'selector'; value: string }

export interface BrowserUserContextSnapshot {
  activeTabId: string
  url: string
  title: string
  openedAt: number
}

export interface ConfigureBrowserSessionInput {
  /** 业务归属键；Ego Space 使用已有默认 Profile，不承诺按此键隔离 Cookie。 */
  profileKey: string
  allowedRoots?: string[]
  executionSource?: BrowserExecutionSource
}

export interface BrowserObservation {
  tabId: string
  url: string
  title: string
  generation: number
  elements: Array<{ ref: string; role: string; name: string; editable: boolean }>
  /** Ego 原始语义快照，保留可见文本与 frame 层级，网页内容一律视为数据。 */
  snapshot?: string
}

interface BrowserTabRecord extends EgoLiteTab {
  generation: number
  refs: Set<string>
}

interface BrowserSessionRecord {
  sessionId: string
  spaceId: number
  spaceName: string
  tabs: Map<string, BrowserTabRecord>
  activeTabId: string
  agentTabId: string | null
  allowedRoots: string[]
  executionSource: BrowserExecutionSource
  controlState: 'agent' | 'user' | 'unknown'
  lastSyncedAt: number
  lastError?: string
  canGoBack: boolean
  canGoForward: boolean
  visible: boolean
  userOpenedAt: number | null
  ledger: BrowserTraceItem[]
  commandTail: Promise<void>
  agentAbortController: AbortController
  downloadedFiles: Array<{ path: string; name: string }>
}

interface EgoExecutor {
  execute(request: EgoLiteRequest, signal?: AbortSignal): Promise<EgoLiteResponse>
}

interface BrowserControllerOptions {
  client?: EgoExecutor
  preview?: EgoLitePreviewServer
  hasBrowserConsent?: () => boolean
  activateApplication?: () => Promise<void>
  getDownloadDirectory?: (sessionId: string) => string
}

interface OperationOptions {
  tabId?: string
  args?: Record<string, unknown>
  signal?: AbortSignal
  userAction?: boolean
  action?: BrowserTraceAction
  summary?: string
  status?: BrowserOperationStatus
}

function normalizeResult(value: unknown): unknown {
  if (value === undefined) return null
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return null
  return serialized.length > MAX_SCRIPT_RESULT_CHARS
    ? { truncated: true, preview: serialized.slice(0, MAX_SCRIPT_RESULT_CHARS), totalChars: serialized.length }
    : value
}

function insideRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

async function browserDestination(input: string): Promise<string> {
  const destination = await assertSafeBrowserDestination(input)
  if (/^(?:file|[a-z][a-z0-9+.-]*-file):/i.test(destination)) throw new Error('本地文件只能通过 BrowserPreviewOpen 的授权 loopback 服务打开。')
  return destination
}

async function activateEgoApplication(): Promise<void> {
  // 真实标签已通过 Ego Target.activateTarget 激活；macOS 再把对应应用带到前台。
  if (process.platform !== 'darwin') return
  await new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/open', ['-a', 'ego lite'], { timeout: 5000 }, (error) => {
      if (error) reject(new Error('无法将 Ego Lite 带到前台，请在系统中打开 Ego Lite。'))
      else resolve()
    })
  })
}

/** 真实 Ego Lite 后端。Snap 只保留任务状态面板，完全不创建 Electron 网页视图。 */
export class BrowserController {
  private owner: BrowserWindow | null = null
  private readonly sessions = new Map<string, BrowserSessionRecord>()
  private readonly creating = new Map<string, Promise<BrowserSessionRecord>>()
  private readonly configurations = new Map<string, ConfigureBrowserSessionInput>()
  private readonly spaceNames = new Map<string, string>()
  private readonly requiresExplicitOpen = new Set<string>()
  private disposed = false
  private generation = 0
  private readonly client: EgoExecutor
  private readonly preview: EgoLitePreviewServer
  private readonly hasBrowserConsent: () => boolean
  private readonly activateApplication: () => Promise<void>
  private readonly getDownloadDirectory: (sessionId: string) => string

  constructor(options: BrowserControllerOptions = {}) {
    this.client = options.client ?? new EgoLiteClient()
    this.preview = options.preview ?? new EgoLitePreviewServer()
    this.hasBrowserConsent = options.hasBrowserConsent ?? (() => hasAcknowledgedBrowserRiskDisclaimer(getSettings()))
    this.activateApplication = options.activateApplication ?? activateEgoApplication
    this.getDownloadDirectory = options.getDownloadDirectory ?? ((sessionId) => path.join(getConfigDir(), 'browser-downloads', sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'session'))
  }

  configureSession(sessionId: string, input: ConfigureBrowserSessionInput): void {
    const previous = this.configurations.get(sessionId)
    const allowedRoots = [...new Set((input.allowedRoots ?? previous?.allowedRoots ?? []).filter(Boolean))]
    this.configurations.set(sessionId, { profileKey: input.profileKey, allowedRoots, executionSource: input.executionSource ?? previous?.executionSource ?? 'user' })
    const session = this.sessions.get(sessionId)
    if (session) {
      if (JSON.stringify(session.allowedRoots) !== JSON.stringify(allowedRoots)) this.preview.revokeSession(sessionId)
      session.allowedRoots = allowedRoots
      session.executionSource = input.executionSource ?? session.executionSource
    }
  }

  setAllowedRoots(sessionId: string, allowedRoots: string[]): void {
    const previous = this.configurations.get(sessionId)
    this.configureSession(sessionId, { ...previous, profileKey: previous?.profileKey ?? resolveBrowserProfileKey(undefined, sessionId), allowedRoots })
  }

  setOwnerWindow(window: BrowserWindow): void {
    this.owner = window
    this.disposed = false
  }

  private emit(session: BrowserSessionRecord): void {
    if (this.disposed || this.sessions.get(session.sessionId) !== session || !session.tabs.has(session.activeTabId) || !this.owner || this.owner.isDestroyed()) return
    this.owner.webContents.send(AGENT_IPC_CHANNELS.BROWSER_STATE_CHANGED, this.buildState(session))
  }

  private emitClosed(sessionId: string): void {
    if (this.disposed || !this.owner || this.owner.isDestroyed()) return
    const change: BrowserSessionClosed = { sessionId, closed: true }
    this.owner.webContents.send(AGENT_IPC_CHANNELS.BROWSER_STATE_CHANGED, change)
  }

  private emitFocused(session: BrowserSessionRecord): void {
    if (this.disposed || !this.owner || this.owner.isDestroyed()) return
    const change: BrowserTabFocusChange = { sessionId: session.sessionId, tabId: session.activeTabId }
    this.owner.webContents.send(AGENT_IPC_CHANNELS.BROWSER_TAB_FOCUSED, change)
  }

  private buildState(session: BrowserSessionRecord): BrowserViewState {
    const active = session.tabs.get(session.activeTabId)
    const trace = session.ledger.slice(-MAX_TRACE_ITEMS)
    return {
      sessionId: session.sessionId, executionSource: session.executionSource,
      activeTabId: session.activeTabId, agentTabId: session.agentTabId,
      tabs: [...session.tabs.values()].map((tab) => ({ tabId: tab.tabId, url: tab.url, title: tab.title, loading: false, openedByAgent: tab.openedBy === 'agent', openedByPopup: false })),
      url: active?.url ?? '', title: active?.title ?? 'Ego Lite', loading: false, visible: session.visible,
      canGoBack: session.canGoBack, canGoForward: session.canGoForward,
      trace, activity: trace.at(-1) ?? null,
      backend: 'ego-lite', spaceId: session.spaceId, controlState: session.controlState,
      lastSyncedAt: session.lastSyncedAt, ...(session.lastError ? { lastError: session.lastError } : {}),
      downloadedFiles: [...session.downloadedFiles],
    }
  }

  private synchronize(session: BrowserSessionRecord, state: EgoLiteState): void {
    const next = new Map<string, BrowserTabRecord>()
    for (const tab of state.tabs) {
      const previous = session.tabs.get(tab.tabId)
      const changed = previous?.url !== tab.url
      next.set(tab.tabId, { ...tab, generation: (previous?.generation ?? 0) + (changed ? 1 : 0), refs: changed ? new Set() : previous?.refs ?? new Set() })
    }
    session.tabs = next
    if (!next.has(session.activeTabId)) session.activeTabId = state.selectedTabId ?? next.keys().next().value ?? ''
    if (session.agentTabId && !next.has(session.agentTabId)) session.agentTabId = null
    session.controlState = state.controlState
    session.spaceId = state.spaceId
    session.lastSyncedAt = Date.now()
    session.lastError = undefined
    if (state.canGoBack !== undefined) session.canGoBack = state.canGoBack
    if (state.canGoForward !== undefined) session.canGoForward = state.canGoForward
  }

  private ensureSession(sessionId: string, explicitOpen = false): Promise<BrowserSessionRecord> {
    if (this.disposed) return Promise.reject(new EgoLiteError('浏览器控制器已关闭，请重新打开应用窗口后再试。', 'EGO_CONTROLLER_DISPOSED'))
    if (this.requiresExplicitOpen.has(sessionId) && !explicitOpen) return Promise.reject(new EgoLiteError('浏览器任务已断开，请先手动重新打开浏览器，再继续当前任务。', 'EGO_EXPLICIT_OPEN_REQUIRED'))
    const existing = this.sessions.get(sessionId)
    if (existing) return Promise.resolve(existing)
    const pending = this.creating.get(sessionId)
    if (pending) return pending
    const generation = this.generation
    const creating = (async () => {
      const spaceName = this.spaceNames.get(sessionId) ?? `Snap-${sessionId}`
      this.spaceNames.set(sessionId, spaceName)
      const response = await this.client.execute({ operation: 'ensure', spaceName })
      if (!response.state) throw new Error('Ego Lite 没有建立任务空间。')
      if (this.disposed || generation !== this.generation) {
        // 创建结果明确成功才尝试清理；不重试创建，也不接管或结束用户持有的 Space。
        if (response.state.controlState === 'agent') {
          await this.client.execute({ operation: 'finish', spaceId: response.state.spaceId, spaceName }).catch(() => {})
        }
        throw new EgoLiteError('应用窗口已关闭，本次浏览器任务未接入；已确认属于 Agent 的空间会尝试清理。', 'EGO_CONTROLLER_DISPOSED')
      }
      const config = this.configurations.get(sessionId)
      const selected = response.state.selectedTabId ?? response.state.tabs.find((tab) => tab.managed && tab.openedBy === 'agent')?.tabId ?? ''
      const session: BrowserSessionRecord = {
        sessionId, spaceId: response.state.spaceId, spaceName, tabs: new Map(), activeTabId: selected, agentTabId: selected || null,
        allowedRoots: config?.allowedRoots ?? [], executionSource: config?.executionSource ?? 'user', controlState: 'agent', lastSyncedAt: Date.now(),
        canGoBack: false, canGoForward: false, visible: true, userOpenedAt: null, ledger: [], commandTail: Promise.resolve(), agentAbortController: new AbortController(), downloadedFiles: [],
      }
      this.synchronize(session, response.state)
      this.sessions.set(sessionId, session)
      this.requiresExplicitOpen.delete(sessionId)
      this.emit(session)
      return session
    })()
    this.creating.set(sessionId, creating)
    void creating.finally(() => {
      if (this.creating.get(sessionId) === creating) this.creating.delete(sessionId)
    }).catch(() => {})
    return creating
  }

  /** 只断开 Snap 本地任务；用户接管或结果未知时绝不操作 Ego。 */
  private detachSession(session: BrowserSessionRecord): void {
    if (this.sessions.get(session.sessionId) !== session) return
    this.sessions.delete(session.sessionId)
    session.agentAbortController.abort()
    this.preview.revokeSession(session.sessionId)
    this.spaceNames.set(session.sessionId, `Snap-${session.sessionId}-${randomUUID()}`)
    this.requiresExplicitOpen.add(session.sessionId)
    this.emitClosed(session.sessionId)
  }

  private session(sessionId: string): BrowserSessionRecord {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Ego Lite 浏览器会话不存在，请先打开浏览器。')
    return session
  }

  private tab(session: BrowserSessionRecord, tabId?: string, userAction = false): BrowserTabRecord {
    const target = tabId ?? (userAction ? session.activeTabId : session.agentTabId)
    const tab = target ? session.tabs.get(target) : undefined
    if (!tab) throw new Error('工作标签已关闭，请先 BrowserNewTab 新建或 BrowserSelectTab 显式选择已有标签。')
    return tab
  }

  private assertConsent(): void {
    if (!this.hasBrowserConsent()) throw new Error('首次使用浏览器前，请在面板阅读并确认账号风险告知后重试。')
  }

  private trace(session: BrowserSessionRecord, tabId: string, action: BrowserTraceAction, summary: string, status: BrowserOperationStatus): void {
    const tab = session.tabs.get(tabId)
    let domain: string | null = null
    try { domain = new URL(tab?.url ?? '').host || null } catch { /* 空白页。 */ }
    session.ledger.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, action, summary, at: Date.now(), success: status === 'verified' || status === 'dispatched', status, tabId, domain, executionSource: session.executionSource })
    session.ledger = session.ledger.slice(-100)
    this.emit(session)
  }

  private invalidate(session: BrowserSessionRecord, tabId?: string): void {
    for (const tab of session.tabs.values()) {
      if (tabId && tab.tabId !== tabId) continue
      tab.refs.clear()
      tab.generation += 1
    }
  }

  private invoke(session: BrowserSessionRecord, operation: EgoLiteOperation, options: OperationOptions = {}): Promise<EgoLiteResponse> {
    const generation = this.generation
    const signal = options.userAction ? options.signal : options.signal ? AbortSignal.any([options.signal, session.agentAbortController.signal]) : session.agentAbortController.signal
    const run = async () => {
      if (this.disposed || generation !== this.generation || this.sessions.get(session.sessionId) !== session) throw new EgoLiteError('浏览器任务已断开，请重新打开浏览器。', 'EGO_BROWSER_SESSION_CLOSED')
      throwIfBrowserOperationAborted(signal)
      if (session.controlState === 'user' && operation !== 'resume') throw new EgoLiteError('Ego Lite 当前由用户接管。请点击“允许 Agent 继续”，不会自动抢回控制权。', 'EGO_TASK_SPACE_USER_IN_CONTROL')
      try {
        const response = await this.client.execute({ operation, spaceId: session.spaceId, spaceName: session.spaceName, tabId: options.tabId, args: options.args }, signal)
        throwIfBrowserOperationAborted(signal)
        if (this.disposed || generation !== this.generation || this.sessions.get(session.sessionId) !== session) throw new EgoLiteError('浏览器任务已断开；已发送的页面事件结果请在 Ego 中确认。', 'EGO_BROWSER_SESSION_CLOSED')
        if (response.state) this.synchronize(session, response.state)
        if (response.result && typeof response.result === 'object' && 'downloadedFiles' in response.result && Array.isArray(response.result.downloadedFiles)) {
          const root = this.getDownloadDirectory(session.sessionId)
          for (const file of response.result.downloadedFiles) {
            if (!file || typeof file !== 'object' || !('path' in file) || !('name' in file) || typeof file.path !== 'string' || typeof file.name !== 'string') continue
            const target = await realpath(file.path)
            const downloadRoot = await realpath(root)
            if (!insideRoot(target, downloadRoot) || !(await stat(target)).isFile()) throw new Error('Ego 下载结果未通过文件回读验证。')
            session.downloadedFiles.push({ path: target, name: file.name })
            session.downloadedFiles = session.downloadedFiles.slice(-20)
            this.trace(session, options.tabId ?? session.activeTabId, 'download', 'Ego 下载已完成，文件已回读验证', 'verified')
          }
        }
        if (!['observe', 'screenshot', 'state', 'ensure'].includes(operation)) this.invalidate(session, options.tabId)
        if (options.action) this.trace(session, options.tabId ?? session.activeTabId, options.action, options.summary ?? 'Ego Lite 操作', options.status ?? 'dispatched')
        this.emit(session)
        return response
      } catch (error) {
        if (error instanceof EgoLiteError && ENDED_SPACE_CODES.has(error.code)) {
          this.detachSession(session)
          throw new EgoLiteError('Ego Lite 任务已结束或已关闭，已断开本地连接。需要继续时，请手动重新打开浏览器。', error.code)
        }
        if (error instanceof EgoLiteError && /USER_IN_CONTROL|INACTIVE|UNAVAILABLE|HOST_DISCONNECTED/.test(error.code)) {
          session.controlState = error.code.includes('USER_IN_CONTROL') ? 'user' : 'unknown'
        }
        const unknownOutcome = signal?.aborted
          || (error instanceof EgoLiteError && /TIMEOUT|TIMED_OUT|ABORTED|HOST_DISCONNECTED|BROWSER_UNAVAILABLE/.test(error.code))
          || (error instanceof Error && /timed?\s*out|timeout|超时/i.test(error.message))
        if (unknownOutcome && session.controlState !== 'user') session.controlState = 'unknown'
        session.lastError = unknownOutcome ? '操作已停止或超时；已发送的页面事件结果未知，请重新观察。' : error instanceof Error ? error.message : String(error)
        this.invalidate(session, options.tabId)
        if (options.action) this.trace(session, options.tabId ?? session.activeTabId, options.action, session.lastError, unknownOutcome ? 'unknown' : 'failed')
        this.emit(session)
        throw error
      }
    }
    const result = session.commandTail.then(run, run)
    session.commandTail = result.then(() => undefined, () => undefined)
    return result
  }

  async open(sessionId: string): Promise<BrowserViewState> {
    const session = await this.ensureSession(sessionId, true)
    session.userOpenedAt ??= Date.now()
    session.visible = true
    this.emit(session)
    return this.buildState(session)
  }

  getState(sessionId: string): BrowserViewState | null {
    const session = this.sessions.get(sessionId)
    return session ? this.buildState(session) : null
  }

  getUserContext(sessionId: string): BrowserUserContextSnapshot | null {
    const session = this.sessions.get(sessionId)
    const tab = session?.tabs.get(session.activeTabId)
    if (!session?.userOpenedAt || !tab?.url) return null
    return { activeTabId: tab.tabId, url: tab.url, title: tab.title, openedAt: session.userOpenedAt }
  }

  async listTabs(sessionId: string): Promise<BrowserViewState> {
    const session = await this.ensureSession(sessionId)
    this.assertConsent()
    await this.invoke(session, 'state', { userAction: true })
    return this.buildState(session)
  }

  setLayout(layout: BrowserViewLayout): void {
    const session = this.sessions.get(layout.sessionId)
    if (!session) return
    session.visible = layout.visible
    this.emit(session)
  }

  minimize(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.visible = false
    this.emit(session)
  }

  cancelSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.agentAbortController.abort()
    session.agentAbortController = new AbortController()
    this.invalidate(session)
    this.trace(session, session.agentTabId ?? session.activeTabId, 'tab', 'Agent 已停止等待；已发送的 Ego 页面操作不能撤销，请重新观察。', 'unknown')
  }

  async showInEgo(sessionId: string, tabId?: string): Promise<BrowserViewState> {
    const session = await this.ensureSession(sessionId)
    session.userOpenedAt ??= Date.now()
    if (session.controlState !== 'user') {
      const target = this.tab(session, tabId, true)
      const response = await this.invoke(session, 'show', { tabId: target.tabId, userAction: true })
      session.activeTabId = response.state?.selectedTabId ?? target.tabId
    }
    await this.activateApplication()
    this.emit(session)
    return this.buildState(session)
  }

  async resume(sessionId: string): Promise<BrowserViewState> {
    const session = this.session(sessionId)
    await this.invoke(session, 'resume', { userAction: true, tabId: session.activeTabId })
    session.controlState = 'agent'
    this.emit(session)
    return this.buildState(session)
  }

  async createNewTab(sessionId: string, url?: string): Promise<BrowserViewState> {
    this.assertConsent()
    const session = await this.ensureSession(sessionId)
    const destination = url?.trim() ? await browserDestination(url) : undefined
    const response = await this.invoke(session, 'new', { args: { url: destination }, action: 'tab', summary: '在 Ego Lite 新建工作标签' })
    session.agentTabId = response.state?.selectedTabId ?? null
    session.activeTabId = response.state?.selectedTabId ?? session.activeTabId
    this.emit(session)
    return this.buildState(session)
  }

  async createDisplayTab(sessionId: string, url?: string): Promise<BrowserViewState> {
    this.assertConsent()
    const session = await this.ensureSession(sessionId)
    session.userOpenedAt ??= Date.now()
    const response = await this.invoke(session, 'new', { userAction: true, args: { url: url?.trim() ? await browserDestination(url) : undefined } })
    session.activeTabId = response.state?.selectedTabId ?? session.activeTabId
    this.emit(session)
    return this.buildState(session)
  }

  async selectTab(sessionId: string, tabId: string): Promise<BrowserViewState> {
    this.assertConsent()
    const session = this.session(sessionId)
    this.tab(session, tabId, true)
    session.userOpenedAt ??= Date.now()
    const response = await this.invoke(session, 'select', { tabId, userAction: true })
    session.activeTabId = response.state?.selectedTabId ?? tabId
    this.emitFocused(session)
    this.emit(session)
    return this.buildState(session)
  }

  async selectAgentTab(sessionId: string, tabId: string): Promise<BrowserViewState> {
    this.assertConsent()
    const session = await this.ensureSession(sessionId)
    this.tab(session, tabId)
    const response = await this.invoke(session, 'select', { tabId, action: 'tab', summary: 'Agent 显式选择 Ego Lite 工作标签' })
    session.agentTabId = response.state?.selectedTabId ?? null
    session.activeTabId = session.agentTabId ?? session.activeTabId
    this.emit(session)
    return this.buildState(session)
  }

  async closeTab(sessionId: string, tabId: string): Promise<BrowserViewState | null> {
    const session = this.session(sessionId)
    const tab = this.tab(session, tabId, true)
    if (tab.openedBy !== 'agent') throw new Error('此标签由用户创建，请在 Ego Lite 中手动关闭；Snap 不会删除用户标签。')
    await this.invoke(session, 'closeTab', { tabId, userAction: true, action: 'tab', summary: '关闭 Snap 创建的 Ego 标签' })
    if (session.tabs.size === 0) {
      await this.close(sessionId)
      return null
    }
    return this.buildState(session)
  }

  async previewOpen(sessionId: string, inputPath: string, tabId: string | undefined, allowedRoots: string[], baseDir?: string, signal?: AbortSignal): Promise<BrowserViewState> {
    this.assertConsent()
    this.setAllowedRoots(sessionId, allowedRoots)
    const session = await this.ensureSession(sessionId)
    throwIfBrowserOperationAborted(signal)
    const url = await this.preview.register(sessionId, inputPath, session.allowedRoots, baseDir)
    if (!tabId) {
      const response = await this.invoke(session, 'new', { args: { url }, signal, action: 'navigate', summary: '通过授权 loopback 服务预览本地 HTML' })
      session.agentTabId = response.state?.selectedTabId ?? null
      session.activeTabId = session.agentTabId ?? session.activeTabId
    } else {
      this.tab(session, tabId)
      await this.invoke(session, 'navigate', { tabId, args: { url }, signal, action: 'navigate', summary: '通过授权 loopback 服务预览本地 HTML' })
      session.agentTabId = tabId
      session.activeTabId = tabId
    }
    this.emit(session)
    return this.buildState(session)
  }

  private async navigateTarget(sessionId: string, url: string, tabId: string | undefined, userAction: boolean, signal?: AbortSignal): Promise<BrowserViewState> {
    this.assertConsent()
    const session = await this.ensureSession(sessionId)
    const tab = this.tab(session, tabId, userAction)
    const destination = await browserDestination(url)
    await this.invoke(session, 'navigate', { tabId: tab.tabId, userAction, signal, args: { url: destination }, action: 'navigate', summary: 'Ego Lite 导航到目标页面', status: 'verified' })
    session.activeTabId = tab.tabId
    if (userAction) session.userOpenedAt ??= Date.now()
    this.emit(session)
    return this.buildState(session)
  }

  navigate(sessionId: string, url: string, tabId?: string, signal?: AbortSignal): Promise<BrowserViewState> { return this.navigateTarget(sessionId, url, tabId, false, signal) }
  navigateDisplay(sessionId: string, url: string, tabId?: string): Promise<BrowserViewState> { return this.navigateTarget(sessionId, url, tabId, true) }

  private async history(sessionId: string, operation: 'back' | 'forward' | 'reload', tabId?: string, userAction = false): Promise<BrowserViewState> {
    this.assertConsent()
    const session = await this.ensureSession(sessionId)
    const tab = this.tab(session, tabId, userAction)
    await this.invoke(session, operation, { tabId: tab.tabId, userAction, action: 'navigate', summary: operation === 'reload' ? '重新加载 Ego 页面' : operation === 'back' ? 'Ego 页面后退' : 'Ego 页面前进', status: 'verified' })
    return this.buildState(session)
  }

  goBack(sessionId: string, tabId?: string): Promise<BrowserViewState> { return this.history(sessionId, 'back', tabId) }
  goBackDisplay(sessionId: string): Promise<BrowserViewState> { return this.history(sessionId, 'back', undefined, true) }
  goForward(sessionId: string, tabId?: string): Promise<BrowserViewState> { return this.history(sessionId, 'forward', tabId) }
  goForwardDisplay(sessionId: string): Promise<BrowserViewState> { return this.history(sessionId, 'forward', undefined, true) }
  reload(sessionId: string, tabId?: string): Promise<BrowserViewState> { return this.history(sessionId, 'reload', tabId) }
  reloadDisplay(sessionId: string): Promise<BrowserViewState> { return this.history(sessionId, 'reload', undefined, true) }

  private async observeInternal(session: BrowserSessionRecord, tab: BrowserTabRecord, requestedMaxElements?: number, signal?: AbortSignal): Promise<BrowserObservation> {
    const response = await this.invoke(session, 'observe', { tabId: tab.tabId, args: { fullPage: (requestedMaxElements ?? 0) > 240 }, signal, action: 'observe', summary: '读取 Ego Lite 语义快照', status: 'verified' })
    const current = this.tab(session, tab.tabId)
    current.generation += 1
    current.refs.clear()
    const elements = parseEgoSnapshot(response.snapshot ?? '').slice(0, resolveBrowserObserveMaxElements(requestedMaxElements))
    for (const element of elements) current.refs.add(element.ref)
    return { tabId: current.tabId, url: current.url, title: current.title, generation: current.generation, elements, snapshot: (response.snapshot ?? '').slice(0, MAX_SCRIPT_RESULT_CHARS) }
  }

  async observe(sessionId: string, tabId?: string, requestedMaxElements?: number, signal?: AbortSignal): Promise<BrowserObservation> {
    this.assertConsent()
    const session = await this.ensureSession(sessionId)
    return this.observeInternal(session, this.tab(session, tabId), requestedMaxElements, signal)
  }

  async find(sessionId: string, query: { role?: string; name?: string; exact?: boolean; maxResults?: number }, tabId?: string, signal?: AbortSignal): Promise<BrowserObservation> {
    this.assertConsent()
    const session = await this.ensureSession(sessionId)
    const observed = await this.observeInternal(session, this.tab(session, tabId), 400, signal)
    const matches = (value: string, expected?: string) => !expected || (query.exact ? value === expected : value.toLowerCase().includes(expected.toLowerCase()))
    const elements = observed.elements.filter((element) => matches(element.role, query.role) && matches(element.name, query.name)).slice(0, Math.max(1, Math.min(100, query.maxResults ?? 20)))
    const tab = this.tab(session, observed.tabId)
    tab.refs = new Set(elements.map((element) => element.ref))
    this.trace(session, tab.tabId, 'find', `找到 ${elements.length} 个匹配元素`, 'verified')
    return { ...observed, elements }
  }

  private validateRef(tab: BrowserTabRecord, ref: string): void {
    if (!tab.refs.has(ref)) throw new Error('页面引用已过期或不属于当前标签，请先重新调用 BrowserObserve / BrowserFind。')
  }

  private async refAction(sessionId: string, operation: 'click' | 'fill' | 'hover' | 'drag' | 'upload', ref: string, args: Record<string, unknown>, tabId?: string, signal?: AbortSignal): Promise<BrowserViewState> {
    this.assertConsent()
    const session = await this.ensureSession(sessionId)
    const tab = this.tab(session, tabId)
    this.validateRef(tab, ref)
    if (operation === 'drag') this.validateRef(tab, String(args.targetRef))
    await this.invoke(session, operation, { tabId: tab.tabId, signal, args: { ...args, ref, ...(operation === 'click' ? { downloadDirectory: this.getDownloadDirectory(sessionId) } : {}) }, action: operation, summary: `Ego Lite ${operation} 页面元素` })
    return this.buildState(session)
  }

  click(sessionId: string, ref: string, tabId?: string, signal?: AbortSignal): Promise<BrowserViewState> { return this.refAction(sessionId, 'click', ref, {}, tabId, signal) }
  hover(sessionId: string, ref: string, tabId?: string, signal?: AbortSignal): Promise<BrowserViewState> { return this.refAction(sessionId, 'hover', ref, {}, tabId, signal) }
  fill(sessionId: string, ref: string, text: string, tabId?: string, signal?: AbortSignal): Promise<BrowserViewState> { return this.refAction(sessionId, 'fill', ref, { text }, tabId, signal) }
  drag(sessionId: string, sourceRef: string, targetRef: string, tabId?: string, signal?: AbortSignal): Promise<BrowserViewState> { return this.refAction(sessionId, 'drag', sourceRef, { sourceRef, targetRef }, tabId, signal) }

  async press(sessionId: string, key: string, tabId?: string, signal?: AbortSignal): Promise<BrowserViewState> {
    this.assertConsent()
    const action = parseBrowserPressAction(key)
    const session = await this.ensureSession(sessionId)
    const tab = this.tab(session, tabId)
    await this.invoke(session, 'press', { tabId: tab.tabId, signal, args: action, action: 'press', summary: '向 Ego 页面发送按键或文字' })
    return this.buildState(session)
  }

  private assertWait(condition: BrowserWaitCondition, timeoutMs: number): void {
    if (!['url', 'text', 'selector'].includes(condition.kind) || !condition.value.trim()) throw new Error('等待条件无效。')
    if (!Number.isFinite(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) throw new Error('等待超时必须在 250 到 30000 毫秒之间。')
  }

  async waitFor(sessionId: string, condition: BrowserWaitCondition, timeoutMs = 10_000, tabId?: string, signal?: AbortSignal): Promise<{ tabId: string; url: string; title: string; matched: boolean }> {
    this.assertConsent()
    this.assertWait(condition, timeoutMs)
    const session = await this.ensureSession(sessionId)
    const tab = this.tab(session, tabId)
    const response = await this.invoke(session, 'wait', { tabId: tab.tabId, signal, args: { condition, timeoutMs }, action: 'wait', summary: '等待 Ego 页面满足条件' })
    const current = this.tab(session, tab.tabId)
    const matched = !!response.result && typeof response.result === 'object' && 'matched' in response.result && response.result.matched === true
    return { tabId: current.tabId, url: current.url, title: current.title, matched }
  }

  async act(sessionId: string, ref: string, waitFor: BrowserWaitCondition | undefined, timeoutMs = 10_000, tabId?: string, signal?: AbortSignal): Promise<{ state: BrowserViewState; wait: { tabId: string; url: string; title: string; matched: boolean } | null }> {
    this.assertConsent()
    if (waitFor) this.assertWait(waitFor, timeoutMs)
    const session = await this.ensureSession(sessionId)
    const tab = this.tab(session, tabId)
    this.validateRef(tab, ref)
    const response = await this.invoke(session, 'click', { tabId: tab.tabId, signal, args: { ref, condition: waitFor, timeoutMs, downloadDirectory: this.getDownloadDirectory(sessionId) }, action: 'act', summary: 'Ego 点击并等待页面条件' })
    const current = this.tab(session, tab.tabId)
    const matched = !!response.result && typeof response.result === 'object' && 'matched' in response.result && response.result.matched === true
    return { state: this.buildState(session), wait: waitFor ? { tabId: current.tabId, url: current.url, title: current.title, matched } : null }
  }

  private async expression(sessionId: string, script: string, action: BrowserTraceAction, tabId?: string, signal?: AbortSignal): Promise<{ tabId: string; url: string; result: unknown }> {
    this.assertConsent()
    const session = await this.ensureSession(sessionId)
    const tab = this.tab(session, tabId)
    const response = await this.invoke(session, 'evaluate', { tabId: tab.tabId, signal, args: { script }, action, summary: `在 Ego 页面执行 ${action} 操作` })
    return { tabId: tab.tabId, url: this.tab(session, tab.tabId).url, result: normalizeResult(response.result) }
  }

  domAction(sessionId: string, input: BrowserDomActionInput, tabId?: string, signal?: AbortSignal): Promise<{ tabId: string; url: string; result: unknown }> { return this.expression(sessionId, buildBrowserDomActionExpression(input), 'dom', tabId, signal) }
  scroll(sessionId: string, input: BrowserScrollInput, tabId?: string, signal?: AbortSignal): Promise<{ tabId: string; url: string; result: unknown }> { assertBrowserScroll(input); return this.expression(sessionId, buildBrowserScrollExpression(input), 'scroll', tabId, signal) }
  extract(sessionId: string, input: BrowserExtractInput, tabId?: string, signal?: AbortSignal): Promise<{ tabId: string; url: string; result: unknown }> { assertBrowserExtract(input); return this.expression(sessionId, buildBrowserExtractExpression(input), 'extract', tabId, signal) }
  evaluate(sessionId: string, script: string, tabId?: string, signal?: AbortSignal): Promise<{ tabId: string; url: string; result: unknown }> { assertBrowserScript(script); return this.expression(sessionId, script, 'script', tabId, signal) }

  async selectOption(sessionId: string, input: BrowserSelectOptionInput, tabId?: string, signal?: AbortSignal): Promise<{ tabId: string; url: string; result: unknown }> {
    this.assertConsent()
    assertBrowserSelectOption(input)
    const session = await this.ensureSession(sessionId)
    const tab = this.tab(session, tabId)
    const selection = input.value !== undefined ? { value: input.value } : input.label !== undefined ? { label: input.label } : { index: input.index }
    const response = await this.invoke(session, 'selectOption', { tabId: tab.tabId, signal, args: { selector: input.selector, selection }, action: 'select', summary: '选择 Ego 页面下拉选项' })
    return { tabId: tab.tabId, url: this.tab(session, tab.tabId).url, result: normalizeResult(response.result) }
  }

  async upload(sessionId: string, ref: string, filePaths: string[], tabId?: string, signal?: AbortSignal): Promise<BrowserViewState> {
    this.assertConsent()
    const session = await this.ensureSession(sessionId)
    if (filePaths.length < 1 || filePaths.length > 20) throw new Error('一次上传文件数量必须为 1 到 20。')
    const roots = (await Promise.all(session.allowedRoots.map((root) => realpath(root).catch(() => null)))).filter((root): root is string => !!root)
    if (!roots.length) throw new Error('当前会话没有获授权的文件目录，不能上传。')
    const files = await Promise.all(filePaths.map(async (filePath) => {
      if (!path.isAbsolute(filePath)) throw new Error('上传文件必须使用绝对路径。')
      const target = await realpath(filePath)
      if (!(await stat(target)).isFile() || !roots.some((root) => insideRoot(target, root))) throw new Error('上传文件不在当前会话获授权的目录内，或不是普通文件。')
      return target
    }))
    return this.refAction(sessionId, 'upload', ref, { paths: files }, tabId, signal)
  }

  async screenshot(sessionId: string, tabId?: string, signal?: AbortSignal): Promise<{ tabId: string; url: string; mimeType: string; base64: string }> {
    this.assertConsent()
    const session = await this.ensureSession(sessionId)
    const tab = this.tab(session, tabId)
    const response = await this.invoke(session, 'screenshot', { tabId: tab.tabId, signal, action: 'screenshot', summary: '捕获真实 Ego Lite 页面', status: 'verified' })
    const result = response.result as { mimeType?: string; base64?: string } | null
    if (result?.mimeType !== 'image/png' || typeof result.base64 !== 'string') throw new Error('Ego Lite 没有返回有效截图。')
    const bytes = Buffer.from(result.base64, 'base64')
    if (bytes.length > 3 * 1024 * 1024 || !isValidImageBytes('image/png', bytes)) throw new Error('Ego Lite 截图无效或超过大小限制。')
    return { tabId: tab.tabId, url: this.tab(session, tab.tabId).url, mimeType: 'image/png', base64: result.base64 }
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) { this.emitClosed(sessionId); return }
    if (session.controlState !== 'agent') { this.detachSession(session); return }
    try { await this.invoke(session, 'finish', { userAction: true }) } catch (error) {
      // 外部接管可能发生在缓存读取之后；关闭/删会话只撤本地连接，不抢回控制。
      if (this.sessions.get(sessionId) !== session || session.controlState !== 'agent') { this.detachSession(session); return }
      throw error
    }
    this.detachSession(session)
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    for (const session of this.sessions.values()) {
      session.agentAbortController.abort()
      // 用户接管后的 Space 交还用户保留；应用退出绝不抢回控制权或删除用户页面。
      if (session.controlState === 'agent') void this.client.execute({ operation: 'finish', spaceId: session.spaceId, spaceName: session.spaceName }).catch(() => {})
    }
    this.sessions.clear()
    // 未完成 ensure 保留到 settled，阻止新窗口与旧创建请求并发；迟到成功由代际检查清理。
    this.configurations.clear()
    this.spaceNames.clear()
    this.requiresExplicitOpen.clear()
    this.preview.dispose()
    this.owner = null
  }
}

export const browserController = new BrowserController()
