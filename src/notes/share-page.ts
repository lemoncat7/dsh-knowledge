import { SHARE_PAGE_CSS } from './share-page-styles.js'
import type { NoteNode, NoteShare } from './domain.js'
import { renderSharedMarkdown, type SharedMarkdownHeading } from './share-markdown.js'

export interface NoteSharePageInput {
  apiPrefix: string
  share: NoteShare
  nodes: NoteNode[]
  selectedNode?: NoteNode
  selectedText?: string
  contentTruncated?: boolean
  listTruncated?: boolean
}

export function renderNoteSharePage(input: NoteSharePageInput): string {
  const { share, nodes } = input
  const baseHref = `${input.apiPrefix.replace(/\/$/, '')}/shared/${encodeURIComponent(share.token)}`
  const paths = relativePaths(share.node, nodes)
  const selected = input.selectedNode
  const selectedPath = selected === undefined ? '' : paths.get(selected.id) ?? selected.name
  const rendered = renderSharedContent(selected ?? share.node, selectedPath || share.node.name, input.selectedText, input.contentTruncated, baseHref)
  const directory = share.node.kind === 'folder'
    ? renderDirectoryPanel(share.node, nodes, baseHref, selected?.id, input.listTruncated === true)
    : ''
  const outline = rendered.outline === undefined ? '' : renderOutlinePanel(rendered.outline)
  const panelClass = directory.length === 0 && outline.length === 0 ? ' is-single' : ''
  const title = share.node.name
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · 分享笔记</title>
<style>${SHARE_PAGE_CSS}</style></head><body>
<main class="share-shell">
  <header class="share-header"><div class="share-title"><span class="eyebrow">DSH KNOWLEDGE</span><h1>${escapeHtml(title)}</h1><p>${share.node.kind === 'folder' ? `共享目录 · ${Math.max(0, nodes.length - 1)} 个项目` : '共享笔记文档 · 只读'}</p></div><span class="readonly">只读分享</span></header>
  <div class="share-workspace${panelClass}">
    ${directory}
    <section class="share-content">${rendered.html}</section>
    ${outline}
  </div>
  <footer class="share-footer"><span>分享于 ${formatDate(share.createdAt)}</span><span>内容会随原笔记更新</span></footer>
</main></body></html>`
}

function renderDirectoryPanel(root: NoteNode, nodes: NoteNode[], baseHref: string, selectedId: string | undefined, truncated: boolean): string {
  const children = childNodes(nodes)
  return `<details class="share-panel directory-panel" open>
    <summary class="panel-toggle">${directoryIcon()}<span class="panel-label">目录</span><span class="panel-count">${Math.max(0, nodes.length - 1)}</span>${chevronIcon()}</summary>
    <nav class="share-tree" aria-label="共享目录">
      <a class="tree-root" href="${escapeAttribute(baseHref)}">${folderIcon()}<span>${escapeHtml(root.name)}</span></a>
      ${renderTreeChildren(root.id, children, baseHref, selectedId, 0)}
      ${truncated ? '<p class="notice">目录内容较多，仅展示前 500 项。</p>' : ''}
    </nav>
  </details>`
}

function renderTreeChildren(parentId: string, children: Map<string, NoteNode[]>, baseHref: string, selectedId: string | undefined, depth: number): string {
  return (children.get(parentId) ?? []).map(node => {
    if (node.kind === 'folder') {
      const descendants = containsNode(node.id, selectedId, children)
      return `<details class="tree-folder"${depth === 0 || descendants ? ' open' : ''}>
        <summary class="tree-item is-folder" style="padding-left:${9 + depth * 14}px">${folderIcon()}<span>${escapeHtml(node.name)}</span>${chevronIcon()}</summary>
        <div class="tree-children">${renderTreeChildren(node.id, children, baseHref, selectedId, depth + 1)}</div>
      </details>`
    }
    const href = `${baseHref}?note=${encodeURIComponent(node.id)}`
    const active = node.id === selectedId
    return `<a class="tree-item is-file${active ? ' is-active' : ''}" style="padding-left:${9 + depth * 14}px" href="${escapeAttribute(href)}"${active ? ' aria-current="page"' : ''}>${fileIcon()}<span>${escapeHtml(node.name)}</span></a>`
  }).join('')
}

function childNodes(nodes: NoteNode[]): Map<string, NoteNode[]> {
  const result = new Map<string, NoteNode[]>()
  for (const node of nodes) {
    if (node.parentId === null) continue
    const siblings = result.get(node.parentId) ?? []
    siblings.push(node)
    result.set(node.parentId, siblings)
  }
  for (const siblings of result.values()) {
    siblings.sort((left, right) => {
      if (left.kind === 'folder' && right.kind !== 'folder') return -1
      if (left.kind !== 'folder' && right.kind === 'folder') return 1
      return left.name.localeCompare(right.name, 'zh-CN', { numeric: true })
    })
  }
  return result
}

function containsNode(rootId: string, selectedId: string | undefined, children: Map<string, NoteNode[]>): boolean {
  if (selectedId === undefined) return false
  const pending = [...(children.get(rootId) ?? [])]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    if (current.id === selectedId) return true
    pending.push(...(children.get(current.id) ?? []))
  }
  return false
}

function renderOutlinePanel(headings: SharedMarkdownHeading[]): string {
  return `<details class="share-panel outline-panel" open>
    <summary class="panel-toggle">${outlineIcon()}<span class="panel-label">大纲</span><span class="panel-count">${headings.length}</span>${chevronIcon()}</summary>
    <nav class="share-outline" aria-label="文档大纲">${headings.length === 0
      ? '<p class="outline-empty">这篇文档还没有标题。</p>'
      : headings.map(heading => `<a href="#${escapeAttribute(heading.id)}" style="padding-left:${8 + Math.min(3, Math.max(0, heading.depth - 1)) * 12}px">${escapeHtml(heading.text)}</a>`).join('')}</nav>
  </details>`
}

function renderSharedContent(node: NoteNode, path: string, text: string | undefined, truncated: boolean | undefined, baseHref: string): { html: string; outline?: SharedMarkdownHeading[] } {
  if (node.kind === 'folder') {
    return { html: '<div class="empty"><span class="empty-mark" aria-hidden="true"></span><h2>选择一篇文档</h2><p>从目录中选择要阅读的内容。</p></div>' }
  }
  const download = `${baseHref}/content?noteId=${encodeURIComponent(node.id)}&download=1`
  const heading = `<header class="content-header"><div class="content-title"><span>${escapeHtml(path)}</span><h2>${escapeHtml(node.name)}</h2></div><a class="download" href="${escapeAttribute(download)}">${downloadIcon()}<span>下载</span></a></header>`
  if (node.mediaType?.startsWith('image/')) {
    const source = `${baseHref}/content?noteId=${encodeURIComponent(node.id)}`
    return { html: `${heading}<div class="image-stage"><img src="${escapeAttribute(source)}" alt="${escapeAttribute(node.name)}"></div>` }
  }
  if (text !== undefined) {
    const notice = truncated ? '<p class="notice content-notice">文档较长，网页仅显示前 512 KiB；下载可查看完整内容。</p>' : ''
    if (isMarkdown(node)) {
      const markdown = renderSharedMarkdown(text)
      return { html: `${heading}${notice}<article class="document"><div class="markdown-body">${markdown.html}</div></article>`, outline: markdown.headings }
    }
    return { html: `${heading}${notice}<article class="document"><pre class="plain-text">${escapeHtml(text)}</pre></article>` }
  }
  return { html: `${heading}<div class="empty"><span class="file-large" aria-hidden="true"></span><h2>此格式不支持网页预览</h2><p>可以下载后使用本地应用打开。</p><a class="download primary" href="${escapeAttribute(download)}">${downloadIcon()}<span>下载文件</span></a></div>` }
}

function isMarkdown(node: NoteNode): boolean {
  const mediaType = node.mediaType?.toLocaleLowerCase() ?? ''
  const name = node.name.toLocaleLowerCase()
  return node.kind === 'document' || mediaType === 'text/markdown' || name.endsWith('.md') || name.endsWith('.markdown')
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

function directoryIcon(): string {
  return '<svg class="panel-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3.5 5.25h4l1.35 1.5h7.65v8H3.5v-9.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>'
}

function outlineIcon(): string {
  return '<svg class="panel-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5.5h10M5 10h7.5M5 14.5h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
}

function chevronIcon(): string {
  return '<svg class="chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m5.75 6.25 2.25 2.5 2.25-2.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>'
}

function folderIcon(): string {
  return '<svg class="tree-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3.5 5.5h4l1.25 1.4h7.75v7.6h-13v-9Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>'
}

function fileIcon(): string {
  return '<svg class="tree-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5.25 3.5h6l3.5 3.5v9.5h-9.5v-13Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M11.25 3.75V7h3.25" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>'
}

function downloadIcon(): string {
  return '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 2.75v8.5m0 0 3-3m-3 3-3-3M3.5 14.75h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
}
