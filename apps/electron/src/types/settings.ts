/**
 * 应用设置类型
 *
 * 主题模式、IPC 通道等设置相关定义。
 */

import type { EnvironmentCheckResult, ThinkingConfig, AgentEffort, AgentThinkingLevel, FeishuSessionMirrorSettings, TerminalProfile, WindowsShellPreference } from '@snap/shared'

/**
 * 用户自定义快捷键覆盖（持久化到 settings.json）
 *
 * 字段三态语义：
 * - `undefined`（字段缺失）→ 使用默认快捷键
 * - 非空字符串 → 使用该自定义 accelerator
 * - `null` → 用户已主动禁用此平台的快捷键，不注册任何监听
 */
export interface ShortcutOverrides {
  [shortcutId: string]: {
    mac?: string | null
    win?: string | null
  }
}

/** 主题模式 */
export type ThemeMode = 'light' | 'dark' | 'system'

/** 所有合法的特殊风格值（白名单，新增主题时只需追加这里） */
export const THEME_STYLES = [
  'default',
  'ocean-light',
  'ocean-dark',
  'forest-light',
  'forest-dark',
  'slate-light',
  'slate-dark',
  'terminal-dark',
] as const

/** 特殊风格主题 */
export type ThemeStyle = (typeof THEME_STYLES)[number]

/** 默认主题模式 */
export const DEFAULT_THEME_MODE: ThemeMode = 'dark'

/** 读取旧主题配置时，已移除的特殊风格回退为跟随系统。 */
export function normalizeThemeMode(mode: unknown): ThemeMode {
  if (mode === 'special') return 'system'
  return mode === 'light' || mode === 'dark' || mode === 'system' ? mode : DEFAULT_THEME_MODE
}

/** 默认特殊风格 */
export const DEFAULT_THEME_STYLE: ThemeStyle = 'default'

/** Markdown 预览字号档位 */
export type MarkdownFontSize = 'small' | 'medium' | 'large'

/** 默认 Markdown 字号档位 */
export const DEFAULT_MARKDOWN_FONT_SIZE: MarkdownFontSize = 'medium'

/** macOS 原生 Agent 灵动岛偏好。 */
export interface AgentIslandSettings {
  /** 是否启用 Agent / 近期 Todo 日程的灵动岛提醒，默认 true。 */
  enabled?: boolean
}

/** 可在通用设置中关闭的本地生产力工具；缺省保持开启以兼容已有用户。 */
export interface ProductivityToolsSettings {
  todosEnabled: boolean
  calendarEnabled: boolean
  obsidianEnabled: boolean
}

export const DEFAULT_PRODUCTIVITY_TOOLS_SETTINGS: ProductivityToolsSettings = {
  todosEnabled: true,
  calendarEnabled: true,
  obsidianEnabled: true,
}

/** 容错读取旧配置与手写 settings.json，未知或缺失字段默认开启。 */
export function normalizeProductivityToolsSettings(input: unknown): ProductivityToolsSettings {
  const raw = input && typeof input === 'object' ? input as Partial<ProductivityToolsSettings> : {}
  return {
    todosEnabled: typeof raw.todosEnabled === 'boolean' ? raw.todosEnabled : true,
    calendarEnabled: typeof raw.calendarEnabled === 'boolean' ? raw.calendarEnabled : true,
    obsidianEnabled: typeof raw.obsidianEnabled === 'boolean' ? raw.obsidianEnabled : true,
  }
}

/** 提升此版本可要求用户重新确认更新后的受管浏览器风险告知。 */
export const BROWSER_RISK_DISCLAIMER_VERSION = 2

/** 应用设置 */
export interface AppSettings {
  /** 主题模式 */
  themeMode: ThemeMode
  /** 特殊风格主题 */
  themeStyle?: ThemeStyle
  /** Agent 默认渠道 ID（由当前 Agent Core 解释） — 当前选中的渠道 */
  agentChannelId?: string
  /** Agent 默认模型 ID */
  agentModelId?: string
  /** Agent 当前工作区 ID */
  agentWorkspaceId?: string
  /** Windows 上用户最近一次明确选择的 Agent 终端 Shell；未设置时使用系统默认。 */
  lastWindowsTerminalProfile?: TerminalProfile
  /** Windows 上 Agent Bash 工具的运行环境；默认自动选择 Git Bash，WSL 需用户显式启用。 */
  windowsShellPreference?: WindowsShellPreference
  /** 侧栏「自动任务」合成项目组在项目列表中的位置索引（默认 0 = 最靠前；可拖拽调整） */
  agentAutomationGroupOrder?: number
  /** 是否已完成 Onboarding 流程 */
  onboardingCompleted?: boolean
  /** 已完成的 Onboarding 版本；低于当前版本时会再次展示引导。 */
  onboardingVersion?: number
  /** 是否跳过了环境检测 */
  environmentCheckSkipped?: boolean
  /** 最后一次环境检测结果（缓存） */
  lastEnvironmentCheck?: EnvironmentCheckResult
  /** 是否启用桌面通知 */
  notificationsEnabled?: boolean
  /** 标签页持久化状态（重启恢复） */
  tabState?: PersistedTabSettings
  /** Agent 思考模式 */
  agentThinking?: ThinkingConfig
  /** Agent 推理深度 */
  agentEffort?: AgentEffort
  /** OpenAI 新会话默认思考深度 */
  defaultOpenAIThinkingLevel?: AgentThinkingLevel
  /** Agent 最大预算（美元/次） */
  agentMaxBudgetUsd?: number
  /** Agent 最大轮次（0 或 undefined = SDK 默认） */
  agentMaxTurns?: number
  /** 自动归档天数（0 = 禁用，默认 7） */
  archiveAfterDays?: number
  /** 发送消息快捷键模式：true = Cmd/Ctrl+Enter 发送，false(默认) = Enter 发送 */
  sendWithCmdEnter?: boolean
  /** 用户自定义快捷键覆盖 */
  shortcutOverrides?: ShortcutOverrides
  /** 左侧会话列表悬浮预览迷你地图（默认 false，需手动开启） */
  sessionHoverPreviewEnabled?: boolean
  /** 粘贴超过阈值的长文本时是否自动转为附件（默认 false） */
  longTextPasteAsAttachmentEnabled?: boolean
  /** 输入框是否渲染 Markdown 富文本格式（默认 false，关闭后为纯文本模式，仍保留 Mention 引用） */
  richTextRenderingEnabled?: boolean
  /** Markdown 预览字号档位（默认 'medium'，对应 15px） */
  markdownFontSize?: MarkdownFontSize
  /** 应用图标变体 ID（dock + window icon），'default' 或 logo 变体 id */
  appIconVariant?: string
  /** 飞书 Session 镜像设置：每个 Snap Session 可创建一个仅包含用户与指定 Bot 的飞书群 */
  feishuSessionMirror?: FeishuSessionMirrorSettings
  /** 已确认的受管浏览器风险告知版本；低于当前版本时首次使用会再次要求确认。 */
  browserRiskDisclaimerVersion?: number
  /** Todo、日程与 Obsidian 的可见性和 Agent 工具注入开关，默认全部开启。 */
  productivityTools: ProductivityToolsSettings
  /** 启动时自动清理临时文件（snap-preview、snap-installers），默认 true */
  autoCleanupTempOnStart?: boolean
  /** 自动清理 N 天前已归档会话的 SDK 数据（0 = 禁用，默认 0） */
  autoCleanupArchivedDays?: number
  /**
   * Agent 代创建 git commit / PR 时是否附加 Snap 推广标识。
   * 默认 true：commit trailer 为 `Made-with: Snap`，PR body 末尾使用相同的文字品牌。
   * 关闭后不注入任何 Snap 归因，并覆盖 Claude SDK 默认 Co-Authored-By。
   */
  gitAttributionEnabled?: boolean
  /** macOS 原生 Agent 灵动岛偏好。 */
  agentIsland?: AgentIslandSettings
  /** 主窗口状态（大小、位置、是否最大化） */
  mainWindowState?: MainWindowState
}

/** 主窗口大小、位置和最大化状态 */
export interface MainWindowState {
  width: number
  height: number
  x: number
  y: number
  isMaximized: boolean
}

/** 持久化的标签页状态 */
export interface PersistedTabSettings {
  tabs: import('../renderer/atoms/tab-atoms').TabItem[]
  activeTabId: string | null
}

/** 设置 IPC 通道 */
export const SETTINGS_IPC_CHANNELS = {
  GET: 'settings:get',
  UPDATE: 'settings:update',
  UPDATE_SYNC: 'settings:update-sync',
  GET_SYSTEM_THEME: 'settings:get-system-theme',
  ON_SYSTEM_THEME_CHANGED: 'settings:system-theme-changed',
  /** 用户手动切换主题时广播给所有窗口 */
  ON_THEME_SETTINGS_CHANGED: 'settings:theme-settings-changed',
} as const

/** Scratch Pad IPC 通道 */
export const SCRATCH_PAD_IPC_CHANNELS = {
  /** 从磁盘加载 scratch-pad.md 内容 */
  LOAD: 'scratch-pad:load',
  /** 保存内容到 scratch-pad.md */
  SAVE: 'scratch-pad:save',
  /** 同步保存（beforeunload 场景） */
  SAVE_SYNC: 'scratch-pad:save-sync',
  /** 导出为 Markdown 到指定目录 */
  EXPORT: 'scratch-pad:export',
  /** 打开保存对话框选择导出路径 */
  CHOOSE_EXPORT_PATH: 'scratch-pad:choose-export-path',
  /** 将图片写入系统剪贴板 */
  COPY_IMAGE: 'scratch-pad:copy-image',
} as const

/** 应用图标 IPC 通道 */
export const APP_ICON_IPC_CHANNELS = {
  /** 设置应用图标（variant ID） */
  SET: 'app-icon:set',
} as const

/** Dock/Launcher 角标 IPC 通道 */
export const DOCK_BADGE_IPC_CHANNELS = {
  /** 设置系统应用角标数量 */
  SET_COUNT: 'dock-badge:set-count',
} as const

/** 快速任务窗口 IPC 通道 */
export const QUICK_TASK_IPC_CHANNELS = {
  /** 提交快速任务（渲染进程 → 主进程） */
  SUBMIT: 'quick-task:submit',
  /** 隐藏快速任务窗口 */
  HIDE: 'quick-task:hide',
  /** 通知渲染进程聚焦输入框 */
  FOCUS: 'quick-task:focus',
  /** 重新注册全局快捷键（设置变更后） */
  REREGISTER_GLOBAL_SHORTCUTS: 'quick-task:reregister-global-shortcuts',
  /** 查询当前已成功注册的全局快捷键 */
  GET_GLOBAL_SHORTCUT_REGISTRATION_STATUS: 'quick-task:get-global-shortcut-registration-status',
} as const

/** 快速任务提交输入 */
export interface QuickTaskSubmitInput {
  /** 任务文本内容 */
  text: string
  /** 目标模式 */
  mode: 'chat' | 'agent'
  /** 附件列表（base64 编码或本地路径引用） */
  files?: QuickTaskFile[]
}

/** 快速任务附件 */
export interface QuickTaskFile {
  filename: string
  mediaType: string
  base64?: string
  sourcePath?: string
  size: number
}

/** 主窗口接收的快速任务打开会话数据 */
export interface QuickTaskOpenSessionData {
  mode: 'chat' | 'agent'
  text: string
  files?: QuickTaskFile[]
}

/** 菜单栏打开 Agent 会话事件 */
export interface TrayOpenAgentSessionData {
  /** Agent 会话 ID */
  sessionId: string
  /** 标签页标题 */
  title: string
}

/** 菜单栏创建会话事件 */
export interface TrayCreateSessionData {
  /** 目标模式 */
  mode: 'chat' | 'agent'
}

/** 菜单栏 IPC 事件通道 */
export const TRAY_IPC_CHANNELS = {
  /** 打开已有 Agent 会话 */
  OPEN_AGENT_SESSION: 'tray:open-agent-session',
  /** 创建新会话 */
  CREATE_SESSION: 'tray:create-session',
} as const

/** Windows Agent Island IPC 通道（主进程 ↔ 渲染进程） */
export const WINDOWS_AGENT_ISLAND_IPC_CHANNELS = {
  /** 渲染进程（悬停窗）→ 主进程：点击跳转到会话 */
  OPEN_SESSION: 'windows-agent-island:open-session',
  /** 主进程 → 渲染进程（悬停窗）：推送全量 snapshot */
  PUSH_SNAPSHOT: 'windows-agent-island:push-snapshot',
  /** 渲染进程（悬停窗）→ 主进程：鼠标进入气泡区域 */
  MOUSE_ENTER: 'windows-agent-island:mouse-enter',
  /** 渲染进程（悬停窗）→ 主进程：鼠标离开气泡区域 */
  MOUSE_LEAVE: 'windows-agent-island:mouse-leave',
} as const

/** 存储管理 IPC 通道 */
export const STORAGE_IPC_CHANNELS = {
  /** 计算各目录存储统计 */
  GET_STATS: 'storage:get-stats',
  /** 按选项清理存储 */
  CLEANUP: 'storage:cleanup',
  /** 仅清理临时文件（启动时/快速清理） */
  CLEANUP_TEMP: 'storage:cleanup-temp',
} as const
