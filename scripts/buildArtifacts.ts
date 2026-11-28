import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  INVENTORY_JSON_PATH,
  MEETS_JSON_PATH,
  RIDER_INDEX_DIR,
  RIDER_INDEX_JSON_PATH,
  readJson,
  writeJson,
  type MeetEntry,
} from "../lib/raceConfig.js";
import { buildArtifacts, type InventoryFailure, type RiderIndexBySeason } from "../lib/artifacts.js";
import type { RaceResult } from "../lib/types.js";

const DATA_DIR = path.join(import.meta.dirname, "..", "data");

/** シーズンごとの選手索引を書く。容量を抑えるため各シーズンは改行なしのJSONにする。 */
async function writeRiderIndexBySeason({ manifest, seasons }: RiderIndexBySeason): Promise<void> {
  await mkdir(RIDER_INDEX_DIR, { recursive: true });
  const expected = new Set(["manifest.json", ...manifest.seasons.map((season) => `${season}.json`)]);
  for (const name of await readdir(RIDER_INDEX_DIR)) {
    if (name.endsWith(".json") && !expected.has(name)) await rm(path.join(RIDER_INDEX_DIR, name));
  }
  for (const season of manifest.seasons) {
    await writeFile(path.join(RIDER_INDEX_DIR, `${season}.json`), `${JSON.stringify(seasons[season])}
`, "utf-8");
  }
  await writeJson(path.join(RIDER_INDEX_DIR, "manifest.json"), manifest);
}

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
  // 1ファイルの選手索引は GitHub の容量の警告を超えるため書かない。viewer は rider-index/ を読む
  await rm(RIDER_INDEX_JSON_PATH, { force: true });
  await writeRiderIndexBySeason(artifacts.riderIndexBySeason);

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
