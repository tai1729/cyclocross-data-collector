import assert from "node:assert/strict";
import test from "node:test";
import { buildArtifacts } from "../lib/artifacts.js";
import { parseRaceHtml } from "../lib/parseRaceHtml.js";
import type { MeetEntry } from "../lib/raceConfig.js";
import type { RaceResult } from "../lib/types.js";

const meet: MeetEntry = {
  meetId: "M-1",
  season: "2024-25",
  meetDate: "2024-12-15",
  series: "Test Series",
  meetName: "Test Meet",
  categories: [
    { raceId: "R-2", name: "Women", order: 2 },
    { raceId: "R-1", name: "Men", order: 1 },
  ],
};

function race(raceId: string, riders: RaceResult["riders"], raceLapNumbers?: number[]): RaceResult {
  return {
    raceId,
    raceName: raceId,
    category: raceId,
    updatedAt: "2026-01-01T00:00:00.000Z",
    riders,
    ...(raceLapNumbers ? { raceLapNumbers } : {}),
  };
}

const resultOnlyRider = {
  riderId: "RIDER-1",
  name: "Result Only",
  finalPosition: 1,
  status: "finished" as const,
  laps: [],
  dataQuality: "ok" as const,
};

const lapRider = {
  riderId: "RIDER-2",
  name: "Lap Rider",
  finalPosition: 2,
  status: "finished" as const,
  laps: [{ lapNumber: 1, lapTimeSec: 60, cumulativeTimeSec: 60, rankAtLap: 2 }],
  dataQuality: "ok" as const,
};

test("classifies result-only and lap-enabled races without inferring laps", () => {
  const result = buildArtifacts({
    meets: [{ ...meet, categories: [meet.categories[0]!] }],
    races: new Map([["R-2", race("R-2", [resultOnlyRider])]]),
  });

  assert.deepEqual(result.inventory.counts, {
    seasons: 1,
    events: 1,
    races: 1,
    resultRowsAvailable: 1,
    lapEnabledRaces: 0,
    resultOnlyRaces: 1,
    unavailableRaces: 0,
    indexedRiders: 1,
  });
  assert.equal(result.inventory.events[0]?.categories[0]?.lapDataAvailability, "result-only");
  assert.deepEqual(result.riderIndex.riders[0]?.appearances[0]?.raceId, "R-2");
});

test("sorts artifacts deterministically and bounds rider appearances", () => {
  const first = buildArtifacts({
    meets: [meet],
    races: new Map([
      ["R-2", race("R-2", [resultOnlyRider])],
      ["R-1", race("R-1", [lapRider], [1])],
    ]),
  });
  const second = buildArtifacts({
    meets: [{ ...meet, categories: [...meet.categories].reverse() }],
    races: new Map([
      ["R-1", race("R-1", [lapRider], [1])],
      ["R-2", race("R-2", [resultOnlyRider])],
    ]),
  });

  assert.deepEqual(second, first);
  assert.equal(first.inventory.events[0]?.categories[0]?.raceId, "R-1");
  assert.equal(first.inventory.counts.lapEnabledRaces, 1);
});

test("records integrity failures without discarding the normalized race", () => {
  const invalid = race("R-1", [lapRider, { ...lapRider }], [1]);
  invalid.riders[1]!.laps[0]!.lapNumber = 2;
  const result = buildArtifacts({ meets: [{ ...meet, categories: [meet.categories[1]!] }], races: new Map([["R-1", invalid]]) });

  assert.equal(result.inventory.counts.races, 1);
  assert.equal(result.inventory.counts.resultRowsAvailable, 2);
  assert.ok(result.inventory.failures.some((failure) => failure.code === "duplicate-rider-row"));
  assert.ok(result.inventory.failures.some((failure) => failure.code === "race-lap-axis-shorter-than-rider"));
});

test("records malformed and unsupported rider statuses as validation failures", () => {
  for (const [riderId, status] of [["UNSUPPORTED", "DNS"], ["MALFORMED", undefined]] as const) {
    const invalidRider = { ...resultOnlyRider, riderId, status } as unknown as RaceResult["riders"][number];
    const result = buildArtifacts({
      meets: [{ ...meet, categories: [meet.categories[1]!] }],
      races: new Map([["R-1", race("R-1", [invalidRider])]]),
    });

    assert.ok(result.inventory.failures.some((failure) => failure.code === "invalid-rider-status"));
  }
});

test("accepts annotated-rank riders and retains their official label in the rider index", () => {
  const annotatedRider = {
    ...resultOnlyRider,
    riderId: "ANNOTATED",
    name: "Annotated",
    finalPosition: 11,
    status: "annotated-rank" as const,
    officialPositionLabel: "11 (80%Out)",
  };
  const result = buildArtifacts({
    meets: [{ ...meet, categories: [meet.categories[1]!] }],
    races: new Map([[
      "R-1",
      race("R-1", [annotatedRider]),
    ]]),
  });

  assert.deepEqual(result.inventory.failures, []);
  assert.equal(result.inventory.counts.resultRowsAvailable, 1);
  assert.equal(result.riderIndex.riders[0]?.riderId, "ANNOTATED");
});

test("diagnoses malformed annotated-rank official labels", () => {
  const malformed = {
    ...resultOnlyRider,
    riderId: "ANNOTATED",
    finalPosition: 11,
    status: "annotated-rank" as const,
    officialPositionLabel: "<b>11</b>",
  };
  const result = buildArtifacts({
    meets: [{ ...meet, categories: [meet.categories[1]!] }],
    races: new Map([["R-1", race("R-1", [malformed])]]),
  });

  assert.ok(result.inventory.failures.some((failure) => failure.code === "invalid-official-position-label"));
});

test("requires an annotated official label to retain a non-empty suffix and matching rank", () => {
  for (const [label, finalPosition] of [["11", 11], ["11 ", 11], ["12 LapOut", 11]] as const) {
    const malformed = {
      ...resultOnlyRider,
      riderId: `ANNOTATED-${label}`,
      finalPosition,
      status: "annotated-rank" as const,
      officialPositionLabel: label,
    };
    const result = buildArtifacts({
      meets: [{ ...meet, categories: [meet.categories[1]!] }],
      races: new Map([["R-1", race("R-1", [malformed])]]),
    });

    assert.ok(
      result.inventory.failures.some((failure) => failure.code === "invalid-official-position-label"),
      label,
    );
  }
});

test("carries parser excluded rank diagnostics into inventory", () => {
  const parsed = parseRaceHtml(
    "R-1",
    `<h1 id="js__page_title">Diagnostic race</h1><div id="ec_name">ME1</div>
      <table class="table__laptime"><thead><tr><th>Rank</th><th>Rider</th></tr></thead><tbody>
        <tr><td class="cell__rank">1</td><td class="cell__rider">Accepted</td></tr>
        <tr><td class="cell__rank">-1</td><td class="cell__rider">Negative</td></tr>
        <tr><td class="cell__rank">LapOut</td><td class="cell__rider">No prefix</td></tr>
        <tr><td class="cell__rank">9007199254740992</td><td class="cell__rider">Overflow</td></tr>
        <tr><td class="cell__rank">1\u0000LapOut</td><td class="cell__rider">Control</td></tr>
      </tbody></table>`,
  );
  const result = buildArtifacts({
    meets: [{ ...meet, categories: [meet.categories[1]!] }],
    races: new Map([["R-1", parsed]]),
  });
  const category = result.inventory.events[0]?.categories[0];

  assert.equal(category?.excludedRowsByStatus?.["-1"], 1);
  assert.equal(category?.excludedRowsByStatus?.LapOut, 1);
  assert.equal(category?.excludedRowsByStatus?.["9007199254740992"], 1);
  assert.equal(category?.excludedRowsByStatus?.["1\u0000LapOut"], 1);
  assert.ok(result.inventory.failures.filter((failure) => failure.code === "invalid-excluded-status").length >= 4);
});

test("records duplicate meet, race, and event identities as dataset failures", () => {
  const duplicateMeet = { ...meet, categories: [{ raceId: "R-3", name: "Men", order: 1 }] };
  const duplicateEvent = {
    ...meet,
    meetId: "M-2",
    categories: [{ raceId: "R-4", name: "Men", order: 1 }],
  };
  const duplicateRace = {
    ...meet,
    meetId: "M-3",
    categories: [{ raceId: "R-3", name: "Men", order: 1 }],
  };

  const result = buildArtifacts({
    meets: [meet, duplicateMeet, duplicateEvent, duplicateRace],
    races: new Map([
      ["R-1", race("R-1", [lapRider])],
      ["R-2", race("R-2", [resultOnlyRider])],
      ["R-3", race("R-3", [resultOnlyRider])],
      ["R-4", race("R-4", [resultOnlyRider])],
    ]),
  });

  assert.ok(result.inventory.failures.some((failure) => failure.code === "duplicate-meet-id"));
  assert.ok(result.inventory.failures.some((failure) => failure.code === "duplicate-race-id"));
  assert.ok(result.inventory.failures.some((failure) => failure.code === "duplicate-event-identity"));
});

test("records noncanonical meet seasons as validation failures", () => {
  const result = buildArtifacts({
    meets: [{ ...meet, season: "2023-99", categories: [meet.categories[0]!] }],
    races: new Map([["R-2", race("R-2", [resultOnlyRider])]]),
  });

  const failure = result.inventory.failures.find((candidate) => candidate.code === "invalid-season");
  assert.deepEqual(failure, {
    stage: "validation",
    code: "invalid-season",
    message: "meet M-1 has a noncanonical season 2023-99",
    meetId: "M-1",
    season: "2023-99",
  });
  assert.equal(result.inventory.counts.resultRowsAvailable, 1);
});

test("copies excluded source status counts into inventory diagnostics", () => {
  const result = buildArtifacts({
    meets: [{ ...meet, categories: [meet.categories[0]!] }],
    races: new Map([
      [
        "R-2",
        {
          ...race("R-2", [resultOnlyRider]),
          excludedRowsByStatus: { "?": 1, DNS: 2, DSQ: 1, OTL: 1 },
        },
      ],
    ]),
  });

  assert.deepEqual(result.inventory.events[0]?.categories[0]?.excludedRowsByStatus, {
    "?": 1,
    DNS: 2,
    DSQ: 1,
    OTL: 1,
  });
});

test("accepts known numeric-less source labels as nonfatal inventory diagnostics", () => {
  const excludedRowsByStatus = {
    FIN: 1,
    "FIN/OPEN": 2,
    "DNS/OPEN": 3,
    "DNF/OPEN": 4,
  };
  const result = buildArtifacts({
    meets: [{ ...meet, categories: [meet.categories[0]!] }],
    races: new Map([
      [
        "R-2",
        {
          ...race("R-2", [resultOnlyRider]),
          excludedRowsByStatus,
        },
      ],
    ]),
  });

  assert.deepEqual(result.inventory.events[0]?.categories[0]?.excludedRowsByStatus, excludedRowsByStatus);
  assert.equal(result.inventory.failures.filter((failure) => failure.code === "invalid-excluded-status").length, 0);
  assert.equal(Object.values(result.inventory.events[0]?.categories[0]?.excludedRowsByStatus ?? {}).reduce((sum, count) => sum + count, 0), 10);
});

test("keeps unknown, malformed, control, and overflow source labels fatal", () => {
  const result = buildArtifacts({
    meets: [{ ...meet, categories: [meet.categories[0]!] }],
    races: new Map([
      [
        "R-2",
        {
          ...race("R-2", [resultOnlyRider]),
          excludedRowsByStatus: {
            UNKNOWN: 1,
            "-1": 1,
            "1\u0000LapOut": 1,
            "9007199254740992": 1,
          },
        },
      ],
    ]),
  });

  assert.equal(result.inventory.failures.filter((failure) => failure.code === "invalid-excluded-status").length, 4);
  assert.deepEqual(result.inventory.events[0]?.categories[0]?.excludedRowsByStatus, {
    "-1": 1,
    "1\u0000LapOut": 1,
    "9007199254740992": 1,
    UNKNOWN: 1,
  });
});

test("retains excluded status diagnostics for races with no accepted riders", () => {
  const result = buildArtifacts({
    meets: [{ ...meet, categories: [meet.categories[0]!] }],
    races: new Map([
      [
        "R-2",
        {
          ...race("R-2", []),
          excludedRowsByStatus: { DNS: 2, DSQ: 1, OTL: 1, "?": 1 },
        },
      ],
    ]),
  });

  assert.equal(result.inventory.events[0]?.categories[0]?.resultAvailability, "unavailable");
  assert.deepEqual(result.inventory.events[0]?.categories[0]?.excludedRowsByStatus, {
    "?": 1,
    DNS: 2,
    DSQ: 1,
    OTL: 1,
  });
});

test("records malformed excluded status diagnostics without dropping valid entries", () => {
  const result = buildArtifacts({
    meets: [{ ...meet, categories: [meet.categories[0]!] }],
    races: new Map([
      [
        "R-2",
        {
          ...race("R-2", [resultOnlyRider]),
          excludedRowsByStatus: {
            "?": 0,
            DNS: -1,
            DSQ: 1.5,
            OTL: Number.POSITIVE_INFINITY,
            UNKNOWN: 2,
          },
        },
      ],
    ]),
  });

  assert.deepEqual(result.inventory.events[0]?.categories[0]?.excludedRowsByStatus, { "?": 0, UNKNOWN: 2 });
  assert.equal(result.inventory.failures.filter((failure) => failure.code === "invalid-excluded-status").length, 1);
  assert.equal(result.inventory.failures.filter((failure) => failure.code === "invalid-excluded-status-count").length, 3);
});

test("records missing race files as unavailable sources", () => {
  const result = buildArtifacts({ meets: [{ ...meet, categories: [meet.categories[0]!] }], races: new Map() });

  assert.equal(result.inventory.counts.unavailableRaces, 1);
  assert.equal(result.inventory.events[0]?.categories[0]?.resultAvailability, "unavailable");
  assert.equal(result.inventory.failures[0]?.code, "race-file-missing");
});

test("classifies normalized races with no accepted riders as nonblocking unavailable sources", () => {
  const result = buildArtifacts({
    meets: [{ ...meet, categories: [meet.categories[0]!] }],
    races: new Map([["R-2", race("R-2", [])]]),
  });

  assert.deepEqual(result.inventory.counts, {
    seasons: 1,
    events: 1,
    races: 1,
    resultRowsAvailable: 0,
    lapEnabledRaces: 0,
    resultOnlyRaces: 0,
    unavailableRaces: 1,
    indexedRiders: 0,
  });
  assert.equal(result.inventory.events[0]?.categories[0]?.resultAvailability, "unavailable");
  assert.equal(result.inventory.events[0]?.categories[0]?.lapDataAvailability, "unavailable");
  assert.deepEqual(result.inventory.failures, []);
});
