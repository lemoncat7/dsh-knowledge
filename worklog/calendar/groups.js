import { fail } from '../domain.js'
import { integer, object, string } from './domain.js'

export const groupColors = ['slate', 'blue', 'teal', 'green', 'purple', 'rose', 'amber']
export const defaultGroups = () => ({ revision: 0, items: [{ id: 'default', name: '工作', color: 'teal' }] })
export function normalizeGroups(input) {
  object(input, ['revision', 'items'])
  const revision = integer(input.revision, 0, Number.MAX_SAFE_INTEGER)
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw fail('日历分组须为 1—100 个')
  const items = input.items.map(item => {
    object(item, ['id', 'name', 'color'])
    const id = string(item.id, 100, true), name = string(item.name, 60, true)
    if (!/^[\w-]+$/.test(id) || !groupColors.includes(item.color)) throw fail('日历分组标识或颜色无效')
    return { id, name, color: item.color }
  })
  if (!items.some(item => item.id === 'default') || new Set(items.map(item => item.id)).size !== items.length || new Set(items.map(item => item.name)).size !== items.length) throw fail('保留默认分组，分组名称和标识不能重复')
  return { revision, items }
}
