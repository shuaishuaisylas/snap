import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type EgoLiteOperation = 'ensure' | 'state' | 'new' | 'select' | 'closeTab' | 'finish' | 'show' | 'resume'
  | 'navigate' | 'back' | 'forward' | 'reload' | 'observe' | 'click' | 'hover' | 'drag' | 'fill' | 'press'
  | 'wait' | 'evaluate' | 'upload' | 'screenshot' | 'selectOption' | 'focus'

export interface EgoLiteRequest {
  operation: EgoLiteOperation
  spaceName: string
  spaceId?: number
  tabId?: string
  args?: Record<string, unknown>
}

export interface EgoLiteTab {
  tabId: string
  url: string
  title: string
  openedBy: 'agent' | 'unknown'
  managed: boolean
  active: boolean
}

export interface EgoLiteState {
  spaceId: number
  tabs: EgoLiteTab[]
  selectedTabId: string | null
  controlState: 'agent' | 'user'
  canGoBack?: boolean
  canGoForward?: boolean
}

export interface EgoLiteResponse {
  state: EgoLiteState | null
  result?: unknown
  snapshot?: string
}

interface EgoLiteEnvelope {
  ok: boolean
  value?: EgoLiteResponse
  error?: string
  code?: string
}

export interface EgoLiteClientOptions {
  executablePath?: string
  timeoutMs?: number
  maxOutputBytes?: number
}

export class EgoLiteError extends Error {
  constructor(message: string, readonly code = 'EGO_OPERATION_FAILED') {
    super(message)
    this.name = 'EgoLiteError'
  }
}

export function resolveEgoLiteExecutable(): string {
  if (process.env.SNAP_EGO_BROWSER_PATH) return process.env.SNAP_EGO_BROWSER_PATH
  const candidates = process.platform === 'darwin'
    ? [join(homedir(), '.local/bin/ego-browser'), '/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/Current/Helpers/ego-browser']
    : process.platform === 'win32'
      ? [join(process.env.LOCALAPPDATA ?? homedir(), 'ego', 'ego-browser.exe'), join(homedir(), '.local/bin/ego-browser.exe')]
      : [join(homedir(), '.local/bin/ego-browser')]
  return candidates.find((candidate) => existsSync(candidate)) ?? 'ego-browser'
}

/** 参数始终作为 JSON 数据进入固定程序，绝不执行调用方提供的 Node / shell 代码。 */
export function buildEgoLiteScript(request: EgoLiteRequest, marker: string): string {
  const encoded = Buffer.from(JSON.stringify(request), 'utf-8').toString('base64')
  return `const request = JSON.parse(Buffer.from(${JSON.stringify(encoded)}, 'base64').toString('utf8'));\nconst marker = ${JSON.stringify(marker)};\n${EGO_LITE_PROGRAM}`
}

export function parseEgoLiteOutput(output: string, marker: string): EgoLiteResponse {
  const line = output.split(/\r?\n/).findLast((candidate) => candidate.startsWith(marker))
  if (!line) throw new EgoLiteError('Ego Lite 未返回有效执行结果；请确认已安装并打开 Ego Lite。', 'EGO_INVALID_RESULT_PAYLOAD')
  let envelope: EgoLiteEnvelope
  try { envelope = JSON.parse(line.slice(marker.length)) as EgoLiteEnvelope } catch {
    throw new EgoLiteError('Ego Lite 返回了无法解析的执行结果。', 'EGO_INVALID_RESULT_PAYLOAD')
  }
  if (envelope.ok !== true) {
    throw new EgoLiteError(envelope.error ?? 'Ego Lite 操作失败。', envelope.code)
  }
  if (!envelope.value || !Object.hasOwn(envelope.value, 'state')) {
    throw new EgoLiteError('Ego Lite 结果缺少浏览器状态。', 'EGO_INVALID_RESULT_PAYLOAD')
  }
  const state = envelope.value.state
  if (state !== null && (!Number.isInteger(state.spaceId) || !Array.isArray(state.tabs)
    || !['agent', 'user'].includes(state.controlState)
    || state.tabs.some((tab) => !tab || typeof tab.tabId !== 'string' || typeof tab.url !== 'string' || typeof tab.title !== 'string'))) {
    throw new EgoLiteError('Ego Lite 返回了无效的任务空间状态。', 'EGO_INVALID_RESULT_PAYLOAD')
  }
  return envelope.value
}

export class EgoLiteClient {
  private readonly executablePath: string
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number

  constructor(options: EgoLiteClientOptions = {}) {
    this.executablePath = options.executablePath ?? resolveEgoLiteExecutable()
    this.timeoutMs = options.timeoutMs ?? 45_000
    this.maxOutputBytes = options.maxOutputBytes ?? 6 * 1024 * 1024
  }

  async execute(request: EgoLiteRequest, signal?: AbortSignal): Promise<EgoLiteResponse> {
    if (signal?.aborted) throw new EgoLiteError('浏览器操作已停止；已发送的页面事件可能已执行，请重新观察。', 'EGO_OPERATION_ABORTED')
    const marker = `__SNAP_EGO_${randomUUID()}__`
    const script = buildEgoLiteScript(request, marker)
    const output = await new Promise<string>((resolve, reject) => {
      // stdin 传固定程序，禁用 shell。URL、文本、selector 与网页 JavaScript 不进入命令行。
      const child = spawn(this.executablePath, ['nodejs'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const capturedOutput = () => Buffer.concat(stdout).toString('utf-8') + '\n' + Buffer.concat(stderr).toString('utf-8')
      let size = 0
      let settled = false
      const settle = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error) { child.kill('SIGTERM'); reject(error) } else resolve(capturedOutput())
      }
      const abort = () => settle(new EgoLiteError('浏览器操作已停止；已发送的页面事件可能已执行，请重新观察。', 'EGO_OPERATION_ABORTED'))
      const timer = setTimeout(() => settle(new EgoLiteError('Ego Lite 操作超时；页面上的操作结果未知，请重新观察后继续。', 'EGO_OPERATION_TIMEOUT')), this.timeoutMs)
      const capture = (stream: Buffer[], chunk: Buffer) => {
        size += chunk.length
        if (size > this.maxOutputBytes) { settle(new EgoLiteError('Ego Lite 返回内容过大。', 'EGO_OUTPUT_LIMIT')); return }
        stream.push(chunk)
      }
      child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk))
      // 官方 CLI 的 console 结果可能写入 stderr；只解析随机 marker，绝不输出原始日志。
      child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk))
      child.once('error', (error) => settle(new EgoLiteError(`无法启动 Ego Lite CLI：${error.message}。请安装并打开 Ego Lite，或配置 SNAP_EGO_BROWSER_PATH。`, 'EGO_BROWSER_UNAVAILABLE')))
      child.once('close', (code) => {
        const text = capturedOutput()
        if (code !== 0 && !text.split(/\r?\n/).some((line) => line.startsWith(marker))) {
          settle(new EgoLiteError('Ego Lite CLI 未正常结束；请确认浏览器运行中并检查当前任务控制权。', 'EGO_BROWSER_UNAVAILABLE'))
        } else settle()
      })
      child.stdin.on('error', (error) => settle(new EgoLiteError(`无法向 Ego Lite 发送任务：${error.message}`, 'EGO_BROWSER_UNAVAILABLE')))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      if (!settled) child.stdin.end(script)
    })
    const response = parseEgoLiteOutput(output, marker)
    if (request.spaceId !== undefined && response.state !== null && response.state.spaceId !== request.spaceId) {
      throw new EgoLiteError('Ego Lite 返回的任务空间与当前会话不一致，已阻止继续操作。', 'EGO_INVALID_RESULT_PAYLOAD')
    }
    return response
  }
}

export interface EgoSnapshotElement {
  ref: string
  role: string
  name: string
  editable: boolean
}

/** 只把实际快照行的 ref 元数据解析成操作引用，忽略页面名称里伪造的 ref 文本。 */
export function parseEgoSnapshot(snapshot: string): EgoSnapshotElement[] {
  const lines = snapshot.split(/\r?\n/)
  const elements: EgoSnapshotElement[] = []
  const seen = new Set<string>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const prefix = /^(\s*)(?:[-*]\s+)?([\w:-]+)\s*(.*)$/.exec(line)
    if (!prefix) continue
    let rest = prefix[3] ?? ''
    let name = ''
    if (rest.startsWith('"')) {
      const quoted = /^"(?:\\.|[^"\\])*"/.exec(rest)?.[0]
      if (!quoted) continue
      try { name = JSON.parse(quoted) as string } catch { continue }
      rest = rest.slice(quoted.length)
    }
    const metadata = /\[(?:ref=|@)(\d+)(?:[,\]])/.exec(rest) ?? /(?:^|\s)@(\d+)\b/.exec(rest)
    if (!metadata) continue
    const ref = `@${metadata[1]}`
    if (seen.has(ref)) continue
    seen.add(ref)
    if (!name) name = rest.slice(0, metadata.index).trim()
    if (!name) {
      const indent = (prefix[1] ?? '').length
      for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
        const child = lines[childIndex] ?? ''
        if (child.trim() && (child.match(/^\s*/)?.[0].length ?? 0) <= indent) break
        const text = /^\s+(?:[-*]\s+)?text\s+("(?:\\.|[^"\\])*")/.exec(child)
        if (text?.[1]) {
          try { name = JSON.parse(text[1]) as string } catch { /* 只显示可解析的文字。 */ }
          if (name) break
        }
      }
    }
    const rawRole = (prefix[2] ?? '').toLowerCase()
    const role = ({ anchor: 'link', text_box: 'textbox', textfield: 'textbox', push_button: 'button' } as Record<string, string>)[rawRole] ?? rawRole
    elements.push({ ref, role, name: name.slice(0, 1000), editable: ['textbox', 'searchbox', 'combobox'].includes(role) || /editable=(?:true|richtext|plaintext)/.test(rest) })
  }
  return elements
}

// 运行于 Ego 自己的 Node Runtime。只能通过公开 TaskSpace/Page 方法访问真实浏览器。
const EGO_LITE_PROGRAM = String.raw`
try {
  const args = request.args || {};
  let task = request.operation === 'resume'
    ? await takeOverTaskSpace(request.spaceId)
    : await taskSpace(request.spaceId === undefined ? request.spaceName : request.spaceId);
  if (task.ownership !== 'agent') throw Object.assign(new Error('该 Ego Space 不属于当前 Agent；不会抢占用户空间。'), { code: 'EGO_TASK_SPACE_USER_IN_CONTROL' });
  let selected = request.tabId || null;
  let result = null;
  let snapshot;
  const inventory = async () => await task.tabs();
  const choose = async (adoptUnknown = false) => {
    const tabs = await inventory();
    let tab = selected ? tabs.find(t => t.label === selected || (!t.label && 'unmanaged:' + t.targetId === selected)) : tabs.find(t => t.label && t.openedBy === 'agent');
    if (!tab) throw new Error('工作标签不存在或已关闭；请新建标签，或显式选择已有标签。');
    if (!tab.label) {
      if (!adoptUnknown) throw new Error('这是用户创建的未托管标签；请先显式选择，不能自动操作。');
      const page = await task.adopt(tab.page);
      selected = page.label;
      return page;
    }
    selected = tab.label;
    return task.page(tab.label);
  };
  const state = async () => {
    const tabs = await inventory();
    if (!selected || !tabs.some(t => t.label === selected)) selected = tabs.find(t => t.active && t.label)?.label || tabs.find(t => t.label)?.label || null;
    return { spaceId: task.spaceId, selectedTabId: selected, controlState: 'agent', tabs: tabs.map(t => ({ tabId: t.label || 'unmanaged:' + t.targetId, url: t.url || '', title: t.title || '未命名页面', managed: !!t.label, openedBy: t.openedBy === 'agent' ? 'agent' : 'unknown', active: !!t.active })) };
  };
  const wait = async page => {
    const condition = args.condition;
    const timeout = Number(args.timeoutMs || 10000);
    try {
      if (condition.kind === 'selector') await page.waitForSelector('loc=css:' + condition.value, { state: 'attached', timeout });
      else await page.waitForFunction(input => input.kind === 'url' ? location.href.includes(input.value) : (document.body?.innerText || '').includes(input.value), condition, { timeout });
      return { matched: true };
    } catch (error) {
      if (/timed?\s*out|timeout/i.test(String(error?.message || error))) return { matched: false };
      throw error;
    }
  };
  if (request.operation === 'finish') {
    result = await task.finish({ keep: [] });
    console.log(marker + JSON.stringify({ ok: true, value: { state: null, result } }));
  } else {
    if (request.operation === 'new') {
      const page = await task.newPage(); selected = page.label;
      if (args.url) await page.goto(args.url, { timeout: 20000 });
    } else if (request.operation === 'select' || request.operation === 'show') {
      const page = await choose(true);
      // Page handle 不保证带有 targetId；从当前公开标签清单解析，不缓存原生目标。
      const tab = (await inventory()).find(t => t.label === page.label);
      if (!tab || typeof tab.targetId !== 'string' || !tab.targetId) throw new Error('无法取得当前标签的浏览器目标；请刷新标签状态后重试。');
      await task.cdp('Target.activateTarget', { targetId: tab.targetId });
    } else if (request.operation === 'closeTab') {
      const page = await choose(false);
      const tab = (await inventory()).find(t => t.label === page.label);
      if (tab?.openedBy !== 'agent') throw new Error('此标签由用户创建，Snap 不会自动关闭它。请在 Ego 中手动关闭。');
      await page.close(); selected = null;
    } else if (!['ensure', 'state', 'resume'].includes(request.operation)) {
      const page = await choose(false);
      switch (request.operation) {
        case 'navigate': await page.goto(args.url, { timeout: 20000 }); break;
        case 'reload': await page.reload({ timeout: 20000 }); break;
        case 'back': case 'forward': {
          const history = await page.cdp('Page.getNavigationHistory');
          const index = history.currentIndex + (request.operation === 'back' ? -1 : 1);
          if (history.entries[index]) await page.cdp('Page.navigateToHistoryEntry', { entryId: history.entries[index].id });
          break;
        }
        case 'observe': snapshot = await page.snapshot(args.fullPage ? { scope: 'full_page' } : {}); break;
        case 'click': {
          // 只短暂探测本次点击的真实 download 事件；无事件绝不声称下载成功。
          const pendingDownload = args.downloadDirectory
            ? page.waitForEvent('download', { timeout: 750 }).then(download => ({ download })).catch(error => {
              if (/timed?\s*out|timeout/i.test(String(error?.message || error))) return { download: null };
              return { download: null, error };
            }) : Promise.resolve({ download: null });
          result = await page.click(args.ref, { label: 'Snap 点击页面元素' });
          const downloadEvent = await pendingDownload;
          if (downloadEvent.error) throw downloadEvent.error;
          const download = downloadEvent.download;
          if (download) {
            const fs = await import('node:fs/promises');
            const paths = await import('node:path');
            const crypto = await import('node:crypto');
            const rawName = download.suggestedFilename();
            const name = String(rawName || 'download').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').slice(0, 180) || 'download';
            await fs.mkdir(args.downloadDirectory, { recursive: true, mode: 0o700 });
            const target = paths.join(args.downloadDirectory, crypto.randomUUID() + '-' + name);
            await download.saveAs(target);
            result = { ...result, downloadedFiles: [{ path: target, name }] };
          }
          if (args.condition) result = { ...result, ...await wait(page) };
          break;
        }
        case 'hover': result = await page.hover(args.ref, { label: 'Snap 悬停页面元素' }); break;
        case 'drag': result = await page.dragAndDrop(args.sourceRef, args.targetRef, { label: 'Snap 拖动页面元素' }); break;
        case 'fill': result = await page.fill(args.ref, args.text); break;
        case 'focus': await page.focus(args.selector); break;
        case 'press': if (args.kind === 'text') await page.keyboard.insertText(args.text); else await page.keyboard.press(args.key); break;
        case 'wait': result = await wait(page); break;
        case 'evaluate': result = await page.evaluate(args.script); break;
        case 'upload': await page.setInputFiles(args.ref, args.paths); break;
        case 'selectOption': result = await page.selectOption('loc=css:' + args.selector, args.selection); break;
        case 'screenshot': {
          const fs = await import('node:fs/promises');
          const path = await page.screenshot();
          try {
            const bytes = await fs.readFile(path);
            if (bytes.length > 3 * 1024 * 1024) throw new Error('截图超过 3 MiB，请缩小页面或使用 BrowserObserve。');
            result = { mimeType: 'image/png', base64: bytes.toString('base64') };
          } finally { await fs.unlink(path).catch(() => {}); }
          break;
        }
        default: throw new Error('不支持的 Ego Lite 操作。');
      }
    }
    const current = await state();
    // 原始 CDP 会使 refs 失效，因此绝不在 Observe 之后读导航历史。
    if (['ensure', 'navigate', 'new', 'back', 'forward', 'reload', 'select', 'resume'].includes(request.operation) && current.selectedTabId) {
      const page = task.page(current.selectedTabId);
      const history = await page.cdp('Page.getNavigationHistory');
      current.canGoBack = history.currentIndex > 0;
      current.canGoForward = history.currentIndex < history.entries.length - 1;
    }
    if (request.operation === 'show') {
      await task.handOff(); current.controlState = 'user';
    }
    console.log(marker + JSON.stringify({ ok: true, value: { state: current, result: result === undefined ? null : result, ...(snapshot === undefined ? {} : { snapshot }) } }));
  }
} catch (error) {
  console.log(marker + JSON.stringify({ ok: false, error: String(error?.message || error), code: String(error?.error_code || error?.code || 'EGO_OPERATION_FAILED') }));
}
`
