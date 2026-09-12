import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscoveryFailureError,
  assertSeasonResponse,
  parseMeetCandidates,
  readSeasonOptions,
  resolveSeasonOption,
} from "../scripts/discover.js";
import {
  isCanonicalSeason,
  mergeMeetEntries,
  mergeRaceEntries,
  seasonForDate,
  type MeetEntry,
} from "../lib/raceConfig.js";

const selector = (options: string) => `<select id="season_list">${options}</select>`;

test("resolves one official season label to its option value", () => {
  const html = selector('<option value="14">2023-24</option><option value="15">2024-25</option>');

  assert.deepEqual(resolveSeasonOption(html, "2023-24"), { label: "2023-24", value: "14" });
  assert.deepEqual(readSeasonOptions(html), [
    { label: "2023-24", value: "14" },
    { label: "2024-25", value: "15" },
  ]);
});

test("rejects missing, duplicate, empty-value, and renamed season options", () => {
  const cases = [
    [selector('<option value="15">2024-25</option>'), "2023-24", "season-not-found"],
    [selector('<option value="14">2023-24</option><option value="14b">2023-24</option>'), "2023-24", "season-duplicate"],
    [selector('<option value="">2023-24</option>'), "2023-24", "season-value-missing"],
    [selector('<option value="14">2023/24</option>'), "2023-24", "season-not-found"],
  ] as const;

  for (const [html, season, code] of cases) {
    assert.throws(
      () => resolveSeasonOption(html, season),
      (error: unknown) => error instanceof DiscoveryFailureError && error.failure.code === code,
    );
  }
});

test("rejects a selected response whose canonical heading is missing or duplicated", () => {
  assert.doesNotThrow(() => assertSeasonResponse("<h2>2023-24</h2>", "2023-24"));
  assert.throws(
    () => assertSeasonResponse("<h2>2024-25</h2>", "2023-24"),
    (error: unknown) => error instanceof DiscoveryFailureError && error.failure.code === "season-response-mismatch",
  );
  assert.throws(
    () => assertSeasonResponse("<h2>2023-24</h2><h2>2023-24</h2>", "2023-24"),
    (error: unknown) => error instanceof DiscoveryFailureError && error.failure.code === "season-response-mismatch",
  );
});

test("filters explicit-season candidates by event-date season and records mismatches", () => {
  const html = `
    <table><tbody>
      <tr><td class="resuts_date">2023-10-08</td><td class="results_area"><a>Series</a></td><td class="resuts_race"><a href="/meet/A-1">A</a></td></tr>
      <tr><td class="resuts_date">2024-07-07</td><td class="results_area"><a>Series</a></td><td class="resuts_race"><a href="/meet/B-1">B</a></td></tr>
    </tbody></table>`;

  const result = parseMeetCandidates(html, "2023-24");
  assert.deepEqual(result.candidates.map((candidate) => candidate.meetId), ["A-1"]);
  assert.equal(result.failures[0]?.code, "event-date-mismatch");
  assert.equal(result.failures[0]?.meetId, "B-1");
});

test("merges meet and race inventories by stable ID deterministically", () => {
  const meet = (meetId: string, meetDate: string): MeetEntry => ({
    meetId,
    season: "2023-24",
    meetDate,
    series: "S",
    meetName: meetId,
    categories: [],
  });

  const meets = mergeMeetEntries([meet("same", "2023-10-01")], [meet("same", "2023-10-02"), meet("new", "2023-10-01")]);
  assert.deepEqual(meets.map((entry) => [entry.meetId, entry.meetDate]), [
    ["same", "2023-10-02"],
    ["new", "2023-10-01"],
  ]);
  assert.deepEqual(mergeMeetEntries(meets, []), meets);

  const races = mergeRaceEntries(
    [{ raceId: "2", meetDate: "2023-10-02" }],
    [{ raceId: "2", meetDate: "2023-10-03" }, { raceId: "1", meetDate: "2023-10-01" }],
  );
  assert.deepEqual(races, [
    { raceId: "1", meetDate: "2023-10-01" },
    { raceId: "2", meetDate: "2023-10-03" },
  ]);
  assert.deepEqual(mergeRaceEntries(races, []), races);
});

test("uses canonical season labels derived from event dates", () => {
  assert.equal(isCanonicalSeason("2023-24"), true);
  assert.equal(isCanonicalSeason("2023-25"), false);
  assert.equal(seasonForDate("2023-07-01"), "2023-24");
  assert.equal(seasonForDate("2024-06-30"), "2023-24");
});
