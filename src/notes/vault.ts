import {installVaultFile} from './vault-file.js'
import { constants } from 'node:fs'
import { mkdir, lstat, open, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep, extname } from 'node:path'
import { atomicWriteFile } from '../atomic-file.js'
import { hash, syncError } from './sync-protocol.js'
import type { NoteNode } from './domain.js'

export interface VaultNotes {
  all(): NoteNode[] | Promise<NoteNode[]>
  read(id: string): Promise<{ node: NoteNode; content: Uint8Array }> | { node: NoteNode; content: Uint8Array }
  update(id: string, bytes: Uint8Array, version: number): Promise<NoteNode>
  create(kind: 'folder' | 'document', name: string, parentId: string | null, content: Uint8Array): Promise<NoteNode>
}
interface Mapping {
  id: string
  path: string
  hash: string | null
  version: number
  kind: NoteNode['kind']
  missing?: boolean
  conflict?: boolean
}
/** Plain files are an interoperable projection. The journal lives outside the vault. */
export class NoteVault {
  private mappings: Mapping[] = []
  private running: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private loaded = false
  private rescan = false
  private warning = ''
  constructor(
    readonly path: string,
    private readonly notes: VaultNotes,
    private readonly manifestPath: string,
    autoStart = true,
  ) {
    if (autoStart) {
      this.timer = setInterval(() => {
        if (!this.running) void this.scan()
      }, 5000)
      this.timer.unref()
      void this.scan()
    }
  }
  status() {
    return {
      path: this.path,
      warning: this.warning,
      externalConflicts: this.mappings.filter((m) => m.conflict).length,
      externalMissing: this.mappings.filter((m) => m.missing).length,
    }
  }
  private async safe(path: string, allowMissing = false) {
    const root = resolve(this.path),
      target = resolve(path)
    if (target !== root && !target.startsWith(root + sep)) throw syncError(400, '路径超出笔记工作区')
    const parts = relative(root, target).split(sep).filter(Boolean)
    let current = root
    for (const part of ['', ...parts]) {
      if (part) current = join(current, part)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink()) throw syncError(409, '笔记工作区不读取或写入符号链接')
      } catch (e) {
        if (allowMissing && (e as NodeJS.ErrnoException).code === 'ENOENT') return
        throw e
      }
    }
  }
  private async bytes(path: string) {
    await this.safe(path)
    const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const st = await f.stat()
      if (!st.isFile() || st.size > 64 * 1024 * 1024) throw syncError(413, '文件过大或不是普通文件')
      return await f.readFile()
    } finally {
      await f.close()
    }
  }
  private async persist() {
    await mkdir(dirname(this.manifestPath), { recursive: true, mode: 0o700 })
    await atomicWriteFile(this.manifestPath, JSON.stringify({ format: 1, mappings: this.mappings }), { mode: 0o600 })
  }
  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.running) {
      this.rescan = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.rescan = false
        await this.cycle()
      } while (this.rescan && !this.stopped)
    })()
      .catch((e) => {
        this.warning = e instanceof Error ? e.message : '本地文件工作区暂不可用'
      })
      .finally(() => {
        this.running = undefined
      })
    return this.running
  }
  private async cycle() {
    await mkdir(this.path, { recursive: true, mode: 0o700 })
    await this.safe(this.path)
    if (!this.loaded) {
      try {
        const saved = JSON.parse(await readFile(this.manifestPath, 'utf8'))
        if (saved.format !== 1 || !Array.isArray(saved.mappings)) throw Error('工作区索引格式无效')
        this.mappings = saved.mappings
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      this.loaded = true
    }
    this.warning = ''
    let nodes = await this.notes.all()
    const known = new Map(nodes.map((n) => [n.id, n]))
    // Import external edits before exporting. Dirty files are never overwritten.
    for (const m of this.mappings) {
      if (m.kind === 'folder') continue
      const path = join(this.path, m.path)
      let bytes: Buffer
      try {
        bytes = await this.bytes(path)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          m.missing = true
          continue
        }
        throw e
      }
      m.missing = false
      const digest = hash(bytes)
      if (m.conflict) {
        const node = known.get(m.id)
        if (node?.sha256 === digest) {
          m.conflict = false
          m.hash = digest
          m.version = node.version
        } else if (node?.sha256 === m.hash) m.conflict = false
        else continue
      }
      if (digest === m.hash) continue
      const node = known.get(m.id)
      if (!node || node.sha256 !== m.hash || !node.editable) {
        m.conflict = true
        this.warning = '外部文件与工作区同时变化，双方均已保留；请手动整理后再保存'
        continue
      }
      try {
        const updated = await this.notes.update(m.id, bytes, node.version)
        m.hash = digest
        m.version = updated.version
        known.set(m.id, updated)
      } catch (e) {
        m.conflict = true
        this.warning = e instanceof Error ? e.message : '外部编辑冲突'
      }
    }
    await this.persist()
    nodes = await this.notes.all()
    const pathFor = (n: NoteNode, seen = new Set<string>()): string => {
      if (seen.has(n.id)) throw Error('笔记目录循环')
      seen.add(n.id)
      // Keep ordinary names so standard Markdown relative links work in OB.
      const clean =
        n.name
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
          .replace(/[. ]+$/g, '')
          .slice(0, 100) || '未命名'
      const ext =
        n.kind === 'document'
          ? /\.(md|markdown)$/i.test(clean)
            ? extname(clean)
            : '.md'
          : n.kind === 'file'
            ? extname(clean)
            : ''
      const stem = ext && clean.endsWith(ext) ? clean.slice(0, -ext.length) : clean
      const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)
      const component = reserved ? `${stem} [${n.id.slice(5, 13)}]${ext}` : `${stem}${ext}`
      const stored = this.mappings.find((m) => m.id === n.id)
      if (stored) return stored.path
      const parent = n.parentId ? nodes.find((x) => x.id === n.parentId) : undefined
      return parent ? join(pathFor(parent, seen), component) : component
    }
    for (const n of nodes) {
      let m = this.mappings.find((m) => m.id === n.id)
      if (m?.conflict || m?.missing) continue
      const rel = m?.path ?? pathFor(n),
        path = join(this.path, rel)
      await this.safe(path, true)
      if (n.kind === 'folder') {
        await mkdir(path, { recursive: true, mode: 0o700 })
        if (!m) {
          m = { id: n.id, path: rel, hash: null, version: n.version, kind: n.kind }
          this.mappings.push(m)
        }
        continue
      }
      if (m && m.hash === n.sha256) continue
      if (!m) {
        try {
          await lstat(path)
          this.warning = '目标文件已存在，未覆盖；请检查工作区文件'
          continue
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        }
      }
      const { node, content } = await this.notes.read(n.id)
      if (node.sha256 !== n.sha256) continue
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await this.safe(path, true)
      // Check again immediately before replacement (external editors may save during I/O).
      if (m) {
        const current = await this.bytes(join(this.path, m.path))
        if (hash(current) !== m.hash) {
          m.conflict = true
          continue
        }
      }
      if(!await installVaultFile(path,content,m?.hash??null)){if(m)m.conflict=true;this.warning='外部文件在保存期间变化，已保留原文件及历史，请整理后再同步';continue}
      if (m && m.path !== rel) {
        this.warning = '笔记路径发生变化，旧路径保留，避免误删外部文件'
      }
      const updated = { id: n.id, path: rel, hash: n.sha256, version: n.version, kind: n.kind }
      if (m) Object.assign(m, updated)
      else this.mappings.push(updated)
    }
    // New Markdown files can be created in OB; configuration, symlinks and hidden files are excluded.
    const mapped = new Set(this.mappings.map((m) => m.path))
    let count = 0
    const walk = async (dir: string, parentId: string | null, depth: number): Promise<void> => {
      if (depth > 24) throw Error('工作区目录层级过深')
      for (const entry of await readdir(join(this.path, dir), { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        if (++count > 10000) throw Error('工作区文件数量超过第一版上限')
        const rel = join(dir, entry.name)
        const m = this.mappings.find((m) => m.path === rel)
        if (entry.isDirectory()) {
          if (m) {
            await walk(rel, m.id, depth + 1)
          } else {
            // Only import folders that contain Markdown, not arbitrary application folders.
            const children = await readdir(join(this.path, rel), { withFileTypes: true })
            if (!children.some((x) => x.isFile() && /\.(md|markdown)$/i.test(x.name))) continue
            const node = await this.notes.create('folder', entry.name, parentId, new Uint8Array())
            this.mappings.push({ id: node.id, path: rel, hash: null, version: node.version, kind: 'folder' })
            await this.persist()
            await walk(rel, node.id, depth + 1)
          }
        } else if (entry.isFile() && !mapped.has(rel) && /\.(md|markdown)$/i.test(entry.name)) {
          const bytes = await this.bytes(join(this.path, rel))
          const node = await this.notes.create('document', entry.name, parentId, bytes)
          this.mappings.push({ id: node.id, path: rel, hash: hash(bytes), version: node.version, kind: 'document' })
          await this.persist()
        }
      }
    }
    await walk('', null, 0)
    await this.persist()
  }
  async close() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await this.running
  }
}
