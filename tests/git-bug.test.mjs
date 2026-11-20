import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GitBugFailure, GitBugFailureKind, createGitBug, identityOf, issueDetailOf, issueSummaryOf } from '../src/git-bug.js'
import { adapter, childProcessRunner, git, makeRepo } from './support.mjs'

test('normalizes a serialized bug summary', () => {
  const summary = issueSummaryOf({
    id: 'abcdef0123',
    human_id: 'abcdef0',
    title: 'Ship it',
    status: 'closed',
    labels: ['triage', 7],
    create_time: { timestamp: 1, time: '2026-01-02T03:04:05Z' },
    edit_time: { timestamp: 2, time: '2026-01-02T04:04:05Z' },
    author: { id: 'u1', human_id: 'u1', name: 'Agent', login: '' },
    participants: [{ id: 'u1', human_id: 'u1', name: 'Agent', login: '' }],
    comments: 2,
  })
  assert.equal(summary.humanId, 'abcdef0')
  assert.equal(summary.status, 'closed')
  assert.deepEqual(summary.labels, ['triage'])
  assert.equal(summary.comments, 2)
  assert.equal(summary.author.name, 'Agent')
  assert.equal(summary.editedAt.time, '2026-01-02T04:04:05Z')
  assert.equal(issueSummaryOf({}), null)
  assert.equal(identityOf({ id: 'x' }).humanId, 'x')
  assert.equal(identityOf(null), null)
})

test('normalizes comments into a detail', () => {
  const detail = issueDetailOf({
    id: 'a1',
    human_id: 'a1',
    title: 'T',
    status: 'open',
    comments: [{ id: 'c1', human_id: 'c1', author: { id: 'u', name: 'A' }, message: 'hello' }],
  })
  assert.equal(detail.commentCount, 1)
  assert.equal(detail.comments[0].message, 'hello')
  assert.equal(detail.comments[0].author.name, 'A')
})

test('rejects a non-repository directory with a classified failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-git-bug-norepo-'))
  await assert.rejects(
    () => adapter(dir).list(),
    (error) => {
      assert.ok(error instanceof GitBugFailure)
      assert.equal(error.kind, GitBugFailureKind.NOT_A_REPOSITORY)
      assert.match(error.message, /\.git not found/)
      return true
    },
  )
})

test('refuses writes without an identity, then creates one', async () => {
  const repo = await makeRepo({ identity: false })
  const api = adapter(repo)
  await assert.rejects(
    () => api.create({ title: 'no identity' }),
    (error) => {
      assert.equal(error.kind, GitBugFailureKind.NO_IDENTITY)
      return true
    },
  )
  const created = await api.ensureIdentity({ name: 'Harness', email: 'harness@example.com' })
  assert.equal(created.created, true)
  assert.equal(created.identity.name, 'Harness')
  const second = await api.ensureIdentity({ name: 'Other', email: 'other@example.com' })
  assert.equal(second.created, false)
  assert.equal(second.identity.name, 'Harness')
  const overview = await api.overview()
  assert.equal(overview.counts.total, 0)
  assert.equal(overview.identities.length, 1)
})

test('creates, reads, comments on, labels, and closes a bug', async () => {
  const repo = await makeRepo()
  const api = adapter(repo)

  const created = await api.create({ title: 'Wire the panel', message: 'first body', labels: ['agent-task'] })
  assert.match(created.humanId, /^[0-9a-f]{7}$/)

  const list = await api.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].title, 'Wire the panel')
  assert.deepEqual(list[0].labels, ['agent-task'])
  assert.equal(list[0].status, 'open')

  const id = list[0].humanId
  const detail = await api.show(id)
  assert.equal(detail.comments.length, 1)
  assert.equal(detail.comments[0].message, 'first body')

  await api.comment(id, 'progress note')
  const withComment = await api.show(id)
  assert.deepEqual(withComment.comments.map(comment => comment.message), ['first body', 'progress note'])

  await api.label(id, 'ui', 'add')
  assert.deepEqual((await api.show(id)).labels.sort(), ['agent-task', 'ui'])
  await api.label(id, 'ui', 'remove')
  assert.deepEqual((await api.show(id)).labels, ['agent-task'])

  assert.equal(await api.setStatus(id, 'closed'), 'closed')
  assert.equal((await api.show(id)).status, 'closed')
  assert.equal((await api.list({ status: 'open' })).length, 0)
  assert.equal((await api.list({ status: 'closed' })).length, 1)
  assert.equal(await api.setStatus(id, 'open'), 'open')

  const overview = await api.overview()
  assert.ok(overview.labels.includes('agent-task'), 'the labels in use are listed')
  assert.ok(!overview.labels.includes('never-used'), 'and only those in use')
  assert.doesNotThrow(async () => api.labels())

  await api.create({ title: 'Second task' })
  const searched = await api.list({ titles: ['Wire'] })
  assert.equal(searched.length, 1)
  assert.equal(searched[0].title, 'Wire the panel')
  // A search term is literal. It reaches the CLI as --title, so the colon in this
  // term can never be read as a qualifier by git-bug's own parser.
  assert.equal((await api.list({ titles: ['status:'] })).length, 0)
  assert.equal((await api.list({ titles: ['wire'] })).length, 1)
  assert.equal((await api.list({ limit: 1 })).length, 1)
})

test('sends a long body over stdin', async () => {
  const repo = await makeRepo()
  const api = adapter(repo)
  const message = 'x'.repeat(60_500)
  await api.create({ title: 'Long body', message })
  const [issue] = await api.list()
  const detail = await api.show(issue.humanId)
  assert.equal(detail.comments[0].message.length, message.length)
  await api.comment(issue.humanId, 'y'.repeat(60_500))
  assert.equal((await api.show(issue.humanId)).comments.at(-1).message.length, 60_500)
})

test('reports an unknown id as a not-found failure', async () => {
  const repo = await makeRepo()
  const api = adapter(repo)
  await assert.rejects(
    () => api.show('deadbeef'),
    (error) => {
      assert.equal(error.kind, GitBugFailureKind.NOT_FOUND)
      return true
    },
  )
})

test('rejects invalid input before spawning', async () => {
  const repo = await makeRepo()
  const api = adapter(repo)
  await assert.rejects(() => api.create({ title: '   ' }), /non-empty title/)
  await assert.rejects(() => api.create({ title: 'a\nb' }), /single line/)
  await assert.rejects(() => api.comment('abc', '  '), /non-empty message/)
  await assert.rejects(() => api.label('abc', ' '), /non-empty value/)
  await assert.rejects(() => api.setStatus('abc', 'maybe'), /unknown status/)
})

test('publishes over one remote and merges it into a second clone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-bug-sync-'))
  const origin = join(root, 'origin.git')
  await git(root, ['init', '-q', '--bare', origin])

  const producer = await makeRepo({ root: join(root, 'producer') })
  await git(producer, ['remote', 'add', 'origin', origin])
  await git(producer, ['push', '-q', '-u', 'origin', 'main'])
  const producerApi = adapter(producer)
  const created = await producerApi.create({ title: 'Shared task', labels: ['agent-task'] })
  const pushed = await producerApi.push('origin')
  assert.equal(pushed.direction, 'push')
  assert.equal(pushed.remote, 'origin')

  const consumer = join(root, 'consumer')
  await git(root, ['clone', '-q', origin, consumer])
  const consumerApi = adapter(consumer)
  const pulled = await consumerApi.pull('origin')
  assert.equal(pulled.direction, 'pull')
  const issues = await consumerApi.list()
  assert.equal(issues.length, 1)
  assert.equal(issues[0].humanId, created.humanId)
  assert.equal(issues[0].title, 'Shared task')
  assert.ok((await consumerApi.overview()).identities.length >= 1)
})

test('probe describes an unusable execution world without throwing', async () => {
  const repo = await makeRepo()
  const missing = adapter(repo, { availability: async () => ({ available: false, reason: 'not installed' }) })
  const probe = await missing.probe()
  assert.equal(probe.available, false)
  assert.equal(probe.repository, false)

  const working = adapter(repo, { availability: async () => ({ available: true, version: 'v9.9.9' }) })
  const ok = await working.probe()
  assert.equal(ok.available, true)
  assert.equal(ok.repository, true)
  assert.equal(ok.version, 'v9.9.9')
  assert.equal(ok.identity.name, 'Agent')

  const outside = adapter(mkdtempSync(join(tmpdir(), 'dsh-git-bug-probe-')))
  const none = await outside.probe()
  assert.equal(none.repository, false)
  assert.equal(none.error.kind, GitBugFailureKind.NOT_A_REPOSITORY)
})

test('a timed-out command is reported instead of hanging', async () => {
  const repo = await makeRepo()
  const slow = adapter(repo, { timeoutMs: 1 })
  await assert.rejects(
    () => slow.list(),
    (error) => {
      assert.equal(error.kind, GitBugFailureKind.TIMEOUT)
      return true
    },
  )
})

test('structured filters are flags and the query text is passed through positionally', async () => {
  const seen = []
  const run = async ({ argv }) => {
    seen.push(argv.slice(1))
    return { code: 0, stdout: '[]', stderr: '' }
  }
  const api = createGitBug({ run, repoPath: '/tmp/repo' })
  await api.list({
    status: 'open',
    labels: ['bug'],
    titles: ['status:'],
    query: 'label:component/ui label:priority:high sort:creation-asc "component/ui" https',
  })
  // One argv, in full: the explicit filters are flags, and the filter text keeps
  // git-bug's own syntax as one positional argument per term. Quotes group words
  // into a single term, and no token is interpreted by the plugin.
  assert.deepEqual(seen, [[
    'bug', '--format', 'json',
    '--status', 'open',
    '--label', 'bug',
    '--title', 'status:',
    '--by', 'edit', '--direction', 'desc',
    '--', 'label:component/ui', 'label:priority:high', 'sort:creation-asc', 'component/ui', 'https',
  ]])
})

test('the filter box keeps a quoted term together for git-bug', async () => {
  const seen = []
  const run = async ({ argv }) => {
    seen.push(argv.slice(1))
    return { code: 0, stdout: '[]', stderr: '' }
  }
  const api = createGitBug({ run, repoPath: '/tmp/repo' })
  await api.list({ query: 'title:"Render issue" label:ui' })
  assert.deepEqual(seen, [[
    'bug', '--format', 'json',
    '--by', 'edit', '--direction', 'desc',
    '--', 'title:Render issue', 'label:ui',
  ]])
})

test('a bare subcommand name stays a query term, not a command', async () => {
  const seen = []
  const run = async ({ argv }) => {
    seen.push(argv.slice(1))
    return { code: 0, stdout: '[]', stderr: '' }
  }
  const api = createGitBug({ run, repoPath: '/tmp/repo' })
  await api.list({ query: 'label' })
  // Without the separator git-bug dispatches its `label` subcommand and then
  // rejects the leading --format flag ("unknown flag: --format").
  assert.deepEqual(seen, [[
    'bug', '--format', 'json',
    '--by', 'edit', '--direction', 'desc',
    '--', 'label',
  ]])
})

test('a caller-supplied ordering wins over the default', async () => {
  const seen = []
  const run = async ({ argv }) => {
    seen.push(argv.slice(1))
    return { code: 0, stdout: '[]', stderr: '' }
  }
  const api = createGitBug({ run, repoPath: '/tmp/repo' })
  await api.list({ sort: 'creation', direction: 'asc' })
  await api.list({})
  assert.deepEqual(seen.map(args => args.slice(args.indexOf('--by'))), [
    ['--by', 'creation', '--direction', 'asc'],
    ['--by', 'edit', '--direction', 'desc'],
  ])
})

test('a malformed qualifier is reported by git-bug and classified', async () => {
  const seen = []
  const run = async ({ argv }) => {
    seen.push(argv.slice(1))
    return { code: 1, stdout: '', stderr: 'Error: empty qualifier or value\n' }
  }
  const api = createGitBug({ run, repoPath: '/tmp/repo' })
  await assert.rejects(
    () => api.list({ query: 'status:' }),
    (error) => {
      assert.equal(error.kind, GitBugFailureKind.INVALID_FILTER)
      assert.match(error.message, /empty qualifier or value/)
      return true
    },
  )
  assert.equal(seen.length, 1, 'the CLI owns the parser, so it runs and reports')
  assert.ok(seen[0].includes('--'), 'the query terms follow the separator')
  assert.equal(seen[0].at(-1), 'status:')
})
