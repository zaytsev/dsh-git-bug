import assert from 'node:assert/strict'
import test from 'node:test'
import { FilterError, QUERY_QUALIFIERS, parseQuery, qualifierSummary, splitTerms } from '../src/query.js'

test('free text splits into terms, honouring quotes', () => {
  assert.deepEqual(splitTerms(''), [])
  assert.deepEqual(splitTerms('  one   two  '), [
    { text: 'one', quoted: false },
    { text: 'two', quoted: false },
  ])
  assert.deepEqual(splitTerms('"two words" one'), [
    { text: 'two words', quoted: true },
    { text: 'one', quoted: false },
  ])
  assert.deepEqual(splitTerms("'single'"), [{ text: 'single', quoted: true }])
})

test('an empty query is an empty filter set', () => {
  const filters = parseQuery('')
  assert.equal(filters.status, null)
  assert.deepEqual(filters.labels, [])
  assert.deepEqual(filters.terms, [])
  assert.deepEqual(filters.titles, [])
})

test('qualifiers become filters a caller can hand to flags', () => {
  const filters = parseQuery('status:open label:bug label:component:ui author:sergey title:panel no:label sort:creation-asc full text')
  assert.equal(filters.status, 'open')
  assert.deepEqual(filters.labels, ['bug', 'component:ui'])
  assert.deepEqual(filters.authors, ['sergey'])
  assert.deepEqual(filters.titles, ['panel'])
  assert.deepEqual(filters.absence, ['label'])
  assert.equal(filters.sort, 'creation')
  assert.equal(filters.direction, 'asc')
  assert.deepEqual(filters.terms, ['full', 'text'])
})

test('a grouped label value is a slash path, and a colon value still maps to a label', () => {
  const filters = parseQuery('label:priority/high label:component/ui')
  assert.deepEqual(filters.labels, ['priority/high', 'component/ui'])

  // Leniency, deliberately: a repository may already hold colon labels. git-bug
  // needs those quoted in its own query language, but the flag form takes them
  // verbatim, and a flag is what this parser produces.
  const legacy = parseQuery('label:priority:high')
  assert.deepEqual(legacy.labels, ['priority:high'])
})

test('a quoted term is literal, even when it looks like a qualifier', () => {
  const filters = parseQuery('"component:ui" "status:"')
  assert.deepEqual(filters.titles, ['component:ui', 'status:'])
  assert.deepEqual(filters.terms, [])
  assert.equal(filters.status, null)
})

test('a malformed qualifier names the vocabulary instead of failing at the CLI', () => {
  const cases = [
    ['status:', /empty value/, 'status'],
    ['status:done', /accepts open, closed/, 'status'],
    ['component:ui', /unknown qualifier "component:"/, 'component'],
    ['sort:creation-sideways', /accepts asc, desc/, 'sort'],
    ['metadata:example', /needs key=value/, 'metadata'],
  ]
  for (const [text, pattern, qualifier] of cases) {
    assert.throws(
      () => parseQuery(text),
      (error) => {
        assert.ok(error instanceof FilterError, text + ' must raise a FilterError')
        assert.match(error.message, pattern)
        assert.equal(error.qualifier, qualifier)
        assert.equal(error.token, text)
        return true
      },
    )
  }
  assert.throws(() => parseQuery('"unbalanced'), /unbalanced " quote/)
})

test('the error message lists every qualifier the parser accepts', () => {
  assert.equal(qualifierSummary(), QUERY_QUALIFIERS.map((key) => key + ':').join(' '))
  assert.throws(() => parseQuery('component:ui'), (error) => {
    for (const key of QUERY_QUALIFIERS) assert.ok(error.message.includes(key + ':'), key + ' is named')
    return true
  })
})
