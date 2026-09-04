/**
 * End-to-end acceptance test for the Phase 1 sync spike.
 *
 * Connects two independent Yjs documents to a running selfnote-sync server and
 * verifies:
 *   1. live propagation      — an edit on A appears on B
 *   2. late-joiner sync      — a doc that joins later receives existing content
 *   3. offline-merge (CRDT)  — B edits while disconnected, both converge on reconnect
 *
 * Requires the sync server running (SYNC_URL, default ws://localhost:4444/ws).
 * Exits non-zero on any failure so it can gate CI.
 */
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WS from "ws";

const URL = process.env.SYNC_URL ?? "ws://localhost:4444/ws";
const ROOM = `smoketest-${Math.floor(Math.random() * 1e9)}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 5000, step = 50) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await wait(step);
  }
  return false;
}

function connect() {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(URL, ROOM, doc, {
    WebSocketPolyfill: WS,
    connect: true,
  });
  return { doc, provider };
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log(`sync server: ${URL}`);
console.log(`room:        ${ROOM}\n`);

const a = connect();
const b = connect();

const connected = await until(() => a.provider.wsconnected && b.provider.wsconnected);
check("both clients connect", connected);
if (!connected) finish();

// 1. live propagation A -> B
a.doc.getText("t").insert(0, "hello");
const propagated = await until(() => b.doc.getText("t").toString() === "hello");
check("edit on A propagates to B", propagated, `B sees "${b.doc.getText("t").toString()}"`);

// 2. late joiner receives existing state from the server's authoritative copy
const c = connect();
const lateSynced = await until(() => c.doc.getText("t").toString() === "hello");
check("late joiner syncs existing content", lateSynced, `C sees "${c.doc.getText("t").toString()}"`);
c.provider.destroy();

// 3. offline concurrent-edit merge
b.provider.disconnect();
await wait(200);
a.doc.getText("t").insert(5, " from A"); // A stays online
b.doc.getText("t").insert(5, " from B"); // B edits offline
b.provider.connect();

const converged = await until(
  () =>
    b.provider.wsconnected &&
    a.doc.getText("t").toString() === b.doc.getText("t").toString() &&
    a.doc.getText("t").toString().length === "hello from A from B".length,
);
check(
  "offline concurrent edits merge and converge",
  converged,
  `converged text = "${a.doc.getText("t").toString()}"`,
);

finish();

function finish() {
  const passed = results.length > 0 && results.every((r) => r.ok);
  console.log(`\n${passed ? "SMOKETEST PASS" : "SMOKETEST FAIL"}`);
  try {
    a.provider.destroy();
    b.provider.destroy();
  } catch {
    /* ignore */
  }
  process.exit(passed ? 0 : 1);
}
