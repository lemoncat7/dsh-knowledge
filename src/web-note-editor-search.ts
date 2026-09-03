import { Extension, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export interface NoteSearchRange {
  from: number
  to: number
}

export interface NoteSearchState {
  query: string
  caseSensitive: boolean
  activeIndex: number
  results: NoteSearchRange[]
  decorations: DecorationSet
}

interface NoteSearchMeta {
  query?: string
  caseSensitive?: boolean
  activeIndex?: number
}

const MAX_QUERY_LENGTH = 256
const MAX_RESULTS = 1_000

export const noteSearchPluginKey = new PluginKey<NoteSearchState>('dshKnowledgeNoteSearch')

function normalizeQuery(query: string): string {
  return query.slice(0, MAX_QUERY_LENGTH)
}

function clampActiveIndex(index: number, resultCount: number): number {
  if (resultCount === 0) return 0
  return Math.max(0, Math.min(Math.trunc(index), resultCount - 1))
}

/** Finds literal matches per text block, including text split across inline marks. */
export function findNoteSearchRanges(document: ProseMirrorNode, rawQuery: string, caseSensitive: boolean): NoteSearchRange[] {
  const query = normalizeQuery(rawQuery)
  if (!query) return []
  const needle = caseSensitive ? query : query.toLocaleLowerCase()
  const results: NoteSearchRange[] = []

  document.descendants((node, position) => {
    if (!node.isTextblock || results.length >= MAX_RESULTS) return results.length < MAX_RESULTS

    let segment = ''
    let segmentOffset = 0
    const flush = (): void => {
      if (!segment) return
      const haystack = caseSensitive ? segment : segment.toLocaleLowerCase()
      let offset = 0
      while (offset <= haystack.length - needle.length && results.length < MAX_RESULTS) {
        const match = haystack.indexOf(needle, offset)
        if (match < 0) break
        const from = position + 1 + segmentOffset + match
        results.push({ from, to: from + query.length })
        offset = match + Math.max(1, needle.length)
      }
      segment = ''
    }

    node.forEach((child, offset) => {
      if (!child.isText) {
        flush()
        return
      }
      if (!segment) segmentOffset = offset
      else if (offset !== segmentOffset + segment.length) {
        flush()
        segmentOffset = offset
      }
      segment += child.text ?? ''
    })
    flush()
    if (results.length >= MAX_RESULTS) {
      return false
    }
    return false
  })

  return results
}

function buildDecorations(document: ProseMirrorNode, results: NoteSearchRange[], activeIndex: number): DecorationSet {
  return DecorationSet.create(document, results.map((range, index) => Decoration.inline(range.from, range.to, {
    class: index === activeIndex ? 'notes-search-result notes-search-result-current' : 'notes-search-result',
    'data-note-search-result': index === activeIndex ? 'current' : 'match',
  })))
}

function nextSearchState(transaction: Transaction, previous: NoteSearchState): NoteSearchState {
  const meta = transaction.getMeta(noteSearchPluginKey) as NoteSearchMeta | undefined
  if (!transaction.docChanged && !meta) return previous

  const query = normalizeQuery(meta?.query ?? previous.query)
  const caseSensitive = meta?.caseSensitive ?? previous.caseSensitive
  const mustRescan = transaction.docChanged || query !== previous.query || caseSensitive !== previous.caseSensitive
  const results = mustRescan
    ? findNoteSearchRanges(transaction.doc, query, caseSensitive)
    : previous.results
  const requestedIndex = meta?.activeIndex ?? previous.activeIndex
  const activeIndex = clampActiveIndex(requestedIndex, results.length)

  return {
    query,
    caseSensitive,
    activeIndex,
    results,
    decorations: buildDecorations(transaction.doc, results, activeIndex),
  }
}

export const NoteSearch = Extension.create({
  name: 'dshKnowledgeNoteSearch',
  addProseMirrorPlugins() {
    return [new Plugin<NoteSearchState>({
      key: noteSearchPluginKey,
      state: {
        init: (_, state) => ({
          query: '',
          caseSensitive: false,
          activeIndex: 0,
          results: [],
          decorations: DecorationSet.empty,
        }),
        apply: nextSearchState,
      },
      props: {
        decorations: state => noteSearchPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
      },
    })]
  },
})

export function getNoteSearchState(editor: Editor): NoteSearchState | undefined {
  return noteSearchPluginKey.getState(editor.state)
}

export function updateNoteSearch(editor: Editor, meta: NoteSearchMeta): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(noteSearchPluginKey, meta))
}

export function replaceNoteSearchResult(editor: Editor, range: NoteSearchRange, replacement: string): void {
  if (editor.isDestroyed) return
  const transaction = editor.state.tr
  if (replacement) transaction.replaceWith(range.from, range.to, editor.state.schema.text(replacement, editor.state.doc.resolve(range.from).marks()))
  else transaction.delete(range.from, range.to)
  editor.view.dispatch(transaction)
}

export function replaceAllNoteSearchResults(editor: Editor, ranges: NoteSearchRange[], replacement: string): void {
  if (editor.isDestroyed || ranges.length === 0) return
  const transaction = editor.state.tr
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]
    if (!range) continue
    if (replacement) transaction.replaceWith(range.from, range.to, editor.state.schema.text(replacement, editor.state.doc.resolve(range.from).marks()))
    else transaction.delete(range.from, range.to)
  }
  editor.view.dispatch(transaction)
}
