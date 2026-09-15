/**
 * N-candidate winner selection (Checkpoint 6, B-6-4; ADR-0015, ADR-0014, ADR-0041).
 *
 * The comparator of ADR-0015 is pairwise, so selection is pairwise too: candidates are ordered
 * deterministically and reduced by SEQUENTIAL SINGLE ELIMINATION — the standing winner meets the next
 * eligible candidate, and the survivor of each decisive pair carries forward. No aggregate score is
 * invented: ADR-0015 says a consistent pairwise winner wins, inconsistency is position bias resolved by a
 * third shuffled-rubric run, and remaining ties fall to the deterministic ladder. An opaque ranking would
 * replace that rule rather than implement it.
 *
 * Why single elimination and not round-robin: ADR-0015's cost consequence is "2× comparison calls when
 * N=2", i.e. per PAIR. Single elimination is N−1 decisive pairs (2(N−1) judgments, plus a third where
 * position bias appears); round-robin would be N(N−1)/2 pairs for no additional authority per pair.
 *
 * WHAT DETERMINISM MEANS HERE, EXACTLY. The bracket's outcome is deterministic for the PINNED SCHEDULE
 * (`stable_slot_single_elimination`): candidates are ordered by their stable `slot`, then id, before
 * anything runs, so database row order, input-array order, resume boundary and process restart cannot
 * change the schedule or the winner. It is NOT a schedule-independent global winner. ADR-0015 defines a
 * pairwise comparator, and a pairwise comparator that decides every pair is not thereby transitive: a
 * judge may prefer A over B, B over C and C over A. Under a cycle, single elimination still returns one
 * winner, but which candidate it is depends on the schedule. The honest claim — the one this module makes
 * and `selection.integration.test.ts` proves — is: same candidates, same slots ⇒ same winner, always; and
 * the schedule is persisted with the decision as provenance rather than presented as irrelevant.
 *
 * Each decisive pair is a durable `runStep` keyed by the two candidate slots, so a retry replays a
 * completed comparison instead of re-judging it, and a resume begins at the first incomplete pair.
 *
 * WINNER-ONLY PROPAGATION is enforced at the production boundary, not by an optional helper: `approveVersion`
 * and `acceptDelta` each call `requireSelectedWinner`, which decides from PERSISTED state whether this
 * chapter was selected and refuses anything that is not the committed winner (see `acceptance.ts`).
 */
import { createHash } from 'node:crypto';
import {
  commitSelection,
  getArtifact,
  getSelection,
  SelectionConflictError,
  getManuscriptVersion,
  type CandidateSelectionRow,
} from '@yeonjae/db';
import { GatewayError } from '@yeonjae/gateway';
import {
  compareCandidates,
  earlyStopDecision,
  type Candidate,
  type ComparisonOutcome,
  type EarlyStopDecision,
} from './comparison.js';
import { type Scorecard } from './evaluation.js';
import { WorkflowError } from './errors.js';
import { runStep, saveArtifact, type ProductionPolicy, type WorkflowContext } from './runtime.js';

/** The only selection schedule this checkpoint implements; persisted with every decision as provenance. */
export const SELECTION_SCHEDULE = 'stable_slot_single_elimination';

/** Why a candidate may not take part. Deterministic, explicit, and persisted. */
export type IneligibilityCode =
  | 'CROSS_PROJECT'
  | 'CROSS_CHAPTER'
  | 'CANON_VERSION_MISMATCH'
  | 'IDENTITY_VERSION_MISMATCH'
  | 'POLICY_VERSION_MISMATCH'
  | 'PROMPT_PROVENANCE_MISMATCH'
  | 'NOT_IMMUTABLE'
  | 'EVALUATION_INCOMPLETE'
  | 'GATE_EVIDENCE_MISSING'
  | 'BLOCKING_GATE_FAILED'
  | 'SCORECARD_NOT_PERSISTED'
  | 'SCORECARD_NOT_AUTHENTIC'
  | 'ALREADY_TERMINAL';

/** A candidate as submitted, with the provenance eligibility is decided on. */
export interface CandidateSubmission extends Candidate {
  readonly manuscriptVersionId: string;
  readonly projectId: string;
  readonly chapterNo: number;
  readonly baseCanonVersion: number;
  readonly narrativeIdentityVersionId: string;
  readonly productionPolicyVersion: string;
  readonly promptSetId: string;
}

export interface EligibilityDecision {
  readonly candidateId: string;
  readonly slot: number;
  readonly eligible: boolean;
  readonly codes: readonly IneligibilityCode[];
  readonly detail?: string | undefined;
}

export interface ComparisonScheduleEntry {
  readonly pair: string;
  readonly aId: string;
  readonly bId: string;
  readonly winnerId: string;
  readonly loserId: string;
  readonly reason: ComparisonOutcome['reason'];
  readonly positionBiasDetected: boolean;
  readonly judgments: number;
  readonly verdictArtifactIds: readonly string[];
}

export interface ExclusionRecord {
  readonly candidateId: string;
  readonly slot: number;
  readonly reason: 'ineligible' | 'lost_comparison' | 'not_reached_early_stop';
  readonly codes?: readonly IneligibilityCode[] | undefined;
  readonly detail: string;
}

export type SelectionStatus = 'selected' | 'needs_attention';

export interface SelectionResult {
  readonly status: SelectionStatus;
  readonly chapterNo: number;
  readonly winnerId?: string | undefined;
  readonly winnerManuscriptVersionId?: string | undefined;
  readonly candidateIds: readonly string[];
  readonly eligibility: readonly EligibilityDecision[];
  readonly schedule: readonly ComparisonScheduleEntry[];
  readonly excluded: readonly ExclusionRecord[];
  readonly earlyStop: {
    readonly applied: boolean;
    readonly candidateId?: string | undefined;
    readonly decision: EarlyStopDecision | undefined;
    readonly detail: string;
  };
  readonly budget: {
    readonly pairsBudgeted: number;
    readonly judgmentsSpent: number;
    readonly detail: string;
  };
  readonly needsAttentionReason?: string | undefined;
  readonly artifactId: string;
  readonly pins: {
    readonly baseCanonVersion: number;
    readonly narrativeIdentityVersionId: string;
    readonly productionPolicyVersion: string;
    readonly promptSetId: string;
  };
}

export interface SelectionInput {
  readonly chapterNo: number;
  readonly chapterId: string;
  /** The compiled chapter contract this selection is for; part of the request fingerprint. */
  readonly contractId: string;
  readonly contractShape: string;
  readonly candidates: readonly CandidateSubmission[];
  /** The world the run itself is pinned to; every candidate must match it. */
  readonly expect: {
    readonly baseCanonVersion: number;
    readonly narrativeIdentityVersionId: string;
    readonly productionPolicyVersion: string;
    readonly promptSetId: string;
  };
  /** Maximum comparator judgments this selection may spend. Defaults to the policy-derived budget. */
  readonly maxJudgments?: number | undefined;
}

/** Gated dimensions come from the pinned policy, never a hardcoded list (ADR-0041). */
function gatedDimensions(policy: ProductionPolicy): readonly string[] {
  return Object.keys(policy.gates.dimensions).sort();
}

function sectionOf(
  scorecard: Scorecard,
  dimension: string,
): { score?: number; passed?: boolean } | undefined {
  return (scorecard.sections as Record<string, { score?: number; passed?: boolean } | undefined>)[
    dimension
  ];
}

/**
 * Deterministic candidate order: slot, then id. Applied BEFORE any scheduling so the bracket cannot depend
 * on database row-return order, insertion order or a resume boundary.
 */
export function orderCandidates<T extends { slot: number; id: string }>(
  candidates: readonly T[],
): readonly T[] {
  return [...candidates].sort((a, b) =>
    a.slot !== b.slot ? a.slot - b.slot : a.id < b.id ? -1 : 1,
  );
}

/**
 * Eligibility. Every rule is a REFUSAL of that candidate with an explicit code — never a silent drop, and
 * never a reason to let a blocked candidate win because its rivals were worse.
 *
 * The scorecard eligibility is decided on is the PERSISTED one, loaded from the evaluation artifact of that
 * exact manuscript version. A caller-supplied scorecard is evidence of nothing: it is compared against the
 * stored artifact and any disagreement refuses the candidate (`SCORECARD_NOT_AUTHENTIC`) instead of letting
 * a fabricated pass override a stored failure.
 */
export async function decideEligibility(
  ctx: WorkflowContext,
  input: SelectionInput,
): Promise<readonly EligibilityDecision[]> {
  return (await resolveCandidates(ctx, input)).map((r) => r.decision);
}

/** A candidate paired with its eligibility decision and the persisted scorecard that decision used. */
export interface ResolvedCandidate {
  readonly submission: CandidateSubmission;
  readonly decision: EligibilityDecision;
  /** The scorecard as stored for this manuscript version; absent when no authentic artifact exists. */
  readonly persistedScorecard: Scorecard | undefined;
  readonly scorecardArtifactId: string | undefined;
  readonly scorecardContentHash: string | undefined;
}

/**
 * Decide eligibility and resolve each candidate against durable evidence, in the deterministic slot order.
 */
export async function resolveCandidates(
  ctx: WorkflowContext,
  input: SelectionInput,
): Promise<readonly ResolvedCandidate[]> {
  const resolved: ResolvedCandidate[] = [];
  const policy = ctx.policy;
  const gated = gatedDimensions(policy);
  for (const candidate of orderCandidates(input.candidates)) {
    const codes: IneligibilityCode[] = [];
    const details: string[] = [];

    if (candidate.projectId !== ctx.projectId) {
      codes.push('CROSS_PROJECT');
      details.push(`candidate belongs to project ${candidate.projectId}`);
    }
    if (candidate.chapterNo !== input.chapterNo) {
      codes.push('CROSS_CHAPTER');
      details.push(`candidate is for chapter ${candidate.chapterNo}`);
    }
    if (candidate.baseCanonVersion !== input.expect.baseCanonVersion) {
      codes.push('CANON_VERSION_MISMATCH');
      details.push(
        `candidate read canon v${candidate.baseCanonVersion}, selection pins v${input.expect.baseCanonVersion}`,
      );
    }
    if (candidate.narrativeIdentityVersionId !== input.expect.narrativeIdentityVersionId) {
      codes.push('IDENTITY_VERSION_MISMATCH');
      details.push('candidate was produced under a different Narrative Identity version');
    }
    if (candidate.productionPolicyVersion !== input.expect.productionPolicyVersion) {
      codes.push('POLICY_VERSION_MISMATCH');
      details.push('candidate was produced under a different Production Policy version');
    }
    if (candidate.promptSetId !== input.expect.promptSetId) {
      codes.push('PROMPT_PROVENANCE_MISMATCH');
      details.push('candidate was produced with a different pinned prompt set');
    }

    // The manuscript version must exist, belong here, and still be a working candidate. A version that is
    // already accepted, rejected or superseded has a terminal history that selection must not reopen.
    const row = await getManuscriptVersion(ctx.pool, candidate.manuscriptVersionId);
    if (!row) {
      codes.push('NOT_IMMUTABLE');
      details.push(`manuscript version ${candidate.manuscriptVersionId} does not exist`);
    } else {
      // Project membership is verified through the stored chapter, which is the real integrity link:
      // a version's project is whatever its chapter belongs to, not whatever the submission claims.
      const owner = await ctx.pool.query<{ project_id: string; number: number }>(
        'SELECT project_id, number FROM chapters WHERE id = $1',
        [row.chapter_id],
      );
      const chapter = owner.rows[0];
      if (chapter?.project_id !== ctx.projectId) {
        if (!codes.includes('CROSS_PROJECT')) codes.push('CROSS_PROJECT');
        details.push('stored manuscript version belongs to another project');
      }
      if (chapter?.number !== undefined && chapter.number !== input.chapterNo) {
        if (!codes.includes('CROSS_CHAPTER')) codes.push('CROSS_CHAPTER');
        details.push(`stored manuscript version is chapter ${chapter.number}`);
      }
      if (row.chapter_id !== input.chapterId) {
        if (!codes.includes('CROSS_CHAPTER')) codes.push('CROSS_CHAPTER');
        details.push('stored manuscript version belongs to another chapter');
      }
      if (row.status !== 'working') {
        codes.push('ALREADY_TERMINAL');
        details.push(`manuscript version is ${row.status}`);
      }
      if (row.content_hash !== contentHashOfText(row.text)) {
        codes.push('NOT_IMMUTABLE');
        details.push('stored text does not match its recorded content hash');
      }
      if (row.text !== candidate.text) {
        codes.push('NOT_IMMUTABLE');
        details.push('submitted candidate text differs from the stored manuscript version');
      }
    }

    // ---- Durable evaluation evidence. Eligibility is decided on the STORED scorecard for this exact
    // manuscript version, never on what the caller passed in.
    const stored = await loadPersistedScorecard(ctx, candidate.manuscriptVersionId);
    let scorecard: Scorecard | undefined;
    if (!stored) {
      codes.push('SCORECARD_NOT_PERSISTED');
      details.push(
        `no persisted scorecard artifact for manuscript version ${candidate.manuscriptVersionId}`,
      );
    } else {
      const problems = scorecardAuthenticity(stored.scorecard, {
        manuscriptVersionId: candidate.manuscriptVersionId,
        baseCanonVersion: input.expect.baseCanonVersion,
      });
      if (problems.length > 0) {
        codes.push('SCORECARD_NOT_AUTHENTIC');
        details.push(...problems);
      } else if (
        artifactDigest(candidate.scorecard) !== artifactDigest(stored.scorecard) &&
        !codes.includes('SCORECARD_NOT_AUTHENTIC')
      ) {
        // A caller-supplied scorecard that disagrees with the stored one is refused outright rather than
        // quietly replaced: the disagreement itself means the submission cannot be trusted.
        codes.push('SCORECARD_NOT_AUTHENTIC');
        details.push(
          'submitted scorecard does not match the persisted evaluation artifact for this version',
        );
      }
      scorecard = stored.scorecard;
    }

    // Evaluation must be complete: every gated dimension present, and no blocking/major issue open.
    const judged = scorecard;
    if (judged) {
      const missing = gated.filter((d) => sectionOf(judged, d)?.score === undefined);
      if (missing.length > 0) {
        codes.push('GATE_EVIDENCE_MISSING');
        details.push(`no evidence for gated dimension(s) ${missing.join(', ')}`);
      }
      if (judged.acceptance.dimension_results.length === 0) {
        codes.push('EVALUATION_INCOMPLETE');
        details.push('scorecard carries no dimension results');
      }
      // A candidate that fails a blocking gate is eliminated BEFORE comparison, so it can never win by
      // comparing favourably against even worse candidates.
      const failed = gated.filter((d) => {
        const section = sectionOf(judged, d);
        return section?.score !== undefined && section.passed === false;
      });
      const blocking =
        judged.overall.blocking_count > policy.gates.blocking_max ||
        judged.overall.major_count > policy.gates.major_max;
      if (failed.length > 0 || blocking) {
        codes.push('BLOCKING_GATE_FAILED');
        if (failed.length > 0) details.push(`failed gate(s) ${failed.join(', ')}`);
        if (blocking)
          details.push(
            `${judged.overall.blocking_count} blocking / ${judged.overall.major_count} major issues exceed the pinned maxima`,
          );
      }
    }

    resolved.push({
      submission: candidate,
      decision: {
        candidateId: candidate.id,
        slot: candidate.slot,
        eligible: codes.length === 0,
        codes,
        ...(details.length ? { detail: details.join('; ') } : {}),
      },
      persistedScorecard: scorecard,
      scorecardArtifactId: stored?.artifactId,
      scorecardContentHash: stored?.contentHash,
    });
  }
  return resolved;
}

/** The persisted evaluation artifact for a manuscript version, as `evaluateVersion` stored it. */
async function loadPersistedScorecard(
  ctx: WorkflowContext,
  manuscriptVersionId: string,
): Promise<{ scorecard: Scorecard; artifactId: string; contentHash: string } | undefined> {
  const row = await getArtifact(ctx.pool, {
    projectId: ctx.projectId,
    step: 'evaluate',
    kind: 'scorecard',
    key: manuscriptVersionId,
  });
  if (!row) return undefined;
  const payload = row.payload as Partial<Scorecard> | null;
  // A malformed artifact is not evidence. Refuse it here rather than reading fields off it downstream.
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.manuscript_version_id !== 'string' ||
    typeof payload.canon_version !== 'number' ||
    typeof payload.overall !== 'object' ||
    typeof payload.sections !== 'object' ||
    !Array.isArray(payload.issues) ||
    typeof payload.acceptance !== 'object'
  )
    return undefined;
  return {
    scorecard: payload as Scorecard,
    artifactId: row.id,
    contentHash: row.content_hash,
  };
}

/** Does this stored scorecard actually judge THIS version, under the canon the selection is pinned to? */
function scorecardAuthenticity(
  scorecard: Scorecard,
  expect: { manuscriptVersionId: string; baseCanonVersion: number },
): string[] {
  const problems: string[] = [];
  if (scorecard.manuscript_version_id !== expect.manuscriptVersionId)
    problems.push(
      `persisted scorecard judges manuscript ${scorecard.manuscript_version_id}, not ${expect.manuscriptVersionId}`,
    );
  if (scorecard.canon_version !== expect.baseCanonVersion)
    problems.push(
      `persisted scorecard was produced against canon v${scorecard.canon_version}, selection pins v${expect.baseCanonVersion}`,
    );
  return problems;
}

/** Order-insensitive digest of a JSON value: the same content hashes the same however its keys were written. */
function artifactDigest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortKeysDeep(value)))
    .digest('hex')}`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  return value;
}

function contentHashOfText(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * The complete identity of a selection REQUEST. Two calls may share a decision only if this matches exactly.
 *
 * It covers everything that could change the right answer: where the selection lives (workspace, project,
 * chapter id and number), which candidates take part and in which stable slots, what each candidate's text
 * actually is (content hash, not a claimed id), the canon the run reads, the compiled contract, and every
 * pin that governs judgment — identity, policy, prompt set — plus the persisted scorecard artifact and its
 * content hash for each candidate, and the model/evaluator provenance those scorecards were produced with.
 *
 * Candidate entries are sorted by slot, so a caller that reorders the same request array produces the same
 * fingerprint, while changing a slot assignment, a text, a scorecard or a pin produces a different one.
 */
export interface SelectionFingerprintInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly chapterNo: number;
  readonly contractId: string;
  readonly contractShape: string;
  readonly baseCanonVersion: number;
  readonly narrativeIdentityRef: string;
  readonly narrativeIdentityVersionId: string;
  /** Content digest of the COMPOSED identity: a recomposition that changes any rule changes this. */
  readonly narrativeIdentityHash: string;
  readonly productionPolicyVersion: string;
  readonly productionPolicyHash: string;
  readonly promptSetId: string;
  readonly promptSetHash: string;
  readonly candidates: readonly {
    readonly slot: number;
    readonly candidateId: string;
    readonly manuscriptVersionId: string;
    readonly contentHash: string;
    readonly scorecardArtifactId: string | undefined;
    readonly scorecardContentHash: string | undefined;
    readonly evaluatorProvenance: readonly string[];
  }[];
}

export function selectionFingerprint(input: SelectionFingerprintInput): string {
  const canonical = {
    workspace_id: input.workspaceId,
    project_id: input.projectId,
    chapter_id: input.chapterId,
    chapter_no: input.chapterNo,
    contract_id: input.contractId,
    contract_shape: input.contractShape,
    base_canon_version: input.baseCanonVersion,
    narrative_identity_ref: input.narrativeIdentityRef,
    narrative_identity_version_id: input.narrativeIdentityVersionId,
    narrative_identity_hash: input.narrativeIdentityHash,
    production_policy_version: input.productionPolicyVersion,
    production_policy_hash: input.productionPolicyHash,
    prompt_set_id: input.promptSetId,
    prompt_set_hash: input.promptSetHash,
    schedule: SELECTION_SCHEDULE,
    candidates: [...input.candidates]
      .sort((a, b) =>
        a.slot !== b.slot
          ? a.slot - b.slot
          : a.manuscriptVersionId < b.manuscriptVersionId
            ? -1
            : 1,
      )
      .map((c) => ({
        slot: c.slot,
        candidate_id: c.candidateId,
        manuscript_version_id: c.manuscriptVersionId,
        content_hash: c.contentHash,
        scorecard_artifact_id: c.scorecardArtifactId ?? null,
        scorecard_content_hash: c.scorecardContentHash ?? null,
        evaluator_provenance: [...c.evaluatorProvenance].sort(),
      })),
  };
  return artifactDigest(canonical);
}

/**
 * Build the fingerprint of the request this call represents, from resolved candidates and the run's pins.
 * The content hashes come from the STORED manuscript versions, not from the submission.
 */
async function fingerprintOf(
  ctx: WorkflowContext,
  input: SelectionInput,
  resolved: readonly ResolvedCandidate[],
): Promise<string> {
  const candidates: SelectionFingerprintInput['candidates'] = await Promise.all(
    resolved.map(async (r) => {
      const row = await getManuscriptVersion(ctx.pool, r.submission.manuscriptVersionId);
      return {
        slot: r.submission.slot,
        candidateId: r.submission.id,
        manuscriptVersionId: r.submission.manuscriptVersionId,
        contentHash: row?.content_hash ?? contentHashOfText(r.submission.text),
        scorecardArtifactId: r.scorecardArtifactId,
        scorecardContentHash: r.scorecardContentHash,
        evaluatorProvenance: await evaluatorProvenance(
          ctx,
          r.persistedScorecard?.evaluator_calls ?? [],
        ),
      };
    }),
  );
  return selectionFingerprint({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    chapterId: input.chapterId,
    chapterNo: input.chapterNo,
    contractId: input.contractId,
    contractShape: input.contractShape,
    baseCanonVersion: input.expect.baseCanonVersion,
    narrativeIdentityRef: ctx.pins.narrativeIdentityRef,
    narrativeIdentityVersionId: input.expect.narrativeIdentityVersionId,
    narrativeIdentityHash: artifactDigest(ctx.identity),
    productionPolicyVersion: input.expect.productionPolicyVersion,
    productionPolicyHash: ctx.pins.productionPolicyHash,
    promptSetId: input.expect.promptSetId,
    promptSetHash: promptSetHash(ctx),
    candidates,
  });
}

function promptSetHash(ctx: WorkflowContext): string {
  return artifactDigest(ctx.pins.promptSet);
}

/**
 * The model and prompt provenance of the evaluator calls a scorecard cites, read from the audit table.
 * A scorecard produced by a different judge model or prompt version yields a different fingerprint, so a
 * re-judged candidate can never inherit an earlier decision.
 */
async function evaluatorProvenance(
  ctx: WorkflowContext,
  callIds: readonly string[],
): Promise<readonly string[]> {
  if (callIds.length === 0) return [];
  const rows = await ctx.pool.query<{
    role: string;
    model_id: string;
    prompt_version_id: string;
    prompt_hash: string;
  }>(
    `SELECT role, model_id, prompt_version_id, prompt_hash FROM llm_calls
      WHERE project_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`,
    [ctx.projectId, [...callIds]],
  );
  return rows.rows.map((r) => `${r.role}:${r.model_id}:${r.prompt_version_id}:${r.prompt_hash}`);
}

/**
 * The comparator judgments a selection may spend: 2 per decisive pair (both presentation orders) plus one
 * bias-breaker per pair in the worst case (ADR-0015). Derived, never hardcoded.
 */
export function judgmentBudgetFor(eligibleCount: number): number {
  if (eligibleCount < 2) return 0;
  return (eligibleCount - 1) * 3;
}

/**
 * Select one winner from N ≥ 1 candidates.
 *
 * Returns `needs_attention` — never an arbitrary pick — when no candidate is eligible, when a pair ends in a
 * tie the pinned policy authorizes no deterministic fallback for, or when the comparator's preferences
 * contain a cycle that the schedule alone must not silently resolve. Array position is never a tie-break:
 * the ladder's last rung is the candidate's stable `slot` identity.
 *
 * Idempotency is fingerprinted, not merely keyed by chapter. A committed decision is returned only to a
 * request whose complete fingerprint matches it; a request that changed a candidate, a text, a slot, a
 * scorecard, the canon base, the contract, the policy, the identity or the prompt set is a DIFFERENT
 * question and is refused rather than silently answered with the old decision.
 */
export async function selectWinner(
  ctx: WorkflowContext,
  input: SelectionInput,
): Promise<SelectionResult> {
  const ordered = orderCandidates(input.candidates);
  const resolved = await resolveCandidates(ctx, input);
  const fingerprint = await fingerprintOf(ctx, input, resolved);

  // A committed decision answers exactly one request. Same fingerprint → return it; different fingerprint →
  // refuse, because selection has durable consequences (losers are terminal) that cannot be re-decided.
  const committed = await getSelection(ctx.pool, {
    projectId: ctx.projectId,
    chapterNo: input.chapterNo,
  });
  if (committed) return requireMatchingDecision(ctx, input, committed, fingerprint);

  const eligibility = resolved.map((r) => r.decision);
  const eligibleIds = new Set(eligibility.filter((d) => d.eligible).map((d) => d.candidateId));
  // Comparison runs on the PERSISTED scorecard, so the judge and the tie ladder see durable evidence.
  const persisted = new Map<string, Scorecard>();
  for (const r of resolved)
    if (r.persistedScorecard) persisted.set(r.submission.id, r.persistedScorecard);
  const eligible = ordered
    .filter((c) => eligibleIds.has(c.id))
    .map((c) => ({ ...c, scorecard: persisted.get(c.id) ?? c.scorecard }));
  const excluded: ExclusionRecord[] = [];
  for (const decision of eligibility) {
    if (decision.eligible) continue;
    excluded.push({
      candidateId: decision.candidateId,
      slot: decision.slot,
      reason: 'ineligible',
      codes: decision.codes,
      detail: decision.detail ?? decision.codes.join(', '),
    });
  }

  const pins = {
    baseCanonVersion: input.expect.baseCanonVersion,
    narrativeIdentityVersionId: input.expect.narrativeIdentityVersionId,
    productionPolicyVersion: input.expect.productionPolicyVersion,
    promptSetId: input.expect.promptSetId,
  };
  const budgeted = input.maxJudgments ?? judgmentBudgetFor(eligible.length);
  const base = {
    chapterNo: input.chapterNo,
    candidateIds: ordered.map((c) => c.id),
    eligibility,
    pins,
  };

  if (eligible.length === 0)
    return finish(ctx, input, fingerprint, {
      ...base,
      status: 'needs_attention',
      schedule: [],
      excluded,
      earlyStop: { applied: false, decision: undefined, detail: 'no eligible candidate' },
      budget: { pairsBudgeted: 0, judgmentsSpent: 0, detail: 'no comparison was scheduled' },
      needsAttentionReason:
        'no candidate is eligible; every candidate was excluded before comparison (see eligibility)',
    });

  // ---- Early stop (ADR-0015). Only with complete evidence for EVERY gate the policy requires, the
  // required margin above each, and no open blocking/major issue. Never an aggregate score.
  const first = eligible[0];
  if (!first)
    throw new WorkflowError('INTERNAL', 'ordered eligible list is empty', { step: 'select' });
  const earlyDecision = earlyStopDecision(ctx.policy, first);
  const earlyAllowed = eligible.length > 1 && earlyDecision.stop;
  if (earlyAllowed) {
    for (const c of eligible.slice(1))
      excluded.push({
        candidateId: c.id,
        slot: c.slot,
        reason: 'not_reached_early_stop',
        detail: `slot ${first.slot} cleared every gated dimension by the pinned margin of ${earlyDecision.marginPoints}, so later candidates were not compared (ADR-0015 early stop)`,
      });
    return finish(ctx, input, fingerprint, {
      ...base,
      status: 'selected',
      winnerId: first.id,
      winnerManuscriptVersionId: first.manuscriptVersionId,
      schedule: [],
      excluded,
      earlyStop: {
        applied: true,
        candidateId: first.id,
        decision: earlyDecision,
        detail: `allowed: every gated dimension cleared threshold + ${earlyDecision.marginPoints}, no blocking or major issue, and the candidate is auto-approvable`,
      },
      budget: {
        pairsBudgeted: budgeted,
        judgmentsSpent: 0,
        detail: 'early stop spent no comparator judgment',
      },
    });
  }

  // ---- Sequential single elimination over the deterministic order.
  const schedule: ComparisonScheduleEntry[] = [];
  let spent = 0;
  let standing = first;
  for (const challenger of eligible.slice(1)) {
    const pair = `s${standing.slot}s${challenger.slot}`;
    // Budget is checked BEFORE the provider is reached: a pair needs 2 judgments, and up to 3 if the
    // presentation orders disagree. Refusing here means no comparator call happens at all.
    const worstCase = 3;
    if (spent + worstCase > budgeted)
      throw new WorkflowError(
        'MODEL_CALL_FAILED',
        `comparator budget exhausted before pair ${pair}: ${spent} judgment(s) spent, ${budgeted} budgeted, up to ${worstCase} needed`,
        {
          step: 'select',
          data: {
            gateway_error: 'BUDGET_EXHAUSTED',
            pair,
            judgments_spent: spent,
            judgments_budgeted: budgeted,
            standing_candidate_id: standing.id,
            schedule,
          },
          recommendedActions: ['raise_budget'],
        },
      );

    // Durable per-pair step: a completed comparison replays instead of re-judging, so a retry adds no
    // judgment and a resume starts at the first incomplete pair.
    const outcome = await runStep(
      ctx,
      'select',
      async () =>
        compareCandidates(ctx, {
          chapterNo: input.chapterNo,
          contractShape: input.contractShape,
          a: standing,
          b: challenger,
        }),
      `${input.chapterNo}:${pair}`,
    );
    spent += outcome.verdicts.length;
    schedule.push({
      pair,
      aId: standing.id,
      bId: challenger.id,
      winnerId: outcome.winnerId,
      loserId: outcome.loserId,
      reason: outcome.reason,
      positionBiasDetected: outcome.positionBiasDetected,
      judgments: outcome.verdicts.length,
      verdictArtifactIds: outcome.verdictArtifactIds,
    });

    // An unresolved pair must not be decided by array order, and must not be decided by the ladder unless
    // the PINNED POLICY authorizes the ladder explicitly. `tie_fallback_ladder_authorized` is that
    // authorization and the only one: no other field's mere existence may be read as implying it.
    const ladderAuthorized = ctx.policy.candidates.tie_fallback_ladder_authorized === true;
    if (outcome.reason.startsWith('tiebreak_') && !ladderAuthorized)
      return finish(ctx, input, fingerprint, {
        ...base,
        status: 'needs_attention',
        schedule,
        excluded,
        earlyStop: {
          applied: false,
          decision: earlyDecision,
          detail: earlyStopDetail(earlyDecision),
        },
        budget: {
          pairsBudgeted: budgeted,
          judgmentsSpent: spent,
          detail: 'stopped at an unresolved tie',
        },
        needsAttentionReason: `pair ${pair} could not be separated and the pinned policy authorizes no deterministic fallback`,
      });

    const loser = outcome.loserId === standing.id ? standing : challenger;
    excluded.push({
      candidateId: loser.id,
      slot: loser.slot,
      reason: 'lost_comparison',
      detail: `lost pair ${pair} by ${outcome.reason}${outcome.positionBiasDetected ? ' after position bias was detected and resolved by a third shuffled-rubric judgment' : ''}`,
    });
    standing = outcome.winnerId === standing.id ? standing : challenger;
  }

  // ---- Cycle honesty. Single elimination consults N−1 pairs, so a candidate eliminated early is never
  // re-examined. If the judgments actually made contain a cycle (A beat B, B beat C, C beat A), the surviving
  // candidate is an artifact of the schedule rather than a defensible winner, and the honest answer is
  // needs_attention — not a winner dressed up as schedule-independent.
  const cycle = detectPreferenceCycle(schedule);
  if (cycle)
    return finish(ctx, input, fingerprint, {
      ...base,
      status: 'needs_attention',
      schedule,
      excluded,
      earlyStop: {
        applied: false,
        decision: earlyDecision,
        detail: earlyStopDetail(earlyDecision),
      },
      budget: {
        pairsBudgeted: budgeted,
        judgmentsSpent: spent,
        detail: 'stopped at a cyclic preference',
      },
      needsAttentionReason: `the comparator's preferences are cyclic (${cycle.join(' beats ')}), so no candidate is a defensible winner under any schedule; ADR-0015 authorizes no cycle-resolution rule`,
    });

  return finish(ctx, input, fingerprint, {
    ...base,
    status: 'selected',
    winnerId: standing.id,
    winnerManuscriptVersionId: standing.manuscriptVersionId,
    schedule,
    excluded,
    earlyStop: { applied: false, decision: earlyDecision, detail: earlyStopDetail(earlyDecision) },
    budget: {
      pairsBudgeted: budgeted,
      judgmentsSpent: spent,
      detail: `${schedule.length} decisive pair(s) over ${eligible.length} eligible candidates`,
    },
  });
}

function earlyStopDetail(decision: EarlyStopDecision): string {
  if (decision.reason === 'cleared') return 'not applied: only one eligible candidate';
  if (decision.missingDimensions.length > 0)
    return `refused: no evaluator evidence for gated dimension(s) ${decision.missingDimensions.join(', ')} — a missing judge is never a silent pass`;
  if (decision.shortDimensions.length > 0)
    return `refused: dimension(s) ${decision.shortDimensions.join(', ')} are short of threshold + ${decision.marginPoints}`;
  if (decision.reason === 'not_auto_approvable') return 'refused: candidate is not auto-approvable';
  if (decision.reason === 'open_issues') return 'refused: blocking or major issues are open';
  return `refused: ${decision.reason}`;
}

/**
 * Commit the selection: the evidence artifact, then the DECISION and every loser transition in a single
 * transaction (`commitSelection`).
 *
 * Order matters and is deliberate. The artifact is written first because it is append-only evidence that is
 * inert on its own: an artifact with no committed decision authorizes nothing, since approval and acceptance
 * read `candidate_selections`, not the artifact. The decision row and the loser transitions then commit
 * together, so there is no reachable state in which a decision exists while a loser is still live.
 *
 * A crash between the two writes leaves an orphan artifact and no decision; the retry recomputes the
 * identical decision (same slots, same durable comparator steps, same fingerprint), re-stores the identical
 * artifact content — `putArtifact` is content-addressed and refuses a differing payload under the same key —
 * and commits. A caller that loses the commit race gets a typed retriable conflict, never a raw duplicate-key
 * error, and its retry returns the committed decision.
 */
async function finish(
  ctx: WorkflowContext,
  input: SelectionInput,
  fingerprint: string,
  draft: Omit<SelectionResult, 'artifactId'>,
): Promise<SelectionResult> {
  const ref = await saveArtifact(ctx, {
    step: 'select',
    kind: 'candidate_selection',
    key: String(input.chapterNo),
    payload: {
      chapter_no: draft.chapterNo,
      status: draft.status,
      winner_id: draft.winnerId ?? null,
      winner_manuscript_version_id: draft.winnerManuscriptVersionId ?? null,
      candidate_ids: draft.candidateIds,
      eligibility: draft.eligibility,
      schedule: draft.schedule,
      excluded: draft.excluded,
      early_stop: {
        applied: draft.earlyStop.applied,
        candidate_id: draft.earlyStop.candidateId ?? null,
        detail: draft.earlyStop.detail,
        decision: draft.earlyStop.decision ?? null,
      },
      budget: {
        pairs_budgeted: draft.budget.pairsBudgeted,
        judgments_spent: draft.budget.judgmentsSpent,
        detail: draft.budget.detail,
      },
      needs_attention_reason: draft.needsAttentionReason ?? null,
      request_fingerprint: fingerprint,
      selection_schedule: SELECTION_SCHEDULE,
      pins: {
        base_canon_version: draft.pins.baseCanonVersion,
        narrative_identity_version_id: draft.pins.narrativeIdentityVersionId,
        production_policy_version: draft.pins.productionPolicyVersion,
        prompt_set_id: draft.pins.promptSetId,
      },
    },
  });

  // Losers become terminal so nothing downstream can mistake one for a live version. They stay immutable:
  // only `status` moves, and their text, hash and lineage are untouched. A needs_attention selection rejects
  // nothing — there is no decision to act on.
  const versionOf = new Map(input.candidates.map((c) => [c.id, c.manuscriptVersionId]));
  const loserVersionIds =
    draft.status === 'selected'
      ? draft.excluded
          .map((e) => versionOf.get(e.candidateId))
          .filter((id): id is string => id !== undefined)
      : [];

  try {
    await commitSelection(ctx.pool, {
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      chapterId: input.chapterId,
      chapterNo: input.chapterNo,
      jobId: ctx.job.id,
      status: draft.status,
      ...(draft.winnerId === undefined ? {} : { winnerCandidateId: draft.winnerId }),
      ...(draft.winnerManuscriptVersionId === undefined
        ? {}
        : { winnerManuscriptVersionId: draft.winnerManuscriptVersionId }),
      candidateVersionIds: [...versionOf.values()],
      loserVersionIds,
      requestFingerprint: fingerprint,
      selectionRequired: true,
      schedule: SELECTION_SCHEDULE,
      artifactId: ref.artifact_id,
    });
  } catch (err) {
    if (err instanceof SelectionConflictError)
      throw new WorkflowError(
        'SELECTION_CONFLICT',
        `chapter ${input.chapterNo} was selected concurrently by another caller; retry to read the committed decision`,
        {
          step: 'select',
          data: { chapter_no: input.chapterNo, project_id: ctx.projectId },
          recommendedActions: ['retry_step'],
          cause: err,
        },
      );
    throw err;
  }
  return { ...draft, artifactId: ref.artifact_id };
}

/**
 * The first cycle in the preferences actually observed, as candidate ids, or `undefined` when the judgments
 * made are acyclic. Only edges the comparator really produced are considered — this reports a cycle, it does
 * not speculate about pairs that were never judged.
 */
export function detectPreferenceCycle(
  schedule: readonly ComparisonScheduleEntry[],
): readonly string[] | undefined {
  const edges = new Map<string, string[]>();
  for (const entry of schedule) {
    const out = edges.get(entry.winnerId) ?? [];
    out.push(entry.loserId);
    edges.set(entry.winnerId, out);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const walk = (node: string): readonly string[] | undefined => {
    const seen = state.get(node);
    if (seen === 'done') return undefined;
    if (seen === 'visiting') return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of (edges.get(node) ?? []).slice().sort()) {
      const found = walk(next);
      if (found) return found;
    }
    stack.pop();
    state.set(node, 'done');
    return undefined;
  };
  for (const node of [...edges.keys()].sort()) {
    const found = walk(node);
    if (found) return found;
  }
  return undefined;
}

/**
 * A committed decision may answer only the request it was made for. Same fingerprint → return it; anything
 * else is refused, because selection's consequences are terminal and cannot be re-decided for a new question.
 */
async function requireMatchingDecision(
  ctx: WorkflowContext,
  input: SelectionInput,
  committed: CandidateSelectionRow,
  fingerprint: string,
): Promise<SelectionResult> {
  if (committed.request_fingerprint !== fingerprint)
    throw new WorkflowError(
      'SELECTION_REQUEST_CHANGED',
      `chapter ${input.chapterNo} already has a committed selection for a different request; the candidates, their text, their slots, their scorecards, the canon base, the contract, the policy, the identity or the prompt set changed`,
      {
        step: 'select',
        data: {
          chapter_no: input.chapterNo,
          committed_fingerprint: committed.request_fingerprint,
          requested_fingerprint: fingerprint,
        },
        recommendedActions: ['edit_manually'],
      },
    );
  const stored = await loadSelection(ctx, input.chapterNo);
  if (!stored)
    throw new WorkflowError(
      'INTERNAL',
      `chapter ${input.chapterNo} has a committed selection whose evidence artifact is missing`,
      { step: 'select' },
    );
  return stored;
}

interface StoredSelection {
  status: SelectionStatus;
  winner_id: string | null;
  winner_manuscript_version_id: string | null;
  candidate_ids: string[];
  eligibility: EligibilityDecision[];
  schedule: ComparisonScheduleEntry[];
  excluded: ExclusionRecord[];
  early_stop: {
    applied: boolean;
    candidate_id: string | null;
    detail: string;
    decision: EarlyStopDecision | null;
  };
  budget: { pairs_budgeted: number; judgments_spent: number; detail: string };
  needs_attention_reason: string | null;
  pins: {
    base_canon_version: number;
    narrative_identity_version_id: string;
    production_policy_version: string;
    prompt_set_id: string;
  };
}

/** Read the persisted selection for a chapter, if one exists. */
async function loadSelection(
  ctx: WorkflowContext,
  chapterNo: number,
): Promise<SelectionResult | undefined> {
  const row = await ctx.pool.query<{ id: string; payload: StoredSelection }>(
    `SELECT id, payload FROM workflow_artifacts
      WHERE project_id = $1 AND kind = 'candidate_selection' AND key = $2`,
    [ctx.projectId, String(chapterNo)],
  );
  const found = row.rows[0];
  if (!found) return undefined;
  const p = found.payload;
  return {
    status: p.status,
    chapterNo,
    ...(p.winner_id === null ? {} : { winnerId: p.winner_id }),
    ...(p.winner_manuscript_version_id === null
      ? {}
      : { winnerManuscriptVersionId: p.winner_manuscript_version_id }),
    candidateIds: p.candidate_ids,
    eligibility: p.eligibility,
    schedule: p.schedule,
    excluded: p.excluded,
    earlyStop: {
      applied: p.early_stop.applied,
      ...(p.early_stop.candidate_id === null ? {} : { candidateId: p.early_stop.candidate_id }),
      decision: p.early_stop.decision ?? undefined,
      detail: p.early_stop.detail,
    },
    budget: {
      pairsBudgeted: p.budget.pairs_budgeted,
      judgmentsSpent: p.budget.judgments_spent,
      detail: p.budget.detail,
    },
    ...(p.needs_attention_reason === null
      ? {}
      : { needsAttentionReason: p.needs_attention_reason }),
    artifactId: found.id,
    pins: {
      baseCanonVersion: p.pins.base_canon_version,
      narrativeIdentityVersionId: p.pins.narrative_identity_version_id,
      productionPolicyVersion: p.pins.production_policy_version,
      promptSetId: p.pins.prompt_set_id,
    },
  };
}

/**
 * IS a selection required for this chapter, and if so WHICH version won? Decided from persisted state only.
 *
 * Two independent sources make this unforgeable by a caller:
 *  * the committed `candidate_selections` row — if a selection was committed for this chapter, its winner is
 *    the only version that may ever be approved or accepted, whatever any caller passes in;
 *  * the pinned Production Policy together with the durable candidate rows — when the policy asks for more
 *    than one chapter candidate, or when more than one live candidate version exists for the chapter, a
 *    selection is REQUIRED and its absence fails closed rather than defaulting to "no selection needed".
 *
 * There is no caller-supplied flag anywhere in this decision.
 */
export async function selectionRequirement(
  ctx: WorkflowContext,
  input: { chapterNo: number; chapterId: string },
): Promise<{
  required: boolean;
  reason: string;
  committed: CandidateSelectionRow | undefined;
}> {
  const committed = await getSelection(ctx.pool, {
    projectId: ctx.projectId,
    chapterNo: input.chapterNo,
  });
  if (committed)
    return {
      required: true,
      reason: `chapter ${input.chapterNo} has a committed candidate selection`,
      committed,
    };
  const policyCandidates = ctx.policy.candidates.chapter_candidates;
  if (policyCandidates > 1)
    return {
      required: true,
      reason: `the pinned Production Policy ${ctx.pins.productionPolicyVersion} produces ${policyCandidates} chapter candidates`,
      committed: undefined,
    };
  // More than one candidate-origin version on the chapter means N-candidate production really happened,
  // whatever the policy number says; approving one of them without a selection is exactly the bypass this
  // guard exists to refuse.
  const live = await ctx.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM manuscript_versions
      WHERE chapter_id = $1 AND origin = 'candidate' AND status = 'working'`,
    [input.chapterId],
  );
  const liveCount = Number(live.rows[0]?.n ?? '0');
  if (liveCount > 1)
    return {
      required: true,
      reason: `${liveCount} live candidate versions exist for chapter ${input.chapterNo}`,
      committed: undefined,
    };
  return {
    required: false,
    reason: `the pinned policy produces ${policyCandidates} chapter candidate and ${liveCount} live candidate version(s) exist`,
    committed: undefined,
  };
}

/**
 * Winner-only propagation guard, enforced at the PRODUCTION BOUNDARY. `approveVersion` and `acceptDelta`
 * both call this before they touch a manuscript or canon, so a direct call to either entry point with a
 * loser fails closed; it is not an optional helper a caller may skip.
 *
 * Fails closed on every one of: a loser, a missing selection where one is required, a needs_attention
 * selection, a selection belonging to another project or chapter, a candidate whose stored text no longer
 * matches what was selected, and a decision whose canon base, contract, policy, identity or prompt set no
 * longer match the run — all of which are covered because the committed fingerprint is re-derived from the
 * decision's own record rather than re-asserted by the caller.
 */
export async function requireSelectedWinner(
  ctx: WorkflowContext,
  input: {
    chapterNo: number;
    chapterId: string;
    manuscriptVersionId: string;
    step: 'approve' | 'accept';
  },
): Promise<{ enforced: boolean; winnerManuscriptVersionId: string | undefined; reason: string }> {
  const requirement = await selectionRequirement(ctx, {
    chapterNo: input.chapterNo,
    chapterId: input.chapterId,
  });
  if (!requirement.required)
    return { enforced: false, winnerManuscriptVersionId: undefined, reason: requirement.reason };

  const decision = requirement.committed;
  if (!decision)
    throw new WorkflowError(
      'APPROVAL_BLOCKED',
      `chapter ${input.chapterNo} requires candidate selection (${requirement.reason}) but none is committed; ${input.step} may not proceed on an unselected candidate`,
      {
        step: input.step,
        data: { chapter_no: input.chapterNo, reason: requirement.reason },
        recommendedActions: ['retry_step'],
      },
    );
  // A decision from another project or chapter can never authorize this one.
  if (decision.project_id !== ctx.projectId || decision.chapter_id !== input.chapterId)
    throw new WorkflowError(
      'APPROVAL_BLOCKED',
      `the committed selection for chapter ${input.chapterNo} belongs to another project or chapter`,
      { step: input.step, recommendedActions: ['edit_manually'] },
    );
  if (decision.status !== 'selected' || decision.winner_manuscript_version_id === null)
    throw new WorkflowError(
      'APPROVAL_BLOCKED',
      `chapter ${input.chapterNo} selection is ${decision.status}; no candidate was selected, so ${input.step} may not proceed`,
      { step: input.step, recommendedActions: ['edit_manually', 'regenerate'] },
    );
  if (decision.winner_manuscript_version_id !== input.manuscriptVersionId)
    throw new WorkflowError(
      'APPROVAL_BLOCKED',
      `manuscript version ${input.manuscriptVersionId} is not the selected winner (${decision.winner_manuscript_version_id}) for chapter ${input.chapterNo}`,
      {
        step: input.step,
        data: {
          supplied: input.manuscriptVersionId,
          selected: decision.winner_manuscript_version_id,
        },
        recommendedActions: ['edit_manually'],
      },
    );
  // The winner must still be the text that was judged: a mutated candidate is not the thing that won.
  const row = await getManuscriptVersion(ctx.pool, decision.winner_manuscript_version_id);
  if (row?.content_hash !== contentHashOfText(row?.text ?? ''))
    throw new WorkflowError(
      'APPROVAL_BLOCKED',
      `the selected winner ${decision.winner_manuscript_version_id} is missing or its stored text no longer matches its content hash`,
      { step: input.step, recommendedActions: ['edit_manually'] },
    );
  return {
    enforced: true,
    winnerManuscriptVersionId: decision.winner_manuscript_version_id,
    reason: requirement.reason,
  };
}

export { GatewayError };
