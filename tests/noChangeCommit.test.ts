import assert from "node:assert/strict";
import test from "node:test";
import { hasSameRaceContent } from "../scripts/collect.js";
import { normalizeFailures } from "../scripts/discover.js";
import type { DiscoveryFailure } from "../lib/raceConfig.js";
import type { RaceResult } from "../lib/types.js";

function race(updatedAt: string, lapTimeSec = 300): RaceResult {
  return {
    raceId: "29000",
    raceName: "2026-11-22 テスト大会",
    category: "C1",
    updatedAt,
    riders: [
      {
        riderId: "r1",
        name: "選手A",
        team: "",
        finalPosition: 1,
        status: "finished",
        dataQuality: "ok",
        laps: [{ lapNumber: 1, lapTimeSec, cumulativeTimeSec: lapTimeSec, rankAtLap: 1 }],
      },
    ],
  } as unknown as RaceResult;
}

const serialize = (value: RaceResult) => `${JSON.stringify(value, null, 2)}\n`;

test("re-collecting identical race content is detected as unchanged even when updatedAt differs", () => {
  const stored = serialize(race("2026-11-24T00:00:00.000Z"));
  assert.equal(hasSameRaceContent(stored, race("2026-11-24T01:00:00.000Z")), true);
});

test("a change in race content is detected so the file and updatedAt are rewritten", () => {
  const stored = serialize(race("2026-11-24T00:00:00.000Z"));
  assert.equal(hasSameRaceContent(stored, race("2026-11-24T01:00:00.000Z", 301)), false);
});

test("a missing or unreadable stored race is treated as changed", () => {
  const next = race("2026-11-24T01:00:00.000Z");
  assert.equal(hasSameRaceContent(null, next), false);
  assert.equal(hasSameRaceContent("{not json", next), false);
  assert.equal(hasSameRaceContent("[]", next), false);
});

test("repeated discovery failures are kept once regardless of key order", () => {
  const a: DiscoveryFailure = {
    stage: "meet",
    code: "categories-missing",
    message: "event CXK-267-001 did not expose any race categories",
    meetId: "CXK-267-001",
    meetDate: "2026-09-21",
    season: "2026-27",
  };
  const sameWithOtherOrder = {
    season: "2026-27",
    meetDate: "2026-09-21",
    meetId: "CXK-267-001",
    message: "event CXK-267-001 did not expose any race categories",
    code: "categories-missing",
    stage: "meet",
    sourceSeasonValue: undefined,
  } as DiscoveryFailure;
  const other: DiscoveryFailure = { ...a, meetId: "NGT-267-001", message: "event NGT-267-001 did not expose any race categories" };

  const result = normalizeFailures([a, other, sameWithOtherOrder, a, other]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((failure) => failure.meetId), ["CXK-267-001", "NGT-267-001"]);
  assert.deepEqual(normalizeFailures(result), result);
});
