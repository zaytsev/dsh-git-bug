/**
 * Cached issue board for prompt assembly and the HTTP API.
 *
 * Prompt assembly must never wait on a subprocess, so the board owns one
 * snapshot refreshed in the background: readers get the last good value
 * immediately and a refresh is scheduled when the value is stale. Mutations
 * invalidate the snapshot so the next read reflects them.
 * @module dsh-git-bug/board
 */

/** Milliseconds a snapshot stays fresh before a background refresh is scheduled. */
export const DEFAULT_TTL_MS = 5000

/**
 * Create the board.
 * @param options - the repository adapter and freshness window.
 * @returns the board reader and mutator surface.
 */
export function createBoard(options) {
  const { repo, ttlMs = DEFAULT_TTL_MS } = options
  let snapshot = null
  let inflight = null
  let lastError = null

  /** Refresh the snapshot, coalescing concurrent callers onto one probe. */
  async function refresh() {
    if (inflight !== null) return inflight
    inflight = (async () => {
      try {
        const overview = await repo.overview()
        snapshot = {
          ...overview,
          fetchedAt: Date.now(),
        }
        lastError = null
        return snapshot
      } catch (error) {
        lastError = {
          kind: typeof error?.kind === 'string' ? error.kind : 'command-failed',
          message: error instanceof Error ? error.message : String(error),
        }
        throw error
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  return {
    /**
     * Read the current snapshot without waiting, optionally scheduling a
     * refresh when it is older than the freshness window.
     * @returns the snapshot, or null before the first successful refresh.
     */
    read() {
      const now = Date.now()
      if (snapshot === null || now - snapshot.fetchedAt > ttlMs) {
        refresh().catch(() => {
          // The last good snapshot stays visible; the error surfaces to the
          // HTTP API, which reports it to the panel.
        })
      }
      return snapshot
    },
    /** The most recent refresh failure, cleared by the next success. */
    error() {
      return lastError
    },
    /** Force a refresh now. */
    async reload() {
      return refresh()
    },
    /** Mark the snapshot stale so the next read refreshes it. */
    invalidate() {
      if (snapshot !== null) snapshot = { ...snapshot, fetchedAt: 0 }
    },
  }
}
