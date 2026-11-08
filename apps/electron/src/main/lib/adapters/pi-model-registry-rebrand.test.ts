import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sdkPath = import.meta.resolve('@earendil-works/pi-coding-agent')
const registryPath = join(import.meta.dir, 'pi-model-registry.ts')
const adapterPath = join(import.meta.dir, 'pi-agent-adapter.ts')
const builtinToolsPath = join(import.meta.dir, 'pi-builtin-tools.ts')
const electronPath = import.meta.resolve('electron')
const transformPath = new URL('./api/transform-messages.js', import.meta.resolve('@earendil-works/pi-ai')).href

/**
 * 子进程只继承运行工具所需的 PATH，HOME / Pi 目录全部指向临时目录。
 * 仅代理 SDK 的 create() 注入内存认证与目录；注册、认证解析、会话恢复均调用真实 Pi。
 * 不调用 prompt / stream / complete；fetch 保护还会让任何意外网络访问立即失败。
 */
async function runOfflinePiScenario(scenario: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'snap-pi-provider-alias-'))
  const sourcePath = join(home, 'scenario.ts')
  writeFileSync(sourcePath, `
    import assert from 'node:assert/strict'
    import { mkdirSync, readFileSync } from 'node:fs'
    import { join } from 'node:path'
    let networkAttempts = 0
    globalThis.fetch = async () => { networkAttempts++; throw new Error('离线测试禁止网络请求') }
    const sdk = await import(${JSON.stringify(sdkPath)})
    const { buildModel, resolvePiResumeModel, normalizePiBaseUrl, buildPiRequestHeaders } = await import(${JSON.stringify(registryPath)})
    const { transformMessages } = await import(${JSON.stringify(transformPath)})
    const home = process.env.HOME
    const agentDir = join(home, 'pi')
    const sessionDir = join(home, 'sessions')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(sessionDir, { recursive: true })
    let runtimeCreations = 0
    let credentialWrites = 0
    const credentials = {
      async read() { return undefined },
      async list() { return [] },
      async modify() { credentialWrites++; throw new Error('测试不允许写认证') },
      async delete() { credentialWrites++; throw new Error('测试不允许删认证') },
    }
    const isolatedModelRuntime = new Proxy(sdk.ModelRuntime, {
      get(target, property, receiver) {
        if (property !== 'create') return Reflect.get(target, property, receiver)
        return async (options) => {
          runtimeCreations++
          assert.equal(options.allowModelNetwork, false)
          return sdk.ModelRuntime.create({ ...options, credentials, modelsPath: null, allowModelNetwork: false })
        }
      },
    })
    const isolatedSdk = { ...sdk, ModelRuntime: isolatedModelRuntime }
    function input(provider, model = 'offline-fixture-model') {
      return {
        provider, model, sessionId: 'offline-app-session',
        apiKey: 'offline-fixture-api-key', baseUrl: 'https://example.invalid/proxy/v1/',
        prompt: '离线验证', permissionMode: 'default', systemPrompt: '离线验证',
        piAgentDir: agentDir, piSessionDir: sessionDir, cwd: home,
      }
    }
    async function resources() {
      const settingsManager = sdk.SettingsManager.inMemory({ cacheWarming: 'off' })
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd: home, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      })
      await resourceLoader.reload()
      return { cwd: home, agentDir, settingsManager, resourceLoader, noTools: 'all' }
    }
    ${scenario}
    assert.ok(runtimeCreations > 0)
    assert.equal(credentialWrites, 0)
    assert.equal(networkAttempts, 0)
  `)
  try {
    const child = Bun.spawn([process.execPath, sourcePath], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        PI_CODING_AGENT_DIR: join(home, 'pi'),
        PI_OFFLINE: '1',
        TMPDIR: tmpdir(),
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(status, `${stdout}\n${stderr}`).toBe(0)
  } finally { rmSync(home, { recursive: true, force: true }) }
}

test('Given API-key channels When registered in the installed Pi runtime Then old and new aliases share models, API, endpoint, key and headers', async () => {
  await runOfflinePiScenario(`
    for (const provider of ['openai', 'openai-responses', 'deepseek', 'kimi-coding', 'google', 'custom']) {
      const request = input(provider)
      const { modelRuntime, model } = await buildModel(isolatedSdk, request)
      const currentName = 'snap-' + provider + '-' + request.sessionId
      for (const brand of ['snap']) {
      const oldName = brand + '-' + provider + '-' + request.sessionId
      const current = modelRuntime.getModel(currentName, request.model)
      const legacy = modelRuntime.getModel(oldName, request.model)
      assert.ok(current, currentName)
      assert.ok(legacy, oldName)
      assert.equal(model.provider, currentName)
      assert.deepEqual({ ...legacy, provider: currentName }, current)
      assert.equal(current.baseUrl, normalizePiBaseUrl(request.baseUrl, provider, current.api))
      const currentRegistration = modelRuntime.getRegisteredProviderConfig(currentName)
      const legacyRegistration = modelRuntime.getRegisteredProviderConfig(oldName)
      assert.deepEqual(legacyRegistration, currentRegistration)
      assert.equal(currentRegistration.apiKey, request.apiKey)
      assert.deepEqual(currentRegistration.headers, buildPiRequestHeaders(provider, request.apiKey))
      const currentAuth = await modelRuntime.getAuth(current)
      const legacyAuth = await modelRuntime.getAuth(legacy)
      assert.ok(currentAuth)
      assert.deepEqual(legacyAuth, currentAuth)
      assert.equal(currentAuth.auth.apiKey, request.apiKey)
      const registeredHeaders = buildPiRequestHeaders(provider, request.apiKey)
      for (const [name, value] of Object.entries(registeredHeaders ?? {})) {
        assert.equal(currentAuth.auth.headers[name], value)
      }
      assert.equal((await modelRuntime.getAvailable(currentName)).length, 1)
      assert.equal((await modelRuntime.getAvailable(oldName)).length, 1)
      }
    }
  `)
})

test.each(['snap'] as const)('Given %s Pi JSONL metadata When reopened with the real SDK Then old aliases resolve without rewriting historical entries', async (brand) => {
  await runOfflinePiScenario(`
    const brand = ${JSON.stringify(brand)}
    const request = input('openai')
    const { modelRuntime, model } = await buildModel(isolatedSdk, request)
    const oldName = brand + '-openai-' + request.sessionId
    const manager = sdk.SessionManager.create(home, sessionDir)
    manager.appendModelChange(oldName, request.model)
    manager.appendThinkingLevelChange('off')
    manager.appendMessage({ role: 'user', content: '正文 ' + brand + ' 保持原样', timestamp: 1 })
    manager.appendMessage({
      role: 'assistant', content: [
        { type: 'thinking', thinking: '既有推理', thinkingSignature: 'signed-fixture' },
        { type: 'thinking', thinking: '', thinkingSignature: 'encrypted-fixture', redacted: true },
        { type: 'text', text: '既有回复' },
        { type: 'toolCall', id: 'completed-call', name: 'existing_tool', arguments: {}, thoughtSignature: 'tool-signed-fixture' },
      ],
      api: model.api, provider: oldName, model: request.model,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: 2,
    })
    manager.appendMessage({ role: 'toolResult', toolCallId: 'completed-call', toolName: 'existing_tool',
      content: [{ type: 'text', text: '既有结果' }], isError: false, timestamp: 3 })
    const sessionFile = manager.getSessionFile()
    const original = readFileSync(sessionFile, 'utf8')
    const reopened = sdk.SessionManager.open(sessionFile, sessionDir, home)
    assert.equal(reopened.buildSessionContext().model.provider, oldName)
    const common = await resources()
    const restored = await sdk.createAgentSession({ ...common, sessionManager: reopened, modelRuntime })
    assert.equal(restored.modelFallbackMessage, undefined)
    assert.equal(restored.session.model.provider, oldName)
    assert.equal(restored.session.messages.find((message) => message.role === 'assistant').provider, oldName)
    restored.session.dispose()
    assert.equal(readFileSync(sessionFile, 'utf8'), original)

    // 同模型恢复选取旧身份，实际 Pi 转换仍保留签名、redacted reasoning 与 usage 基线。
    const activeModel = resolvePiResumeModel(request, model, modelRuntime, reopened.buildSessionContext().model)
    const appRestore = await sdk.createAgentSession({
      ...common, modelRuntime, model: activeModel,
      sessionManager: sdk.SessionManager.open(sessionFile, sessionDir, home),
    })
    assert.equal(appRestore.session.model.provider, oldName)
    const originalAssistant = appRestore.session.messages.find((message) => message.role === 'assistant')
    assert.equal(originalAssistant.provider, appRestore.session.model.provider)
    const transformed = transformMessages(appRestore.session.messages, appRestore.session.model)
    const replayedAssistant = transformed.find((message) => message.role === 'assistant')
    assert.deepEqual(replayedAssistant.content, originalAssistant.content)
    assert.deepEqual(replayedAssistant.usage, originalAssistant.usage)
    appRestore.session.dispose()
    assert.equal(readFileSync(sessionFile, 'utf8'), original)

    // 真正 fork 的 Pi 文件仍含父业务 sessionId，不能只登记当前子会话尾部的别名。
    const forkManager = sdk.SessionManager.forkFrom(sessionFile, home, sessionDir)
    const forkRequest = { ...request, sessionId: 'offline-fork-child' }
    const historicalModel = forkManager.buildSessionContext().model
    assert.equal(historicalModel.provider, oldName)
    const forkBuilt = await buildModel(isolatedSdk, forkRequest, historicalModel)
    assert.ok(forkBuilt.modelRuntime.getModel(oldName, request.model))
    const forkActiveModel = resolvePiResumeModel(forkRequest, forkBuilt.model, forkBuilt.modelRuntime, historicalModel)
    const forkRestore = await sdk.createAgentSession({ ...common, ...forkBuilt, model: forkActiveModel, sessionManager: forkManager })
    assert.equal(forkRestore.session.model.provider, oldName)
    assert.deepEqual(transformMessages(forkRestore.session.messages, forkActiveModel).find((message) => message.role === 'assistant').content, originalAssistant.content)
    forkRestore.session.dispose()
    assert.equal(readFileSync(sessionFile, 'utf8'), original)
  `)
})

test('Given a changed model or provider When considering legacy metadata Then only the selected provider and exact model may retain a legacy identity', async () => {
  await runOfflinePiScenario(`
    for (const [provider, historicalProvider, historicalModelId] of [
      ['openai', 'snap-openai-parent', 'other-model'],
      ['openai', 'snap-openai-responses-parent', 'offline-fixture-model'],
      ['zhipu', 'snap-zhipu-coding-parent', 'offline-fixture-model'],
      ['anthropic', 'snap-anthropic-compatible-parent', 'offline-fixture-model'],
      ['openai', 'unrelated-provider', 'offline-fixture-model'],
      ['openai', 'snap-openai-', 'offline-fixture-model'],
      ['openai', 'snap-openai-parent', 'other-model'],
      ['openai', 'snap-openai-responses-parent', 'offline-fixture-model'],
      ['zhipu', 'snap-zhipu-coding-parent', 'offline-fixture-model'],
      ['anthropic', 'snap-anthropic-compatible-parent', 'offline-fixture-model'],
      ['openai', 'snap-openai-', 'offline-fixture-model'],
    ]) {
      const request = input(provider)
      const historicalModel = { provider: historicalProvider, modelId: historicalModelId }
      const { modelRuntime, model } = await buildModel(isolatedSdk, request, historicalModel)
      assert.equal(modelRuntime.getModel(historicalProvider, model.id), undefined)
      assert.equal(resolvePiResumeModel(request, model, modelRuntime, historicalModel).provider, 'snap-' + provider + '-' + request.sessionId)
    }
  `)
})

test('Given a fresh Pi session When initialized with the returned model Then active model and initial model-change metadata use the Snap provider', async () => {
  await runOfflinePiScenario(`
    const request = input('deepseek')
    const { modelRuntime, model } = await buildModel(isolatedSdk, request)
    const manager = sdk.SessionManager.inMemory(home)
    const { session } = await sdk.createAgentSession({ ...await resources(), modelRuntime, model, sessionManager: manager })
    assert.equal(session.model.provider, 'snap-deepseek-' + request.sessionId)
    assert.equal(manager.getBranch().find((entry) => entry.type === 'model_change').provider, session.model.provider)
    session.dispose()
  `)
})

test('Given Snap MCP management tools When registered and permission-wrapped Then tool names are unique and permissions apply before execution', async () => {
  await runOfflinePiScenario(`
    const { mock } = await import('bun:test')
    mock.module(${JSON.stringify(electronPath)}, () => ({
      app: { getPath: () => home, getVersion: () => '0.0.0-test', getName: () => 'Snap test', isPackaged: false, on() {} },
      BrowserWindow: class { static getAllWindows() { return [] } },
      ipcMain: {}, shell: {}, dialog: {}, safeStorage: {}, nativeImage: {}, net: {}, session: {},
      systemPreferences: {}, clipboard: {}, screen: {}, Notification: class {}, Menu: {},
      MenuItem: class {}, Tray: class {}, powerMonitor: {}, globalShortcut: {}, webContents: {},
      utilityProcess: {}, MessageChannelMain: class {}, nativeTheme: {}, protocol: {}, powerSaveBlocker: {},
    }))
    const { buildWorkspaceMcpManagementTools } = await import(${JSON.stringify(builtinToolsPath)})
    const { wrapCustomToolDefinitions } = await import(${JSON.stringify(adapterPath)})
    await buildModel(isolatedSdk, input('openai'))
    const tools = buildWorkspaceMcpManagementTools(sdk, {
      sessionId: 'offline-app-session', channelId: 'fixture-channel', workspaceSlug: 'fixture-workspace', triggeredBy: 'user',
    })
    assert.equal(tools.length, 2)
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length)
    const approvedNames = []
    const wrapped = wrapCustomToolDefinitions(tools, async (name) => {
      approvedNames.push(name)
      return { behavior: 'deny', message: 'offline permission denied' }
    })
    for (const suffix of ['list_mcp_servers', 'configure_mcp_server']) {
      const currentName = 'snap_workspace_' + suffix
      const original = tools.find((tool) => tool.name === currentName)
      assert.ok(original.promptSnippet)
      const tool = wrapped.find((candidate) => candidate.name === currentName)
      assert.equal(tool.executionMode, 'sequential')
      await assert.rejects(() => tool.execute('pending-call', {}, undefined, undefined, {}), /offline permission denied/)
      assert.equal(approvedNames.at(-1), currentName)
    }
  `)
})
