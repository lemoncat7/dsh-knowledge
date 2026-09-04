import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as requestHttp } from 'node:http'
import { request as requestHttps } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import type { NoteNode, NoteNodeKind, NoteShare } from './domain.js'
import type { NoteStore } from './store.js'

const SHARE_TOKEN_PATTERN = /^share_[A-Za-z0-9_-]{32}$/
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024
const MAX_IMPORT_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_IMPORT_NODES = 500
const REQUEST_TIMEOUT_MS = 20_000

export interface NoteShareManifestNode {
  id: string
  path: string
  kind: NoteNodeKind
  mediaType: string | null
  size: number
  sha256: string | null
}

export interface NoteShareManifest {
  version: 1
  share: {
    name: string
    kind: NoteNodeKind
    updatedAt: string
    nodeCount: number
    fileCount: number
    totalSize: number
  }
  nodes: NoteShareManifestNode[]
  truncated: boolean
}

export interface NoteShareImportResult {
  root: NoteNode
  importedNodes: number
  importedFiles: number
  totalBytes: number
}

export interface NoteShareRequestPolicy {
  trustedPrivateOrigins?: readonly string[]
}

export function createNoteShareManifest(share: NoteShare, nodes: NoteNode[], truncated: boolean): NoteShareManifest {
  const paths = relativePaths(share.node, nodes)
  const manifestNodes = nodes.map(node => ({
    id: node.id,
    path: paths.get(node.id) ?? node.name,
    kind: node.kind,
    mediaType: node.mediaType,
    size: node.size,
    sha256: node.sha256,
  }))
  const files = manifestNodes.filter(node => node.kind !== 'folder')
  return {
    version: 1,
    share: {
      name: share.node.name,
      kind: share.node.kind,
      updatedAt: share.node.updatedAt,
      nodeCount: manifestNodes.length,
      fileCount: files.length,
      totalSize: files.reduce((total, node) => total + node.size, 0),
    },
    nodes: manifestNodes,
    truncated,
  }
}

export async function inspectNoteShareUrl(rawUrl: string, store?: NoteStore, policy: NoteShareRequestPolicy = {}): Promise<{ url: string; manifest: NoteShareManifest }> {
  const url = canonicalShareUrl(rawUrl)
  const localShare = store?.getShareByToken(shareToken(url))
  if (localShare !== undefined) {
    const localNodes = localShare.node.kind === 'folder' ? store!.listSharedSubtree(localShare.noteId, 501) : [localShare.node]
    const truncated = localNodes.length > 500
    return { url: url.href, manifest: createNoteShareManifest(localShare, localNodes.slice(0, 500), truncated) }
  }
  const payload = await requestPublicUrl(new URL(`${url.href}/manifest`), MAX_MANIFEST_BYTES, policy)
  return { url: url.href, manifest: validateManifest(JSON.parse(payload.toString('utf8')) as unknown) }
}

export async function importNoteShare(
  store: NoteStore,
  rawUrl: string,
  parentId: string | null,
  policy: NoteShareRequestPolicy = {},
): Promise<NoteShareImportResult> {
  const canonical = canonicalShareUrl(rawUrl)
  const localShare = store.getShareByToken(shareToken(canonical))
  if (localShare !== undefined) {
    const nodes = localShare.node.kind === 'folder' ? store.listSharedSubtree(localShare.noteId, MAX_IMPORT_NODES + 1) : [localShare.node]
    if (nodes.length > MAX_IMPORT_NODES) throw inputError('分享目录超过 500 项，暂时不能导入')
    const root = await store.copy(localShare.noteId, parentId)
    const files = nodes.filter(node => node.kind !== 'folder')
    return {
      root,
      importedNodes: nodes.length,
      importedFiles: files.length,
      totalBytes: files.reduce((total, node) => total + node.size, 0),
    }
  }
  const { url, manifest } = await inspectNoteShareUrl(canonical.href, undefined, policy)
  if (manifest.truncated) throw inputError('分享目录超过 500 项，暂时不能导入')
  if (manifest.nodes.length === 0) throw inputError('分享中没有可导入的内容')
  const rootManifest = manifest.nodes.find(node => node.path === manifest.share.name)
  if (rootManifest === undefined || rootManifest.kind !== manifest.share.kind) throw inputError('分享清单缺少有效的根项目')

  const createdByPath = new Map<string, NoteNode>()
  let root: NoteNode | undefined
  let importedFiles = 0
  let totalBytes = 0
  try {
    const ordered = [...manifest.nodes].sort((left, right) => {
      const depth = pathDepth(left.path) - pathDepth(right.path)
      if (depth !== 0) return depth
      if (left.kind === 'folder' && right.kind !== 'folder') return -1
      if (left.kind !== 'folder' && right.kind === 'folder') return 1
      return left.path.localeCompare(right.path, 'zh-CN')
    })
    for (const item of ordered) {
      const name = pathName(item.path)
      const parentPath = pathParent(item.path)
      const destinationParentId = parentPath === null ? parentId : createdByPath.get(parentPath)?.id
      if (parentPath !== null && destinationParentId === undefined) throw inputError(`分享清单中的父目录不存在：${parentPath}`)
      let created: NoteNode
      if (item.kind === 'folder') {
        created = await store.createFolder(name, destinationParentId ?? null)
      } else {
        const content = await requestPublicUrl(contentUrl(url, item.id), MAX_IMPORT_FILE_BYTES, policy)
        if (content.byteLength !== item.size) throw inputError(`分享文件大小校验失败：${item.path}`)
        if (item.sha256 !== null && createHash('sha256').update(content).digest('hex') !== item.sha256) {
          throw inputError(`分享文件完整性校验失败：${item.path}`)
        }
        totalBytes += content.byteLength
        if (totalBytes > MAX_IMPORT_TOTAL_BYTES) throw inputError('分享内容超过 256 MiB 导入上限')
        created = item.kind === 'document'
          ? await store.createDocument(name, destinationParentId ?? null, content.toString('utf8'))
          : await store.upload({ name, parentId: destinationParentId ?? null, mediaType: item.mediaType ?? 'application/octet-stream', content })
        importedFiles += 1
      }
      createdByPath.set(item.path, created)
      if (item === rootManifest) root = created
    }
  } catch (error) {
    if (root !== undefined) await store.delete(root.id).catch(() => {})
    throw error
  }
  if (root === undefined) throw inputError('分享内容导入失败')
  return { root, importedNodes: createdByPath.size, importedFiles, totalBytes }
}

function canonicalShareUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw inputError('请输入完整的 HTTP 或 HTTPS 分享链接') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw inputError('分享链接只支持 HTTP 或 HTTPS')
  if (url.username || url.password) throw inputError('分享链接不能包含用户名或密码')
  const match = url.pathname.match(/^(.*\/shared\/(share_[A-Za-z0-9_-]{32}))(?:\/)?$/)
  if (match?.[1] === undefined || !SHARE_TOKEN_PATTERN.test(match[2] ?? '')) throw inputError('这不是有效的 DSH 笔记分享链接')
  url.pathname = match[1]
  url.search = ''
  url.hash = ''
  return url
}

function contentUrl(base: string, noteId: string): URL {
  const url = new URL(`${base}/content`)
  url.searchParams.set('noteId', noteId)
  return url
}

function shareToken(url: URL): string { return url.pathname.slice(url.pathname.lastIndexOf('/') + 1) }

async function requestPublicUrl(url: URL, maximumBytes: number, policy: NoteShareRequestPolicy, redirects = 0): Promise<Buffer> {
  if (redirects > 3) throw upstreamError('分享服务重定向次数过多')
  const target = await resolveShareTarget(url, policy)
  const request = url.protocol === 'https:' ? requestHttps : requestHttp
  return await new Promise<Buffer>((resolve, reject) => {
    const req = request(url, {
      headers: { accept: 'application/json, application/octet-stream;q=0.9', 'user-agent': 'dsh-knowledge-share-import/1' },
      lookup: createPinnedLookup(target),
    }, response => {
      const status = response.statusCode ?? 502
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume()
        const location = response.headers.location
        if (!location) return reject(upstreamError('分享服务返回了无效重定向'))
        let redirected: URL
        try { redirected = new URL(location, url) } catch { return reject(upstreamError('分享服务返回了无效重定向')) }
        requestPublicUrl(redirected, maximumBytes, policy, redirects + 1).then(resolve, reject)
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        reject(upstreamError(status === 404 ? '分享不存在或已经停止' : `分享服务返回 HTTP ${status}`))
        return
      }
      const declared = Number(response.headers['content-length'] ?? 0)
      if (Number.isFinite(declared) && declared > maximumBytes) {
        response.destroy()
        reject(inputError('分享内容超过导入限制'))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.byteLength
        if (size > maximumBytes) {
          response.destroy(inputError('分享内容超过导入限制'))
          return
        }
        chunks.push(buffer)
      })
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(upstreamError('读取分享超时，请稍后重试')))
    req.on('error', reject)
    req.end()
  })
}

/** Keep the request on the address that passed SSRF validation, including Node 24's multi-address lookup mode. */
export function createPinnedLookup(target: { address: string; family: 4 | 6 }): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [target])
    else callback(null, target.address, target.family)
  }
}

export async function resolveShareTarget(
  url: URL,
  policy: NoteShareRequestPolicy = {},
  lookupHost: typeof lookup = lookup,
): Promise<{ address: string; family: 4 | 6 }> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw inputError('分享链接只支持 HTTP 或 HTTPS')
  const hostname = url.hostname.toLocaleLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw inputError('分享链接不能指向本机或私有网络')
  const literalFamily = isIP(hostname)
  if (literalFamily !== 0) {
    if (!isPublicAddress(hostname)) throw inputError('分享链接不能指向本机或私有网络')
    return { address: hostname, family: literalFamily as 4 | 6 }
  }
  let addresses: { address: string; family: number }[]
  try { addresses = await lookupHost(hostname, { all: true, verbatim: true }) } catch { throw upstreamError('无法解析分享链接的主机名') }
  const publicAddress = addresses.find(item => isPublicAddress(item.address))
  if (publicAddress !== undefined && addresses.every(item => isPublicAddress(item.address))) {
    return { address: publicAddress.address, family: publicAddress.family === 6 ? 6 : 4 }
  }
  const trustedPrivateOrigin = policy.trustedPrivateOrigins?.includes(url.origin) === true && isShareResourcePath(url.pathname)
  if (!trustedPrivateOrigin) {
    throw inputError('分享链接不能解析到本机或私有网络')
  }
  const pinned = addresses.find(item => isIP(item.address) !== 0)
  if (pinned === undefined) throw upstreamError('无法解析分享链接的主机名')
  return { address: pinned.address, family: pinned.family === 6 ? 6 : 4 }
}

function isShareResourcePath(pathname: string): boolean {
  return /\/shared\/share_[A-Za-z0-9_-]{32}(?:\/(?:manifest|content))?\/?$/u.test(pathname)
}

function isPublicAddress(address: string): boolean {
  if (address.includes(':')) {
    const normalized = address.toLocaleLowerCase()
    if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return false
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
    return mapped === undefined || isPublicAddress(mapped)
  }
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false
  const [a = 0, b = 0, c = 0] = octets
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113))
}

function validateManifest(value: unknown): NoteShareManifest {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.share) || !Array.isArray(value.nodes)) throw inputError('分享服务返回的清单格式无效')
  const share = value.share
  if (typeof share.name !== 'string' || share.name.length === 0 || share.name.length > 255) throw inputError('分享名称无效')
  if (!isNoteKind(share.kind) || typeof share.updatedAt !== 'string') throw inputError('分享信息无效')
  if (value.nodes.length > MAX_IMPORT_NODES) throw inputError('分享目录超过 500 项，暂时不能导入')
  const paths = new Set<string>()
  let totalSize = 0
  const nodes = value.nodes.map((item, index): NoteShareManifestNode => {
    if (!isRecord(item) || typeof item.id !== 'string' || !/^note_[a-f0-9]{32}$/.test(item.id)) throw inputError(`分享清单第 ${index + 1} 项编号无效`)
    if (typeof item.path !== 'string' || !validRelativePath(item.path)) throw inputError(`分享清单第 ${index + 1} 项路径无效`)
    if (paths.has(item.path)) throw inputError(`分享清单存在重复路径：${item.path}`)
    paths.add(item.path)
    if (!isNoteKind(item.kind) || (item.mediaType !== null && typeof item.mediaType !== 'string')) throw inputError(`分享清单第 ${index + 1} 项类型无效`)
    const size = item.size
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_IMPORT_FILE_BYTES) throw inputError(`分享清单第 ${index + 1} 项大小无效`)
    if (item.sha256 !== null && (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))) throw inputError(`分享清单第 ${index + 1} 项摘要无效`)
    if (item.kind !== 'folder') totalSize += size
    return { id: item.id, path: item.path, kind: item.kind, mediaType: item.mediaType, size, sha256: item.sha256 }
  })
  if (totalSize > MAX_IMPORT_TOTAL_BYTES) throw inputError('分享内容超过 256 MiB 导入上限')
  if (share.nodeCount !== nodes.length || share.fileCount !== nodes.filter(node => node.kind !== 'folder').length || share.totalSize !== totalSize) throw inputError('分享清单统计信息不一致')
  return { version: 1, share: { name: share.name, kind: share.kind, updatedAt: share.updatedAt, nodeCount: share.nodeCount, fileCount: share.fileCount, totalSize: share.totalSize }, nodes, truncated: value.truncated === true }
}

function relativePaths(root: NoteNode, nodes: NoteNode[]): Map<string, string> {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const paths = new Map<string, string>([[root.id, root.name]])
  const resolve = (node: NoteNode, seen = new Set<string>()): string => {
    const cached = paths.get(node.id)
    if (cached !== undefined) return cached
    if (seen.has(node.id) || node.parentId === null) return node.name
    seen.add(node.id)
    const parent = byId.get(node.parentId)
    const value = parent === undefined ? node.name : `${resolve(parent, seen)}/${node.name}`
    paths.set(node.id, value)
    return value
  }
  for (const node of nodes) resolve(node)
  return paths
}

function validRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 4096 || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false
  const parts = value.split('/')
  return parts.every(part => part.length > 0 && part.length <= 255 && part !== '.' && part !== '..')
}

function pathDepth(value: string): number { return value.split('/').length }
function pathName(value: string): string { return value.slice(value.lastIndexOf('/') + 1) }
function pathParent(value: string): string | null {
  const index = value.lastIndexOf('/')
  return index < 0 ? null : value.slice(0, index)
}
function isNoteKind(value: unknown): value is NoteNodeKind { return value === 'folder' || value === 'document' || value === 'file' }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function inputError(message: string): Error { return Object.assign(new Error(message), { status: 400, code: 'BAD_REQUEST' }) }
function upstreamError(message: string): Error { return Object.assign(new Error(message), { status: 502, code: 'UPSTREAM_ERROR' }) }
