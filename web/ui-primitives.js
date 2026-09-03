/**
 * Small, dependency-free DOM primitives shared by the management views.
 * Business renderers should describe content; browser normalization and
 * element construction stay here.
 */
export function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'checked' || key === 'selected' || key === 'disabled') node[key] = Boolean(value)
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

export function actionButton(label, onClick, variant = '', attributes = {}) {
  return element('button', { type: 'button', class: `button ${variant}`.trim(), onClick, ...attributes }, label)
}

export function paneToggleButton(pane, visible, onClick, label) {
  const action = `${visible ? '隐藏' : '显示'}${label}`
  return element('button', {
    type: 'button', class: 'pane-toggle-button', 'data-pane': pane,
    'aria-label': action, 'aria-pressed': String(visible), title: action, onClick,
  }, element('span', { class: `pane-icon pane-icon-${pane}`, 'aria-hidden': 'true' }))
}

export function interfaceIcon(name, className = 'interface-icon') {
  const paths = {
    search: 'M10.8 4.5a6.3 6.3 0 1 0 0 12.6 6.3 6.3 0 0 0 0-12.6Zm4.6 11 4.1 4',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    save: 'M5 3.5h11l3 3v14H5zM8 3.5v6h8v-6M8 20.5v-7h8v7',
    outline: 'M8 6h11M8 12h11M8 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
    history: 'M4 4v5h5M4.8 8.2A8 8 0 1 1 4 13M12 7.5V12l3 2',
    download: 'M12 3v11M8 10l4 4 4-4M5 20h14',
    link: 'M9.5 14.5l5-5M8.5 17H6a5 5 0 0 1 0-10h3M15.5 7H18a5 5 0 0 1 0 10h-3',
    rename: 'M4 20l4.2-1 10.4-10.4a2.1 2.1 0 0 0-3-3L5.2 16zM14.5 6.5l3 3',
  }
  return element('svg', {
    class: className, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  }, element('path', { d: paths[name] }))
}

export function badge(label, variant = '') {
  return element('span', { class: `badge ${variant}`.trim() }, label)
}

export function createToastPresenter(region) {
  return (message, kind = '') => {
    const toast = element('div', { class: `toast ${kind}`.trim(), role: kind === 'error' ? 'alert' : 'status' },
      element('span', {}, message),
      kind === 'error' ? actionButton('关闭', () => toast.remove(), 'ghost small toast-close', { 'aria-label': '关闭错误提示' }) : null,
    )
    region.append(toast)
    if (kind !== 'error') window.setTimeout(() => toast.remove(), 4200)
  }
}
