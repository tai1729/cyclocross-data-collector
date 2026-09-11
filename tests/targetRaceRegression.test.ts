import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { RaceResult } from "../lib/types.js";

const dataDirectory = fileURLToPath(new URL("../data/", import.meta.url));

async function readRace(raceId: string): Promise<RaceResult> {
  return JSON.parse(
    await readFile(`${dataDirectory}race-${raceId}.json`, "utf8"),
  ) as RaceResult;
}

test("CCS-256-003 retains the official 11-lap race axis and final checkpoint", async () => {
  const race = await readRace("27834");
  const rider = race.riders.find((item) => item.riderId === "KNS-167-0031");

  assert.deepEqual(race.raceLapNumbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(rider?.laps.at(-1)?.lapNumber, 11);
});

test("KNS-256-010 retains the official 11-lap axis when measured data starts at lap 2", async () => {
  const race = await readRace("27770");
  const rider = race.riders.find((item) => item.riderId === "CCM-000-1602");

  assert.deepEqual(race.raceLapNumbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(rider?.laps[0]?.lapNumber, 2);
  assert.equal(rider?.laps.at(-1)?.lapNumber, 11);
});

test("KNS-256-011 retains both first comparison lap values for the gap chart", async () => {
  const race = await readRace("27160");
  const leader = race.riders.find((item) => item.riderId === "KNS-000-1252");
  const second = race.riders.find((item) => item.riderId === "KNS-000-2145");

  assert.deepEqual(race.raceLapNumbers, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(leader?.laps.find((lap) => lap.lapNumber === 2)?.cumulativeTimeSec, 872.2);
  assert.equal(second?.laps.find((lap) => lap.lapNumber === 2)?.cumulativeTimeSec, 873.1);
});
