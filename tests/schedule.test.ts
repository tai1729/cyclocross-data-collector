import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseCalendarDate } from "../scripts/updateSchedule.js";

test("parses the official calendar date text", () => {
  assert.equal(parseCalendarDate("2026. 9.21"), "2026-09-21");
  assert.equal(parseCalendarDate("開催日: 2026.10. 3"), "2026-10-03");
  assert.equal(parseCalendarDate("date unavailable"), null);
});

test("the monthly updater does not rewrite the collection workflow", async () => {
  const source = await readFile(
    new URL("../scripts/updateSchedule.ts", import.meta.url),
    "utf8",
  );
  const workflow = await readFile(
    new URL("../.github/workflows/collect.yml", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /\.github[\\/]workflows[\\/]collect\.yml/);
  assert.doesNotMatch(workflow, /^  schedule:/m);
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /^  queue: max$/m);
});
