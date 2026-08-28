import { readFileSync } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RuntimeContextLike } from './runtime.js'

interface Asset {
  body: Buffer
  contentType: string
}

const STATIC_ASSETS = new Map<string, Asset>([
  ['app.js', loadAsset('../web/app.js', 'text/javascript; charset=utf-8')],
  ['change-review.js', loadAsset('../web/change-review.js', 'text/javascript; charset=utf-8')],
  ['markdown-preview.js', loadAsset('../web/markdown-preview.js', 'text/javascript; charset=utf-8')],
  ['note-editor.js', loadAsset('../web/note-editor.js', 'text/javascript; charset=utf-8')],
  ['styles.css', loadAsset('../web/styles.css', 'text/css; charset=utf-8')],
])
const ASSET_VERSION = createHash('sha256')
  .update([...STATIC_ASSETS.values()].map(asset => asset.body).join(''))
  .digest('hex')
  .slice(0, 12)
const INDEX_TEMPLATE = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')

export function registerKnowledgeWeb(
  ctx: RuntimeContextLike,
  webPath: string,
  apiPrefix: string,
  authMode: 'bearer' | 'same-origin' = 'bearer',
  embedToken?: string,
): () => void {
  const webServer = ctx.webServer ?? ctx.get('webServer') as RuntimeContextLike['webServer']
  if (webServer === undefined) throw new Error('exposeWeb requires the DSH webServer service')
  const index = Buffer.from(INDEX_TEMPLATE
    .replaceAll('__DSH_KNOWLEDGE_API_PREFIX__', escapeHtmlAttribute(apiPrefix))
    .replaceAll('__DSH_KNOWLEDGE_AUTH_MODE__', escapeHtmlAttribute(authMode))
    .replaceAll('__DSH_KNOWLEDGE_WEB_PATH__', escapeHtmlAttribute(webPath))
    .replaceAll('__DSH_KNOWLEDGE_ASSET_VERSION__', ASSET_VERSION))
  return webServer.register({
    kind: 'prefix',
    path: webPath,
    handler: (req, res) => serveWeb(req, res, webPath, index, embedToken),
  })
}

function serveWeb(
  req: IncomingMessage,
  res: ServerResponse,
  webPath: string,
  index: Buffer,
  embedToken?: string,
): void {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', ...securityHeaders() })
    res.end()
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://knowledge.local').pathname
  const relative = pathname.slice(webPath.length).replace(/^\/+|\/+$/g, '')
  if (relative.length === 0) {
    const embedded = embedToken !== undefined && hasValidEmbedToken(req.url, embedToken)
    sendAsset(res, method, { body: index, contentType: 'text/html; charset=utf-8' }, embedded)
    return
  }
  const asset = STATIC_ASSETS.get(relative)
  if (asset === undefined) {
    res.writeHead(404, securityHeaders())
    res.end()
    return
  }
  sendAsset(res, method, asset)
}

function sendAsset(res: ServerResponse, method: string, asset: Asset, embedded = false): void {
  res.writeHead(200, {
    ...securityHeaders(embedded),
    'content-type': asset.contentType,
    'content-length': asset.body.byteLength,
    'cache-control': asset.contentType.startsWith('text/html') ? 'no-store' : 'public, max-age=31536000, immutable',
  })
  res.end(method === 'HEAD' ? undefined : asset.body)
}

function securityHeaders(embedded = false): Record<string, string> {
  const policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'"
  return {
    'content-security-policy': embedded ? policy : `${policy}; frame-ancestors 'self'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...embedded ? {} : { 'x-frame-options': 'SAMEORIGIN' },
    'cross-origin-opener-policy': 'same-origin',
  }
}

function hasValidEmbedToken(rawUrl: string | undefined, expected: string): boolean {
  const supplied = new URL(rawUrl ?? '/', 'http://knowledge.local').searchParams.get('embed')
  if (supplied === null) return false
  const suppliedBytes = Buffer.from(supplied)
  const expectedBytes = Buffer.from(expected)
  return suppliedBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(suppliedBytes, expectedBytes)
}

function loadAsset(path: string, contentType: string): Asset {
  return { body: readFileSync(new URL(path, import.meta.url)), contentType }
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
