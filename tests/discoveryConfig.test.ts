import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscoveryFailureError,
  assertSeasonResponse,
  orderCategoriesByOfficialPriority,
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

test("orders recognized classes by official priority and keeps unknown classes stable", () => {
  const categories: MeetEntry["categories"] = [
    { raceId: "redirect", name: "MM2+3", order: 0 },
    { raceId: "unknown-a", name: "Special A", order: 1 },
    { raceId: "ck1", name: "CK1", order: 2 },
    { raceId: "me1", name: "ME1", order: 3 },
    { raceId: "we2", name: "WE2", order: 4 },
    { raceId: "unknown-b", name: "Special B", order: 5 },
    { raceId: "me2", name: "ME2", order: 6 },
    { raceId: "me34", name: "ME3+4", order: 7 },
    { raceId: "we1", name: "WE1", order: 8 },
    { raceId: "mm1", name: "MM1", order: 9 },
    { raceId: "mu17", name: "MU17", order: 10 },
    { raceId: "mu15", name: "MU15", order: 11 },
    { raceId: "ck3", name: "CK3", order: 12 },
    { raceId: "ck2", name: "CK2", order: 13 },
  ];

  const ordered = orderCategoriesByOfficialPriority(categories);

  assert.deepEqual(ordered.map(({ name }) => name), [
    "ME1",
    "ME2",
    "ME3+4",
    "WE1",
    "WE2",
    "MM1",
    "MM2+3",
    "MU17",
    "MU15",
    "CK3",
    "CK2",
    "CK1",
    "Special A",
    "Special B",
  ]);
  assert.deepEqual(ordered.map(({ order }) => order), ordered.map((_, index) => index));
  assert.deepEqual(categories[0], { raceId: "redirect", name: "MM2+3", order: 0 });
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
