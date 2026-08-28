export type SensitiveContentKind =
  | 'private-key'
  | 'authorization-header'
  | 'cookie'
  | 'credential-assignment'
  | 'known-token-format'
  | 'embedded-url-credential'

export interface SensitiveContentFinding {
  kind: SensitiveContentKind
}

/**
 * Deterministic last-line defence for automatic direct write-back. Findings
 * intentionally contain no matched value so logs and review metadata cannot
 * leak the credential a second time.
 */
export function inspectSensitiveContent(content: string): SensitiveContentFinding[] {
  const findings = new Set<SensitiveContentKind>()
  if (/-----BEGIN\s+(?:(?:RSA|EC|DSA|OPENSSH)\s+)?PRIVATE KEY-----/iu.test(content)) findings.add('private-key')
  if (/\bauthorization\s*:\s*(?:basic|bearer)\s+[^\s"'<>]{8,}/iu.test(content)) findings.add('authorization-header')
  if (/^(?:set-cookie|cookie)\s*:\s*\S.{6,}$/imu.test(content)) findings.add('cookie')
  if (/(?:https?|ssh):\/\/[^\s/:@]+:[^\s/@]{4,}@/iu.test(content)) findings.add('embedded-url-credential')
  if (/\b(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[oprsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/u.test(content)) {
    findings.add('known-token-format')
  }
  if (containsCredentialAssignment(content)) findings.add('credential-assignment')
  return [...findings].map(kind => ({ kind }))
}

export function containsSensitiveContent(content: string): boolean {
  return inspectSensitiveContent(content).length > 0
}

function containsCredentialAssignment(content: string): boolean {
  const assignment = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|pwd)\b\s*(?::|=)\s*["']?([^\s"'`,;}{\]]{6,})/giu
  for (const match of content.matchAll(assignment)) {
    const value = match[1]?.trim() ?? ''
    if (!isObviousPlaceholder(value)) return true
  }
  return false
}

function isObviousPlaceholder(value: string): boolean {
  return /^(?:x+|\*+|<[^>]+>|\[[^\]]+\]|redacted|masked|hidden|example|sample|placeholder|your[_-].+|process\.env\..+|\$\{?[A-Z][A-Z0-9_]*\}?)$/iu.test(value)
}
