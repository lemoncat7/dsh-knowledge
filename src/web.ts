import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RuntimeContextLike } from './runtime.js'

interface Asset {
  body: Buffer
  contentType: string
}

const STATIC_ASSETS = new Map<string, Asset>([
  ['app.js', loadAsset('../web/app.js', 'text/javascript; charset=utf-8')],
  ['styles.css', loadAsset('../web/styles.css', 'text/css; charset=utf-8')],
])
const INDEX_TEMPLATE = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')

export function registerKnowledgeWeb(
  ctx: RuntimeContextLike,
  webPath: string,
  apiPrefix: string,
): () => void {
  const webServer = ctx.webServer ?? ctx.get('webServer') as RuntimeContextLike['webServer']
  if (webServer === undefined) throw new Error('exposeWeb requires the DSH webServer service')
  const index = Buffer.from(INDEX_TEMPLATE
    .replaceAll('__DSH_KNOWLEDGE_API_PREFIX__', escapeHtmlAttribute(apiPrefix))
    .replaceAll('__DSH_KNOWLEDGE_WEB_PATH__', escapeHtmlAttribute(webPath)))
  return webServer.register({
    kind: 'prefix',
    path: webPath,
    handler: (req, res) => serveWeb(req, res, webPath, index),
  })
}

function serveWeb(req: IncomingMessage, res: ServerResponse, webPath: string, index: Buffer): void {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', ...securityHeaders() })
    res.end()
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://knowledge.local').pathname
  const relative = pathname.slice(webPath.length).replace(/^\/+|\/+$/g, '')
  if (relative.length === 0) {
    sendAsset(res, method, { body: index, contentType: 'text/html; charset=utf-8' })
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

function sendAsset(res: ServerResponse, method: string, asset: Asset): void {
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': asset.contentType,
    'content-length': asset.body.byteLength,
    'cache-control': asset.contentType.startsWith('text/html') ? 'no-store' : 'public, max-age=3600',
  })
  res.end(method === 'HEAD' ? undefined : asset.body)
}

function securityHeaders(): Record<string, string> {
  return {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
  }
}

function loadAsset(path: string, contentType: string): Asset {
  return { body: readFileSync(new URL(path, import.meta.url)), contentType }
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
