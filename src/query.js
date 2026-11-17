/**
 * The filter vocabulary of git-bug, made explicit.
 *
 * git-bug's list command accepts two unrelated things through one door:
 * structured qualifiers (status:open, sort:edit-desc) and free text. Its own
 * parser owns both, so a half-typed qualifier (status:) surfaces as the CLI
 * error "empty qualifier or value", and a term that merely contains a colon
 * (component:ui) is read as an unknown qualifier. Whoever typed that was
 * searching, not writing a query.
 *
 * This module keeps the two modes apart. Literal terms go to the CLI's --title
 * flag, which accepts any characters; query syntax is parsed here first, so a
 * bad qualifier is answered with the valid vocabulary rather than with the
 * CLI's diagnostic.
 * @module dsh-git-bug/query
 */

/** Status values the status: qualifier accepts. */
export const STATUS_VALUES = Object.freeze(['open', 'closed'])

/** Values the no: qualifier accepts: absence of a label. */
export const ABSENCE_VALUES = Object.freeze(['label'])

/** Sort keys the sort: qualifier accepts. */
export const SORT_KEYS = Object.freeze(['id', 'creation', 'edit'])

/** Sort directions the sort: qualifier accepts. */
export const SORT_DIRECTIONS = Object.freeze(['asc', 'desc'])

/** Every qualifier key of git-bug's query language. */
export const QUERY_QUALIFIERS = Object.freeze([
  'status', 'label', 'author', 'actor', 'participant', 'title', 'metadata', 'no', 'sort',
])

/**
 * One filter the plugin refused to send to git-bug.
 *
 * It is raised before any process starts, so the message can be written for a
 * reader who never learned that git-bug has a query language.
 */
export class FilterError extends Error {
  /**
   * @param message - the reader-facing explanation.
   * @param details - the rejected token and qualifier, when one token is at fault.
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'FilterError'
    /** The token that was rejected, when one token is at fault. */
    this.token = details.token ?? null
    /** The qualifier key involved, when the token carried one. */
    this.qualifier = details.qualifier ?? null
  }
}

/**
 * The qualifier list as one line, for error messages and tool descriptions.
 * @returns the qualifier keys, each with a trailing colon.
 */
export function qualifierSummary() {
  return QUERY_QUALIFIERS.map(key => key + ':').join(' ')
}

/**
 * Split free text into terms, honouring single and double quotes so that one
 * term may contain spaces.
 * @param text - the text to split.
 * @returns one entry per term, remembering whether it was quoted.
 */
export function splitTerms(text) {
  if (typeof text !== 'string') return []
  const terms = []
  let current = ''
  let quoted = null
  let wasQuoted = false
  for (const char of text) {
    if (quoted !== null) {
      if (char === quoted) quoted = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quoted = char
      wasQuoted = true
      continue
    }
    if (/\s/.test(char)) {
      if (wasQuoted || current.length > 0) terms.push({ text: current, quoted: wasQuoted })
      current = ''
      wasQuoted = false
      continue
    }
    current += char
  }
  if (quoted !== null) {
    throw new FilterError('unbalanced ' + quoted + ' quote in ' + JSON.stringify(text) + '; close it or drop it')
  }
  if (wasQuoted || current.length > 0) terms.push({ text: current, quoted: wasQuoted })
  return terms.filter(term => term.text.length > 0)
}

/** The empty filter set, so no caller has to handle a null shape. */
function emptyFilters() {
  return {
    status: null,
    labels: [],
    authors: [],
    actors: [],
    participants: [],
    titles: [],
    metadata: [],
    absence: [],
    sort: null,
    direction: null,
    terms: [],
  }
}

/**
 * Read one enum-valued qualifier, or explain what the qualifier does accept.
 * @param token - the token as the caller wrote it, for the message.
 * @param key - the qualifier key.
 * @param value - the value to check.
 * @param allowed - the accepted values.
 * @returns the value.
 */
function enumValue(token, key, value, allowed) {
  if (allowed.includes(value)) return value
  throw new FilterError(
    '"' + token + '" is not valid: ' + key + ': accepts ' + allowed.join(', ') + '.',
    { token, qualifier: key },
  )
}

/**
 * Apply one sort: qualifier, which carries its direction after a dash.
 * @param filters - the filter set being built.
 * @param value - the qualifier value, such as edit-desc.
 * @param token - the token as the caller wrote it.
 */
function applySort(filters, value, token) {
  const parts = value.split('-')
  if (parts.length > 2) {
    throw new FilterError('"' + token + '" is not valid: sort: takes a key, or a key and a direction after a dash.', {
      token,
      qualifier: 'sort',
    })
  }
  filters.sort = enumValue(token, 'sort', parts[0], SORT_KEYS)
  if (parts.length === 2) filters.direction = enumValue(token, 'sort', parts[1], SORT_DIRECTIONS)
}

/**
 * Apply one validated qualifier to the filter set being built.
 * @param filters - the filter set.
 * @param key - the qualifier key.
 * @param value - the non-empty value after the colon.
 * @param token - the token as the caller wrote it.
 */
function applyQualifier(filters, key, value, token) {
  switch (key) {
    case 'status':
      filters.status = enumValue(token, key, value, STATUS_VALUES)
      return
    case 'label':
      filters.labels.push(value)
      return
    case 'author':
      filters.authors.push(value)
      return
    case 'actor':
      filters.actors.push(value)
      return
    case 'participant':
      filters.participants.push(value)
      return
    case 'title':
      filters.titles.push(value)
      return
    case 'no':
      filters.absence.push(enumValue(token, key, value, ABSENCE_VALUES))
      return
    case 'metadata':
      if (!value.includes('=')) {
        throw new FilterError('"' + token + '" needs key=value, as in metadata:github-url=https://example.test/1.', {
          token,
          qualifier: key,
        })
      }
      filters.metadata.push(value)
      return
    case 'sort':
      applySort(filters, value, token)
      return
    default:
      return
  }
}

/**
 * Parse one git-bug query string into filters this plugin can hand to flags.
 *
 * Quoted terms are always literal, which is the escape hatch for a term that
 * looks like a qualifier (component:ui) or is one (status:).
 * @param text - the query string; an empty string yields an empty filter set.
 * @returns the filter set, including the free-text terms left over.
 */
export function parseQuery(text) {
  const filters = emptyFilters()
  for (const term of splitTerms(text)) {
    if (term.quoted) {
      filters.titles.push(term.text)
      continue
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(term.text)
    if (match === null) {
      filters.terms.push(term.text)
      continue
    }
    const key = match[1]
    const value = match[2]
    if (!QUERY_QUALIFIERS.includes(key)) {
      throw new FilterError(
        'unknown qualifier "' + key + ':" in ' + JSON.stringify(term.text) + '. Qualifiers: '
        + qualifierSummary() + '. Quote the term to search for it literally.',
        { token: term.text, qualifier: key },
      )
    }
    if (value.length === 0) {
      throw new FilterError(
        'empty value: "' + term.text + '" needs a value after the colon. Qualifiers: ' + qualifierSummary() + '.',
        { token: term.text, qualifier: key },
      )
    }
    applyQualifier(filters, key, value, term.text)
  }
  return filters
}
