// Run: npx vitest run tests/artifact-wiring.test.ts
//
// connection-boot must register the stage-1a `artifact` placeholder as a
// plain shape body (not an embed: an embed takes pointer input, and this body
// has none), and the body itself must declare no handlers. Source-level,
// for the reason tests/lib/source.ts gives: there is no jsdom here.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bodyStatements, countInCode } from "./lib/source.js";

const BOOT = readFileSync(new URL("../canvas/panel/connection-boot.ts", import.meta.url), "utf8");
const SHAPE_URL = new URL("../canvas/shapes/ArtifactPlaceholderShape.tsx", import.meta.url);

describe("connection-boot registers the 'artifact' placeholder", () => {
  it("calls registerShape('artifact', ArtifactPlaceholderShape) inside boot(), next to bbthread", () => {
    const statements = bodyStatements(BOOT, "boot");
    const coreIndex = statements.indexOf("registerCoreShapes();");
    const bbthreadIndex = statements.indexOf('registerShape("bbthread", BbThreadShape);');
    const artifactIndex = statements.indexOf('registerShape("artifact", ArtifactPlaceholderShape);');
    expect(coreIndex).toBeGreaterThanOrEqual(0);
    expect(artifactIndex).toBeGreaterThan(coreIndex);
    expect(artifactIndex).toBe(bbthreadIndex + 1);
  });

  it("imports ArtifactPlaceholderShape from the shapes directory", () => {
    expect(BOOT).toContain(
      'import { ArtifactPlaceholderShape } from "../shapes/ArtifactPlaceholderShape.js";',
    );
  });
});

describe("the placeholder body declares no interaction", () => {
  it("exists", () => {
    expect(existsSync(SHAPE_URL)).toBe(true);
  });

  it("has no handlers, focus stops or interactive markers", () => {
    const shape = existsSync(SHAPE_URL) ? readFileSync(SHAPE_URL, "utf8") : "";
    expect(shape).not.toBe("");
    for (const needle of ["onClick", "onPointer", "onKey", "onMouse", "onDoubleClick", "tabIndex", "data-canvas-interactive", "href", "iframe"]) {
      expect(countInCode(shape, needle)).toBe(0);
    }
  });
});
