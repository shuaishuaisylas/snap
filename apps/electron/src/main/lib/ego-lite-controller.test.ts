import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserController } from './browser-controller'
import { EgoLiteError } from './ego-lite-client'
import type { EgoLiteOperation, EgoLiteRequest, EgoLiteResponse, EgoLiteState } from './ego-lite-client'
import type { BrowserWindow } from 'electron'

class FakeEgo {
  readonly requests: EgoLiteRequest[] = []
  state: EgoLiteState = {
    spaceId: 101, controlState: 'agent', selectedTabId: 'p1',
    tabs: [{ tabId: 'p1', url: 'about:blank', title: '空白页', openedBy: 'agent', managed: true, active: true }],
  }
  unavailable = false
  nextResult?: unknown
  pauseOperation?: EgoLiteOperation
  onPaused?: () => void
  failures = new Map<EgoLiteOperation, EgoLiteError>()

  async execute(request: EgoLiteRequest, signal?: AbortSignal): Promise<EgoLiteResponse> {
    this.requests.push(request)
    const failure = this.failures.get(request.operation)
    if (failure) throw failure
    if (this.unavailable) throw new EgoLiteError('Ego 不可用', 'EGO_BROWSER_UNAVAILABLE')
    if (request.operation === this.pauseOperation) {
      this.onPaused?.()
      await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new EgoLiteError('停止等待，不能撤销页面事件', 'EGO_OPERATION_ABORTED')), { once: true }))
    }
    const tab = this.state.tabs.find((candidate) => candidate.tabId === request.tabId)
    if (request.operation === 'navigate' && tab) { tab.url = String(request.args?.url); tab.title = '测试网页' }
    if (request.operation === 'show') this.state.controlState = 'user'
    if (request.operation === 'resume') this.state.controlState = 'agent'
    if (request.operation === 'new') {
      const tabId = `p${this.state.tabs.length + 1}`
      this.state.tabs.push({ tabId, url: String(request.args?.url ?? 'about:blank'), title: '新标签', openedBy: 'agent', managed: true, active: true })
      this.state.selectedTabId = tabId
    }
    if (request.operation === 'select') this.state.selectedTabId = request.tabId ?? null
    if (request.operation === 'closeTab') this.state.tabs = this.state.tabs.filter((candidate) => candidate.tabId !== request.tabId)
    return { state: structuredClone(this.state), snapshot: request.operation === 'observe' ? 'textbox "标题" [ref=1]\nbutton "保存" [ref=2]' : undefined, result: this.nextResult ?? (request.operation === 'wait' ? { matched: true } : 'page-result') }
  }
}

const controllers: BrowserController[] = []
const directories: string[] = []
function setup(): { controller: BrowserController; ego: FakeEgo } {
  const ego = new FakeEgo()
  const controller = new BrowserController({ client: ego, hasBrowserConsent: () => true, activateApplication: async () => {}, getDownloadDirectory: () => directories.at(-1) ?? '/nonexistent/test-downloads' })
  controllers.push(controller)
  return { controller, ego }
}
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('真实 Ego 后端控制契约（假传输隔离）', () => {
  test('Given 原生或自定义本地文件协议 When 直接导航 Then 均须经授权预览且不发送给 Ego', async () => {
    const { controller, ego } = setup()
    await controller.open('task')
    for (const scheme of ['file', 'snap-file', 'legacy-file', 'vendor-file']) {
      await expect(controller.navigate('task', `${scheme}:///fixture/index.html`)).rejects.toThrow('授权 loopback')
    }
    expect(ego.requests.some((request) => request.operation === 'navigate')).toBe(false)
  })

  test('Given 已打开会话 When 导航观察和输入 Then 复用同一 Space 且旧引用不能继续操作', async () => {
    const { controller, ego } = setup()
    await controller.open('task')
    await controller.navigate('task', 'example.com')
    const observed = await controller.observe('task')
    expect(observed.elements.map((element) => element.ref)).toEqual(['@1', '@2'])
    await controller.fill('task', '@1', '用户输入')
    await expect(controller.click('task', '@2')).rejects.toThrow('引用已过期')
    expect(ego.requests.filter((request) => request.operation === 'ensure')).toHaveLength(1)
    expect(ego.requests.filter((request) => request.operation !== 'ensure').every((request) => request.spaceId === 101)).toBe(true)
    expect(ego.requests.find((request) => request.operation === 'fill')?.args).toMatchObject({ ref: '@1', text: '用户输入' })
  })

  test('Given 用户在 Ego 查看 When Agent 再请求导航 Then 不抢控制且只有显式继续才恢复', async () => {
    const { controller, ego } = setup()
    await controller.open('task')
    expect((await controller.showInEgo('task')).controlState).toBe('user')
    const calls = ego.requests.length
    await expect(controller.navigate('task', 'example.com')).rejects.toThrow('允许 Agent 继续')
    expect(ego.requests).toHaveLength(calls)
    expect((await controller.resume('task')).controlState).toBe('agent')
    await controller.navigate('task', 'example.com')
  })

  test('Given 用户已接管且本地预览可访问 When 关闭或删除会话 Then 只断开本地连接并撤销预览', async () => {
    const root = mkdtempSync(join(tmpdir(), 'snap-ego-detach-'))
    directories.push(root)
    const file = join(root, 'index.html')
    writeFileSync(file, '<h1>仅供授权预览</h1>')
    const { controller, ego } = setup()
    await controller.open('task')
    const preview = await controller.previewOpen('task', file, undefined, [root])
    expect((await fetch(preview.url)).status).toBe(200)
    await controller.showInEgo('task')
    const calls = ego.requests.length
    await controller.close('task')
    expect(controller.getState('task')).toBeNull()
    expect(ego.requests).toHaveLength(calls)
    expect((await fetch(preview.url)).status).toBe(404)
    await expect(controller.navigate('task', 'example.com')).rejects.toThrow('手动重新打开')
    expect(ego.requests).toHaveLength(calls)
    ego.state.controlState = 'agent'
    ego.state.spaceId = 102
    await controller.open('task')
    expect(ego.requests.at(-1)?.operation).toBe('ensure')
    expect(ego.requests.at(-1)?.spaceName).not.toBe(ego.requests[0]?.spaceName)
  })

  test('Given 外部在缓存同步后接管 When 用户关闭 Then 接管拒绝后只断开本地且不重试 finish', async () => {
    const { controller, ego } = setup()
    await controller.open('task')
    ego.failures.set('finish', new EgoLiteError('用户接管', 'EGO_TASK_SPACE_USER_IN_CONTROL'))
    await controller.close('task')
    expect(controller.getState('task')).toBeNull()
    expect(ego.requests.map((request) => request.operation)).toEqual(['ensure', 'finish'])
  })

  for (const code of ['EGO_TASK_SPACE_NOT_FOUND', 'EGO_TASK_SPACE_INACTIVE']) {
    test(`Given 明确任务终止 ${code} When 同步失败 Then 发送关闭状态且只在主动 open 后创建新任务`, async () => {
      const { controller, ego } = setup()
      const events: unknown[] = []
      controller.setOwnerWindow({ isDestroyed: () => false, webContents: { send: (_channel: string, value: unknown) => { events.push(value) } } } as unknown as BrowserWindow)
      await controller.open('task')
      ego.failures.set('state', new EgoLiteError('native ended task', code))
      await expect(controller.listTabs('task')).rejects.toThrow('请手动重新打开')
      expect(controller.getState('task')).toBeNull()
      expect(events.at(-1)).toEqual({ sessionId: 'task', closed: true })
      const calls = ego.requests.length
      await expect(controller.observe('task')).rejects.toThrow('手动重新打开')
      expect(ego.requests).toHaveLength(calls)
      ego.failures.clear()
      ego.state.spaceId = 202
      expect((await controller.open('task')).spaceId).toBe(202)
      const ensures = ego.requests.filter((request) => request.operation === 'ensure')
      expect(ensures).toHaveLength(2)
      expect(ensures[1]?.spaceName).not.toBe(ensures[0]?.spaceName)
    })
  }

  for (const code of ['EGO_OPERATION_TIMEOUT', 'EGO_TASK_HOST_DISCONNECTED', 'EGO_TASK_SPACE_UNAVAILABLE']) {
    test(`Given 不确定错误 ${code} When 同步失败 Then 保留原任务且不自动创建替代空间`, async () => {
      const { controller, ego } = setup()
      await controller.open('task')
      ego.failures.set('state', new EgoLiteError('结果未知', code))
      await expect(controller.listTabs('task')).rejects.toThrow('结果未知')
      expect(controller.getState('task')?.spaceId).toBe(101)
      expect(controller.getState('task')?.controlState).toBe('unknown')
      await controller.open('task')
      expect(ego.requests.filter((request) => request.operation === 'ensure')).toHaveLength(1)
      const calls = ego.requests.length
      await controller.close('task')
      expect(controller.getState('task')).toBeNull()
      expect(ego.requests).toHaveLength(calls)
    })
  }

  for (const controlState of ['agent', 'user'] as const) {
    test(`Given ensure 仍在等待且返回 ${controlState} When 控制器已销毁 Then 不回填缓存或发送事件且只清理明确 Agent 空间`, async () => {
      let complete: ((response: EgoLiteResponse) => void) | undefined
      const pending = new Promise<EgoLiteResponse>((resolve) => { complete = resolve })
      const requests: EgoLiteRequest[] = []
      const events: unknown[] = []
      const controller = new BrowserController({ client: { execute: async (request) => { requests.push(request); return request.operation === 'ensure' ? pending : { state: null } } }, hasBrowserConsent: () => true })
      controllers.push(controller)
      controller.setOwnerWindow({ isDestroyed: () => false, webContents: { send: (_channel: string, value: unknown) => { events.push(value) } } } as unknown as BrowserWindow)
      const opening = controller.open('late')
      controller.dispose()
      complete?.({ state: { spaceId: 303, controlState, selectedTabId: 'p1', tabs: [{ tabId: 'p1', url: 'about:blank', title: 'blank', managed: true, openedBy: 'agent', active: true }] } })
      await expect(opening).rejects.toThrow('应用窗口已关闭')
      expect(controller.getState('late')).toBeNull()
      expect(events).toEqual([])
      expect(requests.map((request) => request.operation)).toEqual(controlState === 'agent' ? ['ensure', 'finish'] : ['ensure'])
      await expect(controller.open('late')).rejects.toThrow('控制器已关闭')
      expect(requests.filter((request) => request.operation === 'ensure')).toHaveLength(1)
    })
  }

  test('Given ensure 结果未知 When 控制器已销毁 Then 不回填、不结束未知空间且不重试创建', async () => {
    let fail: ((error: Error) => void) | undefined
    const pending = new Promise<EgoLiteResponse>((_resolve, reject) => { fail = reject })
    const requests: EgoLiteRequest[] = []
    const controller = new BrowserController({ client: { execute: async (request) => { requests.push(request); return pending } }, hasBrowserConsent: () => true })
    controllers.push(controller)
    const opening = controller.open('late')
    controller.dispose()
    fail?.(new EgoLiteError('结果未知', 'EGO_OPERATION_TIMEOUT'))
    await expect(opening).rejects.toThrow('结果未知')
    expect(controller.getState('late')).toBeNull()
    expect(requests.map((request) => request.operation)).toEqual(['ensure'])
  })

  test('Given 面板选择和 Agent 工作标签不同 When UI 切换后 Agent 导航 Then 不隐式切到用户查看的标签', async () => {
    const { controller, ego } = setup()
    await controller.open('task')
    await controller.createNewTab('task')
    await controller.selectTab('task', 'p1')
    expect(controller.getState('task')?.agentTabId).toBe('p2')
    await controller.navigate('task', 'example.com')
    expect(ego.requests.findLast((request) => request.operation === 'navigate')?.tabId).toBe('p2')
  })

  test('Given Ego 用户创建标签 When 工具试图关闭 Then 保留用户页面', async () => {
    const { controller, ego } = setup()
    ego.state.tabs.push({ tabId: 'unmanaged:user', url: 'https://example.com', title: '用户标签', openedBy: 'unknown', managed: false, active: false })
    await controller.open('task')
    await expect(controller.closeTab('task', 'unmanaged:user')).rejects.toThrow('不会删除用户标签')
    expect(ego.requests.some((request) => request.operation === 'closeTab')).toBe(false)
  })

  test('Given 外部 Ego 不可用 When 打开浏览器 Then 返回真实错误而不创建假后端状态', async () => {
    const { controller, ego } = setup()
    ego.unavailable = true
    await expect(controller.open('task')).rejects.toThrow('Ego 不可用')
    expect(controller.getState('task')).toBeNull()
  })

  test('Given 已知页面 When 执行等待抽取滚动和脚本 Then 所有动作进入 Ego 公开操作通道', async () => {
    const { controller, ego } = setup()
    await controller.open('task')
    await controller.waitFor('task', { kind: 'text', value: '完成' })
    await controller.extract('task', { format: 'text' })
    await controller.scroll('task', { deltaY: 300 })
    await controller.evaluate('task', 'document.title')
    await controller.selectOption('task', { selector: 'select', value: 'option' })
    await controller.press('task', 'Enter')
    expect(ego.requests.slice(1).map((request) => request.operation)).toEqual(['wait', 'evaluate', 'evaluate', 'evaluate', 'selectOption', 'press'])
    expect(ego.requests.at(-1)?.args).toMatchObject({ kind: 'key', key: 'Enter' })
    const count = ego.requests.length
    expect(controller.getState('task')?.backend).toBe('ego-lite')
    expect(ego.requests).toHaveLength(count)
  })

  test('Given 操作已下发但尚未返回 When 停止 Agent Then 取消等待并把结果记为未知', async () => {
    const { controller, ego } = setup()
    await controller.open('task')
    await controller.observe('task')
    ego.pauseOperation = 'click'
    const started = new Promise<void>((resolve) => { ego.onPaused = resolve })
    const clicking = controller.click('task', '@2')
    await started
    controller.cancelSession('task')
    await expect(clicking).rejects.toThrow('不能撤销')
    expect(controller.getState('task')?.activity?.status).toBe('unknown')
  })

  test('Given 下载返回路径 When 文件真实存在于会话下载目录 Then 回读验证后保留下载元数据', async () => {
    const root = mkdtempSync(join(tmpdir(), 'snap-ego-controller-download-'))
    directories.push(root)
    const file = join(root, 'result.txt')
    writeFileSync(file, 'downloaded')
    const { controller, ego } = setup()
    await controller.open('task')
    await controller.observe('task')
    ego.nextResult = { downloadedFiles: [{ path: file, name: 'result.txt' }] }
    const state = await controller.click('task', '@2')
    expect(state.downloadedFiles).toEqual([{ path: realpathSync(file), name: 'result.txt' }])
    expect(state.trace.some((item) => item.action === 'download' && item.status === 'verified')).toBe(true)
  })
})
