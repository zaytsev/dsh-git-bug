import assert from 'node:assert/strict'
import test from 'node:test'
import { COMPONENT_PREFIX, GROUP_SEPARATOR, OWNERSHIP, describeVocabulary, labelVocabulary } from '../src/labels.js'

test('the default vocabulary is the agreed framework', () => {
  const v = labelVocabulary()
  assert.deepEqual(v.kinds, ['bug', 'feature', 'enhancement', 'refactor', 'docs', 'todo'])
  assert.deepEqual(v.priorities, ['priority/low', 'priority/normal', 'priority/high', 'priority/urgent'])
  assert.deepEqual(v.severities, ['severity/minor', 'severity/major', 'severity/critical', 'severity/blocker'])
  assert.deepEqual(v.states, ['blocked', 'needs-info', 'duplicate', 'wontfix', 'cant-reproduce'])
  assert.equal(v.ownership, 'ai')
  assert.equal(v.componentPrefix, 'component/')
  assert.equal(OWNERSHIP, 'ai')
  assert.equal(COMPONENT_PREFIX, 'component/')
  assert.equal(GROUP_SEPARATOR, '/')
  // Suggestions are the closed groups plus ownership; the component prefix stays free text.
  assert.equal(v.suggestions.length, 6 + 4 + 4 + 5 + 1)
  assert.ok(v.suggestions.includes('ai'))
  assert.ok(!v.suggestions.some(label => label.startsWith('component/')))
  // No colon anywhere: git-bug's query grammar splits a qualifier at the last colon,
  // so an unquoted `label:priority:high` is a parse error while `label:priority/high`
  // is not. The vocabulary must stay expressible in a plain query.
  assert.deepEqual(v.suggestions.filter(label => label.includes(':')), [])
})

test('the description is derived, stable, and states that it is not a rule', () => {
  const text = describeVocabulary()
  assert.equal(text, describeVocabulary(), 'same input, same text')
  assert.match(text, /not a rule/)
  assert.match(text, /`ai` for work an agent owns/)
  assert.match(text, /component\/<area>/)
  // Keep it prompt-sized: it lives in the byte-stable section.
  assert.ok(text.length < 500, `description is ${String(text.length)} chars`)
})

test('a repository can replace any group without changing the rest', () => {
  const v = labelVocabulary({ kinds: ['defect'], priorities: ['hot'] })
  assert.deepEqual(v.kinds, ['defect'])
  assert.deepEqual(v.priorities, ['priority/hot'])
  assert.deepEqual(v.states, labelVocabulary().states)
  assert.match(describeVocabulary({ kinds: ['defect'] }), /kind \(defect\)/)
})
