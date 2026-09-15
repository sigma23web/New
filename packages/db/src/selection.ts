/**
 * Durable N-candidate selection decisions (Checkpoint 6, B-6-4; migration 0005).
 *
 * `workflow_artifacts` holds the selection's append-only evidence. This module owns what an append-only
 * artifact cannot express: whether the decision and all of its durable consequences are committed, and which
 * of several concurrent callers is allowed to make the decision at all. Both properties need the database:
 *
 *  * Atomic finalization. `commitSelection` writes the decision row and marks every loser terminal in ONE
 *    transaction, so a committed decision always implies exactly one live candidate. A crash before that
 *    commit leaves no decision and no terminal loser, which is a clean state for the retry.
 *  * One decision under concurrency. The row's UNIQUE (project_id, chapter_no) means exactly one racing
 *    caller commits; the other reads the committed decision. `SelectionConflictError` is typed, so a raw
 *    unique-violation never escapes into the workflow layer.
 */
import { type Client, type Pool, rethrowCanon, withTransaction } from './client.js';

type Queryable = Pool | Client;

export interface CandidateSelectionRow {
  id: string;
  workspace_id: string;
  project_id: string;
  chapter_id: string;
  chapter_no: number;
  job_id: string | null;
  status: 'selected' | 'needs_attention';
  winner_candidate_id: string | null;
  winner_manuscript_version_id: string | null;
  candidate_version_ids: string[];
  loser_version_ids: string[];
  request_fingerprint: string;
  selection_required: boolean;
  schedule: string;
  artifact_id: string | null;
  created_at: Date;
}

/** A concurrent caller committed this chapter's selection first. Retriable: re-read and use that decision. */
export class SelectionConflictError extends Error {
  constructor(
    readonly projectId: string,
    readonly chapterNo: number,
  ) {
    super(
      `SELECTION_CONFLICT: chapter ${chapterNo} of project ${projectId} was selected concurrently by another caller`,
    );
    this.name = 'SelectionConflictError';
  }
}

export interface CommitSelectionInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly chapterNo: number;
  readonly jobId?: string | undefined;
  readonly status: 'selected' | 'needs_attention';
  readonly winnerCandidateId?: string | undefined;
  readonly winnerManuscriptVersionId?: string | undefined;
  readonly candidateVersionIds: readonly string[];
  readonly loserVersionIds: readonly string[];
  readonly requestFingerprint: string;
  readonly selectionRequired: boolean;
  readonly schedule: string;
  readonly artifactId?: string | undefined;
}

/**
 * Commit the decision and every durable consequence of it in one transaction.
 *
 * Losers move only from `working`: a version that already reached a terminal status keeps the history it has
 * — immutability means `status` moves once and the text, hash and lineage never move at all.
 *
 * Throws `SelectionConflictError` when another caller already committed this chapter.
 */
export async function commitSelection(
  pool: Pool,
  input: CommitSelectionInput,
): Promise<CandidateSelectionRow> {
  return withTransaction(pool, async (client) => {
    const inserted = await client
      .query<CandidateSelectionRow>(
        `INSERT INTO candidate_selections
           (workspace_id, project_id, chapter_id, chapter_no, job_id, status,
            winner_candidate_id, winner_manuscript_version_id,
            candidate_version_ids, loser_version_ids, request_fingerprint, selection_required,
            schedule, artifact_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], $10::uuid[], $11, $12, $13, $14)
         ON CONFLICT (project_id, chapter_no) DO NOTHING
         RETURNING *`,
        [
          input.workspaceId,
          input.projectId,
          input.chapterId,
          input.chapterNo,
          input.jobId ?? null,
          input.status,
          input.winnerCandidateId ?? null,
          input.winnerManuscriptVersionId ?? null,
          [...input.candidateVersionIds],
          [...input.loserVersionIds],
          input.requestFingerprint,
          input.selectionRequired,
          input.schedule,
          input.artifactId ?? null,
        ],
      )
      .catch(rethrowCanon);
    const row = inserted.rows[0];
    if (!row) throw new SelectionConflictError(input.projectId, input.chapterNo);
    if (input.loserVersionIds.length > 0)
      await client
        .query(
          `UPDATE manuscript_versions SET status = 'rejected'
            WHERE id = ANY($1::uuid[]) AND status = 'working'`,
          [[...input.loserVersionIds]],
        )
        .catch(rethrowCanon);
    return row;
  });
}

export async function getSelection(
  db: Queryable,
  q: { projectId: string; chapterNo: number },
): Promise<CandidateSelectionRow | undefined> {
  const r = await db.query<CandidateSelectionRow>(
    'SELECT * FROM candidate_selections WHERE project_id = $1 AND chapter_no = $2',
    [q.projectId, q.chapterNo],
  );
  return r.rows[0];
}

/**
 * Every committed selection of a project, oldest first. Used by acceptance to answer "was this chapter
 * decided by a selection?" from persisted truth.
 */
export async function selectionsOf(
  db: Queryable,
  projectId: string,
): Promise<CandidateSelectionRow[]> {
  const r = await db.query<CandidateSelectionRow>(
    'SELECT * FROM candidate_selections WHERE project_id = $1 ORDER BY chapter_no',
    [projectId],
  );
  return r.rows;
}
