import { isCanonicalSeason, type MeetEntry } from "./raceConfig.js";
import type { RaceResult, Rider } from "./types.js";

export const ARTIFACT_VERSION = 1 as const;
export const RIDER_INDEX_APPEARANCE_LIMIT = 6;

const SUPPORTED_EXCLUDED_SOURCE_STATUSES = new Set([
  "?",
  "DNS",
  "DSQ",
  "OTL",
  "FIN",
  "FIN/OPEN",
  "DNS/OPEN",
  "DNF/OPEN",
]);
const UNSAFE_OFFICIAL_POSITION_LABEL = /[\p{Cc}\p{Cf}\u2028\u2029\ufffd<>]/u;

export type Availability = "available" | "unavailable" | "invalid-data";
export type LapAvailability = "enabled" | "result-only" | "unavailable";

export interface InventoryFailure {
  raceId?: string;
  meetId?: string;
  season?: string;
  stage: "discovery" | "collection" | "validation";
  code: string;
  message: string;
}

export interface InventoryCategory {
  raceId: string;
  name: string;
  order: number;
  resultAvailability: Availability;
  lapDataAvailability: LapAvailability;
  resultRows: number;
  lapRecords: number;
  excludedRowsByStatus?: Record<string, number>;
}

export interface InventoryEvent {
  meetId: string;
  season: string;
  series: string;
  meetDate: string;
  meetName: string;
  categories: InventoryCategory[];
}

export interface InventoryCounts {
  seasons: number;
  events: number;
  races: number;
  resultRowsAvailable: number;
  lapEnabledRaces: number;
  resultOnlyRaces: number;
  unavailableRaces: number;
  indexedRiders: number;
}

export interface InventoryArtifact {
  version: typeof ARTIFACT_VERSION;
  source: "https://data.cyclocross.jp";
  counts: InventoryCounts;
  events: InventoryEvent[];
  failures: InventoryFailure[];
}

export interface RiderAppearance {
  meetId: string;
  meetName: string;
  meetDate: string;
  season: string;
  series: string;
  raceId: string;
  categoryId: string;
  categoryName: string;
  categoryOrder: number;
  riderName: string;
  riderDataQuality: Rider["dataQuality"];
}

export interface RiderIndexEntry {
  riderId: string;
  name: string;
  dataQuality: Rider["dataQuality"];
  totalAppearances: number;
  appearances: Omit<RiderAppearance, "categoryOrder" | "riderName" | "riderDataQuality">[];
}

export interface RiderIndexArtifact {
  version: typeof ARTIFACT_VERSION;
  scannedSources: number;
  failedSources: number;
  totalSources: number;
  riders: RiderIndexEntry[];
}

export interface ArtifactInput {
  meets: readonly MeetEntry[];
  races: ReadonlyMap<string, RaceResult | undefined>;
  failures?: readonly InventoryFailure[];
}

function isFinitePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function officialLabelRank(label: string): number | null {
  const match = label.trim().match(/^(\d+)(.*)$/u);
  if (!match || match[2]?.length === 0) return null;
  const rank = Number(match[1]);
  return isFinitePositiveInteger(rank) ? rank : null;
}

function hasUsableLap(rider: Rider): boolean {
  return rider.laps.some(
    (lap) =>
      isFinitePositiveInteger(lap.lapNumber) &&
      Number.isFinite(lap.lapTimeSec) &&
      lap.lapTimeSec > 0 &&
      Number.isFinite(lap.cumulativeTimeSec) &&
      lap.cumulativeTimeSec > 0,
  );
}

function validateRace(
  race: RaceResult,
  meet: MeetEntry,
  category: MeetEntry["categories"][number],
): InventoryFailure[] {
  const failures: InventoryFailure[] = [];
  const failureContext = { meetId: meet.meetId, season: meet.season, raceId: category.raceId };
  const riderIds = new Set<string>();
  const riderPositions = new Set<number>();
  let maximumMeasuredLap = 0;

  for (const rider of race.riders) {
    if (
      rider.status !== "finished" &&
      rider.status !== "dnf" &&
      rider.status !== "annotated-rank"
    ) {
      failures.push({
        ...failureContext,
        stage: "validation",
        code: "invalid-rider-status",
        message: `rider ${rider.riderId} has an unsupported status`,
      });
    }

    const label = typeof rider.officialPositionLabel === "string"
      ? rider.officialPositionLabel.trim()
      : null;
    const unsafeLabel = typeof rider.officialPositionLabel === "string" &&
      UNSAFE_OFFICIAL_POSITION_LABEL.test(rider.officialPositionLabel);
    if (rider.status === "annotated-rank" && (label === null || label.length === 0)) {
      failures.push({
        ...failureContext,
        stage: "validation",
        code: "missing-official-position-label",
        message: `rider ${rider.riderId} is annotated but has no official position label`,
      });
    } else if (
      rider.status === "annotated-rank" &&
      (unsafeLabel || label === null || officialLabelRank(label) !== rider.finalPosition)
    ) {
      failures.push({
        ...failureContext,
        stage: "validation",
        code: "invalid-official-position-label",
        message: `rider ${rider.riderId} has an invalid official position label`,
      });
    } else if (
      rider.officialPositionLabel !== undefined &&
      (label === null || label.length === 0 || unsafeLabel)
    ) {
      failures.push({
        ...failureContext,
        stage: "validation",
        code: "invalid-official-position-label",
        message: `rider ${rider.riderId} has an invalid official position label`,
      });
    }

    if (riderIds.has(rider.riderId)) {
      failures.push({
        ...failureContext,
        stage: "validation",
        code: "duplicate-rider-row",
        message: `rider ${rider.riderId} appears more than once`,
      });
    }
    riderIds.add(rider.riderId);

    if (!isFinitePositiveInteger(rider.finalPosition) || riderPositions.has(rider.finalPosition)) {
      failures.push({
        ...failureContext,
        stage: "validation",
        code: "invalid-rank",
        message: `rider ${rider.riderId} has an invalid or duplicate final position`,
      });
    }
    riderPositions.add(rider.finalPosition);

    const lapNumbers = new Set<number>();
    for (const lap of rider.laps) {
      if (
        !isFinitePositiveInteger(lap.lapNumber) ||
        !Number.isFinite(lap.cumulativeTimeSec) ||
        lap.cumulativeTimeSec <= 0 ||
        !Number.isFinite(lap.rankAtLap) ||
        lap.rankAtLap <= 0 ||
        !Number.isFinite(lap.lapTimeSec) ||
        lap.lapTimeSec < 0 ||
        lapNumbers.has(lap.lapNumber)
      ) {
        failures.push({
          ...failureContext,
          stage: "validation",
          code: lapNumbers.has(lap.lapNumber) ? "duplicate-lap-number" : "invalid-lap-record",
          message: `rider ${rider.riderId} contains an invalid or duplicate lap record`,
        });
      }
      lapNumbers.add(lap.lapNumber);
      if (isFinitePositiveInteger(lap.lapNumber)) maximumMeasuredLap = Math.max(maximumMeasuredLap, lap.lapNumber);
    }
  }

  if (race.raceLapNumbers) {
    let previous = 0;
    for (const lapNumber of race.raceLapNumbers) {
      if (!isFinitePositiveInteger(lapNumber) || lapNumber <= previous) {
        failures.push({
          ...failureContext,
          stage: "validation",
          code: "invalid-race-lap-axis",
          message: "race lap axis must contain strictly increasing positive integers",
        });
        break;
      }
      previous = lapNumber;
    }
    const raceTotalLaps = race.raceLapNumbers.at(-1) ?? 0;
    if (raceTotalLaps < maximumMeasuredLap) {
      failures.push({
        ...failureContext,
        stage: "validation",
        code: "race-lap-axis-shorter-than-rider",
        message: "race lap axis is shorter than a rider's measured laps",
      });
    }
  }

  return failures;
}

function compareAppearance(left: RiderAppearance, right: RiderAppearance): number {
  return (
    right.meetDate.localeCompare(left.meetDate) ||
    left.categoryOrder - right.categoryOrder ||
    left.meetId.localeCompare(right.meetId) ||
    left.categoryId.localeCompare(right.categoryId)
  );
}

function sortFailures(failures: readonly InventoryFailure[]): InventoryFailure[] {
  return [...failures].sort((left, right) =>
    [left.stage, left.code, left.season ?? "", left.meetId ?? "", left.raceId ?? "", left.message]
      .join("\u0000")
      .localeCompare(
        [right.stage, right.code, right.season ?? "", right.meetId ?? "", right.raceId ?? "", right.message]
          .join("\u0000"),
      ),
  );
}

function duplicateFailure(
  code: string,
  message: string,
  meet: MeetEntry,
  raceId?: string,
): InventoryFailure {
  return {
    stage: "validation",
    code,
    message,
    meetId: meet.meetId,
    season: meet.season,
    ...(raceId ? { raceId } : {}),
  };
}

function validateDataset(meets: readonly MeetEntry[]): InventoryFailure[] {
  const failures: InventoryFailure[] = [];
  const meetIds = new Set<string>();
  const raceIds = new Map<string, MeetEntry>();
  const eventIdentities = new Set<string>();

  for (const meet of meets) {
    if (!isCanonicalSeason(meet.season)) {
      failures.push({
        stage: "validation",
        code: "invalid-season",
        message: `meet ${meet.meetId} has a noncanonical season ${meet.season}`,
        meetId: meet.meetId,
        season: meet.season,
      });
    }

    if (meetIds.has(meet.meetId)) {
      failures.push(
        duplicateFailure(
          "duplicate-meet-id",
          `meet ID ${meet.meetId} appears more than once`,
          meet,
        ),
      );
    }
    meetIds.add(meet.meetId);

    const eventIdentity = [meet.season, meet.meetDate, meet.series, meet.meetName].join("\u0000");
    if (eventIdentities.has(eventIdentity)) {
      failures.push(
        duplicateFailure(
          "duplicate-event-identity",
          `event identity ${eventIdentity.replaceAll("\u0000", " / ")} appears more than once`,
          meet,
        ),
      );
    }
    eventIdentities.add(eventIdentity);

    for (const category of meet.categories) {
      const previousMeet = raceIds.get(category.raceId);
      if (previousMeet) {
        failures.push(
          duplicateFailure(
            "duplicate-race-id",
            `race/category ID ${category.raceId} appears in meets ${previousMeet.meetId} and ${meet.meetId}`,
            meet,
            category.raceId,
          ),
        );
      } else {
        raceIds.set(category.raceId, meet);
      }
    }
  }

  return failures;
}

function validateExcludedStatusCounts(
  counts: unknown,
  meet: MeetEntry,
  category: MeetEntry["categories"][number],
): { counts?: Record<string, number>; failures: InventoryFailure[] } {
  if (counts === undefined) return { failures: [] };

  const failureContext = { meetId: meet.meetId, season: meet.season, raceId: category.raceId };
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) {
    return {
      failures: [
        {
          ...failureContext,
          stage: "validation",
          code: "invalid-excluded-status-diagnostics",
          message: "excluded row status diagnostics must be an object",
        },
      ],
    };
  }

  const validCounts: Array<[string, number]> = [];
  const failures: InventoryFailure[] = [];
  for (const [status, count] of Object.entries(counts)) {
    if (!SUPPORTED_EXCLUDED_SOURCE_STATUSES.has(status)) {
      failures.push({
        ...failureContext,
        stage: "validation",
        code: "invalid-excluded-status",
        message: `excluded row status ${status} is unsupported`,
      });
    }

    if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
      failures.push({
        ...failureContext,
        stage: "validation",
        code: "invalid-excluded-status-count",
        message: `excluded row status ${status} has an invalid count`,
      });
      continue;
    }

    // Preserve every well-formed source label in the inventory. Known buckets
    // retain their legacy behavior; unknown/malformed labels remain visible
    // diagnostics instead of disappearing at the artifact boundary.
    validCounts.push([status, count]);
  }

  return {
    failures,
    ...(validCounts.length > 0
      ? { counts: Object.fromEntries(validCounts.sort(([left], [right]) => left.localeCompare(right))) }
      : {}),
  };
}

export function buildArtifacts(input: ArtifactInput): {
  inventory: InventoryArtifact;
  riderIndex: RiderIndexArtifact;
} {
  const failures = [...(input.failures ?? []), ...validateDataset(input.meets)];
  const indexed = new Map<string, { entry: Omit<RiderIndexEntry, "appearances">; appearances: RiderAppearance[] }>();
  let resultRowsAvailable = 0;
  let lapEnabledRaces = 0;
  let resultOnlyRaces = 0;
  let unavailableRaces = 0;
  let totalSources = 0;

  const events = [...input.meets]
    .sort((left, right) => right.meetDate.localeCompare(left.meetDate) || left.meetId.localeCompare(right.meetId))
    .map((meet): InventoryEvent => {
      const categories = [...meet.categories]
        .sort((left, right) => left.order - right.order || left.raceId.localeCompare(right.raceId))
        .map((category): InventoryCategory => {
          totalSources += 1;
          const race = input.races.get(category.raceId);
          const diagnostics = validateExcludedStatusCounts(race?.excludedRowsByStatus, meet, category);
          failures.push(...diagnostics.failures);
          const excludedRowsByStatus = diagnostics.counts;
          if (!race || race.riders.length === 0) {
            unavailableRaces += 1;
            if (!race) {
              failures.push({
                stage: "collection",
                code: "race-file-missing",
                message: "normalized race file is missing",
                meetId: meet.meetId,
                season: meet.season,
                raceId: category.raceId,
              });
            }
            return {
              ...category,
              resultAvailability: "unavailable",
              lapDataAvailability: "unavailable",
              resultRows: 0,
              lapRecords: 0,
              ...(excludedRowsByStatus ? { excludedRowsByStatus } : {}),
            };
          }

          const lapRecords = race.riders.reduce((sum, rider) => sum + rider.laps.length, 0);
          failures.push(...validateRace(race, meet, category));
          const lapEnabled = race.riders.some(hasUsableLap);
          if (lapEnabled) lapEnabledRaces += 1;
          else resultOnlyRaces += 1;
          resultRowsAvailable += race.riders.length;

          for (const rider of race.riders) {
            if (!rider.riderId.trim()) {
              failures.push({
                stage: "validation",
                code: "empty-rider-id",
                message: "rider ID is empty",
                meetId: meet.meetId,
                season: meet.season,
                raceId: category.raceId,
              });
              continue;
            }
            const appearance: RiderAppearance = {
              meetId: meet.meetId,
              meetName: meet.meetName,
              meetDate: meet.meetDate,
              season: meet.season,
              series: meet.series,
              raceId: race.raceId,
              categoryId: category.raceId,
              categoryName: category.name,
              categoryOrder: category.order,
              riderName: rider.name,
              riderDataQuality: rider.dataQuality,
            };
            const current = indexed.get(rider.riderId);
            if (!current) {
              indexed.set(rider.riderId, {
                entry: {
                  riderId: rider.riderId,
                  name: rider.name,
                  dataQuality: rider.dataQuality,
                  totalAppearances: 1,
                },
                appearances: [appearance],
              });
            } else {
              current.entry.totalAppearances += 1;
              current.appearances.push(appearance);
            }
          }

          return {
            ...category,
            resultAvailability: "available",
            lapDataAvailability: lapEnabled ? "enabled" : "result-only",
            resultRows: race.riders.length,
            lapRecords,
            ...(excludedRowsByStatus ? { excludedRowsByStatus } : {}),
          };
        });
      return { ...meet, categories };
    });

  const riders = [...indexed.values()]
    .map(({ entry, appearances }) => {
      const ordered = [...appearances].sort(compareAppearance);
      const newest = ordered[0];
      return {
        ...entry,
        name: newest?.riderName ?? entry.name,
        dataQuality: newest?.riderDataQuality ?? entry.dataQuality,
        appearances: ordered.slice(0, RIDER_INDEX_APPEARANCE_LIMIT).map(({ categoryOrder, riderName, riderDataQuality, ...appearance }) => appearance),
      };
    })
    .sort((left, right) => left.riderId.localeCompare(right.riderId));

  const sortedFailures = sortFailures(failures);
  return {
    inventory: {
      version: ARTIFACT_VERSION,
      source: "https://data.cyclocross.jp",
      counts: {
        seasons: new Set(events.map((event) => event.season)).size,
        events: events.length,
        races: totalSources,
        resultRowsAvailable,
        lapEnabledRaces,
        resultOnlyRaces,
        unavailableRaces,
        indexedRiders: riders.length,
      },
      events,
      failures: sortedFailures,
    },
    riderIndex: {
      version: ARTIFACT_VERSION,
      scannedSources: totalSources - unavailableRaces,
      failedSources: unavailableRaces,
      totalSources,
      riders,
    },
  };
}
