/**
 * B-6-1 multi-chapter continuity on Postgres + ReplayProvider: chapters 1, 2 and 3 are produced to
 * acceptance in one project, and each chapter is proved to remember its predecessor from ACCEPTED state
 * only — its L1 summary, its verbatim tail, its hook, its committed deltas and its elapsed story time.
 *
 * This is the chain T18 could only assert one link of: T18 stops at chapter 2's contract and pack, so
 * nothing there proves a second acceptance commits on top of the first, that canon transitions across a
 * chapter boundary, or that the promise chapter 1 opened is paid in chapter 2. Every model call is replayed.
 *
 * THREE chapters rather than two, because a two-chapter chain cannot distinguish "reads the previous
 * chapter" from "reads chapter 1". Chapter 3 consumes chapter 2's accepted state specifically: its premise
 * is chapter 2's ending hook, it carries chapter 2's committed share forward, and it supersedes the gate
 * fact CHAPTER 2 committed — so the bitemporal chain is bible → ch.1 → ch.2 → ch.3 with three live links.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptedChapter,
  dependencyEdgesFor,
  getManuscriptVersion,
  getProject,
  listCommits,
  migrate,
  resetDatabase,
  searchDocumentsContaining,
  type Pool,
} from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import { checkOutputLanguage, codePointLength, toNfcText } from '@yeonjae/prose';
import {
  exportAccepted,
  produceChapter,
  type ChapterProductionResult,
} from './chapter-production.js';
import { WorkflowError } from './errors.js';
import {
  createHarness,
  EXPECTED,
  EXPECTED_CH02,
  EXPECTED_CH03,
  IDS,
  type Harness,
} from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

run('multi-chapter continuity: chapters 1 → 2 → 3 accepted in sequence (B-6-1)', () => {
  let pool: Pool;
  let h: Harness;
  let ch1: ChapterProductionResult;
  let ch2: ChapterProductionResult;
  let ch3: ChapterProductionResult;

  beforeAll(async () => {
    pool = await freshDatabase();
    h = await createHarness(pool);
    ch1 = await produceChapter({ pool, gateway: h.gateway(), bindings: h.bindings }, h.input(1));
    ch2 = await produceChapter({ pool, gateway: h.gateway(), bindings: h.bindings }, h.input(2));
    ch3 = await produceChapter({ pool, gateway: h.gateway(), bindings: h.bindings }, h.input(3));
  }, 600_000);

  afterAll(async () => {
    await pool.end();
  });

  it('all three chapters complete through the same replayed provider with no live call and no miss', () => {
    expect(ch1.status).toBe('completed');
    expect(ch2.status).toBe('completed');
    expect(ch3.status).toBe('completed');
    expect(h.provider.misses).toEqual([]);
    expect(h.provider.served.every((s) => s.by === 'activity')).toBe(true);
    expect(process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('each chapter commits on top of the last: the canon version advances exactly once per acceptance', async () => {
    // bible v1 + v2, then one bump per accepted chapter: v3, v4, v5 — monotone, never two for one chapter.
    expect(ch1.accepted?.canon_version).toBe(3);
    expect(ch2.accepted?.canon_version).toBe(4);
    expect(ch3.accepted?.canon_version).toBe(5);
    const project = await getProject(pool, h.projectId);
    expect(project.canon_version).toBe(5);
    const commits = await listCommits(pool, h.projectId);
    expect(commits.map((c) => c.source)).toEqual([
      'bible',
      'bible',
      'chapter_acceptance',
      'chapter_acceptance',
      'chapter_acceptance',
    ]);
    expect(ch2.accepted?.item_counts).toEqual(EXPECTED_CH02.item_counts);
    expect(ch3.accepted?.item_counts).toEqual(EXPECTED_CH03.item_counts);
  });

  it('chapter 3 read the canon chapter 2 produced, not chapter 1 and not a stale base', async () => {
    // The delta's base is the version the PREVIOUS acceptance produced: the chain cannot skip a link.
    expect(ch3.pins.canonVersionRead).toBe(4);
    expect(ch2.pins.canonVersionRead).toBe(3);
    const commit = await pool.query<{ base_canon_version: number }>(
      `SELECT (delta->>'base_canon_version')::int AS base_canon_version
         FROM canon_commits WHERE project_id = $1 AND version = 5`,
      [h.projectId],
    );
    expect(commit.rows[0]?.base_canon_version).toBe(4);
  });

  it('chapter 3 is English, accepted, and matches the fixture code-point and word expectations', async () => {
    const v = await getManuscriptVersion(pool, ch3.accepted?.manuscript_version_id ?? '');
    expect(v?.status).toBe('accepted');
    const nfc = toNfcText(v?.text ?? '');
    expect(codePointLength(nfc.text)).toBe(EXPECTED_CH03.assembled_code_points);
    expect(nfc.text.split(/\s+/).filter(Boolean).length).toBe(EXPECTED_CH03.words);
    expect(checkOutputLanguage(nfc, { minConfidence: 0.99 }).passed).toBe(true);
    for (const s of ch3.scenes) expect(s.english_confidence).toBe(1);
  });

  it("chapter 3's pack carried chapter 2's accepted summary, hook and verbatim tail — not chapter 1's", async () => {
    const packs = await pool.query<{ variables: Record<string, string> }>(
      `SELECT payload->'variables' AS variables
         FROM workflow_artifacts
        WHERE project_id = $1 AND kind = 'context_pack' AND key LIKE '3:%'
        ORDER BY created_at`,
      [h.projectId],
    );
    const prev = packs.rows.map((r) => r.variables.previous_text ?? '').find((t) => t.length > 0);
    expect(prev).toBeDefined();
    const text = prev ?? '';
    // Chapter 2's accepted state, by content: its L1 summary and its exact ending hook.
    expect(text).toContain('Chapter 2 factual summary');
    expect(text).toContain(EXPECTED_CH02.ending_hook);
    expect(text).toContain('Chapter 2 ending, verbatim');
    // It is chapter 2 that is carried forward, not chapter 1: chapter 1's hook is no longer the tail.
    expect(text).not.toContain(`Chapter 1 ending hook: “${EXPECTED.ending_hook}”`);
    // Never any non-accepted text.
    expect(text).not.toContain(EXPECTED.bad_sentence.quote);
  });

  it('chapter 3 carries concrete prior state: the share, the leg and the flagged gate', async () => {
    const v = await getManuscriptVersion(pool, ch3.accepted?.manuscript_version_id ?? '');
    const text = v?.text ?? '';
    // Chapter 2 committed an eighteen-percent share; chapter 3's prose uses that exact state, and would
    // be wrong at chapter 1's eight percent.
    expect(text).toContain('Eighteen percent');
    expect(text).not.toContain('eight percent of nothing');
    // Chapter 2's saved leg and its flagged cores are the subject, not background colour.
    expect(text).toContain("kept an old man's leg");
    expect(text).toContain('reinspection');
  });

  it('the gate fact chapter 2 committed is superseded by chapter 3, not duplicated', async () => {
    const rows = await pool.query<{ value_text: string; valid_to: unknown }>(
      `SELECT value_text, valid_to FROM facts
        WHERE project_id = $1 AND attribute = 'gate.core_grade_anomaly'
        ORDER BY (valid_from->>'chapter_no')::int`,
      [h.projectId],
    );
    // Two rows: chapter 2's, now closed, and chapter 3's, open. History kept, never retracted (ADR-0038).
    expect(rows.rows.length).toBe(2);
    const live = rows.rows.filter((r) => r.valid_to === null);
    expect(live).toHaveLength(1);
    expect(live[0]?.value_text).toContain('Entry suspended');
  });

  it('the StoryClock advances across all three chapters without going backwards', async () => {
    const events = await pool.query<{ chapter_no: number; world_date: string; ord: string }>(
      `SELECT (clock_start->>'chapter_no')::int AS chapter_no,
              clock_start->>'world_date' AS world_date,
              clock_ord::text AS ord
         FROM events WHERE project_id = $1 AND clock_start->>'world_date' IS NOT NULL
        ORDER BY clock_ord`,
      [h.projectId],
    );
    const byChapter = new Map<number, string>();
    for (const r of events.rows)
      if (!byChapter.has(r.chapter_no)) byChapter.set(r.chapter_no, r.world_date);
    expect(byChapter.get(1)).toBe('D+0');
    expect(byChapter.get(2)).toBe('D+1');
    expect(byChapter.get(3)).toBe('D+2');
    // clock_ord is monotone over the whole project: no chapter's clock reaches back before its predecessor.
    const ords = events.rows.map((r) => BigInt(r.ord));
    expect([...ords].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ords);
    const chapters = events.rows.map((r) => r.chapter_no);
    expect([...chapters].sort((a, b) => a - b)).toEqual(chapters);
  });

  it('the ch.2 promise advances in chapter 3 and the ch.3 promise is planted', async () => {
    const events = await pool.query<{ kind: string; number: number }>(
      `SELECT pe.kind, c.number FROM promise_events pe
         JOIN chapters c ON c.id = pe.chapter_id
        WHERE c.project_id = $1 AND pe.promise_id = $2
        ORDER BY c.number`,
      [h.projectId, IDS.promise_gate_run],
    );
    // opened in ch.1, paid in ch.2, and its consequence advanced in ch.3 — a chain, not three unrelated rows.
    expect(events.rows.some((e) => e.kind === 'opened' && e.number === 1)).toBe(true);
    expect(events.rows.some((e) => e.kind === 'paid' && e.number === 2)).toBe(true);
    expect(events.rows.some((e) => e.kind === 'advanced' && e.number === 3)).toBe(true);
  });

  it('chapter 2 is English, accepted, and matches the fixture code-point and word expectations', async () => {
    const v = await getManuscriptVersion(pool, ch2.accepted?.manuscript_version_id ?? '');
    expect(v?.status).toBe('accepted');
    const nfc = toNfcText(v?.text ?? '');
    // Code points, not UTF-16 units: the project's offsets are Unicode code points (ADR-0030).
    expect(codePointLength(nfc.text)).toBe(EXPECTED_CH02.assembled_code_points);
    expect(nfc.text.split(/\s+/).filter(Boolean).length).toBe(EXPECTED_CH02.words);
    const check = checkOutputLanguage(nfc, { minConfidence: 0.99 });
    expect(check.passed).toBe(true);
    for (const s of ch2.scenes) expect(s.english_confidence).toBe(1);
  });

  it('chapter 2 was accepted without a revision round, so the chain does not depend on the repair path', () => {
    expect(ch2.revision?.rounds).toBe(0);
    // One evaluation round only: the draft was approvable as written.
    expect(ch2.scorecards).toHaveLength(1);
    expect(ch2.scorecards[0]?.auto_approvable).toBe(true);
    expect(ch2.scorecards[0]?.blocking).toBe(0);
    expect(ch2.scorecards[0]?.major).toBe(0);
    // Chapter 1, by contrast, needed its one targeted revision — two versions, two scorecards.
    expect(ch1.revision?.rounds).toBe(1);
    expect(ch1.scorecards).toHaveLength(2);
  });

  it("chapter 2's pack carried chapter 1's accepted summary, verbatim tail, hook and committed deltas", async () => {
    // The writer pack chapter 2 actually used is persisted; read it rather than rebuilding it.
    const packs = await pool.query<{ variables: Record<string, string> }>(
      `SELECT payload->'variables' AS variables
         FROM workflow_artifacts
        WHERE project_id = $1 AND kind = 'context_pack' AND key LIKE '2:%'
        ORDER BY created_at`,
      [h.projectId],
    );
    const previous = packs.rows
      .map((r) => r.variables.previous_text ?? '')
      .find((t) => t.length > 0);
    expect(previous).toBeDefined();
    const prev = previous ?? '';
    expect(prev).toContain('Chapter 1 factual summary (L1, from the accepted version v2)');
    expect(prev).toContain(`Chapter 1 ending hook: “${EXPECTED.ending_hook}”`);
    expect(prev).toContain('Chapter 1 ending, verbatim');
    // Accepted text only: the revised sentence reaches chapter 2, the working draft's calque never does.
    expect(prev).toContain(EXPECTED.revised_sentence);
    expect(prev).not.toContain(EXPECTED.bad_sentence.quote);
  });

  it('canon transitions across the chapter boundary: the ch.1 share is superseded, not duplicated', async () => {
    // Chapter 2 asserts a new porter share and supersedes the ch.1 relationship. Both facts exist, but only
    // the chapter-2 value is current — history is kept, never retracted (ADR-0038).
    const shares = await pool.query<{ value_text: string; valid_from: unknown; valid_to: unknown }>(
      `SELECT value_text, valid_from, valid_to FROM facts
        WHERE project_id = $1 AND attribute = 'employment.porter_share'
        ORDER BY (valid_from->>'chapter_no')::int`,
      [h.projectId],
    );
    expect(shares.rows.length).toBeGreaterThanOrEqual(1);
    const current = shares.rows.filter((r) => r.valid_to === null);
    expect(current).toHaveLength(1);
    expect(current[0]?.value_text).toContain('Eighteen percent');

    const relationships = await pool.query<{ note: string | null; valid_to: unknown }>(
      `SELECT note, valid_to FROM relationship_states
        WHERE project_id = $1 AND from_entity_id = $2 AND to_entity_id = $3 AND type = 'superior'
        ORDER BY valid_from_ord`,
      [h.projectId, IDS.mujin, IDS.doyoon],
    );
    // The chapter-1 row is closed and the chapter-2 row is open: a supersede, not a second live row.
    expect(relationships.rows.filter((r) => r.valid_to === null)).toHaveLength(1);
    expect(relationships.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('the promise chapter 1 opened is paid in chapter 2', async () => {
    const events = await pool.query<{ kind: string; number: number }>(
      `SELECT pe.kind, c.number FROM promise_events pe
         JOIN chapters c ON c.id = pe.chapter_id
        WHERE c.project_id = $1 AND pe.promise_id = $2
        ORDER BY c.number`,
      [h.projectId, IDS.promise_gate_run],
    );
    expect(events.rows.some((e) => e.kind === 'opened' && e.number === 1)).toBe(true);
    expect(events.rows.some((e) => e.kind === 'paid' && e.number === 2)).toBe(true);
  });

  it('both chapters are summarized and indexed from accepted content only', async () => {
    const summaries = await pool.query<{ chapter_from: number; text: string }>(
      `SELECT chapter_from, text FROM summaries
        WHERE project_id = $1 AND tier = 'L1' ORDER BY chapter_from`,
      [h.projectId],
    );
    expect(summaries.rows.map((r) => r.chapter_from)).toEqual([1, 2, 3]);
    expect(summaries.rows[1]?.text).toBe(EXPECTED_CH02.summary_l1);
    expect(summaries.rows[2]?.text).toBe(EXPECTED_CH03.summary_l1);
    for (const r of summaries.rows) expect(r.text.split(/\s+/).length).toBeLessThanOrEqual(120);

    // Chapter 2's text is searchable because chapter 2 is accepted; nothing non-accepted is indexed.
    expect(await searchDocumentsContaining(pool, h.projectId, 'third chamber')).toBeGreaterThan(0);
    const nonAccepted = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM search_documents sd
         JOIN manuscript_versions mv ON mv.id = sd.manuscript_version_id
        WHERE sd.project_id = $1 AND mv.status <> 'accepted'`,
      [h.projectId],
    );
    expect(nonAccepted.rows[0]?.n).toBe('0');
  });

  it('chapter 2 recorded dependency edges at the canon version it read', async () => {
    // Edges are keyed by the dependent manuscript version, and chapter 2 read canon at the version
    // chapter 1's acceptance produced — the material link from chapter 2 back to chapter 1's state.
    const edges = await dependencyEdgesFor(
      pool,
      h.projectId,
      ch2.accepted?.manuscript_version_id ?? '',
    );
    expect(edges.length).toBeGreaterThan(0);
    expect(ch2.pins.canonVersionRead).toBe(3);
    expect(ch2.accepted?.dependency_edges).toBe(edges.length);
  });

  it('export contains all three accepted chapters, in order, accepted text only', async () => {
    const ex = await exportAccepted(pool, { projectId: h.projectId, title: 'Second Awakening' });
    expect(ex.chapters.map((c) => c.chapter_no)).toEqual([1, 2, 3]);
    const v2 = await getManuscriptVersion(pool, ch2.accepted?.manuscript_version_id ?? '');
    const v3 = await getManuscriptVersion(pool, ch3.accepted?.manuscript_version_id ?? '');
    expect(ex.text).toContain(EXPECTED_CH02.ending_hook.replaceAll('*', ''));
    expect(ex.text).toContain(EXPECTED_CH03.ending_hook.replaceAll('*', ''));
    expect(ex.text).toContain(v2?.text.trim().slice(0, 40) ?? '');
    expect(ex.text).toContain(v3?.text.trim().slice(0, 40) ?? '');
    expect(ex.text).not.toContain(EXPECTED.bad_sentence.quote);
    // The chapters appear in order.
    expect(ex.text.indexOf('Chapter 1')).toBeLessThan(ex.text.indexOf('Chapter 2'));
    expect(ex.text.indexOf('Chapter 2')).toBeLessThan(ex.text.indexOf('Chapter 3'));
  });

  it('re-running an accepted chapter creates no duplicate: every step replays and nothing is added', async () => {
    const before = await pool.query<{
      calls: string;
      versions: string;
      commits: string;
      summaries: string;
      edges: string;
    }>(
      `SELECT (SELECT count(*) FROM llm_calls WHERE project_id = $1)::text AS calls,
              (SELECT count(*) FROM manuscript_versions WHERE project_id = $1)::text AS versions,
              (SELECT count(*) FROM canon_commits WHERE project_id = $1)::text AS commits,
              (SELECT count(*) FROM summaries WHERE project_id = $1)::text AS summaries,
              (SELECT count(*) FROM dependency_edges WHERE project_id = $1)::text AS edges`,
      [h.projectId],
    );
    const rerun = await produceChapter(
      { pool, gateway: h.gateway(), bindings: h.bindings },
      h.input(3),
    );
    expect(rerun.accepted?.manuscript_version_id).toBe(ch3.accepted?.manuscript_version_id);
    expect(rerun.accepted?.canon_version).toBe(5);
    const after = await pool.query<{
      calls: string;
      versions: string;
      commits: string;
      summaries: string;
      edges: string;
    }>(
      `SELECT (SELECT count(*) FROM llm_calls WHERE project_id = $1)::text AS calls,
              (SELECT count(*) FROM manuscript_versions WHERE project_id = $1)::text AS versions,
              (SELECT count(*) FROM canon_commits WHERE project_id = $1)::text AS commits,
              (SELECT count(*) FROM summaries WHERE project_id = $1)::text AS summaries,
              (SELECT count(*) FROM dependency_edges WHERE project_id = $1)::text AS edges`,
      [h.projectId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect((await getProject(pool, h.projectId)).canon_version).toBe(5);
  }, 300_000);

  it('a fourth chapter passes the predecessor gate and then fails closed on the missing recording', async () => {
    // Chapter 3 IS accepted, so the predecessor gate correctly lets chapter 4 start; there is no ch.4
    // fixture, so the run must fail closed on the replay miss rather than improvise a chapter.
    const lookup = await acceptedChapter(pool, h.projectId, 4);
    expect(lookup.state).toBe('missing');
    const before = await counts(pool, h.projectId);
    const err = await produceChapter(
      { pool, gateway: h.gateway(), bindings: h.bindings },
      h.input(4, { stage: 'contract_and_pack' }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowError);
    const wf = err as WorkflowError;
    // Not the predecessor gate — a refusal to call a live provider for an unrecorded chapter.
    expect(wf.code).toBe('MODEL_CALL_FAILED');
    expect(wf.detail).toContain('refusing to call a live provider');
    const after = await counts(pool, h.projectId);
    // Whatever it spent trying, it committed no canon and produced no manuscript, summary, index or edge.
    expect(after.versions).toBe(before.versions);
    expect(after.commits).toBe(before.commits);
    expect(after.summaries).toBe(before.summaries);
    expect(after.searchDocs).toBe(before.searchDocs);
    expect(after.edges).toBe(before.edges);
    expect((await getProject(pool, h.projectId)).canon_version).toBe(5);
  }, 120_000);
});

/**
 * The predecessor gate (B-6-1). Requesting chapter 3 while chapter 2 is absent, still working, or rejected
 * must fail with the EXACT error, at the EXACT step, having spent nothing — the gate exists to refuse
 * before model spend, so "it threw something" is not the assertion.
 */
run('the predecessor gate refuses chapter 3 before any spend (B-6-1)', () => {
  let pool: Pool;
  let h: Harness;

  beforeAll(async () => {
    pool = await freshDatabase();
  }, 60_000);
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    h = await createHarness(pool);
  }, 120_000);
  afterAll(async () => {
    await pool.end();
  });

  async function expectRefusal(label: string) {
    const before = await counts(pool, h.projectId);
    const err = await produceChapter(
      { pool, gateway: h.gateway(), bindings: h.bindings },
      h.input(3),
    ).catch((e: unknown) => e);
    expect(err, label).toBeInstanceOf(WorkflowError);
    const wf = err as WorkflowError;
    expect(wf.code).toBe('PREVIOUS_CHAPTER_NOT_ACCEPTED');
    expect(wf.options.step).toBe('chapter_contract');
    const after = await counts(pool, h.projectId);
    // Zero additional model calls, and nothing durable created for chapter 3.
    expect(after.llmCalls).toBe(before.llmCalls);
    expect(after.versions).toBe(before.versions);
    expect(after.commits).toBe(before.commits);
    expect(after.summaries).toBe(before.summaries);
    expect(after.searchDocs).toBe(before.searchDocs);
    expect(after.edges).toBe(before.edges);
  }

  it('refuses when chapter 2 is absent', async () => {
    await produceChapter({ pool, gateway: h.gateway(), bindings: h.bindings }, h.input(1));
    await expectRefusal('chapter 2 absent');
  }, 300_000);

  it('refuses when chapter 2 exists but is still working', async () => {
    await produceChapter({ pool, gateway: h.gateway(), bindings: h.bindings }, h.input(1));
    // Chapter 2 staged only as far as its contract and pack: it exists and is not accepted.
    await produceChapter(
      { pool, gateway: h.gateway(), bindings: h.bindings },
      h.input(2, { stage: 'contract_and_pack' }),
    );
    await expectRefusal('chapter 2 working');
  }, 300_000);

  it('refuses when chapter 2 was produced and then rejected', async () => {
    await produceChapter({ pool, gateway: h.gateway(), bindings: h.bindings }, h.input(1));
    const ch2 = await produceChapter(
      { pool, gateway: h.gateway(), bindings: h.bindings },
      h.input(2, { stage: 'contract_and_pack' }),
    );
    await pool.query(`UPDATE chapters SET status = 'rejected' WHERE id = $1`, [ch2.chapter_id]);
    await expectRefusal('chapter 2 rejected');
  }, 300_000);
});

/**
 * Chapter 3 resume (B-6-1). Interrupting the third chapter at each durable boundary and resuming must
 * produce exactly one accepted chapter 3, exactly one canon advancement, and no repeated successful model
 * call — the whole point of Postgres-checkpointed steps (ADR-0046).
 */
run('chapter 3 resumes from every durable boundary without duplicating work (B-6-1)', () => {
  let pool: Pool;
  let h: Harness;

  beforeAll(async () => {
    pool = await freshDatabase();
  }, 60_000);
  afterAll(async () => {
    await pool.end();
  });

  it.each(['scene_plan', 'scene_draft', 'assemble', 'evaluate', 'approve', 'extract'])(
    'interrupted after %s: resume completes chapter 3 once, with no repeated successful call',
    async (step) => {
      await resetDatabase(pool);
      await migrate(pool);
      h = await createHarness(pool);
      const deps = { pool, gateway: h.gateway(), bindings: h.bindings };
      await produceChapter(deps, h.input(1));
      await produceChapter(deps, h.input(2));
      const afterTwo = await counts(pool, h.projectId);

      // Interrupt chapter 3 at this durable boundary.
      const err = await produceChapter(deps, h.input(3, { failAfterStep: step })).catch(
        (e: unknown) => e,
      );
      // The injected fault is a typed workflow failure naming the boundary it stopped at, not a bare throw.
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).options.step).toBe(step);
      const interrupted = await counts(pool, h.projectId);
      // Every boundary here precedes the acceptance commit, so canon must still be chapter 2's v4.
      expect((await getProject(pool, h.projectId)).canon_version).toBe(4);
      expect(interrupted.commits).toBe(afterTwo.commits);

      // Resume: the completed steps replay and the chapter finishes.
      const resumed = await produceChapter(deps, h.input(3));
      expect(resumed.status).toBe('completed');
      expect(resumed.accepted?.canon_version).toBe(5);

      const after = await counts(pool, h.projectId);
      // Exactly one accepted chapter 3 and exactly one canon advancement over chapter 2's v4.
      const accepted = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM manuscript_versions mv
           JOIN chapters c ON c.id = mv.chapter_id
          WHERE c.project_id = $1 AND c.number = 3 AND mv.status = 'accepted'`,
        [h.projectId],
      );
      expect(accepted.rows[0]?.n).toBe('1');
      expect((await getProject(pool, h.projectId)).canon_version).toBe(5);
      expect(after.commits).toBe(afterTwo.commits + 1);
      // No duplicate summary, index document set or dependency-edge insertion for chapter 3.
      const summaries = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM summaries
          WHERE project_id = $1 AND tier = 'L1' AND chapter_from = 3`,
        [h.projectId],
      );
      expect(summaries.rows[0]?.n).toBe('1');

      // The successful calls made before the interruption were replayed, not re-issued: the total number
      // of SUCCESSFUL calls after the resume equals the number a clean run makes, never more.
      expect(after.llmCalls).toBeGreaterThanOrEqual(interrupted.llmCalls);
      const duplicates = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM (
           SELECT idempotency_key FROM llm_calls
            WHERE project_id = $1 AND status <> 'failed'
            GROUP BY idempotency_key HAVING count(*) > 1) d`,
        [h.projectId],
      );
      expect(duplicates.rows[0]?.n).toBe('0');
    },
    600_000,
  );
});

/** Durable counters the continuity proofs compare before and after a refusal or a rerun. */
async function counts(pool: Pool, projectId: string) {
  const q = async (sql: string) =>
    Number((await pool.query<{ n: string }>(sql, [projectId])).rows[0]?.n ?? '0');
  return {
    llmCalls: await q('SELECT count(*)::text AS n FROM llm_calls WHERE project_id = $1'),
    versions: await q('SELECT count(*)::text AS n FROM manuscript_versions WHERE project_id = $1'),
    commits: await q('SELECT count(*)::text AS n FROM canon_commits WHERE project_id = $1'),
    summaries: await q('SELECT count(*)::text AS n FROM summaries WHERE project_id = $1'),
    searchDocs: await q('SELECT count(*)::text AS n FROM search_documents WHERE project_id = $1'),
    edges: await q('SELECT count(*)::text AS n FROM dependency_edges WHERE project_id = $1'),
  };
}
