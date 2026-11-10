/** Pure pull-request label validation, independent of Issue Project configuration. */

const PR_KINDS = new Set([
  'kind/feature',
  'kind/bug-fix',
  'kind/doc',
  'kind/testing',
  'kind/cleanup',
  'kind/dependency',
])
const LEGACY_LABELS = new Set([
  'kind/bug',
  'kind/documentation',
  'feature',
  'bug-fix',
  'doc',
  'cleanup',
  'testing',
  'dependencies',
  'ci',
  'cli',
  'llm',
  'web-search',
])
const PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3'])

/**
 * Decide whether the human-review policy applies to a PR.
 * @param {{isDraft: boolean, authorType: string, reviewRequestCount: number, reviewCount: number}} input PR state.
 * @returns {boolean} Whether the PR policy is mandatory.
 */
export function requiresPullRequestPolicy({ isDraft, authorType, reviewRequestCount, reviewCount }) {
  return !isDraft && authorType !== 'Bot' && authorType !== 'App' && (reviewRequestCount > 0 || reviewCount > 0)
}

/**
 * Identify PR kinds and retired label aliases forbidden on Issues.
 * @param {string} label Repository label.
 * @returns {boolean} Whether the Issue lifecycle removes the label.
 */
export function isInvalidIssueLabel(label) {
  return label.startsWith('kind/') || LEGACY_LABELS.has(label)
}

/**
 * Validate labels only when a human PR enters review.
 * @param {{isDraft: boolean, authorType: string, reviewRequestCount: number, reviewCount: number, labels: string[]}} input PR metadata.
 * @returns {string[]} Label violations, independent of Issue references and Project fields.
 */
export function validatePullRequest(input) {
  if (!requiresPullRequestPolicy(input)) return []
  const errors = []
  const kinds = input.labels.filter(label => PR_KINDS.has(label))
  const unknownKinds = input.labels.filter(label => label.startsWith('kind/') && !PR_KINDS.has(label) && !LEGACY_LABELS.has(label))
  const legacyLabels = input.labels.filter(label => LEGACY_LABELS.has(label))
  const sourceLabels = input.labels.filter(label => label.startsWith('source/'))
  const priorities = input.labels.filter(label => PRIORITIES.has(label))
  const aliases = input.labels.filter(label => /^P[0-3]$/.test(label))
  const areas = input.labels.filter(label => label.startsWith('area/'))

  if (kinds.length !== 1) errors.push(`PR 必须恰好有一个允许的 kind/*，当前为 ${kinds.length}`)
  if (unknownKinds.length > 0) errors.push(`PR 含不支持的 kind/*：${unknownKinds.join(', ')}`)
  if (legacyLabels.length > 0) errors.push(`PR 含旧版标签：${legacyLabels.join(', ')}`)
  if (sourceLabels.length > 0) errors.push(`source/* 仅用于 Issue：${sourceLabels.join(', ')}`)
  if (priorities.length > 1) errors.push(`PR 最多有一个 p0–p3，当前为 ${priorities.length}`)
  if (aliases.length > 0) errors.push(`PR Priority 标签必须使用小写 p0–p3：${aliases.join(', ')}`)
  if (areas.length === 0) errors.push('PR 必须至少有一个 area/*')
  return errors
}
