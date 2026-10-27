// Dashboard importance, not query relevance or a quality/success probability.
// Saturation keeps raw activity from dominating; constants are independent of
// the current page/filter so the same evidence always receives the same score.
export const recallScoreSql = {
  recallPoints: '25.0 * recalls / (recalls + 10)',
  readPoints: '25.0 * reads / (reads + 5)',
  sessionPoints: '20.0 * sessions / (sessions + 5)',
  frictionPoints: '0.2 * round(friction, 1)',
  priorityPoints: '5.0 * priority',
} as const

export type RecallScoreBreakdown = Record<keyof typeof recallScoreSql, number>
export const recallScoreColumns = Object.entries(recallScoreSql).map(([key, sql]) => `${sql} AS ${key}`).join(', ')
export const recallScoreTotal = `round(max(0, min(100, ${Object.keys(recallScoreSql).join(' + ')})), 1)`
