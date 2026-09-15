-- 0005_candidate_selection.sql — Checkpoint 6: durable N-candidate selection decision (B-6-4, ADR-0015, ADR-0041)
--
-- The selection artifact in workflow_artifacts is append-only EVIDENCE. It cannot be the authority on
-- "has this selection finalized?", because finalization has a consequence beyond the artifact — every loser
-- must reach a terminal status — and an append-only row cannot express "written but not yet reconciled".
-- A crash between the artifact write and the loser transitions would otherwise leave several candidates live
-- while a retry returned the artifact as though everything were done.
--
-- candidate_selections is therefore the decision itself, and it is written ATOMICALLY: the row and every
-- loser transition commit in one transaction, so a finalized decision always implies exactly one live
-- candidate. A crash before that commit leaves nothing to reconcile — no row, no terminal loser — and the
-- retry recomputes the identical decision, because candidate order is fixed by stable slot and every
-- comparator judgment is a durable, replayed step.
--
--  * UNIQUE (project_id, chapter_no) is the concurrency control. Two racing selections contend on this
--    insert; the loser reads the committed decision instead of producing a second winner. The workflow layer
--    converts a lost race into a typed retriable conflict, never a raw database error.
--  * request_fingerprint pins the exact request the decision answers (candidate slots and content hashes,
--    base canon version, chapter contract, identity, policy, prompt set, persisted scorecard artifacts). A
--    later call may reuse this decision only by presenting the identical fingerprint; any other request is a
--    different question and must not silently inherit this answer.
--  * selection_required records whether the pinned policy and durable candidate state required selection for
--    this chapter, so approval and canon acceptance decide "must a selection be checked?" from persisted
--    truth rather than from an untrusted caller flag.
--  * schedule pins how the candidates were reduced. The pairwise comparator is not guaranteed transitive, so
--    the decision is deterministic FOR THIS SCHEDULE; recording it keeps that claim honest (ADR-0015).

CREATE TABLE candidate_selections (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  chapter_id uuid NOT NULL REFERENCES chapters(id),
  chapter_no integer NOT NULL CHECK (chapter_no >= 1),
  job_id uuid REFERENCES jobs(id),
  status text NOT NULL CHECK (status IN ('selected', 'needs_attention')),
  winner_candidate_id uuid,
  winner_manuscript_version_id uuid REFERENCES manuscript_versions(id),
  candidate_version_ids uuid[] NOT NULL,
  loser_version_ids uuid[] NOT NULL,
  request_fingerprint text NOT NULL,
  selection_required boolean NOT NULL,
  schedule text NOT NULL,
  artifact_id uuid REFERENCES workflow_artifacts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A 'selected' decision must name its winner; 'needs_attention' must never carry one.
  CONSTRAINT candidate_selections_winner_shape CHECK (
    (status = 'selected' AND winner_candidate_id IS NOT NULL AND winner_manuscript_version_id IS NOT NULL)
    OR (status = 'needs_attention' AND winner_candidate_id IS NULL AND winner_manuscript_version_id IS NULL)
  ),
  UNIQUE (project_id, chapter_no)
);
CREATE INDEX candidate_selections_project_idx ON candidate_selections(project_id, chapter_no);
