import assert from "node:assert/strict";
import test from "node:test";
import { buildScheduleLines, getCollectionDays } from "../scripts/updateSchedule.js";

test("generates schedules for the race day and the following day", () => {
  assert.deepEqual(getCollectionDays(["2026-09-21"]), ["2026-09-21", "2026-09-22"]);
  assert.deepEqual(buildScheduleLines(["2026-09-21"]), [
    '    - cron: "7 9-23 21 9 *"\n      timezone: "Asia/Tokyo" # 2026-09-21 JST',
    '    - cron: "7 9-23 22 9 *"\n      timezone: "Asia/Tokyo" # 2026-09-22 JST',
  ]);
});

test("deduplicates consecutive race days and handles year rollover", () => {
  assert.deepEqual(getCollectionDays(["2026-12-31", "2027-01-01"]), [
    "2026-12-31",
    "2027-01-01",
    "2027-01-02",
  ]);
});
