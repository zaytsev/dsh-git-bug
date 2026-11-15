/**
 * System-prompt section: what git-bug is here, how to drive it, and what the
 * board currently holds.
 *
 * Ordering is deliberate. The instructions are a stable prefix the model can
 * cache across turns; the live facts (counts, the open-issue table) come last,
 * so a board refresh changes only the tail of the section.
 * @module dsh-git-bug/server/prompt
 */

import { countLabel, formatIssueList } from '../format.js'

/** Section name registered with the system-prompt registry. */
export const SECTION_NAME = 'dsh-git-bug'

/**
 * Render the instructions, which never vary within one installation.
 * @param config - resolved plugin configuration.
 * @returns the static instruction text.
 */
export function instructionText(config) {
  const tools = [
    'git_bug_list',
    'git_bug_show',
    'git_bug_create',
    'git_bug_comment',
    'git_bug_status',
    'git_bug_label',
    'git_bug_sync',
    'git_bug_identity',
  ].join(' · ')
  return [
    '## git-bug issue tracker',
    '',
    `This workspace uses git-bug — an issue tracker stored in git refs — as its issue database ` +
      `and as the shared, persistent task list for agent work.`,
    '',
    `Tools (they act on \`${config.repoPath}\`): ${tools}.`,
    '',
    'How to use it:',
    '',
    `1. Begin multi-step work by reading the issue list below; call \`git_bug_list\` when you need ` +
      `a different filter. Never create an issue that already exists — update it instead.`,
    `2. Create one issue per unit of work with \`git_bug_create\` and the label ` +
      `\`${config.taskLabel}\` before you start it. Keep it current as you go: ` +
      `\`git_bug_comment\` for progress, decisions, and blockers, ` +
      `\`git_bug_status\` closed the moment the work is genuinely done.`,
    `3. Prefer issues over \`todo_write\` when the plan must outlive this session, be visible to ` +
      `the user in the Issues panel, or be shared with other sessions and people. ` +
      `\`todo_write\` stays right for a private step list inside one turn.`,
    '4. The user sees and edits the same issues in the Issues panel: treat issue text as shared '
      + 'state, not as scratch space, and never rewrite an issue title or body that someone else wrote.',
    `5. \`git_bug_sync\` with action \`pull\` refreshes from the git remote and ` +
      `\`push\` publishes; pull before trusting an id you did not just see, and push only when ` +
      `the user asks to share.`,
  ].join('\n')
}

/**
 * Render the section for one assembly.
 *
 * @param deps - board cache, configuration, executable availability, and any identity-bootstrap failure.
 * @returns the section text: instructions, then the live repository state.
 */
export function renderPromptSection(deps) {
  const { board, config, unavailable = null, identityError = null } = deps
  const instructions = instructionText(config)
  const snapshot = board.read()
  const facts = []

  if (unavailable !== null) {
    facts.push(
      `Status: git-bug is NOT available here — ${unavailable.reason ?? 'the executable was not found'}. ` +
        'The git_bug_* tools will fail; tell the user instead of retrying them.',
    )
    return `${instructions}\n\n${facts.join('\n')}`
  }

  if (snapshot === null) {
    const error = board.error()
    facts.push(
      error === null
        ? 'Status: reading the issue database…'
        : `Status: git-bug could not read this repository (${error.kind}): ${error.message}`,
    )
    if (error !== null && error.kind === 'not-a-repository') {
      facts.push(`\`${config.repoPath}\` is not a git repository, so the git_bug_* tools are inactive here.`)
    }
    return `${instructions}\n\n${facts.join('\n')}`
  }

  const open = snapshot.issues.filter(issue => issue.status === 'open')
  const identity = snapshot.identities[0] ?? null
  facts.push(
    `Repository: \`${snapshot.repoPath}\` · remote \`${snapshot.remote}\` · ` +
      `identity ${identity === null ? 'none yet (the first write creates one)' : `${identity.name} (${identity.humanId})`} · ` +
      `${String(open.length)} open · ${String(snapshot.counts.closed)} closed · ` +
      `${String(countLabel(snapshot.issues, config.taskLabel))} labelled ${config.taskLabel}`,
    '',
  )
  if (identityError !== null) {
    facts.push(`Identity: could not be created automatically (${identityError}); call git_bug_identity with create true before writing.`, '')
  }
  const shown = open.slice(0, config.issueListLimit)
  facts.push(
    formatIssueList(shown, {
      heading: 'Open issues (newest edit first):',
      note: open.length > shown.length
        ? `(showing ${String(shown.length)} of ${String(open.length)}; call git_bug_list for more)`
        : undefined,
    }),
  )
  return `${instructions}\n\n${facts.join('\n')}`
}