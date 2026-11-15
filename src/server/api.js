/**
 * Same-origin HTTP API behind the GUI Issues panel.
 *
 * Every route is a thin JSON projection of the repository adapter, mounted as
 * one prefix route on the harness web server so the panel needs no RPC
 * plumbing. Failures keep their classification: a 404 means "no such bug", a
 * 409 means "the repository is not writable yet" (no identity / not a git
 * repository), and a 503 means git-bug itself is missing.
 * @module dsh-git-bug/server/api
 */

import { GitBugFailure, GitBugFailureKind } from '../git-bug.js'

/** Refuse request bodies larger than this; issue bodies are small. */
const MAX_BODY_BYTES = 1_000_000

/** One request-level rejection the panel can act on. */
class ApiError extends Error {
  /**
   * @param status - HTTP status code.
   * @param message - panel-facing message.
   * @param kind - machine-readable failure class.
   */
  constructor(status, message, kind = 'bad-request') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.kind = kind
  }
}

/** Map one adapter failure onto an HTTP status. */
function statusOf(error) {
  switch (error.kind) {
    case GitBugFailureKind.UNAVAILABLE:
      return 503
    case GitBugFailureKind.NOT_A_REPOSITORY:
    case GitBugFailureKind.NO_IDENTITY:
      return 409
    case GitBugFailureKind.NOT_FOUND:
      return 404
    case GitBugFailureKind.TIMEOUT:
      return 504
    default:
      return 400
  }
}

/** Write one JSON response. */
function send(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read and parse a JSON request body. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ApiError(400, 'request body must be a JSON object')
    }
    return parsed
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, 'request body is not valid JSON')
  }
}

/** Read a repeated query parameter into a string list. */
function repeated(url, key) {
  return url.searchParams.getAll(key).flatMap(value => value.split(',')).map(value => value.trim()).filter(value => value.length > 0)
}

/** Read one optional positive integer query parameter. */
function positiveInt(url, key, fallback) {
  const raw = url.searchParams.get(key)
  if (raw === null) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ApiError(400, `${key} must be a positive integer`)
  return parsed
}

/**
 * Build the request handler mounted at the API prefix.
 *
 * @param deps - repository adapter, availability facts, and configuration.
 * @returns the HTTP handler for the prefix route.
 */
export function createApiHandler(deps) {
  const { repo, config, availability } = deps

  /**
   * Dispatch one request under the API prefix.
   * @param req - incoming request.
   * @param res - response to write.
   */
  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.slice(config.apiPath.length).replace(/\/$/, '')
      const method = req.method ?? 'GET'

      if (path === '' || path === '/overview') {
        if (method !== 'GET') throw new ApiError(405, `${method} is not allowed here`)
        const overview = await repo.overview()
        const found = availability === undefined ? null : await availability()
        send(res, 200, {
          repoPath: overview.repoPath,
          remote: overview.remote,
          identity: overview.identities[0] ?? null,
          identities: overview.identities,
          counts: overview.counts,
          issues: overview.issues,
          taskLabel: config.taskLabel,
          availability: found,
        })
        return
      }

      if (path === '/issues') {
        if (method === 'GET') {
          const status = url.searchParams.get('status')
          const issues = await repo.list({
            status: status === 'open' || status === 'closed' ? status : undefined,
            labels: repeated(url, 'label'),
            search: repeated(url, 'search'),
            limit: positiveInt(url, 'limit', 200),
          })
          send(res, 200, { issues, taskLabel: config.taskLabel })
          return
        }
        if (method === 'POST') {
          const body = await readBody(req)
          const labels = Array.isArray(body.labels) ? body.labels.map(String) : []
          const created = await repo.create({
            title: typeof body.title === 'string' ? body.title : '',
            message: typeof body.message === 'string' ? body.message : '',
            labels,
          })
          send(res, 201, created)
          return
        }
        throw new ApiError(405, `${method} is not allowed here`)
      }

      const issueMatch = /^\/issues\/([^/]+)(\/comments|\/status|\/labels)?$/.exec(path)
      if (issueMatch !== null) {
        const id = decodeURIComponent(issueMatch[1])
        const action = issueMatch[2] ?? ''
        if (action === '' && method === 'GET') {
          send(res, 200, await repo.show(id))
          return
        }
        if (action === '/comments' && method === 'POST') {
          const body = await readBody(req)
          await repo.comment(id, typeof body.message === 'string' ? body.message : '')
          send(res, 200, { id })
          return
        }
        if (action === '/status' && method === 'POST') {
          const body = await readBody(req)
          const status = await repo.setStatus(id, body.status)
          send(res, 200, { id, status })
          return
        }
        if (action === '/labels' && method === 'POST') {
          const body = await readBody(req)
          const label = typeof body.label === 'string' ? body.label : ''
          const result = await repo.label(id, label, body.action === 'remove' ? 'remove' : 'add')
          send(res, 200, { id, ...result })
          return
        }
        throw new ApiError(405, `${method} is not allowed on ${path}`)
      }

      if (path === '/sync' && method === 'POST') {
        const body = await readBody(req)
        const remote = typeof body.remote === 'string' && body.remote.length > 0 ? body.remote : undefined
        const result = body.action === 'push' ? await repo.push(remote) : await repo.pull(remote)
        send(res, 200, result)
        return
      }

      if (path === '/identity') {
        if (method === 'POST') {
          const body = await readBody(req)
          const result = await repo.ensureIdentity({
            name: typeof body.name === 'string' && body.name.length > 0 ? body.name : config.identity.name,
            email: typeof body.email === 'string' && body.email.length > 0 ? body.email : config.identity.email,
          })
          send(res, 200, result)
          return
        }
        if (method === 'GET') {
          const overview = await repo.overview()
          send(res, 200, { identity: overview.identities[0] ?? null, identities: overview.identities })
          return
        }
        throw new ApiError(405, `${method} is not allowed here`)
      }

      throw new ApiError(404, `unknown endpoint ${path}`)
    } catch (error) {
      if (error instanceof ApiError) {
        send(res, error.status, { error: error.message, kind: error.kind })
        return
      }
      if (error instanceof GitBugFailure) {
        send(res, statusOf(error), { error: error.message, kind: error.kind })
        return
      }
      send(res, 500, { error: error instanceof Error ? error.message : String(error), kind: 'internal' })
    }
  }
}