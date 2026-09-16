/**
 * The Yeonjae Studio operator API (Checkpoint 7).
 *
 * Shape of this file: every route is a thin, validated, authorized adapter over a service that already
 * exists and is already tested. The API deliberately contains NO canon, selection or workflow logic — the
 * invariants of Checkpoints 2–6 (accepted-only canon, atomic commits, winner-only propagation, budget
 * checks, replay-only providers) live in `packages/*` and must keep holding whether a request arrives over
 * HTTP or through the CLI. Duplicating any of that here would create a second, weaker enforcement path.
 *
 * Every request therefore follows the same spine:
 *   authenticate → verify membership → open an RLS-scoped connection → validate input → call a service
 *   → serialize a safe response, with errors rendered as RFC 9457 problem documents.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  createSession,
  entitiesOfType,
  listCommits,
  manuscriptVersionsOf,
  revokeSession,
  timelinesOf,
  verifyPassword,
  workspacesOf,
  type Client,
  type Pool,
} from '@yeonjae/db';
import { exportAccepted, workflowIdFor, workflowStatus } from '@yeonjae/workflows';
import {
  authenticate,
  CSRF_HEADER,
  inScope,
  requireRole,
  requireWorkspace,
  SESSION_COOKIE,
  WORKSPACE_HEADER,
  type Principal,
  type WorkspaceScope,
} from './auth.js';
import { withIdempotency } from './idempotency.js';
import { ApiError, PROBLEM_CONTENT_TYPE, toProblem } from './problem.js';
import {
  asObject,
  encodeCursor,
  parsePage,
  requireEnum,
  requireInt,
  requireString,
  requireUuid,
} from './validate.js';

export interface ApiOptions {
  readonly pool: Pool;
  /**
   * Cookies are marked `Secure` unless this is explicitly false for local HTTP development. It defaults to
   * secure, so forgetting to configure a deployment cannot downgrade the cookie.
   */
  readonly secureCookies?: boolean | undefined;
  readonly logger?: boolean | undefined;
}

/** Maximum JSON body. A bounded body is the cheapest defence against memory-exhaustion requests. */
const BODY_LIMIT_BYTES = 1_000_000;

export function buildApi(options: ApiOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: BODY_LIMIT_BYTES,
    // Fastify generates request ids; ours are UUIDs so they can be quoted in problem documents and matched
    // against structured logs and workflow traces.
    genReqId: () => randomUUID(),
    disableRequestLogging: true,
  });
  const pool = options.pool;
  const secure = options.secureCookies ?? true;

  app.addHook('onRequest', async (req, reply) => {
    // Security headers on every response, including errors.
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    const problem = toProblem(err, req.id);
    // The real error is logged against the request id; only the safe document goes to the client.
    if (problem.status >= 500) req.log.error({ err, request_id: req.id }, 'request failed');
    reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  app.setNotFoundHandler((req, reply) => {
    const problem = toProblem(new ApiError('NOT_FOUND', 'No such route.'), req.id);
    reply.status(404).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  // ---- health and readiness -------------------------------------------------------------------------
  // Liveness answers "is the process up"; readiness answers "can it serve", which requires the database.
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      // Never echo the database error: readiness is a boolean to a load balancer, not a diagnostic channel.
      return reply.status(503).type(PROBLEM_CONTENT_TYPE).send({
        type: 'urn:yeonjae:error:INTERNAL_ERROR',
        title: 'Not ready',
        status: 503,
        detail: 'The database is not reachable.',
        code: 'INTERNAL_ERROR',
        request_id: _req.id,
      });
    }
  });

  // ---- authentication -------------------------------------------------------------------------------
  app.post('/v1/auth/login', async (req, reply) => {
    const body = asObject(req.body);
    const email = requireString(body, 'email', { max: 320 });
    const password = requireString(body, 'password', { max: 1024, nfc: false });
    const user = await verifyPassword(pool, email, password);
    // One message for every failure mode, so the endpoint is not an account-existence oracle.
    if (!user) throw new ApiError('INVALID_CREDENTIALS', 'The email or password is incorrect.');
    const session = await createSession(pool, { userId: user.id });
    reply.header(
      'set-cookie',
      [
        `${SESSION_COOKIE}=${encodeURIComponent(session.token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        secure ? 'Secure' : '',
        `Max-Age=${Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)}`,
      ]
        .filter(Boolean)
        .join('; '),
    );
    return {
      user: { id: user.id, email: user.email, display_name: user.display_name },
      // The CSRF token is returned in the body (not a cookie) so a cross-site request cannot obtain it.
      csrf_token: session.csrfToken,
      workspaces: await workspacesOf(pool, user.id),
    };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const principal = await authenticate(pool, toRequestLike(req));
    if (principal.session) await revokeSession(pool, principal.session.id);
    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`,
    );
    return { status: 'logged_out' };
  });

  app.get('/v1/me', async (req) => {
    const principal = await authenticate(pool, toRequestLike(req));
    return {
      user: {
        id: principal.user.id,
        email: principal.user.email,
        display_name: principal.user.display_name,
      },
      via: principal.via,
      workspaces: await workspacesOf(pool, principal.user.id),
    };
  });

  // ---- projects -------------------------------------------------------------------------------------
  app.get('/v1/projects', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const page = parsePage(req.query as Record<string, unknown>);
    return inScope(pool, scope, async (c) => {
      // RLS already restricts to the workspace; ordering by id keeps the cursor stable and deterministic.
      const rows = await c.query<{
        id: string;
        title: string;
        status: string;
        canon_version: number;
        quality_tier: string;
        operating_mode: string;
      }>(
        `SELECT id, title, status, canon_version, quality_tier, operating_mode
           FROM projects
          WHERE ($1::uuid IS NULL OR id > $1::uuid)
          ORDER BY id
          LIMIT $2`,
        [page.after ?? null, page.limit + 1],
      );
      return pageOf(rows.rows, page.limit, (r) => r.id);
    });
  });

  app.post('/v1/projects', async (req, reply) => {
    const scope = await scoped(pool, req);
    // Creating a project spends nothing yet, but it is a write: viewers may not.
    requireRole(scope, 'editor');
    const body = asObject(req.body);
    const title = requireString(body, 'title', { max: 200 });
    const tier =
      body.quality_tier === undefined
        ? 'standard'
        : requireEnum(
            body.quality_tier,
            ['economy', 'standard', 'premium'] as const,
            'body.quality_tier',
          );
    const mode =
      body.operating_mode === undefined
        ? 'assisted'
        : requireEnum(
            body.operating_mode,
            ['assisted', 'semi_auto', 'autopilot'] as const,
            'body.operating_mode',
          );

    const outcome = await inScope(pool, scope, async (c) =>
      withIdempotency(
        c,
        {
          workspaceId: scope.workspaceId,
          key: headerOf(req, 'idempotency-key'),
          method: 'POST',
          route: '/v1/projects',
          body: req.body,
        },
        async () => {
          const created = await createProjectScoped(c, {
            workspaceId: scope.workspaceId,
            title,
            qualityTier: tier,
            operatingMode: mode,
          });
          await audit(c, scope, {
            action: 'project.create',
            targetKind: 'project',
            targetId: created.projectId,
            requestId: req.id,
            detail: { title },
          });
          return { status: 201, body: created };
        },
      ),
    );
    return reply.status(outcome.status).send(outcome.body);
  });

  app.get('/v1/projects/:projectId', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    return inScope(pool, scope, async (c) => {
      const project = await projectOr404(c, projectId);
      const chapters = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM chapters WHERE project_id = $1 AND status = 'accepted'`,
        [projectId],
      );
      const spend = await c.query<{ cents: string }>(
        `SELECT coalesce(sum(cost_cents), 0)::text AS cents FROM llm_calls WHERE project_id = $1`,
        [projectId],
      );
      return {
        ...project,
        accepted_chapters: Number(chapters.rows[0]?.n ?? '0'),
        spend_cents: Number(spend.rows[0]?.cents ?? '0'),
      };
    });
  });

  // ---- chapters and review --------------------------------------------------------------------------
  app.get('/v1/projects/:projectId/chapters', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const rows = await c.query<{
        number: number;
        status: string;
        accepted_version_id: string | null;
      }>(
        'SELECT number, status, accepted_version_id FROM chapters WHERE project_id = $1 ORDER BY number',
        [projectId],
      );
      return { items: rows.rows };
    });
  });

  app.get('/v1/projects/:projectId/chapters/:number', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const params = req.params as { projectId?: string; number?: string };
    const projectId = requireUuid(params.projectId, 'params.projectId');
    const number = requireInt(params.number, 'params.number', { min: 1, max: 10_000 });
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const chapter = await c.query<{
        id: string;
        status: string;
        accepted_version_id: string | null;
      }>(
        'SELECT id, status, accepted_version_id FROM chapters WHERE project_id = $1 AND number = $2',
        [projectId, number],
      );
      const row = chapter.rows[0];
      if (!row)
        throw new ApiError('NOT_FOUND', `Chapter ${number} does not exist in this project.`);
      const versions = await manuscriptVersionsOf(c, row.id);
      return {
        chapter_no: number,
        chapter_id: row.id,
        status: row.status,
        accepted_version_id: row.accepted_version_id,
        // The accepted/working/rejected distinction is carried explicitly so a UI can never render a
        // rejected or losing candidate as canonical.
        versions: versions.map((v) => ({
          id: v.id,
          version_no: v.version_no,
          status: v.status,
          origin: v.origin,
          content_hash: v.content_hash,
          is_accepted: v.id === row.accepted_version_id,
        })),
      };
    });
  });

  // ---- canon inspectors -----------------------------------------------------------------------------
  app.get('/v1/projects/:projectId/canon/commits', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const commits = await listCommits(c, projectId);
      return {
        items: commits.map((commit) => ({
          version: commit.version,
          source: commit.source,
          item_counts: commit.item_counts,
          created_at: commit.created_at,
        })),
      };
    });
  });

  app.get('/v1/projects/:projectId/canon/entities', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const type = (req.query as { type?: string }).type;
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const entities = await entitiesOfType(c, projectId, type ?? 'character');
      return { items: entities };
    });
  });

  app.get('/v1/projects/:projectId/canon/timeline', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const timelines = await timelinesOf(c, projectId);
      const events = await c.query<{
        id: string;
        summary: string;
        frame: string;
        clock_start: unknown;
        timeline_id: string;
      }>(
        `SELECT id, summary, frame, clock_start, timeline_id FROM events
          WHERE project_id = $1 ORDER BY clock_ord, id LIMIT 500`,
        [projectId],
      );
      return { timelines, events: events.rows };
    });
  });

  // ---- jobs -----------------------------------------------------------------------------------------
  app.get('/v1/projects/:projectId/jobs', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const rows = await c.query<{
        id: string;
        kind: string;
        status: string;
        current_step: string | null;
        control: string;
        spend_cents: string;
        error: Record<string, unknown> | null;
      }>(
        `SELECT id, kind, status, current_step, control, spend_cents::text AS spend_cents, error
           FROM jobs WHERE project_id = $1 ORDER BY created_at DESC, id LIMIT 100`,
        [projectId],
      );
      return { items: rows.rows };
    });
  });

  app.get('/v1/projects/:projectId/workflows/:chapterNo/status', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const params = req.params as { projectId?: string; chapterNo?: string };
    const projectId = requireUuid(params.projectId, 'params.projectId');
    const chapterNo = requireInt(params.chapterNo, 'params.chapterNo', { min: 1, max: 10_000 });
    // Verify project visibility in scope first, so a foreign project id cannot be probed through the
    // workflow-status read.
    await inScope(pool, scope, async (c) => projectOr404(c, projectId));
    const status = await workflowStatus(pool, workflowIdFor(projectId, chapterNo));
    return status;
  });

  // ---- exports (accepted content only) --------------------------------------------------------------
  app.get('/v1/projects/:projectId/exports/preview', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const project = await inScope(pool, scope, async (c) => projectOr404(c, projectId));
    // `exportAccepted` is the Checkpoint 5 service: it reads accepted versions only. The API does not
    // re-implement the accepted-only rule, it reuses the one that is already proven.
    const result = await exportAccepted(pool, { projectId, title: project.title });
    return {
      chapters: result.chapters.map((chapter) => ({
        chapter_no: chapter.chapter_no,
        words: chapter.words,
        manuscript_version_id: chapter.manuscript_version_id,
        content_hash: chapter.content_hash,
        canon_version: chapter.canon_version,
      })),
      code_points: result.text.length,
    };
  });

  return app;
}

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------

function headerOf(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function toRequestLike(req: FastifyRequest) {
  return {
    method: req.method,
    headers: req.headers as Readonly<Record<string, string | string[] | undefined>>,
  };
}

/** Authenticate and authorize in one step; every workspace-scoped route starts here. */
async function scoped(pool: Pool, req: FastifyRequest): Promise<WorkspaceScope> {
  const principal: Principal = await authenticate(pool, toRequestLike(req));
  return requireWorkspace(pool, principal, headerOf(req, WORKSPACE_HEADER));
}

/**
 * Read a project inside the RLS scope. A project in another workspace is simply not visible, so this
 * returns the same 404 as a project that does not exist — an id must not be a cross-tenant probe.
 */
async function projectOr404(
  c: Client,
  projectId: string,
): Promise<{
  id: string;
  title: string;
  status: string;
  canon_version: number;
  quality_tier: string;
  operating_mode: string;
  production_policy_version: string;
}> {
  const r = await c.query<{
    id: string;
    title: string;
    status: string;
    canon_version: number;
    quality_tier: string;
    operating_mode: string;
    production_policy_version: string;
  }>(
    `SELECT id, title, status, canon_version, quality_tier, operating_mode, production_policy_version
       FROM projects WHERE id = $1`,
    [projectId],
  );
  const row = r.rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'The project does not exist.');
  return row;
}

/** Project creation inside the caller's RLS scope (so the row cannot land in another workspace). */
async function createProjectScoped(
  c: Client,
  input: { workspaceId: string; title: string; qualityTier: string; operatingMode: string },
): Promise<{ projectId: string; mainTimelineId: string }> {
  const project = await c.query<{ id: string }>(
    `INSERT INTO projects (workspace_id, title, quality_tier, operating_mode)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.workspaceId, input.title, input.qualityTier, input.operatingMode],
  );
  const projectId = project.rows[0]?.id;
  if (!projectId) throw new ApiError('INTERNAL_ERROR', 'The project could not be created.');
  const timeline = await c.query<{ id: string }>(
    `INSERT INTO timelines (workspace_id, project_id, name, kind) VALUES ($1, $2, 'main', 'main')
     RETURNING id`,
    [input.workspaceId, projectId],
  );
  const mainTimelineId = timeline.rows[0]?.id;
  if (!mainTimelineId)
    throw new ApiError('INTERNAL_ERROR', 'The project timeline could not be created.');
  return { projectId, mainTimelineId };
}

/** Append a privileged/destructive action to the audit log. Safe metadata only. */
async function audit(
  c: Client,
  scope: WorkspaceScope,
  input: {
    action: string;
    targetKind?: string | undefined;
    targetId?: string | undefined;
    projectId?: string | undefined;
    requestId: string;
    detail?: Record<string, unknown> | undefined;
  },
): Promise<void> {
  await c.query(
    `INSERT INTO audit_log (workspace_id, project_id, actor_user_id, action, target_kind, target_id, request_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      scope.workspaceId,
      input.projectId ?? null,
      scope.principal.user.id,
      input.action,
      input.targetKind ?? null,
      input.targetId ?? null,
      input.requestId,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

/** Cursor page envelope with a deterministic next cursor. */
function pageOf<T>(
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => string,
): { items: readonly T[]; next_cursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const hasMore = rows.length > limit;
  return {
    items,
    next_cursor: hasMore && last ? encodeCursor(keyOf(last)) : null,
  };
}

export { CSRF_HEADER, SESSION_COOKIE, WORKSPACE_HEADER };
