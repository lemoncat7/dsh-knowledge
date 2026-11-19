export function applyGoalOrder(events, ids = []) {
  if (!ids.length) return events
  const positions = new Map(ids.map((id, index) => [id, index]))
  const goals = events.filter(event => event.kind === 'goal')
    .sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity))
  let index = 0
  return events.map(event => event.kind === 'goal' ? goals[index++] : event)
}

export function moveGoal(ids, source, target) {
  const from = ids.indexOf(source), to = ids.indexOf(target)
  if (from < 0 || to < 0 || from === to) return ids
  const next = ids.slice()
  next.splice(from, 1)
  next.splice(to, 0, source)
  return next
}
