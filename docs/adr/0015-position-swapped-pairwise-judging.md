# ADR-0015: Position-swapped pairwise judging with tie rules and early stop

- **Status:** Accepted
- **Date:** 2026-09-13
- **Deciders:** principal architects (product, software, AI systems, data, Korean webnovel production)

## Context
LLM judges show position bias and self-preference; more candidates cost more.

## Decision
Compare candidates pairwise in **both orders**; consistent winner wins; inconsistency → third run with
shuffled rubric order; ties → higher scorecard → fewer patches (cheaper). Judges use a different model
family from the writer when available and never see the writer's exemplars. **Early stop**: skip further
candidates when the first meets the early-stop threshold with no major issues.

## Alternatives considered
- Single-order judging — biased.
- Absolute scoring only — poorly calibrated across candidates.

## Consequences
2× comparison calls when N=2; budget-aware candidate policy per tier.

### Implementation notes (Checkpoint 6, B-6-4)

**Selection is pairwise, so the schedule is part of the answer.** Reducing N candidates to one uses
sequential single elimination over the candidates' stable slots
(`candidates.selection_schedule = "stable_slot_single_elimination"`), which is N−1 decisive pairs. The
outcome is deterministic **for that schedule**: the same candidates in the same slots always yield the same
winner, whatever order the rows arrived in or where a resume boundary fell. It is *not* a schedule-independent
global winner, and the implementation does not claim one — a pairwise comparator that decides every pair is
not thereby transitive. The schedule is persisted with the decision as provenance.

**Cycles are reported, not resolved.** If the judgments actually made contain a cycle (A beats B, B beats C,
C beats A), the survivor of a bracket is an artifact of the schedule rather than a defensible winner. This
ADR authorizes no cycle-resolution rule, so selection returns `needs_attention` instead of presenting one.

**The tie ladder needs explicit authorization.** The deterministic ladder (higher gated-dimension total →
fewer patches → lower slot) may decide a pair the position-swapped comparator could not separate only when
the pinned Production Policy sets `candidates.tie_fallback_ladder_authorized`. No other field's existence
may be read as implying that authorization.

**Winner-only propagation is enforced at the production boundary.** The selected winner is verified inside
approval and, independently, inside canon acceptance, from persisted state — never from a caller-supplied
id or flag. Losers become terminal in the same transaction that records the decision.
