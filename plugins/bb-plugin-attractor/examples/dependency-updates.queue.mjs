#!/usr/bin/env bun
// Queue helper for examples/dependency-updates.dot. The graph's command
// nodes call this so the mechanical bookkeeping (which update is current,
// marking it done/failed, deciding whether to loop) is deterministic and
// never left to an agent's discretion — dogfood run 4 (2026-09-13) had a
// Haiku worker batch nine updates in one visit and mis-record which ones
// passed, which is exactly the kind of drift this script removes.
//
//   bun dependency-updates.queue.mjs next            print the first pending entry as JSON and
//                                                    remember its id in .local/dep-updates/current
//                                                    (prints "none" and clears current when the queue is empty)
//   bun dependency-updates.queue.mjs mark <status> [log-file]
//                                                    set the current entry's status; with a log file,
//                                                    record its first error line as the entry's notes
//   bun dependency-updates.queue.mjs count           print "remaining=N attempted=M MORE|DONE"
//
// State files live in .local/dep-updates/ (gitignored): queue.json is the
// ordered work list the triage stage wrote, current is the id of the entry
// being applied.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DIR = ".local/dep-updates";
const QUEUE = `${DIR}/queue.json`;
const CURRENT = `${DIR}/current`;
const MAX_ATTEMPTS = 18;

const readQueue = () => JSON.parse(readFileSync(QUEUE, "utf8"));
const writeQueue = (queue) => writeFileSync(QUEUE, `${JSON.stringify(queue, null, 2)}\n`);
const readCurrent = () => (existsSync(CURRENT) ? readFileSync(CURRENT, "utf8").trim() : "");

const [command, ...args] = process.argv.slice(2);

if (command === "next") {
  const entry = readQueue().find((e) => e.status === "pending");
  writeFileSync(CURRENT, entry ? `${entry.id}\n` : "");
  console.log(entry ? JSON.stringify(entry, null, 2) : "none");
} else if (command === "mark") {
  const [status, logFile] = args;
  if (!status) throw new Error("mark needs a status");
  const id = readCurrent();
  if (id === "") {
    console.log("no current entry");
  } else {
    const queue = readQueue();
    const entry = queue.find((e) => e.id === id);
    if (!entry) throw new Error(`no queue entry with id ${id}`);
    entry.status = status;
    if (logFile && existsSync(logFile)) {
      const lines = readFileSync(logFile, "utf8").split("\n");
      const firstError = lines.find((line) => /error|FAIL|✗|×/i.test(line)) ?? lines.filter((l) => l.trim()).at(-1) ?? "";
      entry.notes = `${status} on verification: ${firstError.trim().slice(0, 200)}`;
    }
    writeQueue(queue);
    console.log(`${id} -> ${status}`);
  }
} else if (command === "count") {
  const queue = readQueue();
  const remaining = queue.filter((e) => e.status === "pending").length;
  const attempted = queue.filter((e) => e.status === "done" || e.status === "failed").length;
  const verdict = remaining > 0 && attempted < MAX_ATTEMPTS ? "MORE" : "DONE";
  console.log(`remaining=${remaining} attempted=${attempted} ${verdict}`);
} else {
  console.error("usage: next | mark <status> [log-file] | count");
  process.exit(2);
}
