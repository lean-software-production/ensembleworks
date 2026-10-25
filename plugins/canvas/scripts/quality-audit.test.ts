import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import { productionFiles, tokenLines } from "./quality-audit";
describe("quality audit scanner", () => {
  it("counts token-bearing lines and excludes comments and blanks", () => { const source = ts.createSourceFile("fixture.ts", "// comment\n\nconst x = 1; // trailing\n\nfunction f() {\n  return x;\n}\n", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); expect(tokenLines(source)).toBe(4); });
  it("keeps the frozen production scope stable", () => { const files = productionFiles(process.cwd()); expect(files).toEqual(expect.arrayContaining(["app.tsx", "server.ts", "transport.ts", "canvas/CanvasPanel.tsx", "hooks/useBrowserDimmingModal.ts", "lib/utils.ts"])); expect(files.some((file) => file.startsWith("tests/") || file.startsWith("components/ui/") || file.startsWith("scripts/"))).toBe(false); });
});
