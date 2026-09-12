import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { getSeasonArgument } from "../scripts/collect.js";

const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

test("rejects a non-canonical season before collecting by date range", () => {
  assert.throws(
    () => execFileSync(process.execPath, [tsx, "scripts/collect.ts", "--season", "2023-99"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
    (error: unknown) => {
      assert.ok(error && typeof error === "object");
      const result = error as { status?: number; stderr?: string };
      assert.equal(result.status, 1);
      assert.match(result.stderr ?? "", /canonical YYYY-YY/);
      return true;
    },
  );
});

test("rejects --season with no value", () => {
  assert.throws(
    () => getSeasonArgument(["node", "scripts/collect.ts", "--season"]),
    /--season requires a non-empty YYYY-YY value/,
  );
});

test("rejects --season with an empty value", () => {
  assert.throws(
    () => getSeasonArgument(["node", "scripts/collect.ts", "--season", ""]),
    /--season requires a non-empty YYYY-YY value/,
  );
});

test("leaves season filtering absent for default collection", () => {
  assert.equal(getSeasonArgument(["node", "scripts/collect.ts"]), null);
});
