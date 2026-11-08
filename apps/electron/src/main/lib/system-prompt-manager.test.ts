import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_DEFAULT_ID, BUILTIN_DEFAULT_PROMPT } from '@snap/shared'
import type { SystemPrompt, SystemPromptConfig } from '@snap/shared'
import * as configPaths from './config-paths'

type SystemPromptManager = typeof import('./system-prompt-manager')

let manager: SystemPromptManager
let temporaryDirectory = ''
let promptsPath = ''
let restorePromptsPath = (): void => {}

beforeAll(async () => {
  const promptsPathMock = spyOn(configPaths, 'getSystemPromptsPath').mockImplementation(() => {
    if (!promptsPath) throw new Error('测试临时提示词路径尚未建立')
    return promptsPath
  })
  restorePromptsPath = () => { promptsPathMock.mockRestore() }
  manager = await import('./system-prompt-manager')
})

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'snap-system-prompt-manager-'))
  promptsPath = join(temporaryDirectory, 'system-prompts.json')
})

afterEach(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true })
  promptsPath = ''
})

afterAll(() => {
  restorePromptsPath()
})

describe('内置提示词更名兼容', () => {
  test('Given 旧 Snap 内置提示词与用户自定义提示词 When 读取后保存无关开关 Then 更新内置内容并完整保留用户提示词和默认选择', () => {
    const customPrompt: SystemPrompt = {
      id: 'user-custom-prompt',
      name: '我的 Snap 研究助手',
      content: '这是用户手写的 Snap 研究规则，请逐字保留。',
      isBuiltin: false,
      createdAt: 100,
      updatedAt: 200,
    }
    const legacyConfig: SystemPromptConfig = {
      prompts: [
        { ...BUILTIN_DEFAULT_PROMPT, name: 'Snap 内置提示词', content: '你是 Snap AI 助手。' },
        customPrompt,
      ],
      defaultPromptId: customPrompt.id,
      appendDateTimeAndUserName: true,
    }
    writeFileSync(promptsPath, JSON.stringify(legacyConfig), 'utf-8')

    const config = manager.getSystemPromptConfig()

    expect(config.prompts.find((prompt) => prompt.id === BUILTIN_DEFAULT_ID)).toEqual(BUILTIN_DEFAULT_PROMPT)
    expect(config.prompts.find((prompt) => prompt.id === customPrompt.id)).toEqual(customPrompt)
    expect(config.defaultPromptId).toBe(customPrompt.id)

    manager.updateAppendSetting(false)
    const stored = JSON.parse(readFileSync(promptsPath, 'utf-8')) as SystemPromptConfig

    expect(stored.prompts.find((prompt) => prompt.id === BUILTIN_DEFAULT_ID)).toEqual(BUILTIN_DEFAULT_PROMPT)
    expect(stored.prompts.find((prompt) => prompt.id === customPrompt.id)).toEqual(customPrompt)
    expect(stored.defaultPromptId).toBe(customPrompt.id)
    expect(stored.appendDateTimeAndUserName).toBe(false)
  })
})
