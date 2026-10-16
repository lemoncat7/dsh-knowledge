/** Form navigation only. Saving and modal lifecycle remain owned by dialogs.js. */
export function createDialogSteps({ steps, element, actionButton, interfaceIcon, onChange }) {
  let current = 0
  let busy = false
  let animation
  const track = element('nav', { class: 'dialog-steps', 'aria-label': '填写步骤' })
  track.style.setProperty('--step-count', String(steps.length))
  const glider = element('span', { class: 'dialog-step-glider', 'aria-hidden': 'true' })
  const status = element('span', { class: 'dialog-step-status', role: 'status', 'aria-live': 'polite' })
  const buttons = steps.map((step, index) => actionButton([
    element('span', { class: 'dialog-step-number', 'aria-hidden': 'true' }, String(index + 1)),
    element('span', {}, step.title),
  ], () => go(index), 'dialog-step', { 'aria-label': `第 ${index + 1} 步：${step.title}` }))
  track.append(glider, ...buttons)
  for (const step of steps) {
    step.body.classList.add('dialog-step-panel')
    step.body.tabIndex = -1
    step.body.setAttribute('role', 'group')
    step.body.setAttribute('aria-label', step.title)
  }
  const back = actionButton('上一步', () => go(current - 1), 'ghost dialog-step-back')
  function render(focus = false, direction = 1) {
    animation?.cancel()
    steps.forEach((step, index) => { step.body.hidden = index !== current })
    buttons.forEach((button, index) => {
      if (index === current) button.setAttribute('aria-current', 'step')
      else button.removeAttribute('aria-current')
      button.dataset.complete = String(index < current)
      button.firstChild.replaceChildren(index < current ? interfaceIcon('check') : String(index + 1))
    })
    glider.style.transform = `translateX(${current * 100}%)`
    back.hidden = current === 0
    status.textContent = `${current + 1} / ${steps.length} · ${steps[current].title}`
    steps[current].onEnter?.()
    const panel = steps[current].body
    if (focus) {
      panel.focus({ preventScroll: true })
      panel.closest('.dialog-body')?.scrollTo({ top: 0 })
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && panel.animate) {
        animation = panel.animate([
          { opacity: 0, transform: `translateX(${direction * 14}px)` },
          { opacity: 1, transform: 'translateX(0)' },
        ], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' })
      }
    }
    onChange?.(current === steps.length - 1)
  }
  function validate(until) {
    for (let index = 0; index <= until; index++) {
      const invalid = [...steps[index].body.querySelectorAll('input, select, textarea')]
        .find(control => control.willValidate && !control.validity.valid)
      if (invalid) {
        current = index
        render()
        invalid.reportValidity()
        return false
      }
    }
    return true
  }
  function go(index) {
    if (busy || index < 0 || index >= steps.length || index === current) return
    if (index > current && !validate(index - 1)) return
    const direction = index > current ? 1 : -1
    current = index
    render(true, direction)
  }
  render()
  return {
    track, status, back,
    get isLast() { return current === steps.length - 1 },
    next: () => go(current + 1),
    validate: () => validate(steps.length - 1),
    setBusy(value) { busy = value; back.disabled = value; buttons.forEach(button => { button.disabled = value }) },
    dispose() { animation?.cancel() },
  }
}
