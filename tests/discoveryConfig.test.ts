import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscoveryFailureError,
  assertSeasonResponse,
  parseCategoryTabs,
  parseMeetCandidates,
  readSeasonOptions,
  resolveSeasonOption,
  selectDiscoveryCandidates,
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

const raceLink = (id: string, name: string) =>
  `<li><a href="https://data.cyclocross.jp/race/${id}"> ${name} </a></li>`;
const selectedTab = (name: string) => `<li class="selected"><span>${name}</span></li>`;
const tabs = (items: string, heading: string) =>
  `<ul id="cat_tab">\n${items}\n</ul><h2 id="ec_name"> ${heading} </h2>`;

const names = (categories: MeetEntry["categories"]) => categories.map(({ name }) => name);
const raceIds = (categories: MeetEntry["categories"]) => categories.map(({ raceId }) => raceId);

test("keeps the official tab order when the shown category is first", () => {
  const parsed = parseCategoryTabs(
    tabs(`${selectedTab("E1")}${raceLink("2", "E2")}${raceLink("3", "CK3")}`, "E1"),
    "1",
  );
  assert.deepEqual(names(parsed), ["E1", "E2", "CK3"]);
  assert.deepEqual(raceIds(parsed), ["1", "2", "3"]);
  assert.deepEqual(parsed.map(({ order }) => order), [0, 1, 2]);
});

test("places the shown category at its tab position when it is in the middle", () => {
  const parsed = parseCategoryTabs(
    tabs(`${raceLink("10", "ME1")}${selectedTab("MM2+3")}${raceLink("12", "CK1")}`, "MM2+3"),
    "11",
  );
  assert.deepEqual(names(parsed), ["ME1", "MM2+3", "CK1"]);
  assert.deepEqual(raceIds(parsed), ["10", "11", "12"]);
});

test("falls back to the shown category first when no tab is selected or there are no tabs", () => {
  const noSelected = parseCategoryTabs(
    tabs(`${raceLink("20", "A")}${raceLink("21", "B")}`, "Z"),
    "19",
  );
  assert.deepEqual(raceIds(noSelected), ["19", "20", "21"]);
  assert.equal(noSelected[0].name, "Z");

  const noTabs = parseCategoryTabs('<h2 id="ec_name">Only</h2>', "30");
  assert.deepEqual(noTabs, [{ raceId: "30", name: "Only", order: 0 }]);
});

test("ignores duplicate race links and skips the selected tab without a redirect", () => {
  const duplicated = parseCategoryTabs(
    tabs(`${raceLink("40", "E1")}${raceLink("40", "E1 again")}${raceLink("41", "E2")}`, "E1"),
    null,
  );
  assert.deepEqual(raceIds(duplicated), ["40", "41"]);

  const withoutRedirect = parseCategoryTabs(
    tabs(`${selectedTab("E1")}${raceLink("51", "E2")}`, "E1"),
    null,
  );
  assert.deepEqual(raceIds(withoutRedirect), ["51"]);
  assert.deepEqual(withoutRedirect.map(({ order }) => order), [0]);
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

test("re-reads known meets from the last 14 days so reissued raceIds are noticed", () => {
  const candidate = (meetId: string, meetDate: string) => ({ meetId, meetDate, series: "test", meetName: meetId });
  const candidates = [
    candidate("new", "2026-11-20"),
    candidate("known-recent", "2026-11-23"),
    candidate("known-edge", "2026-11-14"),
    candidate("known-old", "2026-11-13"),
    candidate("known-future", "2026-12-05"),
  ];
  const known = new Set(["known-recent", "known-edge", "known-old", "known-future"]);
  const selected = selectDiscoveryCandidates(candidates, known, {
    season: null,
    start: "2026-09-29",
    end: "2027-01-27",
    force: false,
    today: "2026-11-28",
  });
  assert.deepEqual(selected.map(({ meetId }) => meetId), ["new", "known-recent", "known-edge"]);
});
