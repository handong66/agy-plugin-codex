#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "plugins/agy-plugin-codex/dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: {
    server: "plugins/agy-plugin-codex/src/server.ts",
    // A separate entry point because the worker is spawned detached, as its own
    // process, and has to outlive the MCP server that started it.
    "job-worker": "plugins/agy-plugin-codex/src/job-worker.ts"
  },
  outdir,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  legalComments: "none",
  logLevel: "info"
});
