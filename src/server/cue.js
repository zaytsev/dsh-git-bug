/**
 * Model-facing cues that make the issue list impossible to overlook.
 *
 * Both travel as injected user-role context, never as prompt text: injected
 * messages append at the tail of the conversation, so they cannot move the
 * cached prefix the way a rewritten system prompt would.
 * @module dsh-git-bug/server/cue
 */

import { countLabel } from '../format.js'

/**
 * Build one producer-sourced user message.
 *
 * Session format V4 retires the catch-all `kind: 'plugin'` source: every
 * producer owns a stable kind. The V3→V4 migration names an unknown plugin
 * `plugin:<name>`, so using that same kind here keeps historical cues and new
 * cues identical to consumers. The session freezes and logs the message, so it
 * is replayable like any other model-visible input.
 * @param producer - plugin name recorded as the producer kind.
 * @param text - the cue.
 * @returns the message to inject.
 */
export function contextMessage(producer, text) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:' + producer },
  }
}

/** How many repository labels the cue names before it summarizes the rest. */
const CUE_LABEL_LIMIT = 12

/**
 * The labels this repository actually uses, as a clause for the cue.
 *
 * The prompt stays a static vocabulary; the repository's own labels — legacy
 * ones, ad-hoc ones, another plugin's — ride the injected cue instead, which
 * appends at the tail and cannot move the cached prefix.
 * @param labels - labels in use, or undefined when the read failed.
 * @returns one clause, or an empty string when there is nothing to add.
 */
export function publishedLabels(labels) {
  if (!Array.isArray(labels) || labels.length === 0) return ''
  const shown = labels.slice(0, CUE_LABEL_LIMIT)
  const rest = labels.length - shown.length
  return ` Labels in use here: ${shown.join(', ')}${rest > 0 ? `, and ${String(rest)} more` : ''}.`
}

/**
 * The session-start cue: one line of current facts plus the rule that reads them.
 * @param overview - counts and issues read from the repository.
 * @param taskLabel - label that marks agent-owned tasks.
 * @param repoPath - repository the tools act on.
 * @returns the cue text, or null when the repository has nothing to report.
 */
export function sessionCue(overview, taskLabel, repoPath) {
  const open = overview.issues.filter(issue => issue.status === 'open')
  if (overview.counts.total === 0) {
    return `git-bug task list (${repoPath}): empty right now. Call \`git_bug_list\` before you plan — it is ` +
      `the shared list — and put the first unit of work on it with \`git_bug_create\` (label \`${taskLabel}\`).`
  }
  const labelled = countLabel(overview.issues, taskLabel)
  const inUse = publishedLabels(overview.labels)
  return `git-bug task list (${repoPath}): ${String(open.length)} open · ${String(overview.counts.closed)} closed · ` +
    `${String(labelled)} labelled \`${taskLabel}\`.${inUse} Call \`git_bug_list\` before you plan: it is the shared ` +
    'list, the user sees it in the Issues panel, and it outlives this session.'
}

/**
 * The cue used before any counts have been read: the rule without the numbers.
 *
 * Injected synchronously so it lands in the session's first request; counts
 * arrive on the next session once the background read completes.
 * @param repoPath - repository the tools act on.
 * @param taskLabel - label that marks agent-owned tasks.
 * @returns the cue text.
 */
export function genericCue(repoPath, taskLabel) {
  return `git-bug task list (${repoPath}): the workspace keeps its shared task list in git-bug. ` +
    `Call \`git_bug_list\` before you plan anything that takes more than one step, and put new units of ` +
    `work on it with \`git_bug_create\` (label \`${taskLabel}\`).`
}

/**
 * The nudge attached the first time a session reaches for `todo_write`.
 * @param repoPath - repository the tools act on.
 * @returns the nudge text.
 */
export function todoNudge(repoPath) {
  return `Reminder: \`todo_write\` is private to this turn. If this work must outlive the session, be visible ` +
    `to the user, or be shared, record it in git-bug instead (\`git_bug_create\` / \`git_bug_comment\`, repo ${repoPath}).`
}