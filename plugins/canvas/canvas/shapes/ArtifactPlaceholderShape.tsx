// The `artifact` kind's body in the compatibility-reader release (Canvas
// artifact viewer, stage 1a). This build KEEPS artifact shapes — the schema
// is in canvas-model, so repair no longer drops them — but cannot show one
// yet, so it draws an inert box that says so, styled like canvas-react's
// BoxShape fallback. Deliberately nothing else: no control, no focus stop,
// no handler, and no prop rendered at all, because an artifact's props select
// a file on disk and only the later viewer stage may act on them. Registered
// as a plain body, not an embed (connection-boot.ts): an embed takes pointer
// input, and this has none to take.
import type { ShapeBodyProps } from "@ensembleworks/canvas-react";

export function ArtifactPlaceholderShape(_props: ShapeBodyProps) {
  return (
    <div
      data-shape-body="artifact-placeholder"
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        padding: 4,
        fontSize: 12,
        lineHeight: 1.2,
        textAlign: "center",
        borderRadius: 8,
        border: "1px solid rgba(0, 0, 0, 0.25)",
        background: "rgba(0, 0, 0, 0.04)",
        color: "rgba(0, 0, 0, 0.55)",
      }}
    >
      Artifact · update the Canvas plugin to view
    </div>
  );
}
