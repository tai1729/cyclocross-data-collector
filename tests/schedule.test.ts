import assert from "node:assert/strict";
import test from "node:test";
import { buildScheduleLines } from "../scripts/updateSchedule.js";

test("generates race-day schedules seven minutes after each hour", () => {
  assert.deepEqual(buildScheduleLines(["2026-09-21"]), [
    '    - cron: "7 9-23 21 9 *"\n      timezone: "Asia/Tokyo" # 2026-09-21 JST',
  ]);
});
