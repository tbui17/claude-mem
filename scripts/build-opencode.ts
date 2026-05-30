#!/usr/bin/env bun
// Build the OpenCode plugin and deploy it to the local OpenCode plugin directory.

import { execSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SRC = join(PROJECT_ROOT, "dist", "opencode-plugin", "index.js");
const DEST_DIR = join(homedir(), ".config", "opencode", "plugins");
const DEST = join(DEST_DIR, "claude-mem.js");

console.log("🔨 Building all targets...");
execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });

if (!existsSync(SRC)) {
  console.error(`❌ Build output not found: ${SRC}`);
  process.exit(1);
}

mkdirSync(DEST_DIR, { recursive: true });
copyFileSync(SRC, DEST);

const sizeKB = (statSync(DEST).size / 1024).toFixed(1);
console.log(`✓ OpenCode plugin deployed to ${DEST} (${sizeKB} KB)`);
