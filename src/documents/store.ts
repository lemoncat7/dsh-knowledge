import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import type { KnowledgeBase } from '../domain.js'
import { atomicWriteFile, isWindowsReplaceError, supportsDirectorySync } from '../atomic-file.js'
import {
  markdownHash,
  parseKnowledgeMarkdown,
  renderKnowledgeBaseManifest,
  type ParsedMarkdownDocument,
} from './markdown.js'

export const KNOWLEDGE_BASE_MANIFEST = '.knowledge-base.yml'

export interface StoredKnowledgeDocument extends ParsedMarkdownDocument {
  relPath: string
  size: number
  modifiedAt: string
}

/** File-system boundary for managed knowledge directories. */
export class KnowledgeDocumentStore {
  readonly root: string
  private initialization: Promise<void> | undefined

  constructor(root: string) {
    this.root = resolve(root)
  }

  async initialize(): Promise<void> {
    if (this.initialization === undefined) {
      this.initialization = this.initializeRoot().catch(error => {
        this.initialization = undefined
        throw error
      })
    }
    await this.initialization
  }

  private async initializeRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await removeStaleTemporaryFiles(this.root, Date.now() - 60 * 60 * 1000)
  }

  baseDirectory(base: Pick<KnowledgeBase, 'id' | 'name'>): string {
    return join(this.root, `base-${shortId(base.id)}`)
  }

  async createBase(base: KnowledgeBase): Promise<string> {
    await this.initialize()
    const directory = this.baseDirectory(base)
    await mkdir(directory, { recursive: false })
    await this.writeManifest(directory, base)
    return directory
  }

  async ensureBase(base: KnowledgeBase): Promise<string> {
    await this.initialize()
    const directory = this.baseDirectory(base)
    await mkdir(directory, { recursive: true })
    await this.writeManifest(directory, base)
    return directory
  }

  async updateBase(directory: string, base: KnowledgeBase): Promise<void> {
    await this.assertManagedDirectory(directory)
    await this.writeManifest(directory, base)
  }

  async deleteBase(directory: string): Promise<void> {
    let managed: string
    try { managed = await this.assertManagedDirectory(directory) } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    await rm(managed, { recursive: true, force: false })
  }

  async listDocuments(directory: string): Promise<StoredKnowledgeDocument[]> {
    const root = await this.assertManagedDirectory(directory)
    const paths = await collectMarkdownFiles(root)
    const documents: StoredKnowledgeDocument[] = []
    for (const absolutePath of paths) {
      const relPath = normalizeRelativePath(relative(root, absolutePath))
      if (relPath === 'README.md') continue
      const [markdown, fileStat] = await Promise.all([readFile(absolutePath, 'utf8'), stat(absolutePath)])
      documents.push({
        ...parseKnowledgeMarkdown(markdown),
        relPath,
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
      })
    }
    return documents.sort((left, right) => left.relPath.localeCompare(right.relPath, 'zh-CN'))
  }

  async readDocument(directory: string, relPath: string): Promise<StoredKnowledgeDocument> {
    const root = await this.assertManagedDirectory(directory)
    const absolutePath = await this.resolveDocumentPath(root, relPath, true)
    const [markdown, fileStat] = await Promise.all([readFile(absolutePath, 'utf8'), stat(absolutePath)])
    return {
      ...parseKnowledgeMarkdown(markdown),
      relPath: normalizeRelativePath(relative(root, absolutePath)),
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
    }
  }

  async createDocument(directory: string, title: string, markdown: string): Promise<StoredKnowledgeDocument> {
    const root = await this.assertManagedDirectory(directory)
    const parsed = parseKnowledgeMarkdown(markdown)
    const relPath = await this.availableDocumentPath(root, title, parsed.metadata.id)
    const absolutePath = await this.resolveDocumentPath(root, relPath, false)
    await atomicWrite(absolutePath, parsed.markdown, false)
    return this.readDocument(root, relPath)
  }

  async writeDocument(directory: string, relPath: string, markdown: string): Promise<StoredKnowledgeDocument> {
    const root = await this.assertManagedDirectory(directory)
    const parsed = parseKnowledgeMarkdown(markdown)
    const absolutePath = await this.resolveDocumentPath(root, relPath, false)
    let replace = true
    try { await stat(absolutePath) } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
      replace = false
    }
    await atomicWrite(absolutePath, parsed.markdown, replace)
    return this.readDocument(root, relPath)
  }

  async updateDocument(
    directory: string,
    relPath: string,
    markdown: string,
    expectedContentHash?: string,
  ): Promise<StoredKnowledgeDocument> {
    const root = await this.assertManagedDirectory(directory)
    const absolutePath = await this.resolveDocumentPath(root, relPath, true)
    const current = await readFile(absolutePath, 'utf8')
    if (expectedContentHash !== undefined && markdownHash(current) !== expectedContentHash) {
      throw conflict('knowledge document changed on disk; reload it before saving')
    }
    const next = parseKnowledgeMarkdown(markdown)
    await atomicWrite(absolutePath, next.markdown, true)
    return this.readDocument(root, relPath)
  }

  async deleteDocument(directory: string, relPath: string, expectedContentHash?: string): Promise<void> {
    const root = await this.assertManagedDirectory(directory)
    const absolutePath = await this.resolveDocumentPath(root, relPath, true)
    if (expectedContentHash !== undefined) {
      const current = await readFile(absolutePath, 'utf8')
      if (markdownHash(current) !== expectedContentHash) throw conflict('knowledge document changed on disk; reload it before deleting')
    }
    await unlink(absolutePath)
  }

  private async writeManifest(directory: string, base: KnowledgeBase): Promise<void> {
    await atomicWrite(join(directory, KNOWLEDGE_BASE_MANIFEST), renderKnowledgeBaseManifest(base), true)
  }

  private async assertManagedDirectory(directory: string): Promise<string> {
    const candidate = resolve(directory)
    assertWithinRoot(this.root, candidate)
    const resolvedRoot = await realpath(this.root)
    const resolvedDirectory = await realpath(candidate)
    assertWithinRoot(resolvedRoot, resolvedDirectory)
    return resolvedDirectory
  }

  private async resolveDocumentPath(root: string, relPath: string, mustExist: boolean): Promise<string> {
    const clean = normalizeRelativePath(relPath)
    if (clean.startsWith('.') || extname(clean).toLowerCase() !== '.md') throw new Error('knowledge document path must be a visible .md file')
    const candidate = resolve(root, clean)
    assertWithinRoot(root, candidate)
    if (!mustExist) return candidate
    const resolved = await realpath(candidate)
    assertWithinRoot(root, resolved)
    return resolved
  }

  private async availableDocumentPath(root: string, title: string, id: string): Promise<string> {
    const stem = slugify(title)
    const candidates = [`${stem}.md`, `${stem}--${shortId(id)}.md`]
    for (const relPath of candidates) {
      try {
        await stat(join(root, relPath))
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return relPath
        throw error
      }
    }
    return `${stem}--${shortId(id)}-${Date.now().toString(36)}.md`
  }
}

async function atomicWrite(target: string, content: string, replace: boolean): Promise<void> {
  try {
    await atomicWriteFile(target, content, { replace })
  } catch (error) {
    if (!replace && isConflict(error)) {
      throw conflict(`knowledge document ${basename(target)} already exists`)
    }
    throw error
  }
}

export { isWindowsReplaceError, supportsDirectorySync }

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const output: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) output.push(...await collectMarkdownFiles(path))
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') output.push(path)
  }
  return output
}

async function removeStaleTemporaryFiles(root: string, olderThan: number): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await removeStaleTemporaryFiles(path, olderThan)
      continue
    }
    if (!entry.isFile() || !/^\..+\.[0-9a-f-]{36}\.tmp$/iu.test(entry.name)) continue
    const metadata = await stat(path)
    if (metadata.mtimeMs < olderThan) {
      await unlink(path).catch(error => {
        if (!isNodeError(error, 'ENOENT')) throw error
      })
    }
  }
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '')
  if (normalized.length === 0 || normalized.startsWith('/') || normalized.includes('\0')) throw new Error('knowledge document path is invalid')
  const segments = normalized.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) throw new Error('knowledge document path escapes its knowledge base')
  return segments.join('/')
}

function assertWithinRoot(root: string, candidate: string): void {
  const difference = relative(root, candidate)
  if (difference === '..' || difference.startsWith(`..${sep}`) || resolve(root, difference) !== candidate) {
    throw new Error('knowledge path escapes its managed root')
  }
}

function slugify(value: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, '-').replace(/\s+/gu, '-')
    .replace(/^-+|-+$/gu, '').slice(0, 72)
  return normalized || 'knowledge'
}

function shortId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/gu, '').slice(0, 8) || 'base'
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { code: 'CONFLICT' })
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

function isConflict(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: string }).code === 'CONFLICT'
}
