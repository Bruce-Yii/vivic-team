import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { formatTokenSummary, summarizeTokenLog } from "../src/observability/tokenSummary.js";

/**
 * Token usage for one UTC day of intent telemetry.
 *
 *   pnpm --filter @vivic/local-api token:summary -- --dir /var/lib/vivic/telemetry --date 2026-11-04
 *   pnpm --filter @vivic/local-api token:summary -- --file ./intent-2026-11-04.jsonl --json
 *
 * With no `--dir`, `VIVIC_TELEMETRY_DIR` (the same variable the writer uses) is
 * read. The rotated `.1` file is included so a >50MB day is not half-counted.
 * Only the numbers already on the line are aggregated: no prompt, completion or
 * credential is read or printed.
 */
interface Options {
  dir?: string;
  file?: string;
  date?: string;
  json: boolean;
}

const parseArgs = (argv: string[]): Options => {
  const options: Options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--dir") options.dir = argv[++index];
    else if (arg === "--file") options.file = argv[++index];
    else if (arg === "--date") options.date = argv[++index];
  }
  return options;
};

const usage = "用法：token-summary [--dir <遥测目录> | --file <jsonl>] [--date YYYY-MM-DD] [--json]";

const main = (): number => {
  const options = parseArgs(process.argv.slice(2));
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const dir = options.dir ?? process.env.VIVIC_TELEMETRY_DIR?.trim();
  const files = options.file ? [options.file]
    : dir ? [join(dir, `intent-${date}.jsonl`), join(dir, `intent-${date}.jsonl.1`)]
      : [];
  if (!files.length) {
    process.stderr.write(`未指定日志：${usage}\n`);
    return 1;
  }
  const existing = files.filter(file => existsSync(file));
  if (!existing.length) {
    process.stderr.write(`没有找到 ${files[0]}\n`);
    return 1;
  }
  const lines = existing.flatMap(file => readFileSync(file, "utf8").split(/\r?\n/u));
  const summary = summarizeTokenLog(lines);
  const source = existing.length === 1 ? existing[0]! : existing.map(file => file.replace(/^.*[\\/]/u, "")).join(" + ");
  process.stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatTokenSummary(summary, source)}\n`);
  return 0;
};

process.exitCode = main();
