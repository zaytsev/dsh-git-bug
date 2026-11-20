/**
 * The system-prompt section. It is a pure function of config: provider caches
 * match prefixes byte-for-byte, so repository state here would invalidate the
 * cached prefix of every later request.
 * @module dsh-git-bug/server/prompt
 */

import { formatVocabulary } from '../labels.js'

/** Section name registered with the system-prompt registry. */
export const SECTION_NAME = 'dsh-git-bug'

/**
 * Render the instructions for one plugin instance.
 *
 * @param config - resolved plugin configuration; the only input.
 * @returns the section text, identical for every assembly of this activation.
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
    `Tools (they act on \`${config.repoPath}\`, remote \`${config.remote}\`): ${tools}.`,
    '',
    'How to use it:',
    '',
    `1. **Your first tool call in any task that will take more than one step is \`git_bug_list\`.** ` +
      `Not a later step, not "when needed": before you plan, before you touch a file. The list is ` +
      `the workspace's shared task record, and this prompt does not carry it. Never create an ` +
      `issue that already exists; update it instead.`,
    `2. Create one issue per unit of work with \`git_bug_create\` and the label ` +
      `\`${config.taskLabel}\` before you start it. Keep it current as you go: ` +
      `\`git_bug_comment\` for progress, decisions, and blockers, ` +
      `\`git_bug_status\` closed the moment the work is genuinely done.`,
    `3. \`todo_write\` is a different thing: a private step list inside a single turn — invisible ` +
      `to the user, gone with the session. Anything that must outlive the turn, be visible in the ` +
      `Issues panel, or be shared goes to git-bug instead.`,
    '4. The user sees and edits the same issues in the Issues panel: treat issue text as shared '
      + 'state, not as scratch space, and never rewrite an issue title or body that someone else wrote.',
    `5. ${formatVocabulary(config.labelVocabulary)}`,
    `6. \`git_bug_sync\` with action \`pull\` refreshes from the git remote and ` +
      `\`push\` publishes; pull before trusting an id you did not just see, and push only when ` +
      `the user asks to share.`,
  ].join('\n')
}