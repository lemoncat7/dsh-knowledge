/**
 * Deterministic collation for user-visible names and paths.
 *
 * Problem
 * -------
 * The plugin hardcoded `localeCompare(a, b, 'zh-CN')` when sorting knowledge-base
 * names, document paths, note trees and labels. That pins the ordering rule to
 * one language, which is wrong for values that may be written in any script:
 *
 *   ['Dedicated model base', 'Архив', 'База знаний', 'Рабочие заметки']
 *     zh-CN → 'Dedicated model base' | 'Архив' | 'База знаний' | 'Рабочие заметки'
 *     ru-RU → 'Архив' | 'База знаний' | 'Рабочие заметки' | 'Dedicated model base'
 *
 * A Chinese-only installation never notices. Any installation whose names use
 * another script gets a list that looks arbitrary, and because the mount order
 * also decides extraction order, the visible result is not limited to sorting.
 *
 * Why not just `localeCompare(a, b)` without a locale
 * ---------------------------------------------------
 * That makes the result depend on the host environment. The same data would
 * sort differently on a machine with `LANG=zh_CN.UTF-8` than on CI, which is
 * both surprising for users and untestable:
 *
 *   LC_ALL=C          → 'Dedicated model base' | '默认知识库'
 *   LC_ALL=zh_CN.UTF-8 → '默认知识库' | 'Dedicated model base'
 *
 * So the collation is chosen explicitly, from the values themselves.
 *
 * How it works
 * ------------
 * Each value is classified by its dominant script, and a fixed locale is used:
 *
 *   both CJK        → 'zh-CN'   (existing Chinese installations: no change)
 *   both Cyrillic   → 'ru-RU'
 *   both Latin      → 'en'
 *   mixed scripts   → 'en'      (a common denominator, so pairs from different
 *                                scripts keep a stable relative order)
 *
 * The result is deterministic for a given pair, independent of `LANG`, which
 * matters because several call sites feed equality checks and fingerprints.
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const CYRILLIC = /[\u0400-\u04ff]/

type Script = 'zh-CN' | 'ru-RU' | 'en'

function scriptOf(value: string): Script {
  if (CJK.test(value)) return 'zh-CN'
  if (CYRILLIC.test(value)) return 'ru-RU'
  return 'en'
}

/**
 * Compares two user-visible names with a stable, environment-independent result.
 *
 * Chinese pairs keep Chinese collation, so existing installations are unaffected.
 * Cyrillic pairs sort by Russian rules. Everything else falls back to English
 * collation, which keeps mixed-script lists in a consistent order.
 */
export function compareNames(left: string, right: string, options?: Intl.CollatorOptions): number {
  const a = scriptOf(left)
  const b = scriptOf(right)
  return left.localeCompare(right, a === b ? a : 'en', options)
}

/**
 * Comparator factory for `Array.prototype.sort`, keyed by a selector.
 *
 *   list.sort(byName(item => item.base.name))
 */
export function byName<T>(select: (value: T) => string, options?: Intl.CollatorOptions) {
  return (left: T, right: T): number => compareNames(select(left), select(right), options)
}

/** Lower-cases a value for case-insensitive matching, without pinning a locale. */
export function foldName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase(scriptOf(value)).trim()
}
