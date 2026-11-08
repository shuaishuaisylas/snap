import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ExternalLink, Globe, LoaderCircle, Play, RefreshCw, Unplug } from 'lucide-react'
import type { BrowserViewState } from '@snap/shared'
import { Button } from '@/components/ui/button'
import { browserStateMapAtom } from '@/atoms/browser-atoms'

/** 网页由真实 Ego Lite 窗口显示；这里呈现任务、标签与控制权，避免伪装成内嵌网页。 */
export function BrowserSlot({ sessionId, tabId }: { sessionId: string; tabId: string }): React.ReactElement {
  const state = useAtomValue(browserStateMapAtom).get(sessionId)
  const setStates = useSetAtom(browserStateMapAtom)
  const tab = state?.tabs.find((candidate) => candidate.tabId === tabId)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const run = async (operation: () => Promise<BrowserViewState | void>) => {
    setBusy(true)
    setError(null)
    try {
      const next = await operation()
      if (next) setStates((previous) => new Map(previous).set(sessionId, next))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }

  const userInControl = state?.controlState === 'user'
  const canDetach = userInControl || state?.controlState === 'unknown'
  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-auto bg-muted/10 px-6 py-8 titlebar-no-drag" aria-label="Ego Lite 浏览器任务状态">
      <div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-border bg-background text-foreground">
          <Globe className="size-6" />
        </div>
        <h3 className="text-base font-semibold">Ego Lite</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">网页在 Ego Lite 独立窗口中运行。这里同步当前任务与页面状态。</p>
        <div className="mt-5 w-full rounded-xl border border-border/70 bg-background/70 p-4 text-left text-xs leading-6">
          <p className="truncate text-sm font-medium text-foreground" title={tab?.title}>{tab?.title || '等待页面状态'}</p>
          <p className="mt-1 break-all text-muted-foreground">{tab?.url || '空白页面'}</p>
          <p className="mt-3 text-muted-foreground">任务空间 {state?.spaceId ?? '—'} · {state?.tabs.length ?? 0} 个标签</p>
          <p className="text-foreground">{userInControl ? '你正在控制浏览器' : state?.controlState === 'unknown' ? '连接状态待确认' : 'Agent 可以继续操作'}</p>
          {state?.lastSyncedAt && <p className="text-muted-foreground">上次同步 {new Date(state.lastSyncedAt).toLocaleTimeString()}</p>}
        </div>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button disabled={busy} onClick={() => void run(() => window.electronAPI.showAgentBrowserInEgo(sessionId, tabId))}>
            {busy ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : <ExternalLink className="mr-2 size-4" />}在 Ego 中查看
          </Button>
          {userInControl ? (
            <Button variant="outline" disabled={busy} onClick={() => void run(() => window.electronAPI.resumeAgentBrowser(sessionId))}>
              <Play className="mr-2 size-4" />允许 Agent 继续
            </Button>
          ) : (
            <Button variant="outline" disabled={busy} onClick={() => void run(() => window.electronAPI.listAgentBrowserTabs(sessionId))}>
              <RefreshCw className="mr-2 size-4" />同步状态
            </Button>
          )}
          {canDetach && (
            <Button variant="outline" disabled={busy} onClick={() => void run(() => window.electronAPI.closeAgentBrowser(sessionId))}>
              <Unplug className="mr-2 size-4" />断开任务
            </Button>
          )}
        </div>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">在 Ego 中查看时会把控制权交给你。完成登录或检查后，点击“允许 Agent 继续”。</p>
        {canDetach && <p className="mt-2 text-xs leading-5 text-muted-foreground">断开任务只移除 Snap 的关联，Ego 中的页面会保留。</p>}
        {(error || state?.lastError) && <p role="alert" className="mt-4 w-full rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-left text-xs leading-5 text-destructive">{error || state?.lastError}</p>}
        {state?.activity && <p className="mt-5 w-full border-t border-border/50 pt-3 text-left text-xs leading-5 text-muted-foreground">最近操作：{state.activity.summary}</p>}
      </div>
    </div>
  )
}
