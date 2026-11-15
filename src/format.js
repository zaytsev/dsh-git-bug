/**
 * Text projections of normalized git-bug values.
 *
 * Two consumers read these strings: the tools render them as the model-facing
 * tool result, and the system-prompt section summarizes the repository. Pure
 * functions only — no I/O, no clock reads beyond the timestamps already in the
 * value.
 * @module dsh-git-bug/format
 */

/** Render one timestamp as "YYYY-MM-DD HH:MM" in UTC, or "" when unknown. */
export function stamp(value) {
  if (value === null || value === undefined) return ''
  if (typeof value.time === 'string' && value.time.length >= 16) return value.time.slice(0, 16).replace('T', ' ')
  if (typeof value.epoch === 'number') return new Date(value.epoch * 1000).toISOString().slice(0, 16).replace('T', ' ')
  return ''
}

/** Render an identity as "Name (humanId)", falling back to whichever half exists. */
export function identityLabel(identity) {
  if (identity === null || identity === undefined) return 'unknown'
  const name = typeof identity.name === 'string' && identity.name.length > 0 ? identity.name : ''
  const humanId = typeof identity.humanId === 'string' ? identity.humanId : ''
  if (name.length > 0 && humanId.length > 0) return `${name} (${humanId})`
  return name.length > 0 ? name : humanId
}

/** Render one issue as a single table row. */
export function issueRow(issue) {
  const labels = issue.labels.length > 0 ? `  [${issue.labels.join(', ')}]` : ''
  const comments = issue.comments > 0 ? `  (${String(issue.comments)} comments)` : ''
  return `${stamp(issue.editedAt) || stamp(issue.createdAt) || '-'}  ${issue.status.padEnd(6)}  ${issue.humanId.padEnd(9)}  ${issue.title}${labels}${comments}`
}

/**
 * Render a summary of the repository and an issue list.
 * @param issues - normalized summaries in display order.
 * @param options - heading text and an omitted-count note.
 * @returns the model-facing text block.
 */
export function formatIssueList(issues, options = {}) {
  const open = issues.filter(issue => issue.status === 'open').length
  const closed = issues.length - open
  const head = `${String(open)} open · ${String(closed)} closed`
  const heading = options.heading === undefined ? '' : `${options.heading}\n`
  if (issues.length === 0) {
    return `${heading}${head}\nno issues match`
  }
  const header = 'UPDATED (UTC)       STATUS  ID         TITLE'
  const note = options.note === undefined ? '' : `\n${options.note}`
  return `${heading}${head}\n\n${header}\n${issues.map(issueRow).join('\n')}${note}`
}

/**
 * Render one issue with its comments.
 * @param issue - normalized detail.
 * @returns the model-facing text block.
 */
export function formatIssueDetail(issue) {
  const lines = []
  lines.push(`${issue.humanId}  ${issue.status}  ${issue.title}`)
  lines.push(`id: ${issue.id}`)
  lines.push(`author: ${identityLabel(issue.author)} · created ${stamp(issue.createdAt) || '?'} · updated ${stamp(issue.editedAt) || '?'}`)
  if (issue.labels.length > 0) lines.push(`labels: ${issue.labels.join(', ')}`)
  if (issue.participants.length > 0) lines.push(`participants: ${issue.participants.map(identityLabel).join(', ')}`)
  lines.push('')
  if (issue.comments.length === 0) {
    lines.push('(no comments)')
    return lines.join('\n')
  }
  lines.push(`comments (${String(issue.comments.length)}):`)
  for (const [index, comment] of issue.comments.entries()) {
    lines.push(`--- #${String(index + 1)} ${comment.humanId} by ${identityLabel(comment.author)}`)
    lines.push(comment.message)
  }
  return lines.join('\n')
}

/**
 * Render the short repository digest used by the prompt section and the panel.
 * @param counts - open and closed issue counts.
 * @param taskLabel - the label that marks agent-owned tasks.
 * @param issues - normalized summaries, used for the labelled-task count.
 * @returns one line, e.g. "4 open · 2 closed · 3 labelled agent-task".
 */
export function formatDigest(counts, taskLabel, issues = []) {
  const parts = [`${String(counts.open)} open`, `${String(counts.closed)} closed`]
  const labelled = countLabel(issues, taskLabel)
  if (labelled > 0) parts.push(`${String(labelled)} labelled ${taskLabel}`)
  return parts.join(' · ')
}

/**
 * Count the open issues carrying one label.
 * @param issues - normalized summaries.
 * @param label - the label to look for.
 * @returns the number of open issues carrying it.
 */
export function countLabel(issues, label) {
  return issues.filter(issue => issue.status === 'open' && issue.labels.includes(label)).length
}
