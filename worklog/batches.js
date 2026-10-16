import { fail } from './domain.js'

export const BATCH_CHARS = 90000
export const SINGLE_CHARS = 180000
const size = value => JSON.stringify(value).length

// No clipping: every source belongs to exactly one leaf batch. A single source
// has already passed the collection limits; malformed imports fail visibly.
export function partition(items, limit = BATCH_CHARS) {
  const groups = []; let group = [], chars = 2
  for (const item of items) {
    const n = size(item) + 1
    if (n > limit) throw fail('单条素材或中间摘要过长，请调整素材后重新整理；未截断原文。', 413)
    if (chars + n > limit && group.length) { groups.push(group); group = []; chars = 2 }
    group.push(item); chars += n
  }
  if (group.length) groups.push(group)
  return groups
}
export function prepareBatches(payload) {
  if (size(payload.records) <= SINGLE_CHARS) return
  partition(payload.records)
  payload.batch = { level: 0, index: 0, outputs: [], inputs: null, completed: 0 }
}
export function nextBatch(payload) {
  const state = payload.batch
  if (!state) return { payload, final: true }
  const groups = partition(state.inputs || payload.records), group = groups[state.index]
  if (!group) throw fail('整理检查点无效，请重新整理', 409)
  const final = state.level > 0 && groups.length === 1
  const records = state.level ? [...new Set(group.flatMap(n => n.ids))].map(id => ({ id })) : group
  return { final, groups: groups.length, payload: { route: payload.route, records,
    ...(state.level ? { material: group } : {}), partial: !final } }
}
export function finishBatch(payload, step, markdown) {
  if (step.final) return true
  if (markdown.length > 24000) throw fail('分批摘要过长，请重试或减少单日素材；未提交不完整日报。', 413)
  const state = payload.batch
  state.outputs.push({ text: markdown, ids: step.payload.records.map(r => r.id) })
  state.index++; state.completed++
  if (state.index === step.groups) {
    const next = partition(state.outputs)
    if (state.level > 0 && next.length >= step.groups) throw fail('分批摘要未能收敛，请减少素材后重试。', 413)
    state.inputs = state.outputs; state.outputs = []; state.index = 0; state.level++
  }
  return false
}
export function batchProgress(payload) {
  if (!payload.batch) return null
  const step = nextBatch(payload)
  return { phase: payload.batch.level ? '合并摘要' : '分批整理', current: payload.batch.index + 1,
    total: step.groups, completed: payload.batch.completed }
}
