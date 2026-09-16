#!/usr/bin/env python3
"""
Builds the Checkpoint 6 chapter-3 replay fixture (examples/fixture/ch03/) from the authored scene texts:

  * replay.ch03.json   — ReplayProvider recordings keyed by workflow activity id (`activity:<id>`),
                         with {{placeholders}} bound at replay time
  * expected.ch03.json — code-point offsets and counts the multi-chapter continuity tests assert against

Chapter 3 runs in the SAME project as chapters 1 and 2. Unlike chapter 2 — whose locked contract chapter 1's
run already recorded — chapter 3 needs its OWN contract recording, so this file adds `chapter_contract:3`
alongside the scene plan, scene drafts, evaluators, extraction and L1 summary.

WHY CHAPTER 3 IS NOT FILLER. The chain is bible → ch.1 → ch.2 → ch.3, and chapter 3 consumes chapter 2's
ACCEPTED state concretely rather than gesturing at it:

  * Its premise is chapter 2's ending hook. Chapter 2 ends on cores reading two grades above a D-gate
    envelope; chapter 3 opens on the reinspection that reading caused. Delete chapter 2 and chapter 3 has
    no subject.
  * It consumes chapter 2's committed canon by id. The porter share chapter 2 asserted (18%) is carried,
    not re-derived. The gate anomaly fact chapter 2 asserted is superseded here — the gate moves from
    "flagged" to "entry suspended, reinspection scheduled" — so the bitemporal chain has a third link and
    supersedes the id chapter 2's own commit created.
  * It pays off chapter 2's consequence rather than repeating its beat. Chapter 2's satisfaction was
    "the warning was right"; chapter 3's is the cost of having been right — the protagonist's foreknowledge
    is now provably finite, which is a serialized escalation, not a restatement.
  * It opens the next promise (the Thursday survey) so the hook chain continues past the fixture.

The knowledge guard is deliberately kept: Mu-jin presses hard and is told nothing, so P1 (the regression)
still cannot be extracted as a knowledge_state for him. That is what makes the guard test meaningful across
three chapters instead of two.

Shares tools/fixture_common.py with the chapter-1 and chapter-2 builders. Never edit replay.ch03.json by
hand: fix this builder and re-run it.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fixture_common import (  # noqa: E402
    IDS,
    ROOT,
    clock,
    evidence,
    find_span,
    paragraph_of,
    paragraphs,
    read_scene,
    rec,
    scene_draft,
)

FX = os.path.join(ROOT, "examples", "fixture", "ch03")
CONTRACT3 = "0191b2a0-0000-7000-8000-000000070003"


def main() -> None:
    s1, s2 = read_scene(3, 1), read_scene(3, 2)
    assembled = "\n\n".join(t.strip() for t in (s1, s2))
    paras = paragraphs(assembled)

    def ev(quote: str) -> list[dict]:
        return [evidence(assembled, paras, quote, "version.3.approved", chapter_no=3)]

    # ---- Chapter contract. Chapter 3 is the first chapter whose contract this fixture compiles itself.
    contract = {
        "id": CONTRACT3,
        "project_id": "{{project}}",
        "chapter_number": 3,
        "arc_id": IDS["arc1"],
        "season_id": IDS["season1"],
        "timeline_id": "{{main_timeline}}",
        "status": "draft",
        "pinned": {
            "spec_version": "{{int:spec_version}}",
            "bible_version": 1,
            "narrative_identity_version_id": IDS["identity_version"],
            "canon_version": "{{int:canon_version}}",
            "template_version": "pack.chapter_planner@1.0.0",
        },
        "narrative_identity_version_id": IDS["identity_version"],
        "active_constraints_ref": {
            "id": "{{acs.3.id}}",
            "content_hash": "{{acs.3.hash}}",
            "token_count": "{{int:acs.3.tokens}}",
        },
        "version": 1,
        "beat_refs": ["arc1.beat.05"],
        "purpose": "The cost of being right: the flagged gate becomes a reinspection, the Association takes an interest in the porter, and Do-yoon learns his map of the future has holes he made himself.",
        "must_happen": [
            {
                "id": "MH-1",
                "kind": "event",
                "description": "Mapo Gate 3 is suspended pending reinspection because of the anomalous cores.",
                "entity_ids": [IDS["mapo_gate3"], IDS["association"]],
                "verifiable_by": "extraction",
            },
            {
                "id": "MH-2",
                "kind": "decision",
                "description": "Do-yoon refuses to explain his source to Mu-jin, keeping the regression unspoken.",
                "entity_ids": [IDS["doyoon"], IDS["mujin"]],
                "verifiable_by": "judge",
            },
        ],
        "must_not_happen": [
            {
                "id": "MN-1",
                "description": "Do-yoon stating or implicitly admitting the regression.",
                "source": "spec",
                "requirement_id": "REQ-021",
            },
            {
                "id": "MN-2",
                "description": "Mu-jin's leg being injured after chapter 2 saved it.",
                "source": "spec",
                "requirement_id": "REQ-022",
            },
        ],
        "pov": {"character_id": IDS["doyoon"], "person": "third_limited"},
        "participants": [
            {"character_id": IDS["doyoon"], "role_in_chapter": "protagonist", "on_page": True},
            {"character_id": IDS["mujin"], "role_in_chapter": "mentor", "on_page": True},
        ],
        "locations": [IDS["hall"]],
        "story_time": {
            "start": clock(3, 0, "D+2"),
            "end": clock(3, 99, "D+2"),
            "elapsed_since_previous": "The following morning, 9:20 a.m.",
        },
        "knowledge_deltas": [],
        "state_deltas": [
            {
                "entity_id": IDS["mapo_gate3"],
                "attribute": "gate.status",
                "from": "open",
                "to": "entry suspended pending survey",
                "when_in_chapter": "early",
            }
        ],
        "relationship_deltas": [
            {
                "from_id": IDS["mujin"],
                "to_id": IDS["doyoon"],
                "axis": "trust",
                "direction": "up",
                "magnitude": 1,
                "description": "He asks, is refused, and keeps the share anyway.",
            }
        ],
        "setups": [
            {
                "promise_id": IDS["promise_survey"],
                "kind": "open",
                "how": "The Association's Thursday reinspection will want a porter who has been inside.",
            }
        ],
        "payoffs": [
            {
                "promise_id": IDS["promise_gate_run"],
                "how": "The run's consequence lands: the gate the run changed is now under review.",
                "kind": "advance",
            }
        ],
        "emotional_movement": {
            "start": "First small proof the future can move",
            "end": "The future moved, and it moved out from under him",
        },
        "conflict": {
            "type": "internal",
            "description": "Do-yoon's foreknowledge is an asset that destroys itself as he spends it.",
        },
        "local_satisfaction": [
            {
                "type": "growth_confirmed",
                "description": "He chooses the man over the map, and says so out loud.",
            }
        ],
        "ending_state": "Watched by the survey division, with eleven days of trusted future left.",
        "hook": {
            "type": "reveal",
            "description": "Thursday is blank: the regression's map has already stopped covering the ground.",
        },
        "opening": {"type": "continue_cliffhanger", "description": "9:20 a.m.: the reinspection notice."},
        "scene_count": 2,
        "dialogue_density_target": 0.5,
        "length_target": {"unit": "words", "value": 950, "tolerance_ratio": 0.12},
        "continuity_risks": [
            {"description": "Do-yoon's porter share is 18% as of ch.2; Mu-jin's leg is intact. Mu-jin calls him 'kid'/'Kang'; Do-yoon says 'Mister Park'."}
        ],
        "continuity_anchors": [
            {
                "fact_id": "{{canon.f-share}}",
                "statement": "Kang Do-yoon's porter share under Park Mu-jin is eighteen percent (ch.2).",
                "evidence": [
                    {
                        "manuscript_version_id": "{{version.2.approved}}",
                        "chapter_no": 2,
                        "paragraph_id": "p52",
                        "start": 0,
                        "end": 0,
                        "quote": "“Kang. You carry for eighteen percent.”",
                    }
                ],
            }
        ],
        "knowledge_guards": [
            {"character_id": IDS["mujin"], "must_not_know_proposition_ids": ["{{proposition.P1}}"]}
        ],
        "acceptance_criteria": [
            {
                "id": "AC-LANG",
                "kind": "deterministic",
                "description": "Manuscript is English",
                "check_ref": "EP-LANG-01",
                "threshold": 0.99,
            },
            {
                "id": "AC-MH-1",
                "kind": "judge",
                "description": "The gate is suspended pending reinspection",
                "check_ref": "contract_checker:MH-1",
            },
        ],
    }

    # ---- Scene plan
    reg_dm = {"formality": 3, "deference": 3, "familiarity": 1, "directness": 2, "contractions": "neutral", "address_terms": ["Mister Park", "sir"]}
    reg_md = {"formality": 1, "deference": 0, "familiarity": 1, "directness": 4, "contractions": "free", "address_terms": ["kid", "Kang"]}
    scene_plan = {
        "scenes": [
            {
                "scene_no": 1,
                "objective": "9:20 a.m.: the reinspection notice tells Do-yoon his own success changed the board, and the survey division finds him first.",
                "pov": {"character_id": IDS["doyoon"], "person": "third_limited"},
                "participants": [IDS["doyoon"]],
                "location_id": IDS["hall"],
                "beats": [
                    {"type": "revelation", "description": "The gate is suspended because of the cores he helped carry out.", "tags": ["tension"]},
                    {"type": "emotional", "description": "His memory is a map of a country he is demolishing.", "tags": ["tension"]},
                    {"type": "dialogue", "description": "A surveyor with his statement missing asks where the third chamber came from.", "tags": ["information"]},
                ],
                "length_target": {"unit": "words", "value": 430},
                "speaker_pairs": [
                    {"speaker_id": IDS["doyoon"], "addressee_id": IDS["mujin"], "register": reg_dm}
                ],
                "opening_beat_type": "continue_cliffhanger",
            },
            {
                "scene_no": 2,
                "objective": "Mu-jin presses for the truth, is refused, keeps the share anyway — and Thursday turns out to be blank.",
                "pov": {"character_id": IDS["doyoon"], "person": "third_limited"},
                "participants": [IDS["doyoon"], IDS["mujin"]],
                "location_id": IDS["hall"],
                "beats": [
                    {"type": "dialogue", "description": "'You're telling me the gate got flagged because I lived.'", "tags": ["tension"]},
                    {"type": "dialogue", "description": "'I'd rather have you than the gate.'", "tags": ["satisfaction"]},
                    {"type": "revelation", "description": "Thursday has no remembered shape at all.", "tags": ["tension"]},
                ],
                "length_target": {"unit": "words", "value": 520},
                "speaker_pairs": [
                    {"speaker_id": IDS["doyoon"], "addressee_id": IDS["mujin"], "register": reg_dm},
                    {"speaker_id": IDS["mujin"], "addressee_id": IDS["doyoon"], "register": reg_md},
                ],
                "ending_beat_type": "reveal",
            },
        ]
    }

    # ---- Scene drafts
    s1p, s2p = paragraphs(s1), paragraphs(s2)
    speakers1 = {}
    for pid, _, _, body in s1p:
        if body.startswith(("“You're the porter.", "“You're the porter who", "“Yoon Ha-eun", "“You gave him", "“The survey was wrong", "“Mm.")):
            speakers1[pid] = IDS["yoon"]
        elif body.startswith(("“I'm a porter", "“He asked me", "“Then the survey", "“I have a bad feeling")):
            speakers1[pid] = IDS["doyoon"]
    speakers2 = {}
    for pid, _, _, body in s2p:
        if body.startswith(("“Eighteen percent,”", "“She asked me everything", "“I can read.", "“You're telling me", "“That's the same sentence", "“There is no rest.", "“Kid.", "“And?", "“Eighteen percent,” he said again")):
            speakers2[pid] = IDS["mujin"]
        elif body.startswith(("“She asked you about me.", "“Mister Park. The gate", "“I'm telling you", "“I did work it out.", "“I'd rather have you")):
            speakers2[pid] = IDS["doyoon"]

    drafts = {
        1: scene_draft(1, s1, speakers1, [
            ("Mapo Gate 3 is suspended pending a reinspection after the anomalous cores.", paragraph_of(s1p, s1.find("The Association posted")), [IDS["mapo_gate3"], IDS["association"]]),
            ("The survey division questions Do-yoon about his knowledge of the third chamber.", paragraph_of(s1p, s1.find("“You gave him a third chamber.")), [IDS["doyoon"], IDS["association"]]),
        ]),
        2: scene_draft(2, s2, speakers2, [
            ("Do-yoon refuses to explain his source and keeps the regression unspoken.", paragraph_of(s2p, s2.find("“There is no rest.")), [IDS["doyoon"], IDS["mujin"]]),
            ("Mu-jin keeps Do-yoon at eighteen percent and stops asking.", paragraph_of(s2p, s2.find("“Eighteen percent,” he said again")), [IDS["doyoon"], IDS["mujin"]]),
        ]),
    }

    # ---- Evaluators. Like chapter 2, chapter 3 is accepted at r0: the chain must not depend on the
    # revision path, which chapter 1 already exercises.
    contract_check = {
        "criteria": [
            {"criterion_id": "AC-LANG", "passed": True, "evidence_paragraph_ids": ["p1"], "note": "English throughout."},
            {"criterion_id": "AC-MH-1", "passed": True, "evidence_paragraph_ids": [paragraph_of(paras, find_span(assembled, "The Association posted the reinspection notice")[0])], "note": "The gate is suspended pending survey."},
        ]
    }
    no_issues = {"issues": []}
    prose = {
        "dimension_scores": {"idiomatic_english": 5, "readability": 5, "register_fidelity": 5, "translation_markers": 5},
        "judge_score": 89,
        "drift_flags": [],
        "issues": [],
    }
    genre = {
        "dimension_scores": {"reader_fantasy": 5, "device_correctness": 4, "vocabulary_register": 4, "taboo_restraint": 5},
        "judge_score": 87,
        "drift_flags": [],
        "issues": [],
    }
    voice = {
        "dimension_scores": {"distinguishability": 5, "verbal_habits": 4, "register_naturalness": 5, "register_consistency": 5},
        "judge_score": 88,
        "drift_flags": [],
        "issues": [],
    }
    structure = {
        "dimension_scores": {"hook_timing": 5, "dialogue_forwardness": 5, "local_payoff": 5, "ending_pull": 5, "exposition_control": 4},
        "judge_score": 91,
        "hook_sentence_index": 1,
        "local_payoff_present": True,
        "ending_type_detected": "reveal",
        "drift_flags": [],
        "issues": [],
    }

    # ---- Extraction. Chapter 3's delta reaches into CHAPTER 2's canon: the gate anomaly fact chapter 2
    # asserted is superseded here, so the bitemporal chain is bible → ch.1 → ch.2 → ch.3.
    envelope = {
        "project_id": "{{project}}",
        "chapter_id": "{{chapter.3}}",
        "manuscript_version_id": "{{version.3.approved}}",
        "base_canon_version": "{{int:canon_version}}",
        "stage": "extracted_a",
    }
    delta_items = [
        {"local_id": "ev-suspension", "type": "event", "op": "assert", "frame": "canonical", "confidence": 1, "importance": "core", "story_clock": clock(3, 2, "D+2"),
         "payload": {"type": "other", "summary": "The Association suspends entry to Mapo Gate 3 pending a grade reinspection.",
                     "location_id": IDS["hall"],
                     "participants": [{"entity_id": IDS["association"], "role": "agent"}, {"entity_id": IDS["mapo_gate3"], "role": "patient"}],
                     "importance": "core"},
         "evidence": ev("The Association posted the reinspection notice for Mapo Gate 3 at 9:20 a.m.")},
        {"local_id": "ev-questioned", "type": "event", "op": "assert", "frame": "canonical", "confidence": 1, "importance": "core", "story_clock": clock(3, 20, "D+2"),
         "payload": {"type": "other", "summary": "The survey division questions Do-yoon about how he knew of the third chamber; he does not explain.",
                     "location_id": IDS["hall"],
                     "participants": [{"entity_id": IDS["association"], "role": "agent"}, {"entity_id": IDS["doyoon"], "role": "patient"}],
                     "importance": "core"},
         "evidence": ev("“You gave him a third chamber.”")},
        # Chapter 2 asserted the gate's core-grade anomaly; chapter 3 SUPERSEDES that row, so the chain of
        # states on this gate is ch.2 → ch.3 and `supersedes_ref` binds the id chapter 2 committed as f-cores.
        {"local_id": "f-gate-status", "type": "fact", "op": "supersede", "frame": "canonical", "confidence": 1, "importance": "core", "story_clock": clock(3, 2, "D+2"),
         "supersedes_ref": "{{canon.f-cores}}",
         "payload": {"entity_id": IDS["mapo_gate3"], "attribute": "gate.core_grade_anomaly", "value": "under_review",
                     "value_text": "Entry suspended pending survey after nine of eleven cores read two grades above envelope",
                     "valid_from": clock(3, 2, "D+2"), "valid_to": None},
         "evidence": ev("*Gate MP-003 — grade under review. Entry suspended pending survey.*")},
        # The ch.2 gate-run promise advances: the run's consequence is now on the board.
        {"local_id": "pe-gate-run-cost", "type": "promise_event", "op": "advance", "frame": "canonical", "confidence": 1, "importance": "core", "story_clock": clock(3, 4, "D+2"),
         "payload": {"promise_id": IDS["promise_gate_run"], "kind": "advanced",
                     "note": "The saved run has a price: the gate it changed is under Association review."},
         "evidence": ev("Do-yoon had kept an old man's leg. In exchange, the Association was now looking at a gate that should have gone unwatched for another five months.")},
    ]
    hook_text = "Across the yard, Yoon Ha-eun stood at the hall door with her tablet against her hip, watching the two of them the way a surveyor watches a ceiling."
    summary_l1 = (
        "The morning after the Mapo run. The Association suspends Gate 3 pending reinspection because of "
        "the anomalous cores, and Do-yoon realises his own success changed a future he was relying on. A "
        "survey-division officer questions him about the third chamber and he gives her nothing. In the "
        "yard Mu-jin presses him directly, is refused, and keeps him at eighteen percent anyway. Do-yoon "
        "reaches for Thursday and finds no memory of it at all."
    )
    extraction = {
        **envelope,
        "items": delta_items,
        "unresolved_questions": [],
        "hypothesis_results": [
            {"hypothesis_ref": "MH-1", "result": "realized", "evidence": ev("*Gate MP-003 — grade under review. Entry suspended pending survey.*")},
            {"hypothesis_ref": "MH-2", "result": "realized", "evidence": ev("“There is no rest.”")},
        ],
        "summary_l1": summary_l1,
        "ending_hook": hook_text,
    }
    assert len(summary_l1.split()) <= 120, len(summary_l1.split())
    summary = {
        "summary_l1": summary_l1,
        "ending_hook": hook_text,
        "state_changes": [
            "Mapo Gate 3: entry suspended pending survey",
            "Kang Do-yoon: known to the Association survey division",
        ],
        # Still no knowledge_state: Mu-jin asks outright and is refused, so P1 remains unknown to him and
        # the ch.3 knowledge guard holds exactly as it did in ch.2.
        "knowledge_changes": [],
    }

    A = "activity:"
    recordings = {
        A + "chapter_contract:3": rec(contract),
        A + "scene_plan:3": rec(scene_plan),
        A + "scene_draft:3:1": rec(drafts[1]),
        A + "scene_draft:3:2": rec(drafts[2]),
        A + "contract_check:3:r0": rec(contract_check),
        A + "continuity:3:r0": rec(no_issues),
        A + "knowledge_leak:3:r0": rec(no_issues),
        A + "prose_judge:3:r0": rec(prose),
        A + "structure_judge:3:r0": rec(structure),
        A + "genre_judge:3:r0": rec(genre),
        A + "voice_judge:3:r0": rec(voice),
        A + "extract:3": rec(extraction),
        A + "summarize:3": rec(summary),
    }

    expected = {
        "contract_id": CONTRACT3,
        "assembled_code_points": len(assembled),
        "assembled_paragraphs": len(paras),
        "words": len(assembled.split()),
        "scene_words": [len(s1.split()), len(s2.split())],
        "ending_hook": hook_text,
        "summary_l1": summary_l1,
        "delta_items": len(delta_items),
        "item_counts": {
            "event": sum(1 for i in delta_items if i["type"] == "event"),
            "fact": sum(1 for i in delta_items if i["type"] == "fact"),
            "promise_event": sum(1 for i in delta_items if i["type"] == "promise_event"),
        },
    }

    os.makedirs(FX, exist_ok=True)
    with open(os.path.join(FX, "replay.ch03.json"), "w", encoding="utf-8") as f:
        json.dump(recordings, f, ensure_ascii=False, indent=1)
        f.write("\n")
    with open(os.path.join(FX, "expected.ch03.json"), "w", encoding="utf-8") as f:
        json.dump(expected, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(json.dumps(expected, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
