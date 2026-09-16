/**
 * Workflow persistence (Checkpoint 5, migration 0004): jobs with deterministic workflow ids and pins,
 * Postgres-checkpointed idempotent steps (`job_steps`), the content-addressed artifact store
 * (`workflow_artifacts`, append-only) and dependency edges from accepted manuscripts to the canon items their
 * Context Packs used. Temporal is deferred (ADR-0044); these tables are the checkpoint log it would replace.
 */
import { createHash } from 'node:crypto';
import { type Client, type Pool, rethrowCanon } from './client.js';

type Queryable = Pool | Client;

export interface JobRow {
  id: string;
  workspace_id: string;
  project_id: string;
  kind: string;
  status: string;
  target_kind: string | null;
  target_id: string | null;
  canon_version_read: number | null;
  production_policy_version: string;
  prompt_set_id: string | null;
  narrative_identity_version_id: string | null;
  workflow_id: string | null;
  idempotency_key: string | null;
  pins: Record<string, unknown>;
  progress: Record<string, unknown>;
  current_step: string | null;
  error: Record<string, unknown> | null;
  spend_cents: string | number;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

export interface JobStepRow {
  id: string;
  job_id: string;
  step: string;
  idempotency_key: string;
  status: 'running' | 'completed' | 'failed';
  result: unknown;
  error: Record<string, unknown> | null;
  attempt: number;
  started_at: Date;
  completed_at: Date | null;
}

export async function ensurePromptSet(
  db: Queryable,
  set: { id: string; mapping: Readonly<Record<string, string>> },
): Promise<void> {
  await db.query(
    `INSERT INTO prompt_sets (id, mapping) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING`,
    [set.id, JSON.stringify(set.mapping)],
  );
}

/** Find-or-create a job by its deterministic workflow id. Re-running the same workflow resumes the same job. */
export async function ensureJob(
  db: Queryable,
  input: {
    workspaceId: string;
    projectId: string;
    kind: string;
    workflowId: string;
    idempotencyKey: string;
    targetKind?: string | undefined;
    targetId?: string | undefined;
    canonVersionRead: number;
    productionPolicyVersion: string;
    promptSetId: string;
    narrativeIdentityVersionId: string;
    pins: Record<string, unknown>;
  },
): Promise<{ job: JobRow; created: boolean }> {
  const existing = await db.query<JobRow>('SELECT * FROM jobs WHERE workflow_id = $1', [
    input.workflowId,
  ]);
  const row = existing.rows[0];
  if (row) return { job: row, created: false };
  const r = await db
    .query<JobRow>(
      `INSERT INTO jobs (workspace_id, project_id, kind, status, target_kind, target_id, canon_version_read,
                         production_policy_version, prompt_set_id, narrative_identity_version_id, workflow_id, idempotency_key, pins)
       VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       ON CONFLICT (workflow_id) DO NOTHING
       RETURNING *`,
      [
        input.workspaceId,
        input.projectId,
        input.kind,
        input.targetKind ?? null,
        input.targetId ?? null,
        input.canonVersionRead,
        input.productionPolicyVersion,
        input.promptSetId,
        input.narrativeIdentityVersionId,
        input.workflowId,
        input.idempotencyKey,
        JSON.stringify(input.pins),
      ],
    )
    .catch(rethrowCanon);
  const created = r.rows[0];
  if (created) return { job: created, created: true };
  const again = await db.query<JobRow>('SELECT * FROM jobs WHERE workflow_id = $1', [
    input.workflowId,
  ]);
  const found = again.rows[0];
  if (!found) throw new Error(`job for workflow ${input.workflowId} vanished`);
  return { job: found, created: false };
}

export async function getJob(db: Queryable, jobId: string): Promise<JobRow | undefined> {
  const r = await db.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [jobId]);
  return r.rows[0];
}

export async function getJobByWorkflowId(
  db: Queryable,
  workflowId: string,
): Promise<JobRow | undefined> {
  const r = await db.query<JobRow>('SELECT * FROM jobs WHERE workflow_id = $1', [workflowId]);
  return r.rows[0];
}

export async function updateJob(
  db: Queryable,
  jobId: string,
  patch: {
    status?: string | undefined;
    currentStep?: string | null | undefined;
    progress?: Record<string, unknown> | undefined;
    pins?: Record<string, unknown> | undefined;
    error?: Record<string, unknown> | null | undefined;
    finished?: boolean | undefined;
  },
): Promise<void> {
  await db.query(
    `UPDATE jobs SET
       status = coalesce($2, status),
       current_step = CASE WHEN $3::boolean THEN $4 ELSE current_step END,
       progress = CASE WHEN $5::jsonb IS NULL THEN progress ELSE progress || $5::jsonb END,
       pins = CASE WHEN $6::jsonb IS NULL THEN pins ELSE pins || $6::jsonb END,
       error = CASE WHEN $7::boolean THEN $8::jsonb ELSE error END,
       finished_at = CASE WHEN $9::boolean THEN now() ELSE finished_at END,
       updated_at = now()
     WHERE id = $1`,
    [
      jobId,
      patch.status ?? null,
      patch.currentStep !== undefined,
      patch.currentStep ?? null,
      patch.progress ? JSON.stringify(patch.progress) : null,
      patch.pins ? JSON.stringify(patch.pins) : null,
      patch.error !== undefined,
      patch.error === undefined || patch.error === null ? null : JSON.stringify(patch.error),
      patch.finished ?? false,
    ],
  );
}

export async function listJobSteps(db: Queryable, jobId: string): Promise<JobStepRow[]> {
  const r = await db.query<JobStepRow>(
    'SELECT * FROM job_steps WHERE job_id = $1 ORDER BY started_at, id',
    [jobId],
  );
  return r.rows;
}

export async function getJobStep(
  db: Queryable,
  idempotencyKey: string,
): Promise<JobStepRow | undefined> {
  const r = await db.query<JobStepRow>('SELECT * FROM job_steps WHERE idempotency_key = $1', [
    idempotencyKey,
  ]);
  return r.rows[0];
}

/** Mark a step running (new attempt). A completed step is never reopened: callers check first. */
export async function beginJobStep(
  db: Queryable,
  input: { jobId: string; step: string; idempotencyKey: string },
): Promise<JobStepRow> {
  const r = await db.query<JobStepRow>(
    `INSERT INTO job_steps (job_id, step, idempotency_key, status, attempt)
     VALUES ($1, $2, $3, 'running', 1)
     ON CONFLICT (idempotency_key) DO UPDATE
       SET status = CASE WHEN job_steps.status = 'completed' THEN job_steps.status ELSE 'running' END,
           attempt = CASE WHEN job_steps.status = 'completed' THEN job_steps.attempt ELSE job_steps.attempt + 1 END,
           error = CASE WHEN job_steps.status = 'completed' THEN job_steps.error ELSE NULL END,
           started_at = CASE WHEN job_steps.status = 'completed' THEN job_steps.started_at ELSE now() END
     RETURNING *`,
    [input.jobId, input.step, input.idempotencyKey],
  );
  const row = r.rows[0];
  if (!row) throw new Error('job step upsert returned no row');
  return row;
}

export async function completeJobStep(
  db: Queryable,
  idempotencyKey: string,
  result: unknown,
): Promise<void> {
  await db.query(
    `UPDATE job_steps SET status = 'completed', result = $2::jsonb, error = NULL, completed_at = now()
     WHERE idempotency_key = $1 AND status <> 'completed'`,
    [idempotencyKey, JSON.stringify(result)],
  );
}

export async function failJobStep(
  db: Queryable,
  idempotencyKey: string,
  error: { code: string; message: string; data?: unknown },
): Promise<void> {
  await db.query(
    `UPDATE job_steps SET status = 'failed', error = $2::jsonb WHERE idempotency_key = $1 AND status <> 'completed'`,
    [idempotencyKey, JSON.stringify(error)],
  );
}

// ---------------------------------------------------------------------------------------------------------
// artifact store
// ---------------------------------------------------------------------------------------------------------

export interface ArtifactRow {
  id: string;
  workspace_id: string;
  project_id: string;
  job_id: string | null;
  step: string;
  kind: string;
  key: string;
  schema: string | null;
  content_hash: string;
  payload: unknown;
  created_at: Date;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function artifactHash(payload: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortKeys(payload)), 'utf8')
    .digest('hex')}`;
}

/** RFC 9562 v8 UUID from a content hash (same derivation as context packs / ACS ids). */
export function artifactIdFromHash(hash: string): string {
  const hex = hash.replace(/^sha256:/, '');
  const b = Buffer.from(hex.slice(0, 32), 'hex');
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Store an artifact once per (project, step, kind, key). A retry that produces identical bytes is a no-op; a
 * retry that produces different bytes for the same key is a determinism violation and is refused.
 */
export async function putArtifact(
  db: Queryable,
  input: {
    workspaceId: string;
    projectId: string;
    jobId?: string | undefined;
    step: string;
    kind: string;
    key: string;
    schema?: string | undefined;
    payload: unknown;
  },
): Promise<{ artifact: ArtifactRow; stored: boolean }> {
  const hash = artifactHash(input.payload);
  // Identity = content + address, so identical payloads stored under two keys get two ids.
  const id = artifactIdFromHash(
    `sha256:${createHash('sha256')
      .update(`${hash}|${input.projectId}|${input.step}|${input.kind}|${input.key}`)
      .digest('hex')}`,
  );
  const existing = await db.query<ArtifactRow>(
    'SELECT * FROM workflow_artifacts WHERE project_id = $1 AND step = $2 AND kind = $3 AND key = $4',
    [input.projectId, input.step, input.kind, input.key],
  );
  const prior = existing.rows[0];
  if (prior) {
    if (prior.content_hash !== hash)
      throw new Error(
        `ARTIFACT_NONDETERMINISTIC: ${input.step}/${input.kind}/${input.key} already stored with ${prior.content_hash}, new payload hashes ${hash}`,
      );
    return { artifact: prior, stored: false };
  }
  // Two conflict targets, both legitimate: the address (project, step, kind, key) and the content-addressed
  // primary key, which two concurrent callers computing the SAME payload will derive identically. Neither is
  // an error — the row already exists and is byte-identical — so both are absorbed here rather than escaping
  // as a raw duplicate-key failure. The re-read below returns the committed row.
  const r = await db
    .query<ArtifactRow>(
      `INSERT INTO workflow_artifacts (id, workspace_id, project_id, job_id, step, kind, key, schema, content_hash, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        id,
        input.workspaceId,
        input.projectId,
        input.jobId ?? null,
        input.step,
        input.kind,
        input.key,
        input.schema ?? null,
        hash,
        JSON.stringify(input.payload),
      ],
    )
    .catch(rethrowCanon);
  const row = r.rows[0];
  if (row) return { artifact: row, stored: true };
  const again = await db.query<ArtifactRow>(
    'SELECT * FROM workflow_artifacts WHERE project_id = $1 AND step = $2 AND kind = $3 AND key = $4',
    [input.projectId, input.step, input.kind, input.key],
  );
  const found =
    again.rows[0] ??
    (await db.query<ArtifactRow>('SELECT * FROM workflow_artifacts WHERE id = $1', [id])).rows[0];
  if (!found) throw new Error('artifact insert raced and vanished');
  return { artifact: found, stored: false };
}

export async function getArtifact(
  db: Queryable,
  q: { projectId: string; step: string; kind: string; key: string },
): Promise<ArtifactRow | undefined> {
  const r = await db.query<ArtifactRow>(
    'SELECT * FROM workflow_artifacts WHERE project_id = $1 AND step = $2 AND kind = $3 AND key = $4',
    [q.projectId, q.step, q.kind, q.key],
  );
  return r.rows[0];
}

export async function getArtifactById(db: Queryable, id: string): Promise<ArtifactRow | undefined> {
  const r = await db.query<ArtifactRow>('SELECT * FROM workflow_artifacts WHERE id = $1', [id]);
  return r.rows[0];
}

export async function listArtifacts(db: Queryable, jobId: string): Promise<ArtifactRow[]> {
  const r = await db.query<ArtifactRow>(
    'SELECT * FROM workflow_artifacts WHERE job_id = $1 ORDER BY created_at, id',
    [jobId],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------------------------------------
// dependency edges (ADR-0032)
// ---------------------------------------------------------------------------------------------------------

export interface DependencyEdgeInput {
  readonly dependentKind: 'manuscript_version' | 'chapter_contract' | 'summary';
  readonly dependentId: string;
  readonly canonItemKind: string;
  readonly canonItemRef: string;
  readonly sourceKind: string;
  readonly canonVersionRead: number;
  readonly materiality: 'material' | 'contextual';
  readonly basis:
    'contract_anchor' | 't0' | 't1_state' | 'claim_reference' | 'retrieved_t2' | 'promoted_by_user';
  readonly packId?: string | undefined;
}

/** Idempotent: the unique key makes a replayed step a no-op. Returns the number of edges newly inserted. */
export async function insertDependencyEdges(
  db: Queryable,
  scope: { workspaceId: string; projectId: string },
  edges: readonly DependencyEdgeInput[],
): Promise<number> {
  let inserted = 0;
  for (const e of edges) {
    const r = await db.query(
      `INSERT INTO dependency_edges (workspace_id, project_id, dependent_kind, dependent_id, canon_item_kind, canon_item_ref,
                                     source_kind, canon_version_read, materiality, basis, pack_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (project_id, dependent_kind, dependent_id, canon_item_kind, canon_item_ref) DO NOTHING`,
      [
        scope.workspaceId,
        scope.projectId,
        e.dependentKind,
        e.dependentId,
        e.canonItemKind,
        e.canonItemRef,
        e.sourceKind,
        e.canonVersionRead,
        e.materiality,
        e.basis,
        e.packId ?? null,
      ],
    );
    inserted += r.rowCount ?? 0;
  }
  return inserted;
}

export interface DependencyEdgeRow {
  id: string;
  dependent_kind: string;
  dependent_id: string;
  canon_item_kind: string;
  canon_item_ref: string;
  source_kind: string;
  canon_version_read: number;
  materiality: string;
  basis: string;
  pack_id: string | null;
}

export async function dependencyEdgesFor(
  db: Queryable,
  projectId: string,
  dependentId: string,
): Promise<DependencyEdgeRow[]> {
  const r = await db.query<DependencyEdgeRow>(
    'SELECT * FROM dependency_edges WHERE project_id = $1 AND dependent_id = $2 ORDER BY canon_item_kind, canon_item_ref',
    [projectId, dependentId],
  );
  return r.rows;
}

/** Every manuscript version of a chapter, newest first (statuses included; quarantined versions are absent by construction). */
export async function manuscriptVersionsOf(
  db: Queryable,
  chapterId: string,
): Promise<
  {
    id: string;
    version_no: number;
    status: string;
    origin: string;
    parent_version_id: string | null;
    content_hash: string;
  }[]
> {
  const r = await db.query<{
    id: string;
    version_no: number;
    status: string;
    origin: string;
    parent_version_id: string | null;
    content_hash: string;
  }>(
    'SELECT id, version_no, status, origin, parent_version_id, content_hash FROM manuscript_versions WHERE chapter_id = $1 ORDER BY version_no DESC',
    [chapterId],
  );
  return r.rows;
}

export async function chapterByNumber(
  db: Queryable,
  projectId: string,
  chapterNo: number,
): Promise<{ id: string; status: string; accepted_version_id: string | null } | undefined> {
  const r = await db.query<{ id: string; status: string; accepted_version_id: string | null }>(
    'SELECT id, status, accepted_version_id FROM chapters WHERE project_id = $1 AND number = $2',
    [projectId, chapterNo],
  );
  return r.rows[0];
}
