/**
 * The Rules tab's coverage map: every path into BB and what the guardrail can do about
 * it. Static, versioned with the plugin, and worded so no row implies more than Identity
 * can see — in particular, the automation that sends into an existing thread is blind.
 */
export type CoverageStatus = "checked" | "seen-after" | "logged-only" | "blind";
export type CoverageRow = { path: string; status: CoverageStatus; note: string };

export const COVERAGE_ROWS: readonly CoverageRow[] = [
  { path: "Composer send (new thread or follow-up)", status: "checked",
    note: "The dispatch hook sees it and the guardrail can refuse it." },
  { path: "Send now (queued message)", status: "seen-after",
    note: "Skips the dispatch hook; Identity records the requester afterwards. "
      + "A Send-now dispatch hook in BB core would move this to Checked." },
  { path: "Automation spawning a thread (threads.spawn)", status: "checked",
    note: "Rule C applies to stamped automation spawns." },
  { path: "Automation sending into an existing thread (threads.send)", status: "blind",
    note: "Arrives unstamped, so rule C cannot see it. Needs BB core to stamp threads.send." },
  { path: "Agents and the CLI (no Access header)", status: "checked",
    note: "Always allowed: no identity means nothing to refuse. Attributed to the fallback email when one is set." },
  { path: "Terminals, Stop, Archive, approvals, host routes, plugin RPCs", status: "logged-only",
    note: "Seen by the request stream in audit/enforce modes; never refused." },
  { path: "Raw API calls with an Access header", status: "checked",
    note: "Same hook as the composer." },
];
