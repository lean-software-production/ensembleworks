import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { CANVAS_MIGRATIONS } from "../canvas/store.js";

it("retains the exact six migrations shipped in v0.29.0 before appending format storage", () => {
  // From tag v0.29.0, commit 556ddcca4235505026351927c83cfc1c67b6657c.
  // The SDK hashes SQL bytes, including whitespace; retired tables still
  // reserve their migration indices. A parent-only comparison missed this.
  expect(CANVAS_MIGRATIONS.slice(0, 6).map((sql) => createHash("sha256").update(sql).digest("hex"))).toEqual([
    "65da0a5b05a43adcf69543c371c87bf01583ca17152d15e341c3d2d20479d262",
    "a3a6d624ed85044100aacc065ddc22d03b805e57f731a0c4dd6fd10bc63cb33f",
    "c3ef78384eaa61aa81beca47767fe92ec0b4026a750aeb6e60f94857d3978a09",
    "32731a14b42ca133f8cf7ff7da8dde2ce0da24ba4a6a995898f208d87263b8f5",
    "00a54dc79a4c8a51705eb76466d27ecfff1cc76b0591500e11c319142381efb9",
    "2d948e3a952050f3275fc59bf069f97ed55227a90ae7882aec5e3f1144594b16",
  ]);
  expect(CANVAS_MIGRATIONS[6]).toContain("CREATE TABLE IF NOT EXISTS canvas_format");
});
