import assert from 'node:assert/strict'
import test from 'node:test'
import { countLabel, formatDigest, formatIssueDetail, formatIssueList, identityLabel, issueRow, stamp } from '../src/format.js'

const summary = {
  id: 'a'.repeat(40),
  humanId: 'aaaaaaa',
  title: 'Ship the panel',
  status: 'open',
  labels: ['agent-task', 'ui'],
  createdAt: { time: '2026-11-15T09:00:00Z', epoch: 1 },
  editedAt: { time: '2026-11-15T09:30:00Z', epoch: 2 },
  author: { id: 'u1', humanId: 'u1', name: 'Agent', login: '' },
  participants: [],
  comments: 2,
}

test('stamps timestamps and identities', () => {
  assert.equal(stamp({ time: '2026-11-15T09:30:00Z' }), '2026-11-15 09:30')
  assert.equal(stamp({ epoch: 0 }), '1970-01-01 00:00')
  assert.equal(stamp(null), '')
  assert.equal(stamp({}), '')
  assert.equal(identityLabel({ name: 'Agent', humanId: 'u1' }), 'Agent (u1)')
  assert.equal(identityLabel({ name: '', humanId: 'u1' }), 'u1')
  assert.equal(identityLabel({ name: 'Agent' }), 'Agent')
  assert.equal(identityLabel(null), 'unknown')
})

test('renders one issue row with labels and comment count', () => {
  const row = issueRow(summary)
  assert.match(row, /2026-11-15 09:30/)
  assert.match(row, /open/)
  assert.match(row, /aaaaaaa/)
  assert.match(row, /Ship the panel/)
  assert.match(row, /\[agent-task, ui\]/)
  assert.match(row, /\(2 comments\)/)
  const bare = issueRow({ ...summary, labels: [], comments: 0 })
  assert.doesNotMatch(bare, /\[/)
})

test('renders a list with counts, heading, and an empty case', () => {
  const text = formatIssueList([summary, { ...summary, status: 'closed', humanId: 'bbbbbbb', title: 'Done', comments: 0, labels: [] }], { heading: 'Open issues:' })
  assert.match(text, /^Open issues:\n1 open · 1 closed/)
  assert.match(text, /UPDATED \(UTC\)/)
  assert.match(text, /Done/)
  assert.equal(formatIssueList([]), '0 open · 0 closed\nno issues match')
  assert.match(formatIssueList([summary], { note: '(truncated)' }), /\(truncated\)$/)
})

test('renders detail with comments and without them', () => {
  const detail = {
    ...summary,
    comments: [
      { id: 'c1', humanId: 'c1aaaaa', author: summary.author, message: 'first body', createdAt: null },
      { id: 'c2', humanId: 'c2bbbbb', author: summary.author, message: 'second body', createdAt: null },
    ],
    commentCount: 2,
  }
  const text = formatIssueDetail(detail)
  assert.match(text, /^aaaaaaa {2}open {2}Ship the panel/)
  assert.match(text, /^id: a{40}$/m)
  assert.match(text, /author: Agent \(u1\)/)
  assert.match(text, /labels: agent-task, ui/)
  assert.match(text, /comments \(2\):/)
  assert.match(text, /--- #1 c1aaaaa by Agent \(u1\)/)
  assert.match(text, /second body/)
  assert.match(formatIssueDetail({ ...detail, comments: [], commentCount: 0 }), /\(no comments\)/)
})

test('digest and label counting follow the open set', () => {
  const issues = [summary, { ...summary, status: 'closed' }, { ...summary, humanId: 'ccccccc' }]
  assert.equal(countLabel(issues, 'agent-task'), 2)
  assert.equal(countLabel(issues, 'missing'), 0)
  assert.equal(formatDigest({ open: 2, closed: 1 }, 'agent-task', issues), '2 open · 1 closed · 2 labelled agent-task')
  assert.equal(formatDigest({ open: 0, closed: 0 }, 'agent-task', []), '0 open · 0 closed')
})
