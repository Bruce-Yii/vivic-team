#!/usr/bin/env node
/**
 * Build-time TypeScript precompiler for the Vivic online API image.
 *
 * Runs INSIDE the Docker image during `docker build` (esbuild is already
 * present because tsx depends on it; `typescript` is NOT installed in the
 * image, so `tsc` is not an option).
 *
 * What it does, and why:
 *   1. Transpiles every .ts under the API src tree and the two vendored
 *      @vivic packages to a sibling .js file (same directory, same basename).
 *      Keeping the emitted file beside its source preserves every
 *      `import.meta.url` / `import.meta.dirname` relative path in the app.
 *   2. Rewrites relative import specifiers that have no extension
 *      (`from "./cardRecord"`) to `./cardRecord.js` / `./index.js`, because
 *      Node's ESM resolver does not do extension or directory-index lookup.
 *   3. Repoints the `exports` maps of @vivic/contracts and @vivic/card-runtime
 *      from ./src/*.ts to ./src/*.js so plain `node` can resolve them.
 *
 * The .ts sources stay in the image: the deploy script falls back to
 * `node --import tsx src/online/index.ts` if this step was skipped or the
 * emitted tree is incomplete (see deploy-v2.sh `start_cmd_for`).
 *
 * Usage (inside the image):  node /app/precompile.mjs /app
 * Exit code 0 = every emitted specifier resolves; 1 = unresolved specifiers.
 */
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";

const root = path.resolve(process.argv[2] || "/app");
const SRC_ROOTS = [
  "apps/local-api/src",
  "apps/local-api/node_modules/@vivic/contracts/src",
  "apps/local-api/node_modules/@vivic/card-runtime/src",
  "apps/local-api/node_modules/@vivic/mobile-console-prototype/src",
];
const EXPORT_PACKAGES = [
  "apps/local-api/node_modules/@vivic/contracts/package.json",
  "apps/local-api/node_modules/@vivic/card-runtime/package.json",
  "apps/local-api/node_modules/@vivic/mobile-console-prototype/package.json",
];

const exists = async (p) => {
  try { await stat(p); return true; } catch { return false; }
};
const isDir = async (p) => {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
};

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && /\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) yield full;
  }
}

/** Rewrite relative specifiers so Node ESM can resolve them from the emitted .js. */
async function rewriteSpecifiers(jsPath, warnings) {
  const dir = path.dirname(jsPath);
  let code = await readFile(jsPath, "utf8");
  const fixes = [];
  // Static: from "..." / import "..." / export ... from "..."; dynamic: import("...")
  const pattern = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\2/g;
  const targets = new Set();
  for (const m of code.matchAll(pattern)) targets.add(m[3]);
  for (const spec of targets) {
    if (/\.(js|mjs|cjs|json|css|node|wasm)$/.test(spec)) continue;
    if (/\.(ts|tsx|mts)$/.test(spec)) { fixes.push([spec, spec.replace(/\.(ts|tsx|mts)$/, ".js")]); continue; }
    const base = path.resolve(dir, spec);
    if (await exists(`${base}.js`)) fixes.push([spec, `${spec}.js`]);
    else if (await isDir(base) && await exists(path.join(base, "index.js"))) fixes.push([spec, `${spec}/index.js`]);
    else if (await exists(path.join(base, "index.js"))) fixes.push([spec, `${spec}/index.js`]);
    else warnings.push(`${path.relative(root, jsPath)}: unresolved specifier "${spec}"`);
  }
  for (const [from, to] of fixes) {
    code = code.split(`${JSON.stringify(from)}`).join(`${JSON.stringify(to)}`)
               .split(`'${from}'`).join(`'${to}'`);
  }
  await writeFile(jsPath, code, "utf8");
  return fixes.length;
}

async function main() {
  let files = 0, rewritten = 0;
  const warnings = [];
  for (const rel of SRC_ROOTS) {
    const dir = path.join(root, rel);
    if (!(await isDir(dir))) continue;
    for await (const file of walk(dir)) {
      const code = await readFile(file, "utf8");
      const out = await transform(code, {
        loader: file.endsWith(".tsx") ? "tsx" : "ts",
        format: "esm",
        target: "node24",
        sourcefile: file,
        sourcemap: "inline",
        legalComments: "none",
      });
      const js = file.replace(/\.(ts|tsx|mts)$/, ".js");
      await writeFile(js, out.code, "utf8");
      files += 1;
      rewritten += await rewriteSpecifiers(js, warnings);
    }
  }

  let patched = 0;
  for (const rel of EXPORT_PACKAGES) {
    const file = path.join(root, rel);
    if (!(await exists(file))) continue;
    const before = await readFile(file, "utf8");
    const after = before.replace(/("\.\/[^"]+)\.ts"/g, '$1.js"');
    if (after !== before) { await writeFile(file, after, "utf8"); patched += 1; }
  }

  const entry = path.join(root, "apps/local-api/src/online/index.js");
  const ok = await exists(entry);
  console.log(JSON.stringify({
    precompile: ok ? "ok" : "missing-entry",
    root, files, specifiersRewritten: rewritten, packageJsonPatched: patched,
    entry: path.relative(root, entry),
    warnings: warnings.slice(0, 20), warningCount: warnings.length,
  }, null, 2));
  if (!ok) { console.error("precompile failed: entry not emitted"); process.exit(1); }
  if (warnings.length) { console.error(`precompile: ${warnings.length} unresolved specifier(s)`); process.exit(1); }
}

main().catch((error) => { console.error(error); process.exit(1); });
