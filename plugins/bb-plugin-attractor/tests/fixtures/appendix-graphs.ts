/**
 * The three example graphs from the "Appendix — example graphs" section of
 * docs/plans/2026-09-13-attractor-runner-plan.md, copied verbatim so T2's
 * parser/graph/validate pipeline can be exercised against them. Full
 * end-to-end (engine) tests for these live with the T7 examples task; here
 * they only prove the DOT front-end handles real-world graphs.
 */

export const PLAN_IMPLEMENT_REVIEW = `
digraph PlanImplementReview {
  graph [goal="Implement the requested change safely", rankdir=LR,
         model_stylesheet="* { model: claude-sonnet-5; } #review { model: claude-opus-5; reasoning_effort: high; }"]
  start [shape=Mdiamond]
  exit  [shape=Msquare]
  plan      [label="Plan", prompt="Read the task in context and write a short plan to PLAN.md. Do not edit source."]
  approve   [shape=hexagon, label="Approve plan?"]
  implement [label="Implement", prompt="Implement PLAN.md with tests. Do not commit.", max_visits=3]
  test      [shape=parallelogram, label="Test", script="npm test", goal_gate=true, max_visits=3]
  review    [label="Review", prompt="Review the diff. Return routing JSON: Accept or Repair.", output_schema="routing"]
  start -> plan -> approve
  approve -> implement [label="[A] Approve"]
  approve -> plan      [label="[R] Revise"]
  implement -> test
  test -> review    [condition="outcome=succeeded"]
  test -> implement [condition="outcome=failed"]
  review -> exit      [label="Accept", condition="preferred_label=Accept"]
  review -> implement [label="Repair"]
}
`;

export const PARALLEL_REVIEW = `
digraph ParallelReview {
  graph [goal="Three-lens review"]
  start [shape=Mdiamond]  exit [shape=Msquare]
  fork  [shape=component, label="Fan out"]
  merge [shape=tripleoctagon, label="Merge"]
  security     [prompt="Review for security issues; return findings as text."]
  architecture [prompt="Review for architecture issues; return findings as text."]
  quality      [prompt="Review for code quality; return findings as text."]
  summarise    [prompt="Combine parallel.results into one prioritised report."]
  start -> fork
  fork -> security  fork -> architecture  fork -> quality
  security -> merge  architecture -> merge  quality -> merge
  merge -> summarise -> exit
}
`;

export const BRANCH_LOOP = `
digraph BranchLoop {
  graph [goal="Make the build green", max_node_visits=4, on_failure="route"]
  start [shape=Mdiamond]  exit [shape=Msquare]
  build [shape=parallelogram, script="npm run build", goal_gate=true]
  fix   [prompt="The build failed. Read the output in context and fix it."]
  check [shape=diamond]
  start -> build -> check
  check -> exit [condition="outcome=succeeded"]
  check -> fix  [condition="outcome=failed"]
  fix -> build
}
`;
