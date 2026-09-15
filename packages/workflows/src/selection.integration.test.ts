/**
 * B-6-4 N-candidate selection on Postgres + ReplayProvider (ADR-0015, ADR-0014, ADR-0041).
 *
 * Three real candidates, not two: chapter 1's assembled draft and revised version plus a third immutable
 * candidate version, so no two-candidate assumption can hide. Every comparator judgment is replayed — no
 * credentials, no live provider, no spend.
 *
 * The tests prove the orchestration properties that matter: deterministic outcome regardless of insertion
 * or row order, eligibility refusals before any comparison, position-bias resolution, budget refusal
 * BEFORE a provider call, resume/idempotency across the durable pair boundary, and winner-only propagation
 * verified from the PERSISTED selection rather than a caller-supplied id.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createManuscriptVersion,
  getSelection,
  getManuscriptVersion,
  migrate,
  putArtifact,
  resetDatabase,
  type ManuscriptVersionRow,
  type Pool,
} from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import {
  judgmentBudgetFor,
  makeContext,
  orderCandidates,
  produceChapter,
  requireSelectedWinner,
  selectWinner,
  WorkflowError,
  type CandidateSubmission,
  type SelectionInput,
  type WorkflowContext,
} from './index.js';
import { type Scorecard } from './evaluation.js';
import { createHarness, IDS, type Harness } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

const CONTRACT_SHAPE = JSON.stringify({
  chapter_number: 1,
  hook: { type: 'reveal' },
  opening: { type: 'in_medias_res' },
});

interface Prepared {
  readonly ctx: WorkflowContext;
  readonly candidates: readonly CandidateSubmission[];
  readonly chapterId: string;
  readonly expect: SelectionInput['expect'];
}

/**
 * Stage THREE eligible candidates the way production would: chapter 1 runs only as far as its contract and
 * pack (`stage: 'contract_and_pack'`), then three sibling `origin: 'candidate'` versions are created on
 * that chapter. Selection happens BEFORE approval, so no candidate is accepted or rejected yet — running
 * the full loop first would accept one version and leave another failing its prose gate, which is exactly
 * what the eligibility rules refuse.
 *
 * All three carry the same complete, passing scorecard so the COMPARISON decides the winner rather than a
 * gate or a missing judge; the individual gate and evidence rules are exercised in their own tests below.
 */
async function prepare(pool: Pool, h: Harness): Promise<Prepared> {
  const staged = await produceChapter(
    { pool, gateway: h.gateway(), bindings: h.bindings },
    h.input(1, { stage: 'contract_and_pack' }),
  );
  const chapterId = staged.chapter_id;
  const texts = [
    'Candidate one. The measurement device screamed, and the red letters held.\n\nThe officer was already calling the next name.',
    'Candidate two. The hall was quiet before the device screamed.\n\nA paragraph later, the letters resolved.',
    'Candidate three. The device screamed once.\n\nThe ending turns outward and pulls forward hard.',
  ];
  const rows: ManuscriptVersionRow[] = [];
  for (const text of texts) {
    rows.push(
      await createManuscriptVersion(pool, {
        workspaceId: h.workspaceId,
        projectId: h.projectId,
        chapterId,
        origin: 'candidate',
        text,
        createdByJobId: undefined,
      }),
    );
  }

  const expect_ = {
    baseCanonVersion: staged.pins.canonVersionRead,
    narrativeIdentityVersionId: staged.pins.narrativeIdentityVersionId,
    productionPolicyVersion: staged.pins.productionPolicyVersion,
    promptSetId: staged.pins.promptSetId,
  };
  const common = {
    projectId: h.projectId,
    chapterNo: 1,
    baseCanonVersion: expect_.baseCanonVersion,
    narrativeIdentityVersionId: expect_.narrativeIdentityVersionId,
    productionPolicyVersion: expect_.productionPolicyVersion,
    promptSetId: expect_.promptSetId,
  };
  const candidates: CandidateSubmission[] = rows.map((row, i) => ({
    ...common,
    slot: i + 1,
    id: row.id,
    manuscriptVersionId: row.id,
    text: row.text,
    scorecard: passingScorecard(row.id, false, expect_.baseCanonVersion),
    patchCount: i === 0 ? 1 : 0,
  }));
  // Eligibility reads DURABLE evidence, so each candidate's scorecard is stored exactly as
  // `evaluateVersion` stores it. A submission alone proves nothing.
  for (const c of candidates) await persistScorecard(pool, h, c.manuscriptVersionId, c.scorecard);
  for (const c of candidates) h.bindings[`candidate.${c.slot}`] = c.id;
  const { ctx } = await makeContext(
    { pool, gateway: h.gateway(), bindings: h.bindings },
    h.projectId,
    1,
  );
  return { ctx, candidates, chapterId, expect: expect_ };
}

/**
 * A scorecard that clears every dimension `standard.v1` gates with no open issue, but sits WITHIN the
 * early-stop margin (threshold + `early_stop_margin_points`), so comparison is what decides the winner.
 * `clearsMargin` lifts every dimension above the margin to exercise the early-stop path instead.
 */
function passingScorecard(versionId: string, clearsMargin = false, canonVersion = 3): Scorecard {
  const lift = clearsMargin ? 10 : 2;
  const section = (gate: number) => ({ score: gate + lift, passed: true });
  return {
    id: versionId,
    manuscript_version_id: versionId,
    canon_version: canonVersion,
    overall: { score: 80 + lift, blocking_count: 0, major_count: 0, minor_count: 0 },
    sections: {
      prose: section(78),
      structure: section(78),
      genre: section(72),
      voice: section(76),
      output_language: { score: 100, passed: true },
    },
    issues: [],
    acceptance: {
      criteria_results: [],
      dimension_results: [
        { dimension: 'prose', score: 78 + lift, threshold: 78, passed: true },
        { dimension: 'structure', score: 78 + lift, threshold: 78, passed: true },
        { dimension: 'genre', score: 72 + lift, threshold: 72, passed: true },
        { dimension: 'voice', score: 76 + lift, threshold: 76, passed: true },
      ],
      auto_approvable: true,
      production_policy_version: 'policy/standard@1',
      gate_outcome: 'approved',
    },
  };
}

function inputFor(p: Prepared, overrides: Partial<SelectionInput> = {}): SelectionInput {
  return {
    chapterNo: 1,
    chapterId: p.chapterId,
    contractId: IDS.contract1 ?? '',
    contractShape: CONTRACT_SHAPE,
    candidates: p.candidates,
    expect: p.expect,
    ...overrides,
  };
}

describe('candidate ordering is deterministic (B-6-4)', () => {
  it('orders by slot then id, independent of array order', () => {
    const rows = [
      { slot: 3, id: 'c' },
      { slot: 1, id: 'b' },
      { slot: 2, id: 'a' },
      { slot: 1, id: 'a' },
    ];
    const ordered = orderCandidates(rows).map((r) => `${r.slot}${r.id}`);
    expect(ordered).toEqual(['1a', '1b', '2a', '3c']);
    // Any permutation of the same rows yields the same order.
    expect(orderCandidates([...rows].reverse()).map((r) => `${r.slot}${r.id}`)).toEqual(ordered);
  });

  it('budgets 2 judgments per decisive pair plus one bias-breaker (ADR-0015)', () => {
    expect(judgmentBudgetFor(0)).toBe(0);
    expect(judgmentBudgetFor(1)).toBe(0);
    expect(judgmentBudgetFor(2)).toBe(3);
    expect(judgmentBudgetFor(3)).toBe(6);
    expect(judgmentBudgetFor(5)).toBe(12);
  });
});

run('N-candidate selection with three candidates (B-6-4)', () => {
  let pool: Pool;
  let h: Harness;
  let p: Prepared;

  beforeAll(async () => {
    pool = await freshDatabase();
  }, 60_000);
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    h = await createHarness(pool);
    p = await prepare(pool, h);
  }, 300_000);
  afterAll(async () => {
    await pool.end();
  });

  it('selects exactly one winner from three candidates over N-1 decisive pairs', async () => {
    const result = await selectWinner(p.ctx, inputFor(p));
    expect(result.status).toBe('selected');
    expect(result.candidateIds).toHaveLength(3);
    expect(result.eligibility.every((e) => e.eligible)).toBe(true);
    // Single elimination: 2 decisive pairs for 3 candidates, each judged in both orders.
    expect(result.schedule).toHaveLength(2);
    expect(result.schedule.map((s) => s.pair)).toEqual(['s1s2', 's1s3']);
    for (const entry of result.schedule) expect(entry.judgments).toBe(2);
    expect(result.winnerId).toBe(p.candidates[0]?.id);
    // Exactly one winner, and every other candidate is excluded with a reason.
    expect(result.excluded).toHaveLength(2);
    expect(result.excluded.every((e) => e.reason === 'lost_comparison')).toBe(true);
    expect(h.provider.misses).toEqual([]);
  }, 300_000);

  it('reaches the same winner whatever order the candidates were supplied in', async () => {
    const forward = await selectWinner(p.ctx, inputFor(p));
    // A fresh project so the second run is judged rather than replayed from the audit store.
    await resetDatabase(pool);
    await migrate(pool);
    const h2 = await createHarness(pool);
    const p2 = await prepare(pool, h2);
    const shuffled = [p2.candidates[2], p2.candidates[0], p2.candidates[1]].filter(
      (c): c is CandidateSubmission => c !== undefined,
    );
    const reverse = await selectWinner(p2.ctx, inputFor(p2, { candidates: shuffled }));
    expect(reverse.status).toBe('selected');
    // Same slots win, and the schedule is identical: row order cannot change the outcome.
    const slotOf = (r: typeof forward, id: string | undefined) =>
      r.eligibility.find((e) => e.candidateId === id)?.slot;
    expect(slotOf(reverse, reverse.winnerId)).toBe(slotOf(forward, forward.winnerId));
    expect(reverse.schedule.map((s) => s.pair)).toEqual(forward.schedule.map((s) => s.pair));
  }, 600_000);

  it('persists the whole selection as a content-addressed artifact', async () => {
    const result = await selectWinner(p.ctx, inputFor(p));
    const row = await pool.query<{
      id: string;
      content_hash: string;
      payload: {
        status: string;
        winner_manuscript_version_id: string;
        eligibility: unknown[];
        schedule: unknown[];
        excluded: unknown[];
        early_stop: { applied: boolean; detail: string };
        budget: { judgments_spent: number };
        pins: Record<string, unknown>;
      };
    }>(
      `SELECT id, content_hash, payload FROM workflow_artifacts
        WHERE project_id = $1 AND kind = 'candidate_selection'`,
      [h.projectId],
    );
    expect(row.rows).toHaveLength(1);
    const payload = row.rows[0]?.payload;
    expect(row.rows[0]?.id).toBe(result.artifactId);
    expect(row.rows[0]?.content_hash).toMatch(/^sha256:/);
    expect(payload?.status).toBe('selected');
    expect(payload?.winner_manuscript_version_id).toBe(result.winnerManuscriptVersionId);
    expect(payload?.eligibility).toHaveLength(3);
    expect(payload?.schedule).toHaveLength(2);
    expect(payload?.excluded).toHaveLength(2);
    expect(payload?.budget.judgments_spent).toBe(4);
    // Provenance is pinned on the record, not implied.
    expect(payload?.pins).toMatchObject({
      base_canon_version: p.expect.baseCanonVersion,
      narrative_identity_version_id: p.expect.narrativeIdentityVersionId,
      production_policy_version: p.expect.productionPolicyVersion,
      prompt_set_id: p.expect.promptSetId,
    });
  }, 300_000);

  it('is idempotent: a repeated selection replays every pair and adds no judgment', async () => {
    const first = await selectWinner(p.ctx, inputFor(p));
    const callsAfterFirst = await countComparatorCalls(pool, h.projectId);
    const second = await selectWinner(p.ctx, inputFor(p));
    expect(second.winnerId).toBe(first.winnerId);
    expect(second.schedule.map((s) => s.winnerId)).toEqual(first.schedule.map((s) => s.winnerId));
    // No new comparator call, and still exactly one selection artifact.
    expect(await countComparatorCalls(pool, h.projectId)).toBe(callsAfterFirst);
    const artifacts = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM workflow_artifacts WHERE project_id = $1 AND kind = 'candidate_selection'`,
      [h.projectId],
    );
    expect(artifacts.rows[0]?.n).toBe('1');
  }, 300_000);

  it('resumes at the first incomplete pair without repeating a completed comparison', async () => {
    // Complete only the first pair by budgeting exactly one pair's worth of judgments.
    const partial = await selectWinner(p.ctx, inputFor(p, { maxJudgments: 3 })).catch(
      (e: unknown) => e,
    );
    expect(partial).toBeInstanceOf(WorkflowError);
    expect((partial as WorkflowError).code).toBe('MODEL_CALL_FAILED');
    const afterPartial = await countComparatorCalls(pool, h.projectId);
    expect(afterPartial).toBe(2); // the first pair only

    // Resume with the full budget: the completed pair replays, only the second pair is judged.
    const resumed = await selectWinner(p.ctx, inputFor(p));
    expect(resumed.status).toBe('selected');
    expect(resumed.schedule).toHaveLength(2);
    expect(await countComparatorCalls(pool, h.projectId)).toBe(4);
  }, 300_000);

  it('two simultaneous selections converge or fail with a TYPED retriable conflict', async () => {
    // A genuine race: both callers start before either has committed, so the durable short-circuit cannot
    // help and they contend on the (project, chapter) uniqueness that owns the decision.
    //
    // The allowed outcomes are exactly two, and both are asserted rather than tolerated:
    //   * both return the same winner, or
    //   * one succeeds and the other receives a typed SELECTION_CONFLICT — never a raw database error.
    const [a, b] = await Promise.allSettled([
      selectWinner(p.ctx, inputFor(p)),
      selectWinner(p.ctx, inputFor(p)),
    ]);
    const fulfilled = [a, b].filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof selectWinner>>> =>
        r.status === 'fulfilled',
    );
    const rejected = [a, b].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length + rejected.length).toBe(2);
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // Any caller that failed must have failed in the controlled way. A raw duplicate-key error escaping
    // here is precisely the defect this assertion exists to catch.
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(WorkflowError);
      const wf = r.reason as WorkflowError;
      // Both losing paths are typed and retriable: CONCURRENT_CALL when the race is decided at the
      // gateway's per-activity idempotency index, SELECTION_CONFLICT when it is decided at the selection
      // decision row. Neither is an opaque INTERNAL, and neither leaks a raw database message.
      expect(['CONCURRENT_CALL', 'SELECTION_CONFLICT']).toContain(wf.code);
      expect(wf.options.recommendedActions).toContain('retry_step');
      expect(wf.detail).not.toContain('duplicate key');
      // And its retry converges on the committed decision.
      const retried = await selectWinner(p.ctx, inputFor(p));
      expect(retried.status).toBe('selected');
    }
    // Every caller that succeeded agrees on the same winner.
    const winners = new Set(fulfilled.map((r) => r.value.winnerId));
    expect(winners.size).toBe(1);

    // Exactly one committed decision, and no duplicate successful comparator judgment.
    const decisions = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM candidate_selections WHERE project_id = $1',
      [h.projectId],
    );
    expect(decisions.rows[0]?.n).toBe('1');
    const duplicateJudgments = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT idempotency_key FROM llm_calls
          WHERE project_id = $1 AND role = 'chapter_comparator' AND status <> 'failed'
          GROUP BY idempotency_key HAVING count(*) > 1) d`,
      [h.projectId],
    );
    expect(duplicateJudgments.rows[0]?.n).toBe('0');

    // Exactly one selection record exists, and a later read returns that same decision.
    const artifacts = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM workflow_artifacts WHERE project_id = $1 AND kind = 'candidate_selection'`,
      [h.projectId],
    );
    expect(artifacts.rows[0]?.n).toBe('1');
    const settled = await selectWinner(p.ctx, inputFor(p));
    expect(settled.winnerId).toBe([...winners][0]);
    // And exactly one candidate remains live: the winner.
    const live = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM manuscript_versions
        WHERE chapter_id = $1 AND origin = 'candidate' AND status = 'working'`,
      [p.chapterId],
    );
    expect(live.rows[0]?.n).toBe('1');
  }, 300_000);
});

run('candidate eligibility is decided before any comparison (B-6-4)', () => {
  let pool: Pool;
  let h: Harness;
  let p: Prepared;

  beforeAll(async () => {
    pool = await freshDatabase();
  }, 60_000);
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    h = await createHarness(pool);
    p = await prepare(pool, h);
  }, 300_000);
  afterAll(async () => {
    await pool.end();
  });

  it.each([
    ['CROSS_PROJECT', { projectId: '0191b2a0-0000-7000-8000-00000000dead' }],
    ['CROSS_CHAPTER', { chapterNo: 7 }],
    ['CANON_VERSION_MISMATCH', { baseCanonVersion: 999 }],
    ['IDENTITY_VERSION_MISMATCH', { narrativeIdentityVersionId: 'other-identity' }],
    ['POLICY_VERSION_MISMATCH', { productionPolicyVersion: 'policy/economy@1' }],
    ['PROMPT_PROVENANCE_MISMATCH', { promptSetId: 'set:other' }],
  ])(
    'excludes a candidate with %s and never lets it win',
    async (code, override) => {
      const candidates = p.candidates.map((c, i) => (i === 0 ? { ...c, ...override } : c));
      const result = await selectWinner(p.ctx, inputFor(p, { candidates }));
      const decision = result.eligibility.find((e) => e.candidateId === candidates[0]?.id);
      expect(decision?.eligible).toBe(false);
      expect(decision?.codes).toContain(code);
      expect(result.winnerId).not.toBe(candidates[0]?.id);
      // The excluded candidate is recorded as ineligible, not as having lost a comparison.
      const excluded = result.excluded.find((e) => e.candidateId === candidates[0]?.id);
      expect(excluded?.reason).toBe('ineligible');
      // Only the two remaining candidates were compared: one decisive pair.
      expect(result.schedule).toHaveLength(1);
    },
    300_000,
  );

  it('a candidate failing a blocking gate is eliminated before comparison, not out-compared', async () => {
    const failing = p.candidates[0];
    if (!failing) throw new Error('no candidate');
    // The failure is recorded in the STORED scorecard, which is the only evidence eligibility reads.
    const broken: Scorecard = {
      ...failing.scorecard,
      sections: {
        ...failing.scorecard.sections,
        prose: { score: 10, passed: false },
      },
      overall: { ...failing.scorecard.overall, blocking_count: 1 },
    };
    await replaceScorecard(pool, h, failing.manuscriptVersionId, broken);
    const result = await selectWinner(
      p.ctx,
      inputFor(p, { candidates: [{ ...failing, scorecard: broken }, ...p.candidates.slice(1)] }),
    );
    const decision = result.eligibility.find((e) => e.candidateId === failing.id);
    expect(decision?.codes).toContain('BLOCKING_GATE_FAILED');
    expect(result.winnerId).not.toBe(failing.id);
  }, 300_000);

  it('a fabricated passing scorecard cannot override the stored failure', async () => {
    const candidate = p.candidates[0];
    if (!candidate) throw new Error('no candidate');
    // Durable truth: this candidate failed its prose gate with a blocking issue.
    await replaceScorecard(pool, h, candidate.manuscriptVersionId, {
      ...candidate.scorecard,
      sections: { ...candidate.scorecard.sections, prose: { score: 12, passed: false } },
      overall: { ...candidate.scorecard.overall, blocking_count: 2 },
    });
    // The caller submits the original, passing scorecard anyway.
    const result = await selectWinner(p.ctx, inputFor(p));
    const decision = result.eligibility.find((e) => e.candidateId === candidate.id);
    expect(decision?.eligible).toBe(false);
    // Refused for BOTH reasons: the submission disagrees with durable evidence, and that evidence fails.
    expect(decision?.codes).toContain('SCORECARD_NOT_AUTHENTIC');
    expect(result.winnerId).not.toBe(candidate.id);
  }, 300_000);

  it.each([
    [
      'a scorecard belonging to another manuscript',
      (c: CandidateSubmission, other: string): Scorecard => ({
        ...c.scorecard,
        manuscript_version_id: other,
      }),
    ],
    [
      'a scorecard produced against a stale canon version',
      (c: CandidateSubmission): Scorecard => ({ ...c.scorecard, canon_version: 1 }),
    ],
  ])(
    'refuses %s as evaluation evidence',
    async (_label, mutate) => {
      const candidate = p.candidates[0];
      const other = p.candidates[1];
      if (!candidate || !other) throw new Error('no candidate');
      await replaceScorecard(
        pool,
        h,
        candidate.manuscriptVersionId,
        mutate(candidate, other.manuscriptVersionId),
      );
      const result = await selectWinner(p.ctx, inputFor(p));
      const decision = result.eligibility.find((e) => e.candidateId === candidate.id);
      expect(decision?.eligible).toBe(false);
      expect(decision?.codes).toContain('SCORECARD_NOT_AUTHENTIC');
      expect(result.winnerId).not.toBe(candidate.id);
    },
    300_000,
  );

  it('refuses a candidate with no persisted scorecard at all', async () => {
    const candidate = p.candidates[0];
    if (!candidate) throw new Error('no candidate');
    await pool.query(
      'ALTER TABLE workflow_artifacts DISABLE TRIGGER workflow_artifacts_append_only',
    );
    await pool.query(
      `DELETE FROM workflow_artifacts WHERE project_id = $1 AND step = 'evaluate' AND kind = 'scorecard' AND key = $2`,
      [h.projectId, candidate.manuscriptVersionId],
    );
    await pool.query(
      'ALTER TABLE workflow_artifacts ENABLE TRIGGER workflow_artifacts_append_only',
    );
    const result = await selectWinner(p.ctx, inputFor(p));
    const decision = result.eligibility.find((e) => e.candidateId === candidate.id);
    expect(decision?.codes).toContain('SCORECARD_NOT_PERSISTED');
    expect(result.winnerId).not.toBe(candidate.id);
  }, 300_000);

  it('refuses a malformed persisted scorecard artifact', async () => {
    const candidate = p.candidates[0];
    if (!candidate) throw new Error('no candidate');
    await pool.query(
      'ALTER TABLE workflow_artifacts DISABLE TRIGGER workflow_artifacts_append_only',
    );
    await pool.query(
      `UPDATE workflow_artifacts SET payload = '{"id":"broken"}'::jsonb
        WHERE project_id = $1 AND step = 'evaluate' AND kind = 'scorecard' AND key = $2`,
      [h.projectId, candidate.manuscriptVersionId],
    );
    await pool.query(
      'ALTER TABLE workflow_artifacts ENABLE TRIGGER workflow_artifacts_append_only',
    );
    const result = await selectWinner(p.ctx, inputFor(p));
    const decision = result.eligibility.find((e) => e.candidateId === candidate.id);
    // A payload that is not a scorecard is not evidence: it reads as no persisted scorecard at all.
    expect(decision?.codes).toContain('SCORECARD_NOT_PERSISTED');
    expect(result.winnerId).not.toBe(candidate.id);
  }, 300_000);

  it('a candidate missing a required gate is excluded: a missing judge is never a silent pass', async () => {
    const candidate = p.candidates[0];
    if (!candidate) throw new Error('no candidate');
    const sections = { ...candidate.scorecard.sections } as Record<string, unknown>;
    delete sections.genre;
    const stripped = { ...candidate.scorecard, sections } as Scorecard;
    await replaceScorecard(pool, h, candidate.manuscriptVersionId, stripped);
    const result = await selectWinner(
      p.ctx,
      inputFor(p, {
        candidates: [{ ...candidate, scorecard: stripped }, ...p.candidates.slice(1)],
      }),
    );
    const decision = result.eligibility.find((e) => e.candidateId === candidate.id);
    expect(decision?.codes).toContain('GATE_EVIDENCE_MISSING');
    expect(decision?.detail).toContain('genre');
  }, 300_000);

  it('returns needs_attention rather than picking arbitrarily when no candidate is eligible', async () => {
    const candidates = p.candidates.map((c) => ({ ...c, baseCanonVersion: 999 }));
    const result = await selectWinner(p.ctx, inputFor(p, { candidates }));
    expect(result.status).toBe('needs_attention');
    expect(result.winnerId).toBeUndefined();
    expect(result.schedule).toEqual([]);
    expect(result.needsAttentionReason).toContain('no candidate is eligible');
    // Nothing was judged, so nothing was spent.
    expect(result.budget.judgmentsSpent).toBe(0);
    expect(await countComparatorCalls(pool, h.projectId)).toBe(0);
  }, 300_000);

  it('excludes a candidate whose manuscript version is already terminal', async () => {
    const candidate = p.candidates[1];
    if (!candidate) throw new Error('no candidate');
    await pool.query(`UPDATE manuscript_versions SET status = 'rejected' WHERE id = $1`, [
      candidate.manuscriptVersionId,
    ]);
    const result = await selectWinner(p.ctx, inputFor(p));
    const decision = result.eligibility.find((e) => e.candidateId === candidate.id);
    expect(decision?.codes).toContain('ALREADY_TERMINAL');
    expect(result.winnerId).not.toBe(candidate.id);
  }, 300_000);
});

run('bias, budget and winner-only propagation (B-6-4)', () => {
  let pool: Pool;
  let h: Harness;
  let p: Prepared;

  beforeAll(async () => {
    pool = await freshDatabase();
  }, 60_000);
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    h = await createHarness(pool);
    p = await prepare(pool, h);
  }, 300_000);
  afterAll(async () => {
    await pool.end();
  });

  it('detects position bias on a pair and resolves it with a third shuffled-rubric judgment', async () => {
    h.provider.alias('activity:compare:1:s1s3:ab', 'variant:compare:1:s1s3:ab:biased');
    h.provider.alias('activity:compare:1:s1s3:ba', 'variant:compare:1:s1s3:ba:biased');
    h.provider.alias(
      'activity:compare:1:s1s3:shuffled',
      'variant:compare:1:s1s3:shuffled:decides_1',
    );
    const result = await selectWinner(p.ctx, inputFor(p));
    const biased = result.schedule.find((s) => s.pair === 's1s3');
    expect(biased?.positionBiasDetected).toBe(true);
    expect(biased?.reason).toBe('tiebreak_shuffled_rubric');
    expect(biased?.judgments).toBe(3);
    expect(result.status).toBe('selected');
    // The third judgment is persisted like the other two.
    expect(biased?.verdictArtifactIds).toHaveLength(3);
  }, 300_000);

  it.each([
    ['before the first judgment', 0, 0],
    ['between A/B and B/A of the first pair', 2, 0],
    ['before the second pair, after the first is complete', 4, 2],
  ])(
    'refuses at the budget boundary %s with no provider call after the failed check',
    async (_label, budget, expectedCalls) => {
      const err = await selectWinner(p.ctx, inputFor(p, { maxJudgments: budget })).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(WorkflowError);
      const wf = err as WorkflowError;
      expect(wf.code).toBe('MODEL_CALL_FAILED');
      expect(wf.options.data).toMatchObject({ gateway_error: 'BUDGET_EXHAUSTED' });
      expect(wf.options.recommendedActions).toContain('raise_budget');
      // The refusal happens BEFORE the provider is reached, so no extra call exists.
      expect(await countComparatorCalls(pool, h.projectId)).toBe(expectedCalls);
    },
    300_000,
  );

  it('fails closed when the judge names the wrong candidates', async () => {
    h.provider.alias('activity:compare:1:s1s3:ab', 'variant:compare:1:s1s3:ab:wrong_ids');
    const err = await selectWinner(p.ctx, inputFor(p)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowError);
    expect((err as WorkflowError).code).toBe('EVALUATION_FAILED');
    expect((err as WorkflowError).detail).toContain('comparison verdict names candidates');
  }, 300_000);

  it('a genuinely missing comparator recording fails closed, then resumes without re-judging', async () => {
    // A REAL miss on the context that actually executes: the recording for the second pair is removed from
    // the very provider this selection uses, not from a different harness.
    const key = 'activity:compare:1:s1s3:ab';
    const removed = h.provider.remove(key);
    expect(removed).toBeDefined();

    const err = await selectWinner(p.ctx, inputFor(p)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowError);
    const wf = err as WorkflowError;
    expect(wf.code).toBe('MODEL_CALL_FAILED');
    expect(wf.detail).toContain('ReplayProvider');
    // The provider recorded exactly one miss and served nothing for it: no live fallback was attempted.
    expect(h.provider.misses).toHaveLength(1);
    expect(h.provider.served.some((x) => x.activityId === 'compare:1:s1s3')).toBe(false);

    // Nothing was decided: no committed selection, no winner, no terminal loser.
    expect(await getSelection(pool, { projectId: h.projectId, chapterNo: 1 })).toBeUndefined();
    const live = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM manuscript_versions
        WHERE chapter_id = $1 AND origin = 'candidate' AND status = 'working'`,
      [p.chapterId],
    );
    expect(live.rows[0]?.n).toBe('3');
    // The FIRST pair did complete: 2 SUCCESSFUL judgments were spent before the miss. The missed call is
    // audited as failed, which is the record of a refusal — not a judgment and not spend.
    const spentBefore = await countComparatorCalls(pool, h.projectId);
    expect(spentBefore).toBe(2);
    const failedCalls = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM llm_calls
        WHERE project_id = $1 AND role = 'chapter_comparator' AND status = 'failed'`,
      [h.projectId],
    );
    expect(failedCalls.rows[0]?.n).toBe('1');

    // Restore the recording and resume: the completed pair replays instead of being re-judged.
    if (removed) h.provider.restore(key, removed);
    const resumed = await selectWinner(p.ctx, inputFor(p));
    expect(resumed.status).toBe('selected');
    expect(resumed.schedule).toHaveLength(2);
    // Only the pair that had not completed was judged: 2 more calls, not 4.
    expect(await countComparatorCalls(pool, h.projectId)).toBe(spentBefore + 2);
  }, 300_000);

  it('a committed decision is returned only for the identical request; a changed one is refused', async () => {
    const first = await selectWinner(p.ctx, inputFor(p));
    expect(first.status).toBe('selected');

    // Same request, candidates supplied in a different array order: the fingerprint is order-insensitive.
    const reordered = [p.candidates[2], p.candidates[0], p.candidates[1]].filter(
      (c): c is CandidateSubmission => c !== undefined,
    );
    const again = await selectWinner(p.ctx, inputFor(p, { candidates: reordered }));
    expect(again.winnerId).toBe(first.winnerId);
    expect(again.artifactId).toBe(first.artifactId);
  }, 300_000);

  it.each([
    [
      'a changed slot assignment',
      (c: readonly CandidateSubmission[]): Partial<SelectionInput> => ({
        candidates: c.map((x, i) => (i === 0 ? { ...x, slot: 9 } : x)),
      }),
    ],
    [
      'a dropped candidate',
      (c: readonly CandidateSubmission[]): Partial<SelectionInput> => ({ candidates: c.slice(1) }),
    ],
    [
      'a different chapter contract',
      (): Partial<SelectionInput> => ({ contractId: IDS.contract2 ?? '' }),
    ],
    [
      'a different contract shape',
      (): Partial<SelectionInput> => ({ contractShape: JSON.stringify({ chapter_number: 1 }) }),
    ],
    [
      'a different canon base',
      (
        _c: readonly CandidateSubmission[],
        base: SelectionInput['expect'],
      ): Partial<SelectionInput> => ({
        expect: { ...base, baseCanonVersion: base.baseCanonVersion + 1 },
      }),
    ],
    [
      'a different pinned identity',
      (
        _c: readonly CandidateSubmission[],
        base: SelectionInput['expect'],
      ): Partial<SelectionInput> => ({
        expect: { ...base, narrativeIdentityVersionId: 'other-identity' },
      }),
    ],
    [
      'a different pinned policy',
      (
        _c: readonly CandidateSubmission[],
        base: SelectionInput['expect'],
      ): Partial<SelectionInput> => ({
        expect: { ...base, productionPolicyVersion: 'policy/economy@1' },
      }),
    ],
    [
      'a different pinned prompt set',
      (
        _c: readonly CandidateSubmission[],
        base: SelectionInput['expect'],
      ): Partial<SelectionInput> => ({
        expect: { ...base, promptSetId: 'set:other' },
      }),
    ],
  ])(
    'refuses to answer %s with the committed decision',
    async (_label, mutate) => {
      await selectWinner(p.ctx, inputFor(p));
      const err = await selectWinner(p.ctx, inputFor(p, mutate(p.candidates, p.expect))).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).code).toBe('SELECTION_REQUEST_CHANGED');
    },
    300_000,
  );

  it('refuses the committed decision when a candidate scorecard was re-judged', async () => {
    await selectWinner(p.ctx, inputFor(p));
    const candidate = p.candidates[0];
    if (!candidate) throw new Error('no candidate');
    // The stored evidence changes (a re-judgement), so the request is no longer the same question.
    await replaceScorecard(pool, h, candidate.manuscriptVersionId, {
      ...candidate.scorecard,
      overall: { ...candidate.scorecard.overall, minor_count: 3 },
    });
    const err = await selectWinner(p.ctx, inputFor(p)).catch((e: unknown) => e);
    expect((err as WorkflowError).code).toBe('SELECTION_REQUEST_CHANGED');
  }, 300_000);

  it('losers can never reach canon, summaries, indexing, dependency edges or export', async () => {
    const result = await selectWinner(p.ctx, inputFor(p));
    expect(result.status).toBe('selected');
    const winnerId = result.winnerManuscriptVersionId ?? '';
    const loserIds = p.candidates.map((c) => c.manuscriptVersionId).filter((id) => id !== winnerId);
    expect(loserIds).toHaveLength(2);

    // 1. The REAL approval entry point refuses each loser, and 2. so does the REAL acceptance entry point.
    for (const step of ['approve', 'accept'] as const)
      for (const loserId of loserIds) {
        const err = await requireSelectedWinner(p.ctx, {
          chapterNo: 1,
          chapterId: p.chapterId,
          manuscriptVersionId: loserId,
          step,
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WorkflowError);
        expect((err as WorkflowError).code).toBe('APPROVAL_BLOCKED');
      }

    // 3. No canon moved, and every loser is terminal and excluded from every downstream surface.
    const chapterCommits = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM canon_commits WHERE project_id = $1 AND source <> 'bible'`,
      [h.projectId],
    );
    expect(chapterCommits.rows[0]?.n).toBe('0');

    for (const loserId of loserIds) {
      const row = await getManuscriptVersion(pool, loserId);
      expect(row?.status).toBe('rejected');
      // Never summarized, never indexed, never a dependency source, never accepted.
      const summaries = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM summaries WHERE manuscript_version_id = $1',
        [loserId],
      );
      expect(summaries.rows[0]?.n).toBe('0');
      const docs = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM search_documents WHERE project_id = $1',
        [h.projectId],
      );
      expect(docs.rows[0]?.n).toBe('0');
      const edges = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM dependency_edges WHERE dependent_id = $1',
        [loserId],
      );
      expect(edges.rows[0]?.n).toBe('0');
    }

    // Exactly one candidate remains live: the winner.
    const live = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM manuscript_versions
        WHERE chapter_id = $1 AND origin = 'candidate' AND status = 'working'`,
      [p.chapterId],
    );
    expect(live.rows[0]?.n).toBe('1');
  }, 300_000);

  it('a cross-project decision never authorizes this project', async () => {
    await selectWinner(p.ctx, inputFor(p));
    const other = await getSelection(pool, { projectId: h.projectId, chapterNo: 1 });
    expect(other?.project_id).toBe(h.projectId);
    // A different project has no decision of its own, so nothing leaks across the boundary.
    const foreign = await getSelection(pool, {
      projectId: '0191b2a0-0000-7000-8000-00000000dead',
      chapterNo: 1,
    });
    expect(foreign).toBeUndefined();
  }, 300_000);

  it('losers become terminal and immutable; only the winner stays live', async () => {
    const result = await selectWinner(p.ctx, inputFor(p));
    expect(result.status).toBe('selected');
    const rows = new Map<string, ManuscriptVersionRow>();
    for (const c of p.candidates) {
      const row = await getManuscriptVersion(pool, c.manuscriptVersionId);
      if (row) rows.set(c.id, row);
    }
    const winner = rows.get(result.winnerId ?? '');
    expect(winner?.status).toBe('working');
    for (const loser of result.excluded) {
      const row = rows.get(loser.candidateId);
      expect(row?.status).toBe('rejected');
      // Immutable: the text and its content hash are untouched by losing.
      const original = p.candidates.find((c) => c.id === loser.candidateId);
      expect(row?.text).toBe(original?.text);
    }
  }, 300_000);

  it('approval enforcement reads the PERSISTED decision and refuses a caller-supplied loser', async () => {
    const result = await selectWinner(p.ctx, inputFor(p));
    const loser = result.excluded[0];
    if (!loser) throw new Error('no loser');
    const loserSubmission = p.candidates.find((c) => c.id === loser.candidateId);

    // The winner passes the guard.
    await expect(
      requireSelectedWinner(p.ctx, {
        chapterNo: 1,
        chapterId: p.chapterId,
        manuscriptVersionId: result.winnerManuscriptVersionId ?? '',
        step: 'approve',
      }),
    ).resolves.toMatchObject({
      enforced: true,
      winnerManuscriptVersionId: result.winnerManuscriptVersionId,
    });

    // A loser is refused, even though the caller supplied it directly.
    const err = await requireSelectedWinner(p.ctx, {
      chapterNo: 1,
      chapterId: p.chapterId,
      manuscriptVersionId: loserSubmission?.manuscriptVersionId ?? '',
      step: 'approve',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowError);
    expect((err as WorkflowError).code).toBe('APPROVAL_BLOCKED');
    expect((err as WorkflowError).detail).toContain('is not the selected winner');
  }, 300_000);

  it('canon acceptance enforces the winner independently of approval', async () => {
    const result = await selectWinner(p.ctx, inputFor(p));
    const loser = result.excluded[0];
    if (!loser) throw new Error('no loser');
    const loserSubmission = p.candidates.find((c) => c.id === loser.candidateId);
    const err = await requireSelectedWinner(p.ctx, {
      chapterNo: 1,
      chapterId: p.chapterId,
      manuscriptVersionId: loserSubmission?.manuscriptVersionId ?? '',
      step: 'accept',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowError);
    expect((err as WorkflowError).code).toBe('APPROVAL_BLOCKED');
    expect((err as WorkflowError).options.step).toBe('accept');
    // No canon moved: the refusal happens before anything is committed.
    const commits = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM canon_commits WHERE project_id = $1 AND source <> 'bible'`,
      [h.projectId],
    );
    expect(commits.rows[0]?.n).toBe('0');
  }, 300_000);

  it('a required selection that is missing or needs attention refuses approval entirely', async () => {
    // Three live candidate versions exist, so a selection is REQUIRED by durable state — no caller flag.
    const none = await requireSelectedWinner(p.ctx, {
      chapterNo: 1,
      chapterId: p.chapterId,
      manuscriptVersionId: p.candidates[0]?.manuscriptVersionId ?? '',
      step: 'approve',
    }).catch((e: unknown) => e);
    expect((none as WorkflowError).code).toBe('APPROVAL_BLOCKED');
    expect((none as WorkflowError).detail).toContain('requires candidate selection');

    // A needs_attention decision cannot authorize an approval either.
    for (const c of p.candidates)
      await replaceScorecard(pool, h, c.manuscriptVersionId, {
        ...c.scorecard,
        canon_version: 999,
      });
    const blocked = await selectWinner(p.ctx, inputFor(p));
    expect(blocked.status).toBe('needs_attention');
    const err = await requireSelectedWinner(p.ctx, {
      chapterNo: 1,
      chapterId: p.chapterId,
      manuscriptVersionId: p.candidates[0]?.manuscriptVersionId ?? '',
      step: 'approve',
    }).catch((e: unknown) => e);
    expect((err as WorkflowError).code).toBe('APPROVAL_BLOCKED');
    expect((err as WorkflowError).detail).toContain('needs_attention');
  }, 300_000);

  it('allows early stop when the leading candidate clears every gate by the pinned margin', async () => {
    // ADR-0015: the first candidate is auto-approvable, carries every gated dimension, and clears each by
    // the policy's margin — so later candidates are not compared at all and no judgment is spent.
    const lifted = p.candidates.map((c, i) =>
      i === 0 ? { ...c, scorecard: passingScorecard(c.id, true, p.expect.baseCanonVersion) } : c,
    );
    const leader = lifted[0];
    if (!leader) throw new Error('no candidate');
    await replaceScorecard(pool, h, leader.manuscriptVersionId, leader.scorecard);
    const result = await selectWinner(p.ctx, inputFor(p, { candidates: lifted }));
    expect(result.status).toBe('selected');
    expect(result.earlyStop.applied).toBe(true);
    expect(result.earlyStop.candidateId).toBe(lifted[0]?.id);
    expect(result.earlyStop.detail).toContain('allowed');
    expect(result.winnerId).toBe(lifted[0]?.id);
    // No comparison ran, so nothing was spent and no comparator call exists.
    expect(result.schedule).toEqual([]);
    expect(result.budget.judgmentsSpent).toBe(0);
    expect(await countComparatorCalls(pool, h.projectId)).toBe(0);
    // The candidates that were never reached are recorded with that exact reason.
    expect(result.excluded.map((e) => e.reason)).toEqual([
      'not_reached_early_stop',
      'not_reached_early_stop',
    ]);
  }, 300_000);

  it('refuses early stop while a gated dimension has no evaluator evidence', async () => {
    const candidate = p.candidates[0];
    if (!candidate) throw new Error('no candidate');
    const sections = { ...candidate.scorecard.sections } as Record<string, unknown>;
    delete sections.voice;
    // Voice evidence removed on the leading candidate: early stop must refuse and name the gap. The
    // candidate is also ineligible for the same reason, so selection proceeds on the others.
    const stripped = { ...candidate.scorecard, sections } as Scorecard;
    await replaceScorecard(pool, h, candidate.manuscriptVersionId, stripped);
    const result = await selectWinner(
      p.ctx,
      inputFor(p, {
        candidates: [{ ...candidate, scorecard: stripped }, ...p.candidates.slice(1)],
      }),
    );
    expect(result.earlyStop.applied).toBe(false);
    expect(result.earlyStop.detail).toMatch(/refused|not applied/);
  }, 300_000);
});

/**
 * Store a scorecard exactly where and how `evaluateVersion` stores it, so eligibility reads real durable
 * evidence. Tests that need a candidate to be judged differently change THIS row, not the submission.
 */
async function persistScorecard(
  pool: Pool,
  h: Harness,
  manuscriptVersionId: string,
  scorecard: Scorecard,
): Promise<void> {
  await putArtifact(pool, {
    workspaceId: h.workspaceId,
    projectId: h.projectId,
    step: 'evaluate',
    kind: 'scorecard',
    key: manuscriptVersionId,
    schema: 'scorecard.schema.json',
    payload: scorecard,
  });
}

/** Replace a persisted scorecard (append-only artifacts cannot be updated: delete, then re-store). */
async function replaceScorecard(
  pool: Pool,
  h: Harness,
  manuscriptVersionId: string,
  scorecard: Scorecard,
): Promise<void> {
  await pool.query('ALTER TABLE workflow_artifacts DISABLE TRIGGER workflow_artifacts_append_only');
  await pool.query(
    `DELETE FROM workflow_artifacts WHERE project_id = $1 AND step = 'evaluate' AND kind = 'scorecard' AND key = $2`,
    [h.projectId, manuscriptVersionId],
  );
  await pool.query('ALTER TABLE workflow_artifacts ENABLE TRIGGER workflow_artifacts_append_only');
  await persistScorecard(pool, h, manuscriptVersionId, scorecard);
}

/** SUCCESSFUL comparator judgments. A failed call is the audit trail of a refusal, never a judgment. */
async function countComparatorCalls(pool: Pool, projectId: string): Promise<number> {
  const row = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM llm_calls
      WHERE project_id = $1 AND role = 'chapter_comparator' AND status <> 'failed'`,
    [projectId],
  );
  return Number(row.rows[0]?.n ?? '0');
}
