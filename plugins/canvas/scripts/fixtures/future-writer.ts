// TEST-ONLY representative N+1 writer. Not imported by either plugin entry.
// No viewer, CLI, route or Stage 1b feature is implemented here. The fixture
// uses the compatibility protocol plus raw history authoring to stand in for
// a future release. It is NOT evidence about an actual released N+1 binary.
import Database from "better-sqlite3";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import { Frame, encode } from "@ensembleworks/canvas-sync";
import type { Shape } from "@ensembleworks/canvas-model";
export { default } from "../../server.js";
export const fixtureIdentity = "representative N+1 writer; not a release";

export function artifactFrame(shape: Shape, peerId: bigint): Uint8Array {
  const doc = LoroCanvasDoc.create({ peerId });
  doc.putPage({ id: "page:p", name: "P" });
  doc.putShapeUnchecked(shape);
  doc.commit();
  return encode(Frame.Update, doc.exportUpdate());
}

/** A still-newer writer atomically commits new-format bytes AND its stamp.
 * Called in a separate process at N's check/use barrier. busy_timeout=0
 * makes contention an immediate result, not a timing-dependent wait. */
export function claimNewerFormat(file: string): "blocked" | "committed" {
  const db = new Database(file);
  db.pragma("busy_timeout = 0");
  try {
    db.transaction(() => {
      const doc = LoroCanvasDoc.create({ peerId: 900001n });
      const snapshot = db.prepare("SELECT blob FROM canvas_snapshot WHERE room = 'main'").get() as { blob: Buffer } | undefined;
      if (snapshot) doc.import(snapshot.blob);
      for (const row of db.prepare("SELECT blob FROM canvas_updates WHERE room = 'main' ORDER BY seq").all() as { blob: Buffer }[]) doc.import(row.blob);
      doc.putPage({ id: "page:p", name: "P" });
      doc.putShapeUnchecked({ id: "shape:future-format", kind: "future-kind", parentId: "page:p", index: "a1",
        x: 0, y: 0, rotation: 0, opacity: 1, isLocked: false, meta: {}, props: {} } as unknown as Shape);
      doc.commit();
      db.prepare("INSERT INTO canvas_snapshot(room, blob) VALUES ('main', ?) ON CONFLICT(room) DO UPDATE SET blob = excluded.blob").run(Buffer.from(doc.exportSnapshot()));
      db.prepare("DELETE FROM canvas_updates WHERE room = 'main'").run();
      db.prepare("INSERT INTO canvas_format(room, version) VALUES ('main', 2) ON CONFLICT(room) DO UPDATE SET version = MAX(version, 2)").run();
    }).immediate();
    return "committed";
  } catch (error) {
    if ((error as { code?: string }).code === "SQLITE_BUSY") return "blocked";
    throw error;
  } finally { db.close(); }
}
