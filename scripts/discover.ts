import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { pathToFileURL } from "node:url";
import {
  MEETS_JSON_PATH,
  KNOWN_MEETS_JSON_PATH,
  RACES_JSON_PATH,
  DISCOVERY_FAILURES_JSON_PATH,
  addDays,
  fileExists,
  getJstDate,
  isCanonicalSeason,
  loadKnownMeets,
  loadMeetEntries,
  loadRaceEntries,
  mergeMeetEntries,
  mergeRaceEntries,
  readJson,
  seasonForDate,
  writeJson,
  type DiscoveryFailure,
  type MeetEntry,
  type RaceEntry,
} from "../lib/raceConfig.js";
import { writeSiteMetadata } from "../lib/siteMetadata.js";

export const MEET_LIST_URL = "https://data.cyclocross.jp/meet";
const MAX_CONCURRENCY = 5;
const DISCOVERY_WINDOW_DAYS = 60;

export interface MeetCandidate {
  meetId: string;
  meetDate: string;
  series: string;
  meetName: string;
}

export interface SeasonOption {
  label: string;
  value: string;
}

export class DiscoveryFailureError extends Error {
  constructor(public readonly failure: DiscoveryFailure) {
    super(failure.message);
    this.name = "DiscoveryFailureError";
  }
}

function failure(
  stage: DiscoveryFailure["stage"],
  code: DiscoveryFailure["code"],
  message: string,
  details: Omit<DiscoveryFailure, "stage" | "code" | "message"> = {},
): DiscoveryFailureError {
  return new DiscoveryFailureError({ stage, code, message, ...details });
}

function parseDate(text: string): string | null {
  const match = text.trim().match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function extractRaceId(url: string): string | null {
  const match = url.match(/\/race\/(\d+)/);
  return match ? match[1] : null;
}

function extractMeetId(url: string): string | null {
  const match = url.match(/\/meet\/([^/?#]+)/);
  return match ? match[1] : null;
}

async function fetchText(url: string): Promise<{ html: string; url: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": "cyclocross-data-collector (personal project)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`fetch failed: ${url} (HTTP ${res.status})`);
  return { html: await res.text(), url: res.url };
}

export function readSeasonOptions(html: string): SeasonOption[] {
  const $ = cheerio.load(html);
  return $("#season_list option")
    .map((_, element) => ({
      label: $(element).text().trim(),
      value: $(element).attr("value")?.trim() ?? "",
    }))
    .get();
}

export function resolveSeasonOption(html: string, season: string): SeasonOption {
  if (!isCanonicalSeason(season)) {
    throw failure("season", "invalid-season", `--season must use canonical YYYY-YY: ${season}`, {
      season,
    });
  }

  const matches = readSeasonOptions(html).filter((option) => option.label === season);
  if (matches.length === 0) {
    throw failure("season", "season-not-found", `season option was not found: ${season}`, {
      season,
    });
  }
  if (matches.length > 1) {
    throw failure("season", "season-duplicate", `season option appeared more than once: ${season}`, {
      season,
    });
  }
  if (!matches[0].value) {
    throw failure("season", "season-value-missing", `season option has no value: ${season}`, {
      season,
    });
  }

  return matches[0];
}

export function assertSeasonResponse(html: string, season: string): void {
  const $ = cheerio.load(html);
  const headings = $("h1, h2, h3")
    .map((_, element) => $(element).text().trim())
    .get()
    .filter((text) => text === season);

  if (headings.length !== 1) {
    throw failure(
      "season",
      "season-response-mismatch",
      `season response did not contain exactly one ${season} heading`,
      { season },
    );
  }
}

function parseMeetCandidate($: cheerio.CheerioAPI, row: Element): MeetCandidate | null {
  const $row = $(row);
  const meetLink = $row.find("a[href*='/meet/']").first();
  const meetId = extractMeetId(meetLink.attr("href") ?? "");
  const meetDate = parseDate($row.find("td.resuts_date").text());
  if (!meetId || !meetDate) return null;

  const series = $row.find("td.results_area a").first().text().trim();
  const meetName = meetLink.text().trim() || $row.find("td.resuts_race").text().trim();

  return { meetId, meetDate, series, meetName };
}

export function parseMeetCandidates(
  html: string,
  expectedSeason: string | null,
): { candidates: MeetCandidate[]; failures: DiscoveryFailure[] } {
  const $ = cheerio.load(html);
  const candidates = new Map<string, MeetCandidate>();
  const failures: DiscoveryFailure[] = [];

  $("td.resuts_race a[href*='/meet/']").each((_, element) => {
    const row = $(element).closest("tr").get(0);
    if (!row) return;

    const candidate = parseMeetCandidate($, row as Element);
    if (!candidate) return;

    if (expectedSeason && seasonForDate(candidate.meetDate) !== expectedSeason) {
      failures.push({
        stage: "meet",
        code: "event-date-mismatch",
        season: expectedSeason,
        meetId: candidate.meetId,
        meetDate: candidate.meetDate,
        message: `event date ${candidate.meetDate} does not belong to season ${expectedSeason}`,
      });
      return;
    }

    const previous = candidates.get(candidate.meetId);
    if (previous && previous.meetDate !== candidate.meetDate) {
      failures.push({
        stage: "meet",
        code: "event-date-mismatch",
        season: expectedSeason ?? seasonForDate(candidate.meetDate),
        meetId: candidate.meetId,
        meetDate: candidate.meetDate,
        message: `event ${candidate.meetId} appeared with conflicting dates ${previous.meetDate} and ${candidate.meetDate}`,
      });
      return;
    }

    if (!previous) candidates.set(candidate.meetId, candidate);
  });

  return {
    candidates: [...candidates.values()].sort(
      (a, b) => a.meetDate.localeCompare(b.meetDate) || a.meetId.localeCompare(b.meetId),
    ),
    failures,
  };
}

async function findMeetEntry(candidate: MeetCandidate, requestedSeason: string | null): Promise<MeetEntry> {
  let html: string;
  let url: string;
  try {
    ({ html, url } = await fetchText(`${MEET_LIST_URL}/${candidate.meetId}`));
  } catch (error) {
    throw failure(
      "meet",
      "meet-fetch",
      error instanceof Error ? error.message : `failed to fetch event ${candidate.meetId}`,
      {
        meetId: candidate.meetId,
        meetDate: candidate.meetDate,
        season: requestedSeason ?? seasonForDate(candidate.meetDate),
      },
    );
  }

  const $ = cheerio.load(html);
  const categories: MeetEntry["categories"] = [];
  const seen = new Set<string>();

  const redirectedRaceId = extractRaceId(url);
  if (redirectedRaceId) {
    categories.push({ raceId: redirectedRaceId, name: $("#ec_name").text().trim(), order: 0 });
    seen.add(redirectedRaceId);
  }

  $("#cat_tab a[href*='/race/']").each((_, element) => {
    const raceId = extractRaceId($(element).attr("href") ?? "");
    if (!raceId || seen.has(raceId)) return;
    seen.add(raceId);
    categories.push({
      raceId,
      name: $(element).text().trim(),
      order: categories.length,
    });
  });

  if (categories.length === 0) {
    throw failure(
      "meet",
      "categories-missing",
      `event ${candidate.meetId} did not expose any race categories`,
      {
        meetId: candidate.meetId,
        meetDate: candidate.meetDate,
        season: requestedSeason ?? seasonForDate(candidate.meetDate),
      },
    );
  }

  return {
    meetId: candidate.meetId,
    season: requestedSeason ?? seasonForDate(candidate.meetDate),
    meetDate: candidate.meetDate,
    series: candidate.series,
    meetName: candidate.meetName,
    categories,
  };
}

async function runWithConcurrency<T>(entries: T[], worker: (entry: T) => Promise<void>): Promise<void> {
  const queue = [...entries];
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry) await worker(entry);
    }
  });
  await Promise.all(workers);
}

function getSeasonArgument(): string | null {
  const index = process.argv.indexOf("--season");
  if (index < 0) return null;

  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw failure("season", "invalid-season", "--season requires a YYYY-YY value");
  }
  return value;
}

function getDateRange(season: string | null): { start: string; end: string } {
  if (season) {
    if (!isCanonicalSeason(season)) {
      throw failure("season", "invalid-season", `--season must use canonical YYYY-YY: ${season}`, { season });
    }
    const startYear = Number(season.slice(0, 4));
    return { start: `${startYear}-07-01`, end: `${startYear + 1}-06-30` };
  }

  const today = getJstDate();
  return { start: addDays(today, -DISCOVERY_WINDOW_DAYS), end: addDays(today, DISCOVERY_WINDOW_DAYS) };
}

function isForceRequested(): boolean {
  return process.argv.includes("--force");
}

function sortFailures(failures: DiscoveryFailure[]): DiscoveryFailure[] {
  return [...failures].sort((a, b) =>
    [a.stage, a.code, a.meetId ?? "", a.meetDate ?? "", a.message].join("\u0000")
      .localeCompare([b.stage, b.code, b.meetId ?? "", b.meetDate ?? "", b.message].join("\u0000")),
  );
}

async function main() {
  const season = getSeasonArgument();
  const { start, end } = getDateRange(season);
  const force = isForceRequested();
  const knownMeets = new Set(await loadKnownMeets());
  const existingRaces = await loadRaceEntries();
  const existingMeets = await loadMeetEntries();

  let html: string;
  let sourceSeasonValue: string | undefined;
  if (season) {
    const selector = await fetchText(MEET_LIST_URL);
    const option = resolveSeasonOption(selector.html, season);
    sourceSeasonValue = option.value;
    const selected = await fetchText(`${MEET_LIST_URL}?season=${encodeURIComponent(option.value)}`);
    assertSeasonResponse(selected.html, season);
    html = selected.html;
  } else {
    html = (await fetchText(MEET_LIST_URL)).html;
  }

  const parsed = parseMeetCandidates(html, season);
  const failures = [...parsed.failures];
  for (const recorded of failures) recorded.sourceSeasonValue = sourceSeasonValue;
  const candidates = parsed.candidates.filter(
    (candidate) =>
      (season !== null || (candidate.meetDate >= start && candidate.meetDate <= end)) &&
      (force || !knownMeets.has(candidate.meetId)),
  );

  const discoveredMeets: MeetEntry[] = [];
  await runWithConcurrency(candidates, async (candidate) => {
    try {
      const meet = await findMeetEntry(candidate, season);
      discoveredMeets.push(meet);
      knownMeets.add(candidate.meetId);
      console.log(`[OK] ${candidate.meetId}: ${meet.categories.length} categories discovered`);
    } catch (error) {
      const recorded = error instanceof DiscoveryFailureError
        ? error.failure
        : {
            stage: "meet" as const,
            code: "meet-fetch" as const,
            message: error instanceof Error ? error.message : `failed to discover ${candidate.meetId}`,
            season: season ?? seasonForDate(candidate.meetDate),
            meetId: candidate.meetId,
            meetDate: candidate.meetDate,
          };
      recorded.sourceSeasonValue = sourceSeasonValue;
      failures.push(recorded);
      console.error(`[DISCOVERY_FAILURE] ${JSON.stringify(recorded)}`);
    }
  });

  const discoveredRaces: RaceEntry[] = discoveredMeets.flatMap((meet) =>
    meet.categories.map((category) => ({ raceId: category.raceId, meetDate: meet.meetDate })),
  );
  await writeJson(MEETS_JSON_PATH, mergeMeetEntries(existingMeets, discoveredMeets));
  await writeJson(RACES_JSON_PATH, mergeRaceEntries(existingRaces, discoveredRaces));
  await writeJson(KNOWN_MEETS_JSON_PATH, [...knownMeets].sort());
  const previousFailures = await fileExists(DISCOVERY_FAILURES_JSON_PATH)
    ? await readJson<DiscoveryFailure[]>(DISCOVERY_FAILURES_JSON_PATH)
    : [];
  const retainedFailures = season
    ? previousFailures.filter((failure) => failure.season !== season)
    : previousFailures;
  const sortedFailures = sortFailures([...retainedFailures, ...failures]);
  await writeJson(DISCOVERY_FAILURES_JSON_PATH, sortedFailures);

  if (failures.length > 0) {
    console.error(`[DISCOVERY_FAILURES] ${JSON.stringify(sortedFailures)}`);
    const blockingFailures = failures.filter((failure) => failure.code !== "categories-missing");
    if (blockingFailures.length > 0) {
      throw new Error(`${blockingFailures.length} blocking discovery failure(s) recorded`);
    }
  }

  await writeSiteMetadata();
  console.log(`[OK] discovered ${discoveredMeets.length} event(s)`);
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isMainModule()) {
  main().catch((error) => {
    if (error instanceof DiscoveryFailureError) {
      console.error(`[DISCOVERY_FAILURE] ${JSON.stringify(error.failure)}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}
