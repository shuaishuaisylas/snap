import type { AgentTraceEvent } from '@snap/shared'

const SECRET_KEY = /(?:^|[_-])(?:authorization|proxy[_-]authorization|cookies?|set[_-]cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|credentials?|private[_-]?key|signature)$/i
const MAX_TRACE_CHARS = 192 * 1024
const MAX_STRING_CHARS = 64 * 1024
const MAX_SOURCE_STRING_CHARS = MAX_TRACE_CHARS * 2
const MAX_TRACE_NODES = 8000
const HIDDEN = '[凭据已隐藏]'
const TRUNCATED = '\n[内容已截断]'
const OMIT = Symbol('轨迹字段未记录')

/** 文本型工具结果可能包含 JSON 配置、环境变量、HTTP 头或带认证信息的 URL。 */
function redactText(value: string): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, (match) => `${match.split(/\s/, 1)[0]} ${HIDDEN}`)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[API Key 已隐藏]')
    .replace(/\b(https?:\/\/)[^/?#\s@]+@/gi, `$1${HIDDEN}@`)
    .replace(/(^|[\r\n])(\s*(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, `$1$2${HIDDEN}`)
    .replace(/((?:["'])([^"'\r\n]+)(?:["'])\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)/g,
      (match: string, prefix: string, key: string) => SECRET_KEY.test(key) ? `${prefix}"${HIDDEN}"` : match)
    .replace(/(\b([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'&,;}\]]+)/g,
      (match: string, prefix: string, key: string) => SECRET_KEY.test(key) ? `${prefix}${HIDDEN}` : match)
}

/**
 * 不捕获请求 options/headers/auth。载荷预算按 JSON 实际字符和节点计数，包含数字、键和结构；
 * 元数据优先采集，避免大上下文挤掉关联 Pi branch 所需的 artifactFile。
 */
export function sanitizeAgentTraceEvent(event: AgentTraceEvent): AgentTraceEvent {
  const { input: _input, output: _output, schema: _schema, metadata: _metadata, explanation: _explanation, ...envelope } = event
  // name 不是事件身份；允许控制其大小并隐藏意外放入名称的凭据。
  const redactedName = redactText(event.name.slice(0, MAX_STRING_CHARS))
  const name = redactedName.slice(0, 2048)
  const identity = { ...envelope, name }
  // 预留顶层字段名、分隔符和截断标记；事件身份原样保留。
  let remaining = Math.max(0, MAX_TRACE_CHARS - JSON.stringify(identity).length - 256)
  let nodes = 0
  let truncated = event.name.length > MAX_STRING_CHARS || redactedName.length > 2048
  const ancestors = new WeakSet<object>()

  const take = (size: number): boolean => {
    if (size > remaining) { truncated = true; return false }
    remaining -= size
    return true
  }
  const text = (value: string, key: string, trustedMetadata = false): unknown => {
    const source = value.slice(0, MAX_SOURCE_STRING_CHARS)
    if (source.length < value.length) truncated = true
    const redacted = key === 'artifactFile' && trustedMetadata ? source : redactText(source)
    const cap = Math.min(MAX_STRING_CHARS, remaining)
    const fullLength = JSON.stringify(redacted).length
    if (fullLength <= cap) { remaining -= fullLength; return redacted }
    truncated = true
    const markerSize = JSON.stringify(TRUNCATED).length
    if (markerSize > cap) return OMIT
    // 控制转义后的大小；控制字符与引号不能按原字符串长度估算。
    let low = 0
    let high = Math.min(redacted.length, cap)
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (JSON.stringify(redacted.slice(0, mid) + TRUNCATED).length <= cap) low = mid
      else high = mid - 1
    }
    const result = redacted.slice(0, low) + TRUNCATED
    remaining -= JSON.stringify(result).length
    return result
  }
  const visit = (value: unknown, depth: number, key = '', trustedMetadata = false): unknown => {
    nodes += 1
    if (nodes > MAX_TRACE_NODES || depth > 20 || remaining <= 0) { truncated = true; return OMIT }
    if (SECRET_KEY.test(key)) return text(HIDDEN, '')
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return OMIT
    if (typeof value === 'string') return text(value, key, trustedMetadata)
    if (typeof value === 'bigint') return text(String(value), key)
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      const scalar = typeof value === 'number' && !Number.isFinite(value) ? null : value
      return take(JSON.stringify(scalar).length) ? scalar : OMIT
    }
    if (typeof value !== 'object') return OMIT
    if (ancestors.has(value)) return text('[循环引用]', '')
    const record = value as Record<string, unknown>
    if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image') {
      const image = { type: String(record.type),
        mimeType: typeof record.mimeType === 'string' ? redactText(record.mimeType.slice(0, 128)) : undefined,
        note: '图片二进制不进入轨迹' }
      return take(JSON.stringify(image).length) ? image : OMIT
    }
    if (!take(2)) return OMIT
    ancestors.add(value)
    try {
      if (Array.isArray(value)) {
        if (value.length > 200) truncated = true
        const out: unknown[] = []
        for (const item of value.slice(0, 200)) {
          if (out.length && !take(1)) break
          // 对齐 JSON 数组语义，空项不能让其后的正常消息消失。
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
            if (!take(4)) break
            out.push(null)
            continue
          }
          const child = visit(item, depth + 1)
          if (child === OMIT) break
          out.push(child)
        }
        return out
      }
      const keys = Object.keys(record)
      if (keys.length > 200) truncated = true
      // artifactFile 由采集器产生，优先保留其完整关联路径，不受对象字段顺序影响。
      const ordered = key === 'metadata' && keys.includes('artifactFile')
        ? ['artifactFile', ...keys.filter((name) => name !== 'artifactFile')]
        : keys
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      let count = 0
      for (const field of ordered.slice(0, 200)) {
        if (record[field] === undefined || typeof record[field] === 'function' || typeof record[field] === 'symbol') continue
        if (!take(JSON.stringify(field).length + 1 + (count ? 1 : 0))) break
        const child = visit(record[field], depth + 1, field, trustedMetadata && depth === 0 && field === 'artifactFile')
        if (child === OMIT) break
        out[field] = child
        count += 1
      }
      return out
    } finally {
      ancestors.delete(value)
    }
  }

  const explanation = event.explanation && typeof event.explanation.text === 'string'
    && ['rule', 'recorded', 'model'].includes(event.explanation.source)
    && ['pending', 'ready', 'unavailable'].includes(event.explanation.status)
    && Number.isFinite(event.explanation.version)
    ? { text: redactText(event.explanation.text.slice(0, 800)), source: event.explanation.source,
      status: event.explanation.status, version: event.explanation.version } : undefined
  if (explanation) remaining = Math.max(0, remaining - JSON.stringify(explanation).length)
  const metadataValue = visit(event.metadata ?? {}, 0, 'metadata', true)
  const input = visit(event.input, 0)
  const output = visit(event.output, 0)
  const schema = visit(event.schema, 0)
  const metadata = metadataValue !== OMIT && typeof metadataValue === 'object' && metadataValue !== null
    ? metadataValue as Record<string, unknown> : {}
  return { ...identity, ...(explanation ? { explanation } : {}), input: input === OMIT ? undefined : input, output: output === OMIT ? undefined : output,
    schema: schema === OMIT ? undefined : schema, metadata: { ...metadata, ...(truncated ? { truncated: true } : {}) } }
}
