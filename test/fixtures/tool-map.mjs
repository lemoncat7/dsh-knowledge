// Old operation-oriented assertions now execute through the actual public entry.
// keys()/size still expose only the real host registrations.
export class ToolMap extends Map {
  get(name) {
    const actual = super.get(name)
    if (actual || name === 'knowledge') return actual
    const entry = super.get('knowledge')
    if (!entry || !name.startsWith('knowledge_')) return undefined
    return {
      execute: (args, exec) => entry.execute({ action: 'call', tool: name, arguments: args }, exec),
      output: { render: (args, value) => entry.output.render({ action: 'call', tool: name, arguments: args }, value) },
    }
  }
}
