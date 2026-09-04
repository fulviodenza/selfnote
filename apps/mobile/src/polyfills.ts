/**
 * Runtime polyfills for globals that Yjs/lib0 expect but Hermes (React Native)
 * does not provide. Imported for its side effects as the very first thing in the
 * app entry (index.ts), so these globals exist before any module that pulls in
 * Yjs/lib0 is evaluated.
 *
 *  - crypto.getRandomValues — lib0 uses it for document/client IDs.
 *  - Buffer — lib0/buffer's base64 encode/decode (the CRDT-update bridge to the
 *    WebView editor and SQLite persistence) uses it on non-browser runtimes.
 */
import "react-native-get-random-values";
import { Buffer } from "buffer";

const g = globalThis as typeof globalThis & { Buffer?: unknown };
if (typeof g.Buffer === "undefined") {
  g.Buffer = Buffer;
}
