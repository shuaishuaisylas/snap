import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'

interface PreviewGrant {
  sessionId: string
  directory: string
  authorizedRoot: string
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
}

function isInside(target: string, root: string): boolean {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

/** 仅向 loopback 暴露已授权 HTML 旁的静态资源；随机 token 随会话撤销，不传播 file://。 */
export class EgoLitePreviewServer {
  private server: Server | null = null
  private starting: Promise<number> | null = null
  private port = 0
  private readonly grants = new Map<string, PreviewGrant>()

  async register(sessionId: string, inputPath: string, allowedRoots: string[], baseDir?: string): Promise<string> {
    if (!inputPath.trim()) throw new Error('本地预览路径不能为空。')
    const target = await realpath(resolve(baseDir ?? process.cwd(), inputPath))
    const roots = await Promise.all(allowedRoots.map((root) => realpath(root).catch(() => null)))
    const authorizedRoot = roots.find((root): root is string => !!root && isInside(target, root))
    if (!authorizedRoot) throw new Error('本地预览路径不在当前会话已授权的目录内。')
    let filePath = target
    const targetInfo = await stat(target)
    if (targetInfo.isDirectory()) {
      const candidates = await Promise.all(['index.html', 'index.htm'].map(async (name) => {
        const candidate = await realpath(resolve(target, name)).catch(() => null)
        return candidate && (await stat(candidate)).isFile() ? candidate : null
      }))
      const index = candidates.find((candidate): candidate is string => !!candidate)
      if (!index) throw new Error('本地预览目录中没有 index.html 或 index.htm。')
      filePath = index
    }
    if (!isInside(filePath, authorizedRoot) || !['.html', '.htm'].includes(extname(filePath).toLowerCase()) || !(await stat(filePath)).isFile()) {
      throw new Error('只允许预览已授权目录内的 HTML 文件。')
    }
    const port = await this.ensureStarted()
    const token = randomBytes(24).toString('hex')
    this.grants.set(token, { sessionId, directory: dirname(filePath), authorizedRoot })
    return `http://127.0.0.1:${port}/${token}/${encodeURIComponent(basename(filePath))}`
  }

  revokeSession(sessionId: string): void {
    for (const [token, grant] of this.grants) if (grant.sessionId === sessionId) this.grants.delete(token)
  }

  dispose(): void {
    this.grants.clear()
    this.server?.closeAllConnections()
    this.server?.close()
    this.server = null
    this.starting = null
    this.port = 0
  }

  private ensureStarted(): Promise<number> {
    if (this.port) return Promise.resolve(this.port)
    if (this.starting) return this.starting
    this.starting = new Promise<number>((resolvePort, reject) => {
      const server = createServer((request, response) => { void this.serve(request, response) })
      this.server = server
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('无法启动本地预览服务。')); return }
        this.port = address.port
        server.unref()
        resolvePort(address.port)
      })
    }).catch((error: unknown) => { this.starting = null; throw error })
    return this.starting
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    const fail = (status: number) => { response.writeHead(status); response.end() }
    try {
      if (request.headers.host !== `127.0.0.1:${this.port}`) { fail(403); return }
      if (request.method !== 'GET' && request.method !== 'HEAD') { fail(405); return }
      const parts = (request.url ?? '').split('?')[0]?.split('/').slice(1).map((part) => decodeURIComponent(part)) ?? []
      const token = parts.shift() ?? ''
      const grant = this.grants.get(token)
      if (!grant || parts.length === 0 || parts.some((part) => !part || part.startsWith('.') || /[\\/\0]/.test(part))) { fail(404); return }
      const path = await realpath(resolve(grant.directory, ...parts))
      if (!isInside(path, grant.directory) || !isInside(path, grant.authorizedRoot)) { fail(403); return }
      const mime = MIME_TYPES[extname(path).toLowerCase()]
      if (!mime) { fail(403); return }
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > 50 * 1024 * 1024) { fail(403); return }
        response.setHeader('Content-Type', mime)
        response.setHeader('Content-Length', info.size)
        if (request.method === 'HEAD') { response.writeHead(200); response.end(); return }
        const bytes = await handle.readFile()
        response.writeHead(200)
        response.end(bytes)
      } finally { await handle.close() }
    } catch { if (!response.headersSent) fail(404); else response.destroy() }
  }
}
