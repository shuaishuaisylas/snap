import * as React from 'react'
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { copyTextToClipboard } from '@/lib/clipboard'
import { traceValueEntries, traceValueText } from './trace-view'

interface TraceValueProps {
  value: unknown
  label: string
}

function ValueNode({ value, depth = 0 }: { value: unknown; depth?: number }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(depth === 0)
  const [limit, setLimit] = React.useState(60)
  const [textLimit, setTextLimit] = React.useState(4000)
  if (value === undefined) return <p className="text-muted-foreground">此记录未包含该字段。</p>
  if (value === null || typeof value !== 'object') {
    const text = typeof value === 'string' ? value : traceValueText(value)
    return <div className="min-w-0">
      <pre className="m-0 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">{text.slice(0, textLimit)}</pre>
      {text.length > textLimit && <Button type="button" size="sm" variant="ghost" className="mt-1 h-7 text-xs" onClick={() => setTextLimit((previous) => previous + 12000)}>
        再显示一段（还有 {(text.length - textLimit).toLocaleString()} 字符）
      </Button>}
    </div>
  }
  const count = Object.keys(value).length
  if (depth >= 24) return <p className="text-muted-foreground">层级较深，可复制完整内容查看。</p>
  return <div className="min-w-0">
    <button type="button" className="inline-flex min-h-7 items-center gap-1 rounded px-1 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={expanded} onClick={() => setExpanded((previous) => !previous)}>
      {expanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
      {Array.isArray(value) ? `数组 · ${count} 项` : `对象 · ${count} 个字段`}
    </button>
    {expanded && <div className="ml-2 space-y-1 border-l border-border/60 pl-2">
      {traceValueEntries(value, limit).map(([key, child]) => <div key={key} className="min-w-0">
        <div className="break-all font-mono text-[11px] font-medium text-foreground/80">{key}</div>
        <ValueNode value={child} depth={depth + 1} />
      </div>)}
      {count > limit && <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setLimit((previous) => previous + 100)}>再展开 {Math.min(100, count - limit)} 项</Button>}
      {count === 0 && <span className="text-[11px] text-muted-foreground">{Array.isArray(value) ? '[]' : '{}'}</span>}
    </div>}
  </div>
}

/** 子树仅在用户展开时挂载；复制的是原值，不是当前可见片段。 */
export function TraceValue({ value, label }: TraceValueProps): React.ReactElement {
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle')
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  React.useEffect(() => { setCopyState('idle') }, [value])
  const copy = async (): Promise<void> => {
    try {
      await copyTextToClipboard(traceValueText(value))
      if (mounted.current) setCopyState('copied')
    } catch {
      if (mounted.current) setCopyState('failed')
    }
  }
  return <section className="min-w-0 rounded-md border border-border/60 bg-muted/15 p-2.5" aria-label={label}>
    <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
      <span className="text-xs font-medium">{label}</span>
      <Button type="button" size="sm" variant="ghost" className="h-6 shrink-0 px-1.5 text-[11px]" disabled={value === undefined} onClick={() => void copy()}>
        {copyState === 'copied' ? <Check className="!size-3" /> : <Copy className="!size-3" />}
        {copyState === 'copied' ? '已复制全文' : copyState === 'failed' ? '重试复制' : '复制全文'}
      </Button>
    </div>
    {copyState === 'failed' && <p role="status" className="mb-2 text-[11px] text-destructive">复制失败，请重试。</p>}
    <ValueNode value={value} />
  </section>
}
