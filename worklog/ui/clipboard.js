export async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return }
  const input = document.createElement('textarea'), focus = document.activeElement
  input.value = text; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input)
  try { input.select(); if (!document.execCommand('copy')) throw new Error('浏览器禁止复制，请使用导出 Markdown') }
  finally { input.remove(); focus?.focus?.() }
}

