/**
 * Real Fabro DOT workflow definitions, copied verbatim from the
 * `workflow.fabro` file embedded in each job's `workflow.json` under
 * `~/.bb/plugins/assembly-lines/host-data/jobs/<id>/workflow.json`.
 *
 * NOTE (deviation from the plan): the plan's T2 acceptance criteria says
 * "the three Fabro graphs stored in .../jobs/<id>/workflow.json". At the
 * time this task ran there were four job directories, but only two
 * distinct `workflow.fabro` texts among them (the other two are exact
 * duplicates). Both distinct graphs are included below; see the plugin
 * README's "Deviations from the plan" section.
 */

export const FABRO_REFACTOR_SIMPLE = `
digraph RefactorCodeQuality {
    graph [goal="Improve code quality while preserving behavior", on_failure="exit"]
    node [timeout="20m"]
    start [shape=Mdiamond]
    exit [shape=Msquare]
    baseline [shape=parallelogram, label="Baseline", script="node .fabro-input/runner.mjs baseline", goal_gate=true, on_failure="exit"]
    plan [label="Select one improvement", prompt="Read repository AGENTS.md instructions and .fabro-input/work-order.json. Select one small behavior-preserving improvement within the agreed scope. Record rationale and expected quality improvement in .fabro-output/plan.md. Do not edit source. Do not alter .fabro-input or validation configuration to improve scores."]
    attempt [shape=parallelogram, label="Attempt budget", script="node .fabro-input/runner.mjs begin-attempt", max_visits=1, on_failure="exit"]
    implement [label="Refactor", max_visits=1, prompt="Read .fabro-input/work-order.json, .fabro-output/plan.md and any prior validation/review findings. Implement one focused behavior-preserving improvement within scope. Preserve tests and public behavior; follow repository interaction-contract obligations when applicable. Never edit .fabro-input or weaken validation/quality checks. Do not commit; the delivery stage owns committing."]
    validate [shape=parallelogram, label="Validate", script="node .fabro-input/runner.mjs validate", max_visits=1, goal_gate=true, retry_target="attempt"]
    review [label="Independent review", max_visits=1, output_schema="routing", prompt="Inspect the actual diff against baseSha from .fabro-input/work-order.json and the baseline/after quality evidence in .fabro-output. Check each acceptance criterion and unchanged behavior. Do not edit source. Write your findings to .fabro-output/review.md. Return JSON with preferred_next_label Accept only if the code is improved or no suitable change is justified, scope is respected and evidence supports the criteria. Otherwise return preferred_next_label Repair with concrete findings. Never accept merely because commands ran."]
    delivery [shape=parallelogram, label="Verify and deliver", script="node .fabro-input/runner.mjs deliver", goal_gate=true, on_failure="exit"]
    start -> baseline
    baseline -> plan [condition="outcome=succeeded"]
    baseline -> exit
    plan -> attempt -> implement -> validate
    validate -> review [condition="outcome=succeeded"]
    validate -> attempt [condition="outcome=failed"]
    validate -> exit
    review -> delivery [label="Accept", condition="preferred_label=Accept"]
    review -> attempt [label="Repair"]
    delivery -> exit
  }
`;

export const FABRO_REFACTOR_GOAL_GATED = `
digraph RefactorCodeQuality {
    graph [goal="Improve code quality while preserving behavior", on_failure="exit"]
    node [timeout="20m"]
    start [shape=Mdiamond]
    exit [shape=Msquare]
    baseline [shape=parallelogram, label="Baseline", script="node .fabro-input/runner.mjs baseline", goal_gate=true, on_failure="exit"]
    plan [goal_gate=true, label="Select one improvement", prompt="Read repository AGENTS.md instructions and .fabro-input/work-order.json. Select one small behavior-preserving improvement within the agreed scope. Record rationale and expected quality improvement in .fabro-output/plan.md. Do not edit source. Do not alter .fabro-input or validation configuration to improve scores."]
    attempt [shape=parallelogram, label="Attempt budget", goal_gate=true, script="node .fabro-input/runner.mjs begin-attempt", on_failure="exit"]
    implement [goal_gate=true, label="Refactor", prompt="Read .fabro-input/work-order.json, .fabro-output/plan.md and any prior validation/review findings. Implement one focused behavior-preserving improvement within scope. Preserve tests and public behavior; follow repository interaction-contract obligations when applicable. Never edit .fabro-input or weaken validation/quality checks. Do not commit; the delivery stage owns committing."]
    validate [shape=parallelogram, label="Validate", script="node .fabro-input/runner.mjs validate", goal_gate=true]
    review [goal_gate=true, label="Independent review", output_schema="routing", prompt="Inspect the actual diff against baseSha from .fabro-input/work-order.json and the baseline/after quality evidence in .fabro-output. Check each acceptance criterion and unchanged behavior. Do not edit source. Write your findings to .fabro-output/review.md. Return JSON with preferred_next_label Accept only if the code is improved or no suitable change is justified, scope is respected and evidence supports the criteria. Otherwise return preferred_next_label Repair with concrete findings. Never accept merely because commands ran."]
    delivery [shape=parallelogram, label="Verify and deliver", script="node .fabro-input/runner.mjs deliver", goal_gate=true, on_failure="exit"]
    start -> baseline
    baseline -> plan [condition="outcome=succeeded"]
    baseline -> exit
    plan -> attempt [condition="outcome=succeeded"]
    plan -> exit
    attempt -> implement [condition="outcome=succeeded"]
    attempt -> exit
    implement -> validate [condition="outcome=succeeded"]
    implement -> exit
    validate -> review [condition="outcome=succeeded"]
    validate -> attempt [condition="outcome=failed"]
    validate -> exit
    review -> delivery [label="Accept", condition="preferred_label=Accept"]
    review -> attempt [label="Repair", condition="preferred_label=Repair"]
    review -> exit
    delivery -> exit
  }
`;
