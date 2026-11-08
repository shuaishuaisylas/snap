import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sdkPath = import.meta.resolve('@earendil-works/pi-coding-agent')
const electronPath = import.meta.resolve('electron')
const registryPath = join(import.meta.dir, 'adapters/pi-model-registry.ts')
const builtinToolsPath = join(import.meta.dir, 'adapters/pi-builtin-tools.ts')
const settingsPath = join(import.meta.dir, 'settings-service.ts')
const attachmentsPath = join(import.meta.dir, 'attachment-service.ts')
const imageValidationPath = join(import.meta.dir, 'image-content-validation.ts')
const openAIAdapterPath = join(import.meta.dir, '../../../../../packages/core/src/providers/openai-adapter.ts')
const transformPath = new URL('./api/transform-messages.js', import.meta.resolve('@earendil-works/pi-ai')).href

/** 使用真实 Pi、工具注册和附件存储；临时 HOME、内存认证及 fetch 防线隔离用户数据和网络。 */
async function runOfflineScenario(scenario: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'snap-vision-removal-'))
  const sourcePath = join(home, 'scenario.ts')
  writeFileSync(sourcePath, `
    import assert from 'node:assert/strict'
    import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    import { mock } from 'bun:test'
    const home = process.env.HOME
    let networkAttempts = 0
    globalThis.fetch = async () => { networkAttempts++; throw new Error('离线测试禁止网络请求') }
    mock.module(${JSON.stringify(electronPath)}, () => ({
      app: { getPath: () => home, getVersion: () => '0.0.0-test', getName: () => 'Snap test', isPackaged: false, on() {} },
      BrowserWindow: class { static getAllWindows() { return [] } },
      ipcMain: {}, shell: {}, dialog: {}, safeStorage: {}, nativeImage: {}, net: {}, session: {},
      systemPreferences: {}, clipboard: {}, screen: {}, Notification: class {}, Menu: {},
      MenuItem: class {}, Tray: class {}, powerMonitor: {}, globalShortcut: {}, webContents: {},
      utilityProcess: {}, MessageChannelMain: class {}, nativeTheme: {}, protocol: {}, powerSaveBlocker: {},
    }))
    const sdk = await import(${JSON.stringify(sdkPath)})
    const { buildModel, resolvePiImageInputCapability } = await import(${JSON.stringify(registryPath)})
    const { transformMessages } = await import(${JSON.stringify(transformPath)})
    let credentialWrites = 0
    const credentials = {
      async read() { return undefined }, async list() { return [] },
      async modify() { credentialWrites++; throw new Error('测试不允许写认证') },
      async delete() { credentialWrites++; throw new Error('测试不允许删认证') },
    }
    const isolatedSdk = { ...sdk, ModelRuntime: new Proxy(sdk.ModelRuntime, {
      get(target, property, receiver) {
        if (property !== 'create') return Reflect.get(target, property, receiver)
        return (options) => sdk.ModelRuntime.create({ ...options, credentials, modelsPath: null, allowModelNetwork: false })
      },
    }) }
    function request(model) {
      return {
        provider: 'deepseek', model, sessionId: 'offline-session', apiKey: 'offline-fixture-key',
        baseUrl: 'https://example.invalid/v1', prompt: '离线验证', permissionMode: 'default',
        systemPrompt: '离线验证', cwd: home, piAgentDir: join(home, 'pi'), piSessionDir: join(home, 'sessions'),
      }
    }
    async function resources() {
      const agentDir = join(home, 'pi')
      mkdirSync(agentDir, { recursive: true })
      const settingsManager = sdk.SettingsManager.inMemory({ cacheWarming: 'off' })
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd: home, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      })
      await resourceLoader.reload()
      return { cwd: home, agentDir, settingsManager, resourceLoader }
    }
    ${scenario}
    assert.equal(credentialWrites, 0)
    assert.equal(networkAttempts, 0)
  `)
  try {
    const child = Bun.spawn([process.execPath, sourcePath], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, '.config'), PI_CODING_AGENT_DIR: join(home, 'pi'),
        PI_OFFLINE: '1', SNAP_DEV: '1', TMPDIR: tmpdir(),
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(status, `${stdout}\n${stderr}`).toBe(0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('Given 已启用的旧视觉中转配置和历史工具调用 When 构建工具并恢复真实 Pi 会话 Then 中转不能重新注册且其他工具继续可用', async () => {
  await runOfflineScenario(`
    const configDir = join(home, '.snap-dev')
    mkdirSync(configDir, { recursive: true })
    const file = join(configDir, 'settings.json')
    const original = JSON.stringify({ themeMode: 'dark', visionRelay: { enabled: true, channelId: 'old-vision-channel', modelId: 'old-vision-model' } })
    writeFileSync(file, original)
    const { getSettings, updateSettings } = await import(${JSON.stringify(settingsPath)})
    assert.equal(Object.hasOwn(getSettings(), 'visionRelay'), false)
    assert.equal(readFileSync(file, 'utf8'), original)
    const updated = updateSettings({ agentModelId: 'deepseek-v4-pro', visionRelay: { enabled: true } })
    assert.equal(Object.hasOwn(updated, 'visionRelay'), false)
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(file, 'utf8')), 'visionRelay'), false)
    assert.equal(updated.agentModelId, 'deepseek-v4-pro')

    const { buildPiBuiltinTools } = await import(${JSON.stringify(builtinToolsPath)})
    const context = { sessionId: 'offline-session', channelId: 'offline-channel', modelId: 'deepseek-v4-pro', allowedRoots: [home] }
    const { tools } = await buildPiBuiltinTools(sdk, context)
    assert.equal(tools.some((tool) => tool.name === 'VisionRelay'), false)
    assert.ok(tools.some((tool) => tool.name === 'BrowserScreenshot'))
    assert.ok(tools.some((tool) => tool.name === 'mcp__automation__list_automations'))
    assert.ok(tools.some((tool) => tool.name === 'mcp__planning__list_todos'))

    const { modelRuntime, model } = await buildModel(isolatedSdk, request('deepseek-v4-pro'))
    const manager = sdk.SessionManager.create(home, join(home, 'sessions'))
    manager.appendModelChange(model.provider, model.id)
    manager.appendThinkingLevelChange('off')
    manager.appendMessage({ role: 'user', content: '旧会话正文保持原样', timestamp: 1 })
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'old-call', name: 'VisionRelay', arguments: { imagePath: join(home, 'old.png') } }],
      api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: 2,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
    const sessionFile = manager.getSessionFile()
    const originalSession = readFileSync(sessionFile, 'utf8')
    const { session } = await sdk.createAgentSession({ ...await resources(), modelRuntime, model,
      sessionManager: sdk.SessionManager.open(sessionFile, join(home, 'sessions'), home), customTools: tools })
    assert.equal(session.getToolDefinition('VisionRelay'), undefined)
    assert.equal(session.getAllTools().some((tool) => tool.name === 'VisionRelay'), false)
    session.setActiveToolsByName(['VisionRelay', 'read', 'BrowserScreenshot'])
    assert.deepEqual(session.getActiveToolNames(), ['read', 'BrowserScreenshot'])
    session.dispose()
    assert.equal(readFileSync(sessionFile, 'utf8'), originalSession)
  `)
})

test('Given 原生视觉模型和普通图片附件 When Pi 读取图片并转换消息、Chat 构造请求 Then 图片仍原样进入所选模型且无需中转', async () => {
  await runOfflineScenario(`
    const { modelRuntime, model } = await buildModel(isolatedSdk, request('deepseek-v4-flash'))
    assert.ok(model.input.includes('image'))
    assert.equal(await resolvePiImageInputCapability('deepseek', model.id), 'supported')
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/1RkAAAAASUVORK5CYII='
    const { saveAttachment, isImageAttachment, readAttachmentAsBase64 } = await import(${JSON.stringify(attachmentsPath)})
    const saved = saveAttachment({ conversationId: 'offline-conversation', filename: 'one-pixel.png', mediaType: 'image/png', data: png }).attachment
    assert.ok(isImageAttachment(saved.mediaType))
    assert.equal(readAttachmentAsBase64(saved.localPath), png)
    const localImagePath = join(home, '.snap-dev', 'attachments', saved.localPath)
    const read = await sdk.createReadTool(home, { autoResizeImages: false }).execute('native-read', { path: localImagePath })
    const image = read.content.find((block) => block.type === 'image')
    assert.ok(image)
    assert.equal(image.data, png)
    const { sanitizePiMessageImageContent } = await import(${JSON.stringify(imageValidationPath)})
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '描述这张图片' }, image], timestamp: 1 },
      { role: 'toolResult', toolCallId: 'native-read', toolName: 'read', content: read.content, isError: false, timestamp: 2 },
    ]
    const sanitized = sanitizePiMessageImageContent(messages)
    assert.equal(sanitized[0], messages[0])
    assert.equal(sanitized[1], messages[1])
    const converted = transformMessages(sanitized, model)
    assert.deepEqual(converted[0].content.find((block) => block.type === 'image'), image)
    assert.deepEqual(converted[1].content.find((block) => block.type === 'image'), image)

    const { session } = await sdk.createAgentSession({ ...await resources(), modelRuntime, model, sessionManager: sdk.SessionManager.inMemory(home) })
    const nativeMessages = await session.agent.convertToLlm(sanitized)
    assert.deepEqual(nativeMessages[0].content.find((block) => block.type === 'image'), image)
    session.dispose()

    const { OpenAIAdapter } = await import(${JSON.stringify(openAIAdapterPath)})
    const requestBody = new OpenAIAdapter('deepseek').buildStreamRequest({ baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', modelId: model.id,
      history: [], userMessage: '描述这张图片', attachments: [saved],
      readImageAttachments: (attachments) => (attachments ?? []).filter((attachment) => isImageAttachment(attachment.mediaType))
        .map((attachment) => ({ mediaType: attachment.mediaType, data: readAttachmentAsBase64(attachment.localPath) })),
    })
    const body = JSON.parse(requestBody.body)
    assert.equal(body.model, model.id)
    assert.deepEqual(body.messages[0].content[0], { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } })
    assert.equal(body.tools, undefined)
  `)
})
