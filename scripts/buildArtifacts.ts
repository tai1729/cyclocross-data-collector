import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  INVENTORY_JSON_PATH,
  MEETS_JSON_PATH,
  RIDER_INDEX_JSON_PATH,
  readJson,
  writeJson,
  type MeetEntry,
} from "../lib/raceConfig.js";
import { buildArtifacts, type InventoryFailure } from "../lib/artifacts.js";
import type { RaceResult } from "../lib/types.js";

const DATA_DIR = path.join(import.meta.dirname, "..", "data");

async function readRace(raceId: string): Promise<RaceResult | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(DATA_DIR, `race-${raceId}.json`), "utf8")) as RaceResult;
    if (value.raceId !== raceId || !Array.isArray(value.riders)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export async function buildAndWriteArtifacts(options: { strict?: boolean } = {}): Promise<{
  failures: InventoryFailure[];
  counts: ReturnType<typeof buildArtifacts>["inventory"]["counts"];
}> {
  const meets = await readJson<MeetEntry[]>(MEETS_JSON_PATH);
  const races = new Map<string, RaceResult | undefined>();
  for (const meet of meets) {
    for (const category of meet.categories) {
      const race = await readRace(category.raceId);
      races.set(category.raceId, race);
    }
  }

  const artifacts = buildArtifacts({ meets, races });
  await writeJson(INVENTORY_JSON_PATH, artifacts.inventory);
  await writeJson(RIDER_INDEX_JSON_PATH, artifacts.riderIndex);

  if (options.strict && artifacts.inventory.failures.length > 0) {
    throw new Error(`${artifacts.inventory.failures.length} dataset failure(s) recorded in inventory.json`);
  }

  return { failures: artifacts.inventory.failures, counts: artifacts.inventory.counts };
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isMainModule()) {
  buildAndWriteArtifacts({ strict: process.argv.includes("--strict") })
    .then(({ counts, failures }) => {
      console.log(`[OK] inventory: ${counts.events} events / ${counts.races} races / ${counts.indexedRiders} riders`);
      if (failures.length > 0) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
