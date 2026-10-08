/** Fixed script buckets make comparisons transitive and independent of LANG.
 * Non-Han/non-Cyrillic names sort first, then Cyrillic, then Han names.
 * Within each bucket preserve the corresponding language's collation.
 * Choosing a locale per pair instead would produce cycles (阿 < a阿 < Z < 阿).
 */
const locales = ['en', 'ru-RU', 'zh-CN'] as const
function bucket(value: string): number {
  if (/\p{Script=Han}/u.test(value)) return 2
  if (/\p{Script=Cyrillic}/u.test(value)) return 1
  return 0
}
export function compareNames(left: string, right: string, options?: Intl.CollatorOptions): number {
  const a = bucket(left), b = bucket(right)
  return a - b || left.localeCompare(right, locales[a], options)
}
export function byName<T>(select: (value: T) => string, options?: Intl.CollatorOptions) {
  return (left: T, right: T): number => compareNames(select(left), select(right), options)
}
export function foldName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en').trim()
}
