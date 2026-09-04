// Polyfills MUST be imported first — before any module that pulls in Yjs/lib0 —
// so the globals they install (crypto, Buffer) exist by the time those evaluate.
import "./src/polyfills";
import { registerRootComponent } from "expo";
import { App } from "./App";

registerRootComponent(App);
