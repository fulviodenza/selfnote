#!/usr/bin/env node
/**
 * Stdin/stdout bridge so the Rust API can run the y-prosemirror diff path without
 * embedding a BlockNote engine of its own — the same relationship `ai.rs` has with
 * the `claude` CLI. The API shells out to `node dist/diff-cli.js`, writes one JSON
 * job on stdin, and reads one JSON result on stdout.
 *
 * Jobs (`mode`):
 *   - "compute": stage an edit. Input {updates, op, markdown}. Output the four
 *     proposal fields {before_md, after_md, diff_base64, base_sv}.
 *   - "reapply": re-derive a replace diff from the intended final body against the
 *     note's *current* updates (used when a note drifted before a proposal was
 *     accepted). Input {updates, after_md}. Output {diff_base64, base_sv}.
 *   - "merge": collapse a note's update log into one v1 update (a version-history
 *     checkpoint snapshot). Input {updates}. Output {snapshot, size_bytes}.
 *   - "restore": forward update that turns the note's current state into a target
 *     checkpoint state. Input {updates, target}. Output {update, size_bytes}.
 *
 * Errors are reported as {error: "…"} on stdout with a non-zero exit code, so the
 * caller can surface a clean 409 instead of a stack trace.
 */
import {
  computeProposal,
  mergeUpdatesBase64,
  replaceMarkdownDiff,
  restoreUpdateBase64,
  stateVectorBase64,
} from "./edit.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function run(job: any): Promise<unknown> {
  const updates: string[] = Array.isArray(job.updates) ? job.updates : [];
  switch (job.mode) {
    case "compute": {
      const op = job.op === "replace" ? "replace" : job.op === "append" ? "append" : null;
      if (!op) throw new Error(`invalid op: ${JSON.stringify(job.op)}`);
      if (typeof job.markdown !== "string") throw new Error("markdown must be a string");
      return computeProposal(updates, op, job.markdown);
    }
    case "reapply": {
      if (typeof job.after_md !== "string") throw new Error("after_md must be a string");
      const diff_base64 = await replaceMarkdownDiff(updates, job.after_md);
      return { diff_base64, base_sv: stateVectorBase64(updates) };
    }
    case "merge": {
      const snapshot = mergeUpdatesBase64(updates);
      return { snapshot, size_bytes: Buffer.from(snapshot, "base64").length };
    }
    case "restore": {
      if (typeof job.target !== "string") throw new Error("target must be a string");
      const update = restoreUpdateBase64(updates, job.target);
      return { update, size_bytes: Buffer.from(update, "base64").length };
    }
    default:
      throw new Error(`unknown mode: ${JSON.stringify(job.mode)}`);
  }
}

async function main() {
  try {
    const job = JSON.parse(await readStdin());
    const result = await run(job);
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
  }
}

void main();
