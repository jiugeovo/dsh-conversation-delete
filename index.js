/**
 * Host half of the conversation-delete bundle.
 *
 * The Session row menu's Delete action cannot use a shipped Remote method:
 * Session Controller and the persistence seam expose no delete operation. This
 * entry therefore owns the operation end to end and serves it over one
 * authenticated same-origin route that the Client half calls:
 *
 * 1. admit the request and require the owner principal;
 * 2. refuse a Session whose `workspace/session-activity` waterfall reports
 *    running work, so a live turn, subagent, job, or reminder is never deleted
 *    underneath its owner;
 * 3. remove the Session's own persisted log directory (plus every persisted
 *    subagent descendant, which is not a user-facing conversation);
 * 4. drop the derived `session_projcache` records;
 * 5. detach the identities from every Workspace account and clear pin/archive
 *    membership;
 * 6. emit `api-session/removed` for each id so connected Clients drop the rows
 *    without a page reload.
 *
 * The conversation's content-addressed attachments live in the shared
 * attachment store and are deliberately left alone: equal bytes deduplicate
 * across Sessions, so removing them from one conversation could corrupt
 * another.
 *
 * @module @local/dsh-conversation-delete
 */
import { rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

/** Required Host Services: the route carrier, request admission, storage, and grouping. */
export const inject = ['webServer', 'connection', 'sessionPersistence', 'workspaceRegistry']

/** Exact same-origin route the Client half posts one deletion to. */
const ROUTE = '/plugin/dsh-conversation-delete/delete'

/** Largest accepted request body; the only field is one Session id. */
const BODY_LIMIT = 16 * 1024

/** Derived projection-cache domain and table owned by dsh-session-projection-cache. */
const PROJECTION_CACHE_DOMAIN = 'session_projcache'
const PROJECTION_CACHE_TABLE = 'sessions'

/**
 * Register the deletion route for the lifetime of this plugin.
 * @param ctx - Host Context carrying the injected Services.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (req, res) => handle(ctx, req, res),
      }),
    `conversation-delete: POST ${ROUTE}`,
  )
}

/**
 * Answer one deletion request.
 * @param ctx - Host Context.
 * @param req - incoming request.
 * @param res - response owned to completion.
 * @returns resolution after the response is settled.
 */
async function handle(ctx, req, res) {
  const admission = admitOwner(ctx, req, res)
  if (admission === undefined) return
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'method-not-allowed' }, { allow: 'POST' })
    return
  }
  const contentType = String(req.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  if (contentType !== 'application/json') {
    sendJson(res, 415, { ok: false, code: 'unsupported-media-type' })
    return
  }
  let sessionId
  try {
    const body = JSON.parse(await readBoundedBody(req, BODY_LIMIT))
    sessionId = body?.sessionId
  } catch {
    sendJson(res, 400, { ok: false, code: 'invalid-request' })
    return
  }
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    sessionId.length > 512 ||
    sessionId.includes('\u0000')
  ) {
    sendJson(res, 400, { ok: false, code: 'invalid-request' })
    return
  }
  let result
  try {
    result = await deleteConversation(ctx, sessionId)
  } catch (error) {
    console.warn('[conversation-delete] deletion failed:', error)
    result = {
      status: 500,
      body: {
        ok: false,
        code: 'session/delete-failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
  sendJson(res, result.status, result.body)
}

/**
 * Admit the request and require the Host owner principal. A remote Peer that
 * merely authenticates must not be able to erase the owner's conversations.
 * @param ctx - Host Context.
 * @param req - incoming request.
 * @param res - response to reject on.
 * @returns the admitted peer, or `undefined` when the response is already sent.
 */
function admitOwner(ctx, req, res) {
  const admission = ctx.connection.admit(req)
  if ('rejection' in admission) {
    res.statusCode = admission.rejection
    res.end()
    return undefined
  }
  if (admission.peer.principal.kind !== 'owner') {
    sendJson(res, 403, { ok: false, code: 'forbidden' })
    return undefined
  }
  return admission.peer
}

/**
 * Delete one conversation and everything that names it.
 * @param ctx - Host Context.
 * @param sessionId - Session identity the Client targeted.
 * @returns HTTP status and JSON body.
 */
async function deleteConversation(ctx, sessionId) {
  const sessions = optionalService(ctx, 'sessions')
  const stat = await ctx.sessionPersistence.stat(sessionId)
  const live = sessions?.get?.(sessionId)
  if (stat === undefined && live === undefined) {
    return { status: 404, body: { ok: false, code: 'session/not-found' } }
  }

  const snapshots = await ctx.sessionPersistence.list()
  const doomed = collectDoomedSnapshots(stat, snapshots)
  const ids = []
  const seen = new Set()
  for (const id of [sessionId, ...doomed.map((snapshot) => snapshot.header.id)]) {
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }

  for (const id of ids) {
    const activity = await ctx.waterfall(
      'workspace/session-activity',
      { sessionId: id },
      () => Promise.resolve([]),
    )
    if (activity.length > 0) {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'session/active',
          sessionId: id,
          activity: activity.map((entry) => ({ kind: entry.kind, items: entry.items ?? [] })),
        },
      }
    }
  }

  const root = persistenceRoot(ctx)
  if (root === undefined) {
    return { status: 500, body: { ok: false, code: 'session/storage-unavailable' } }
  }

  const warnings = []
  const directories = []
  for (const snapshot of doomed) {
    const directory = sessionDirectory(root, snapshot)
    if (directory === undefined) {
      warnings.push({ code: 'session/path-refused', sessionId: snapshot.header.id })
      continue
    }
    directories.push(directory)
  }
  try {
    for (const directory of directories) await rm(directory, { recursive: true, force: true })
  } catch (error) {
    return {
      status: 500,
      body: {
        ok: false,
        code: 'session/delete-failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }

  try {
    await dropProjectionCache(ctx, ids)
  } catch (error) {
    warnings.push({ code: 'cache/delete-failed', message: errorMessage(error) })
  }

  try {
    await forgetSessions(ctx, ids)
  } catch (error) {
    warnings.push({ code: 'workspace/detach-failed', message: errorMessage(error) })
  }

  for (const id of ids) ctx.emit('api-session/removed', id)
  return { status: 200, body: { ok: true, deleted: ids, warnings } }
}

/**
 * The targeted Session plus every persisted subagent descendant. Fork children
 * carry `parentSession` too but are ordinary conversations, so only
 * `origin: 'subagent'` Sessions are inherited by this cascade.
 * @param target - the targeted Session's stored snapshot, when it has one.
 * @param snapshots - every stored Session snapshot.
 * @returns snapshots to delete, target first.
 */
function collectDoomedSnapshots(target, snapshots) {
  const children = new Map()
  for (const snapshot of snapshots) {
    const parent = snapshot.header.parentSession
    if (snapshot.header.origin !== 'subagent' || parent === undefined) continue
    const siblings = children.get(parent)
    if (siblings === undefined) children.set(parent, [snapshot])
    else siblings.push(snapshot)
  }
  const doomed = []
  const seen = new Set()
  const visit = (snapshot) => {
    const id = snapshot.header.id
    if (seen.has(id)) return
    seen.add(id)
    doomed.push(snapshot)
    for (const child of children.get(id) ?? []) visit(child)
  }
  if (target !== undefined) visit(target)
  return doomed
}

/**
 * Remove the derived projection-cache records through their owning domain, so
 * the cache owner's in-memory state and durability order stay authoritative.
 * @param ctx - Host Context.
 * @param ids - deleted Session identities.
 */
async function dropProjectionCache(ctx, ids) {
  const domain = ctx.get('storageDomain')?.get?.(PROJECTION_CACHE_DOMAIN)
  const table = domain?.table?.(PROJECTION_CACHE_TABLE)
  if (table === undefined) return
  for (const id of ids) await table.delete(id)
}

/**
 * Detach the identities from every Workspace account and clear their pin and
 * archive membership. All three operations are idempotent for unknown ids.
 * @param ctx - Host Context.
 * @param ids - deleted Session identities.
 */
async function forgetSessions(ctx, ids) {
  const registry = ctx.workspaceRegistry
  for (const workspace of registry.list()) {
    for (const id of ids) {
      if (workspace.sessionIds.includes(id)) await workspace.detachSession(id)
    }
  }
  for (const id of ids) {
    await registry.unpinSession(id)
    await registry.unarchiveSession(id)
  }
}

/**
 * Absolute session-log root of the composed persistence backend.
 * @param ctx - Host Context.
 * @returns the root, or `undefined` when it cannot be determined.
 */
function persistenceRoot(ctx) {
  try {
    const configured = ctx.sessionPersistence.config?.root
    if (typeof configured === 'string' && configured.length > 0) return resolve(configured)
  } catch {
    // A service proxy may hide implementation fields; fall through to the launcher home.
  }
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) return resolve(home, 'sessions')
  return undefined
}

/**
 * Directory the JSONL backend owns for one stored Session, mirroring its own
 * `sessionDir(root, cwd, id)` path derivation.
 * @param root - absolute persistence root.
 * @param snapshot - stored Session snapshot.
 * @returns the directory inside `root`, or `undefined` when the derivation escapes it.
 */
function sessionDirectory(root, snapshot) {
  const directory = resolve(
    root,
    snapshot.header.cwd === undefined ? '_no-cwd' : projectKey(snapshot.header.cwd),
    encodeSegment(snapshot.header.id),
  )
  return directory.startsWith(root + sep) ? directory : undefined
}

/**
 * Encode a Session id as one safe path segment, exactly as the JSONL backend
 * does (safe code units literal, every other unit `~XXXX`).
 * @param raw - Session identity.
 * @returns one filesystem-safe segment.
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) out += character
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Readable project-directory key for one Session cwd, exactly as the JSONL
 * backend does (separator runs collapse to one `-`, unsafe units escape).
 * @param cwd - the Session's recorded working directory.
 * @returns one filesystem-safe project directory name.
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index++) {
    const code = cwd.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Read a request body no larger than `limit` bytes.
 * @param req - incoming request.
 * @param limit - byte cap.
 * @returns the UTF-8 body.
 */
function readBoundedBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`request body exceeds ${String(limit)} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Send one JSON response.
 * @param res - response to write.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 * @param headers - extra response headers.
 */
function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end(JSON.stringify(payload))
}

/**
 * Read one optional Host service without failing plugin activation.
 * @param ctx - Host Context.
 * @param name - service key.
 * @returns the service, or `undefined` when absent.
 */
function optionalService(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * Message of an unknown rejection.
 * @param error - rejected value.
 * @returns a displayable message.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
