/**
 * Persistence + auth check for the sync server.
 *   node persist-check.mjs <wsUrl> <room> <token|-> <mode> [expectedText]
 * modes:
 *   write   — connect (with token), insert expectedText, wait for persist
 *   read    — connect (with token), expect the doc already contains expectedText
 *   reject  — connect WITHOUT a valid token, expect to stay disconnected
 */
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WS from "ws";

const [, , url, room, token, mode, expected] = process.argv;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await wait(50);
  }
  return false;
}

const doc = new Y.Doc();
const params = token && token !== "-" ? { token } : {};
const provider = new WebsocketProvider(url, room, doc, {
  WebSocketPolyfill: WS,
  params,
  connect: true,
});

const connected = await until(() => provider.wsconnected, mode === "reject" ? 2000 : 5000);

if (mode === "reject") {
  const ok = !provider.wsconnected;
  console.log(ok ? "REJECTED-OK" : "REJECT-FAIL (connected without token)");
  process.exit(ok ? 0 : 1);
}

if (!connected) {
  console.log("CONNECT-FAIL");
  process.exit(1);
}

if (mode === "write") {
  doc.getText("t").insert(0, expected);
  await until(() => provider.synced);
  await wait(1000); // let the server persist + we then disconnect to trigger compaction
  provider.destroy();
  console.log("WROTE");
  process.exit(0);
}

if (mode === "read") {
  const ok = await until(() => doc.getText("t").toString() === expected);
  console.log(ok ? `READ-OK (${doc.getText("t").toString()})` : `READ-FAIL (${doc.getText("t").toString()})`);
  provider.destroy();
  process.exit(ok ? 0 : 1);
}

if (mode === "write-ro") {
  // A viewer's writes must be ignored by the server.
  doc.getText("t").insert(0, expected);
  await wait(1200);
  provider.destroy();
  console.log("WROTE-RO (attempted)");
  process.exit(0);
}

if (mode === "readcheck") {
  // expected = required substring; process.argv[7] = forbidden substring (optional)
  const forbidden = process.argv[7];
  await until(() => doc.getText("t").toString().includes(expected));
  const text = doc.getText("t").toString();
  const hasExpected = text.includes(expected);
  const hasForbidden = forbidden ? text.includes(forbidden) : false;
  const ok = hasExpected && !hasForbidden;
  console.log(ok ? `READCHECK-OK ("${text}")` : `READCHECK-FAIL ("${text}")`);
  provider.destroy();
  process.exit(ok ? 0 : 1);
}

console.log("unknown mode");
process.exit(1);
