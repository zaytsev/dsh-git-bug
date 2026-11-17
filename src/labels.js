/**
 * The label vocabulary this plugin suggests.
 *
 * It is a starting framework, not a policy: nothing validates against it, a
 * label outside it is accepted everywhere, and a repository can replace the
 * whole set through `labelVocabulary`. What it buys is consistency — the
 * prompt, the tool descriptions, the panel pickers and the README all read the
 * vocabulary from here, so an agent and a human choose the same words instead
 * of inventing one-offs.
 * @module dsh-git-bug/labels
 */

/** What kind of work an issue describes. */
export const KINDS = ['bug', 'feature', 'enhancement', 'refactor', 'docs', 'todo']

/** How soon it should be done. */
export const PRIORITIES = ['low', 'normal', 'high', 'urgent']

/** How bad it is; bugs only. */
export const SEVERITIES = ['minor', 'major', 'critical', 'blocker']

/** Lifecycle states that are not covered by open/closed. */
export const STATES = ['blocked', 'needs-info', 'duplicate', 'wontfix', 'cant-reproduce']

/** Marks work an agent owns. */
export const OWNERSHIP = 'ai'

/**
 * What separates a label group from its value: `priority/high`, `component/ui`.
 *
 * Checked against git-bug v0.11.0, because the obvious separator is the wrong one:
 * the query grammar puts `:` between a qualifier and its value and splits at the
 * *last* colon, so a label containing one cannot be written unquoted —
 * `git-bug bug 'label:priority:high'` fails with `unknown qualifier "label:priority"`,
 * while `label:"priority:high"` works and `label:priority/high` needs no quoting at
 * all. Slash keeps every label filter expressible the plain way, in the panel, in
 * the tools and in a human's own shell.
 */
export const GROUP_SEPARATOR = '/'

/** Prefix for the free-form component label, e.g. `component/panel`. */
export const COMPONENT_PREFIX = 'component' + GROUP_SEPARATOR

/**
 * Order-preserving de-duplication.
 * @param values - candidate labels.
 * @returns the labels without repeats.
 */
function unique(values) {
  return [...new Set(values)]
}

/**
 * Build the vocabulary as plain data for the prompt, the API and the panel.
 * @param overrides - replacements for any group, e.g. `{ kinds: ['bug'] }`.
 * @returns the grouped vocabulary plus a flat suggestion list.
 */
export function labelVocabulary(overrides = {}) {
  const kinds = overrides.kinds ?? KINDS
  const priorities = (overrides.priorities ?? PRIORITIES).map(level => 'priority' + GROUP_SEPARATOR + level)
  const severities = (overrides.severities ?? SEVERITIES).map(level => 'severity' + GROUP_SEPARATOR + level)
  const states = overrides.states ?? STATES
  const ownership = overrides.ownership ?? OWNERSHIP
  const componentPrefix = overrides.componentPrefix ?? COMPONENT_PREFIX
  return {
    kinds,
    priorities,
    severities,
    states,
    ownership,
    componentPrefix,
    // What a picker offers; the component prefix stays free text past itself.
    suggestions: unique([...kinds, ...priorities, ...severities, ...states, ownership]),
  }
}

/**
 * One sentence for an already-built vocabulary — the form the prompt and the
 * tool text take, so a built vocabulary is never re-prefixed.
 * @param v - a value from {@link labelVocabulary}.
 * @returns the sentence, identical for identical input.
 */
export function formatVocabulary(v) {
  return `Labels are shared vocabulary, not a rule: kind (${v.kinds.join(', ')}), ` +
    `priority (${v.priorities.join(', ')}), severity for bugs (${v.severities.join(', ')}), ` +
    `state (${v.states.join(', ')}), ${v.componentPrefix}<area> for the part of the codebase, ` +
    `and \`${v.ownership}\` for work an agent owns. Use another label when none of these fit.`
}

/**
 * Build the vocabulary from overrides and describe it in one sentence.
 * @param overrides - replacements for any group.
 * @returns the sentence.
 */
export function describeVocabulary(overrides = {}) {
  return formatVocabulary(labelVocabulary(overrides))
}