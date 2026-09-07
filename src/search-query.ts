// Keep automatic recall cheap and compatible with the provider's 20-term FTS
// query. This is only a retrieval hint; extraction still receives the full turn.
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'is', 'are', 'for', 'in', 'on', 'with',
  'this', 'that', 'it', 'as', 'be', 'by', 'from', 'text', 'json', 'cpp',
  '你', '我', '我们', '这个', '那个', '什么', '什么时候', '怎么', '如何', '一下',
  '看下', '看看', '总结', '帮我', '目前', '当前', '下面', '上面', '可以', '需要',
  '已经', '没有', '进行', '时候', '然后', '因为', '所以', '以及', '如果', '但是',
])

export function buildSearchQuery(userText: string, assistantText = ''): string {
  const scores = new Map<string, { text: string; score: number }>()
  const add = (text: string, weight: number) => {
    const seen = new Set<string>()
    const terms = text.match(/[A-Za-z_][A-Za-z0-9_.:-]*|[^\x00-\x7F]+/gu) ?? []
    for (const term of terms) {
      const words = /^[A-Za-z_]/u.test(term)
        ? [term]
        : [...segmenter.segment(term)].filter(part => part.isWordLike).map(part => part.segment)
      for (const word of words) {
        const key = word.toLowerCase()
        if (word.length < 2 || word.length > 64 || STOP_WORDS.has(key) || seen.has(key)) continue
        seen.add(key)
        const previous = scores.get(key)
        scores.set(key, { text: previous?.text ?? word, score: (previous?.score ?? 0) + weight })
      }
    }
  }
  // Bound segmentation cost independently of the model's input/context limit.
  const user = userText.slice(0, 8000)
  const assistant = assistantText.slice(0, 16000)
  add(user, 8)
  add([...assistant.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => match[1]).join('\n'), 4)
  add([...assistant.matchAll(/`([^`\n]{2,100})`/g)].map(match => match[1]).join(' '), 2)
  add(assistant, 1)
  const selected: string[] = []
  let encodedBytes = 0
  for (const { text } of [...scores.values()].sort((a, b) => b.score - a.score)) {
    const bytes = encodeURIComponent(text).length + (selected.length === 0 ? 0 : 1)
    if (encodedBytes + bytes > 2000) continue
    selected.push(text)
    encodedBytes += bytes
    if (selected.length === 20) break
  }
  return selected.join(' ')
}
