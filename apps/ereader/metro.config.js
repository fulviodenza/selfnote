// Metro config for the standalone eReader app.
//
// apps/ereader lives outside the pnpm workspace with its own node_modules, and
// consumes @selfnote/reader through a file: symlink that resolves outside the
// project root, so Metro has to watch the monorepo to read it.
//
// No dedupe hook here, unlike apps/mobile. @selfnote/reader builds to a single
// string and pulls in nothing at runtime, so there are no shared libraries that
// could resolve twice. That is a reason to keep it that way.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [monorepoRoot];

module.exports = config;
