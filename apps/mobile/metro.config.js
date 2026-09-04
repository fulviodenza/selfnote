// Metro config for the standalone Expo app inside the selfnote monorepo.
//
// apps/mobile is excluded from the pnpm workspace and has its own node_modules,
// but it consumes @selfnote/core (raw TS) via a file: symlink that lives outside
// the project root. Metro must therefore watch the monorepo root, and — critically
// — resolve the shared CRDT libs (yjs, lib0, y-websocket, y-protocols) to a SINGLE
// copy. If core resolved yjs from the pnpm store while the app used its own copy,
// there would be two Yjs runtimes and CRDT sync would silently break.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the monorepo so Metro can read packages/core/src.
config.watchFolders = [monorepoRoot];

// Resolve bare imports from the app's own node_modules first.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

// Force every import of these — from the app OR from @selfnote/core — to the app's
// single copy, and stub the browser-only y-indexeddb (imported by core, unused here).
const dedupe = ["yjs", "lib0", "y-websocket", "y-protocols"];
config.resolver.extraNodeModules = {
  ...Object.fromEntries(
    dedupe.map((name) => [name, path.resolve(projectRoot, "node_modules", name)]),
  ),
  "y-indexeddb": path.resolve(projectRoot, "src/shims/y-indexeddb.js"),
};

module.exports = config;
