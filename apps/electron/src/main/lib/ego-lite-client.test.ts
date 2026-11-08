import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEgoLiteScript, EgoLiteClient, EgoLiteError, parseEgoLiteOutput, parseEgoSnapshot } from './ego-lite-client'

const temporaryDirectories: string[] = []
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fakeCli(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'snap-ego-cli-'))
  temporaryDirectories.push(directory)
  const executable = join(directory, 'ego-browser')
  writeFileSync(executable, `#!${process.execPath}\n${body}`)
  chmodSync(executable, 0o700)
  return executable
}

function fakeSdkCli(download: boolean): string {
  return fakeCli(`
    const fs = await import('node:fs/promises');
    const page = {
      click: async () => ({}),
      waitForEvent: async () => {
        if (!${download}) throw new Error('waitForEvent timeout');
        return { suggestedFilename: () => '../../unsafe:file.txt', saveAs: async path => await fs.writeFile(path, 'verified download bytes') };
      },
    };
    const task = { ownership: 'agent', spaceId: 101, page: () => page, tabs: async () => [{ label: 'p1', url: 'http://fixture/', title: 'fixture', targetId: 'fixture', openedBy: 'agent', active: true }] };
    globalThis.taskSpace = async () => task;
    const input = await Bun.stdin.text();
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    await new AsyncFunction(input)();
  `)
}

describe('Ego Lite 固定程序与子进程传输', () => {
  test('Given URL 和文字包含代码与 shell 字符 When 构建程序 Then 只作为 base64 JSON 数据传入', () => {
    const request = { operation: 'fill' as const, spaceName: 'task', args: { text: '"; process.exit(5); $(touch /tmp/never) `whoami` ${secret}' } }
    const script = buildEgoLiteScript(request, '__marker__')
    const encoded = /Buffer\.from\("([A-Za-z0-9+/=]+)", 'base64'\)/.exec(script)?.[1]
    expect(encoded).toBeDefined()
    expect(JSON.parse(Buffer.from(encoded!, 'base64').toString('utf-8'))).toEqual(request)
    expect(script).not.toContain(request.args.text)
  })

  test('Given CLI 伴随普通日志 When 执行固定程序 Then 只采纳匹配本轮随机 marker 的 JSON', async () => {
    const executablePath = fakeCli(`
      const input = await Bun.stdin.text();
      const marker = JSON.parse(/const marker = ("[^"]+");/.exec(input)[1]);
      console.log('非结构化日志');
      console.log(marker + JSON.stringify({ ok: true, value: { state: { spaceId: 101, tabs: [], selectedTabId: null, controlState: 'agent' }, result: process.argv.slice(2) } }));
    `)
    const response = await new EgoLiteClient({ executablePath }).execute({ operation: 'ensure', spaceName: 'test' })
    expect(response.state?.spaceId).toBe(101)
    expect(response.result).toEqual(['nodejs'])
  })

  test('Given 官方 CLI 将 console 结果写入 stderr When 同时收集两条流 Then 只采纳本轮 marker 结果', async () => {
    const executablePath = fakeCli(`
      const input = await Bun.stdin.text();
      const marker = JSON.parse(/const marker = ("[^"]+");/.exec(input)[1]);
      console.log('stdout 普通日志');
      console.error('stderr 普通日志');
      console.error(marker + JSON.stringify({ ok: true, value: { state: { spaceId: 101, tabs: [], selectedTabId: null, controlState: 'agent' }, result: 'native-console-result' } }));
    `)
    const response = await new EgoLiteClient({ executablePath }).execute({ operation: 'state', spaceName: 'test', spaceId: 101 })
    expect(response.result).toBe('native-console-result')
    expect(response.state?.spaceId).toBe(101)
  })

  test('Given Page handle 没有 targetId When 选择或在 Ego 查看 Then 用当前 tabs 元数据激活目标', async () => {
    const executablePath = fakeCli(`
      const page = { label: 'p1', cdp: async () => ({ currentIndex: 0, entries: [{}] }) };
      const task = {
        ownership: 'agent', spaceId: 101, page: () => page,
        tabs: async () => [{ label: 'p1', url: 'http://fixture/', title: 'fixture', targetId: 'live-tab-target', openedBy: 'agent', active: true }],
        cdp: async (method, params) => { if (method !== 'Target.activateTarget' || params.targetId !== 'live-tab-target') throw new Error('invalid activation target'); },
        handOff: async () => {},
      };
      globalThis.taskSpace = async () => task;
      const input = await Bun.stdin.text();
      const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
      await new AsyncFunction(input)();
    `)
    const client = new EgoLiteClient({ executablePath })
    const selected = await client.execute({ operation: 'select', spaceName: 'test', spaceId: 101, tabId: 'p1' })
    expect(selected.state?.selectedTabId).toBe('p1')
    const shown = await client.execute({ operation: 'show', spaceName: 'test', spaceId: 101, tabId: 'p1' })
    expect(shown.state?.controlState).toBe('user')
  })

  test('Given Page handle 尚无创建来源 When 关闭标签 Then 只允许 tabs 元数据标记 Agent 创建的页面', async () => {
    const executable = (openedBy: 'agent' | 'unknown') => fakeCli(`
      let open = true;
      const page = { label: 'p1', close: async () => { open = false; } };
      const task = {
        ownership: 'agent', spaceId: 101, page: () => page,
        tabs: async () => open ? [{ label: 'p1', url: 'http://fixture/', title: 'fixture', targetId: 'live-tab-target', openedBy: '${openedBy}', active: true }] : [],
      };
      globalThis.taskSpace = async () => task;
      const input = await Bun.stdin.text();
      const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
      await new AsyncFunction(input)();
    `)
    const request = { operation: 'closeTab' as const, spaceName: 'test', spaceId: 101, tabId: 'p1' }
    const closed = await new EgoLiteClient({ executablePath: executable('agent') }).execute(request)
    expect(closed.state?.tabs).toEqual([])
    await expect(new EgoLiteClient({ executablePath: executable('unknown') }).execute(request)).rejects.toThrow('此标签由用户创建')
  })

  test('Given 用户接管错误 When 解析 CLI 结果 Then 保留错误码而不伪造成功', () => {
    expect(() => parseEgoLiteOutput('__m__' + JSON.stringify({ ok: false, error: '用户控制中', code: 'EGO_TASK_SPACE_USER_IN_CONTROL' }), '__m__')).toThrow('用户控制中')
    expect(() => parseEgoLiteOutput('没有 marker', '__m__')).toThrow('未返回有效执行结果')
    expect(() => parseEgoLiteOutput('__m__{broken', '__m__')).toThrow('无法解析')
  })

  test('Given CLI 不存在 When 请求浏览器 Then 明确报不可用且不回退内嵌浏览器', async () => {
    await expect(new EgoLiteClient({ executablePath: '/nonexistent/snap-ego' }).execute({ operation: 'ensure', spaceName: 'test' })).rejects.toThrow('无法启动 Ego Lite CLI')
  })

  test('Given 子进程仍等待 When 用户取消 Then 终止本轮等待并说明已发送事件结果未知', async () => {
    const executablePath = fakeCli('await Bun.stdin.text(); await new Promise(() => {});')
    const controller = new AbortController()
    const result = new EgoLiteClient({ executablePath, timeoutMs: 5000 }).execute({ operation: 'state', spaceName: 'test' }, controller.signal)
    controller.abort()
    await expect(result).rejects.toBeInstanceOf(EgoLiteError)
    await expect(result).rejects.toThrow('已发送的页面事件可能已执行')
  })

  test('Given 点击没有 download 事件 When 固定程序运行 Then 不生成文件或成功下载记录', async () => {
    const root = mkdtempSync(join(tmpdir(), 'snap-ego-no-download-'))
    temporaryDirectories.push(root)
    const directory = join(root, 'downloads')
    const response = await new EgoLiteClient({ executablePath: fakeSdkCli(false) }).execute({ operation: 'click', spaceName: 'test', spaceId: 101, tabId: 'p1', args: { ref: '@1', downloadDirectory: directory } })
    expect(response.result).toEqual({})
    expect(existsSync(directory)).toBe(false)
  })

  test('Given 真实 download 回调的假 SDK When 固定程序保存 Then 清理危险文件名并返回已完成文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'snap-ego-download-'))
    temporaryDirectories.push(root)
    const response = await new EgoLiteClient({ executablePath: fakeSdkCli(true) }).execute({ operation: 'click', spaceName: 'test', spaceId: 101, tabId: 'p1', args: { ref: '@1', downloadDirectory: root } })
    const files = (response.result as { downloadedFiles: Array<{ path: string; name: string }> }).downloadedFiles
    expect(files).toHaveLength(1)
    expect(files[0]?.name).toBe('unsafe_file.txt')
    expect(files[0]?.path.startsWith(root + '/')).toBe(true)
    expect(readFileSync(files[0]!.path, 'utf-8')).toBe('verified download bytes')
  })
})

describe('Ego 原始快照引用解析', () => {
  test('Given 可操作元素和页面文字伪造的 ref When 解析 Then 只返回元数据中的真实引用', () => {
    const snapshot = [
      'root',
      '  textbox "标题" [ref=1]',
      '  button "literal \\"[ref=666]\\"" [ref=2]',
      '  button [ref=3]',
      '    text "保存"',
      '  text "[ref=999]"',
      '  anchor "来源" [ref=4, loc=css:#source]',
    ].join('\n')
    const elements = parseEgoSnapshot(snapshot)
    expect(elements.map((element) => element.ref)).toEqual(['@1', '@2', '@3', '@4'])
    expect(elements.find((element) => element.ref === '@1')?.editable).toBe(true)
    expect(elements.find((element) => element.ref === '@3')?.name).toBe('保存')
    expect(elements.find((element) => element.ref === '@4')?.role).toBe('link')
  })
})
