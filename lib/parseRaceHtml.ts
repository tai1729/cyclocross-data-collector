import * as cheerio from "cheerio";
import type { RaceResult, Rider, LapRecord } from "./types.js";
import { parseClockToSec } from "./timeFormat.js";

// parse5 (Cheerio's default HTML parser) drops NUL and other forbidden
// control characters while tokenizing HTML. Preserve them through parsing so
// rank-cell validation can reject them instead of accidentally accepting the
// remaining numeric prefix as an annotation.
const SOURCE_CONTROL_SENTINELS = new Map<number, string>([
  // TAB/LF/FF/CR are valid HTML whitespace. Leave them untouched so DOM
  // text extraction and clock parsing keep their normal trim semantics.
  ...Array.from({ length: 0x20 }, (_, code) => [code, String.fromCodePoint(0xe000 + code)] as const)
    .filter(([code]) => ![0x09, 0x0a, 0x0c, 0x0d].includes(code)),
  ...Array.from({ length: 0x21 }, (_, index) => [0x7f + index, String.fromCodePoint(0xe020 + index)] as const),
  [0x2028, String.fromCodePoint(0xe041)],
  [0x2029, String.fromCodePoint(0xe042)],
]);
const SENTINEL_SOURCE_CONTROLS = new Map(
  [...SOURCE_CONTROL_SENTINELS].map(([code, sentinel]) => [sentinel, String.fromCodePoint(code)]),
);
const UNSAFE_RANK_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029\ufffd<>]/u;

function preserveSourceControls(html: string): string {
  return [...html]
    .map((character) => SOURCE_CONTROL_SENTINELS.get(character.codePointAt(0)!) ?? character)
    .join("");
}

function restoreSourceControls(text: string): string {
  return [...text].map((character) => SENTINEL_SOURCE_CONTROLS.get(character) ?? character).join("");
}

function extractRiderIdFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const match = href.match(/\/racer\/([^/?#]+)/);
  return match ? match[1] : null;
}

function fallbackRiderId(raceId: string, rowOrdinal: number): string {
  return "race-" + raceId + "-row-" + rowOrdinal;
}

function parseAcceptedRank(rankText: string): {
  status: Rider["status"];
  numericPosition: number | null;
  officialPositionLabel?: string;
} | null {
  // Rank labels come from DOM textContent. Keep only incidental outer
  // whitespace out of the payload, while preserving all internal source text.
  const label = rankText.trim();
  if (!label || UNSAFE_RANK_TEXT.test(label)) {
    return null;
  }

  if (label === "DNF") {
    return { status: "dnf", numericPosition: null };
  }

  // Only an ASCII decimal prefix is accepted. A suffix is opaque and, when
  // present, makes this an annotated rank rather than a semantic status.
  const match = label.match(/^(\d+)(.*)$/u);
  if (!match) return null;
  const [, digits, suffix] = match;
  const numericPosition = Number(digits);
  if (!Number.isSafeInteger(numericPosition) || numericPosition <= 0) return null;
  if (suffix.length === 0) return { status: "finished", numericPosition };
  return {
    status: "annotated-rank",
    numericPosition,
    officialPositionLabel: label,
  };
}

function getRiderIdentity(
  name: string,
  href: string | undefined,
  raceId: string,
  rowOrdinal: number,
): { riderId: string; name: string } {
  return {
    name,
    riderId:
      extractRiderIdFromHref(href) ?? fallbackRiderId(raceId, rowOrdinal),
  };
}

interface RawLapCell {
  lapNumber: number;
  cumulativeTimeSec: number | null;
}

interface RawRider {
  riderId: string;
  name: string;
  finalPosition: number;
  status: Rider["status"];
  officialPositionLabel?: string;
  lapCells: RawLapCell[];
  hasAnomaly: boolean;
}

interface LapTableSchema {
  lapNumbers: number[];
  cellOffset: number;
  valueType: "cumulative" | "lap-time";
}

// Keep the quality gate deliberately broader than parseClockToSec: a source
// value that looks like a clock but contains an unsafe control character must
// not silently turn a timing table into a result-only race.
const CLOCK_LIKE_TEXT = /\d+:\d+(?::\d+)?(?:\.\d+)?/u;

function hasClockLikeLapValue($: cheerio.CheerioAPI): boolean {
  let found = false;
  $(".table__laptime tbody td").each((_, cell) => {
    if (CLOCK_LIKE_TEXT.test(restoreSourceControls($(cell).text()))) found = true;
  });
  return found;
}

function hasUsableLap(rider: Rider): boolean {
  return rider.laps.some(
    (lap) =>
      Number.isSafeInteger(lap.lapNumber) &&
      lap.lapNumber > 0 &&
      Number.isFinite(lap.lapTimeSec) &&
      lap.lapTimeSec > 0 &&
      Number.isFinite(lap.cumulativeTimeSec) &&
      lap.cumulativeTimeSec > 0,
  );
}

/**
 * ラップタイムテーブルのヘッダー（例: "2周", "3周", ...）から
 * 列インデックス→周回番号のマッピングを作る。
 * レースによって開始周が1周からでない場合があるため、決め打ちにしない。
 */
function parseLapTableSchema($: cheerio.CheerioAPI): LapTableSchema {
  const headerCells = $(".table__laptime thead th.cell__lapat");
  const labels = (headerCells.length > 0
    ? headerCells
    : $(".table__laptime thead th").slice(2))
    .toArray()
    .map((el) => $(el).text().trim());
  const hasStartLoop = labels[0] === "StartLoop";
  const lapNumbers: number[] = [];
  for (const label of labels) {
    if (label === "StartLoop") continue;
    const match = label.match(/(\d+)\s*周/);
    if (match) lapNumbers.push(Number(match[1]));
  }

  return {
    lapNumbers,
    cellOffset: hasStartLoop ? 1 : 0,
    valueType: hasStartLoop ? "lap-time" : "cumulative",
  };
}

function parseOfficialRaceLapNumbers(
  $: cheerio.CheerioAPI,
  fallback: readonly number[],
): number[] {
  const lapDescription = $("dt")
    .filter((_, element) => $(element).text().includes("\u5468\u56de\u6570"))
    .next("dd")
    .first()
    .text();
  const match = lapDescription.match(/[\u00d7x]\s*(\d+)\s*Lap/i);
  const lapCount = match ? Number(match[1]) : null;
  if (lapCount === null || !Number.isSafeInteger(lapCount) || lapCount <= 0) {
    return [...fallback];
  }

  // A small number of historical pages publish a stale metadata lap count
  // while the numbered timing header contains additional official checkpoints.
  // Keep the source-provided header axis in that case; never truncate measured
  // checkpoints or infer an axis from a selected rider.
  const fallbackLastLap = fallback.at(-1) ?? 0;
  if (fallbackLastLap > lapCount) return [...fallback];

  return Array.from({ length: lapCount }, (_, index) => index + 1);
}

interface ParsedRow {
  riderId: string;
  name: string;
  status: Rider["status"];
  officialPositionLabel?: string;
  /** 完走者のみ実際の順位。DNFはnull（後で連番を割り当てる） */
  numericPosition: number | null;
  lapCells: RawLapCell[];
  hasAnomaly: boolean;
}

interface ParsedRiders {
  riders: RawRider[];
  excludedRowsByStatus: Record<string, number>;
}

function sortStatusCounts(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parseRawRiders(
  $: cheerio.CheerioAPI,
  schema: LapTableSchema,
  raceId: string,
): ParsedRiders {
  const rows: ParsedRow[] = [];
  const excludedRowsByStatus = new Map<string, number>();

  $(".table__laptime tbody tr").each((rowOrdinal, rowEl) => {
    const $row = $(rowEl);
    const rankCell = $row.find("td.cell__rank").first();
    const rankText = restoreSourceControls(
      (rankCell.length > 0 ? rankCell : $row.find("td").first()).text(),
    ).trim();
    const parsedRank = parseAcceptedRank(rankText);
    if (!parsedRank) {
      excludedRowsByStatus.set(rankText, (excludedRowsByStatus.get(rankText) ?? 0) + 1);
      return;
    }

    const riderCell = $row.find("td.cell__rider").first();
    const riderAnchor = $row.find("td.cell__rider a, a[href*='/racer/']").first();
    const { riderId, name } = getRiderIdentity(
      riderAnchor.length > 0
        ? riderAnchor.text().trim()
        : riderCell.length > 0
          ? riderCell.text().trim()
          : $row.find("td").eq(1).text().trim(),
      riderAnchor.attr("href"),
      raceId,
      rowOrdinal + 1,
    );

    const lapCellEls = $row
      .find("td")
      .slice(2 + schema.cellOffset, 2 + schema.cellOffset + schema.lapNumbers.length)
      .toArray();
    let prevCumulative = 0;
    let hasAnomaly = false;
    let missingValueSeen = false;

    const lapCells: RawLapCell[] = lapCellEls.map((cellEl, i) => {
      const lapNumber = schema.lapNumbers[i];
      const text = $(cellEl).text().trim();
      const parsedTimeSec = parseClockToSec(text);
      let cumulativeTimeSec = parsedTimeSec;

      if (parsedTimeSec === null) {
        missingValueSeen = true;
      } else if (schema.valueType === "lap-time") {
        if (parsedTimeSec <= 0 || missingValueSeen) hasAnomaly = true;
        cumulativeTimeSec = prevCumulative + parsedTimeSec;
      }

      if (cumulativeTimeSec !== null) {
        if (schema.valueType === "cumulative" && cumulativeTimeSec <= prevCumulative) {
          // 前の周回より累積タイムが減少している = 明らかな異常値
          hasAnomaly = true;
        }
        prevCumulative = cumulativeTimeSec;
      }

      return { lapNumber, cumulativeTimeSec };
    });

    rows.push({
      riderId,
      name,
      status: parsedRank.status,
      numericPosition: parsedRank.numericPosition,
      ...(parsedRank.officialPositionLabel
        ? { officialPositionLabel: parsedRank.officialPositionLabel }
        : {}),
      lapCells,
      hasAnomaly,
    });
  });

  // DNF選手には完走者の後ろに連番の順位を割り当てる（テーブル上の並び順を維持）
  const maxFinisherPosition = rows.reduce(
    (max, r) => (r.numericPosition !== null ? Math.max(max, r.numericPosition) : max),
    0
  );
  let dnfCount = 0;

  return {
    riders: rows.map((row) => ({
      riderId: row.riderId,
      name: row.name,
      status: row.status,
      ...(row.officialPositionLabel
        ? { officialPositionLabel: row.officialPositionLabel }
        : {}),
      finalPosition: row.numericPosition ?? maxFinisherPosition + ++dnfCount,
      lapCells: row.lapCells,
      hasAnomaly: row.hasAnomaly,
    })),
    excludedRowsByStatus: sortStatusCounts(excludedRowsByStatus),
  };
}

function parseResultRiders($: cheerio.CheerioAPI, raceId: string): ParsedRiders {
  const rows: ParsedRow[] = [];
  const excludedRowsByStatus = new Map<string, number>();

  $("table.table__result tbody tr").each((rowOrdinal, rowEl) => {
    const $row = $(rowEl);
    const rankCell = $row.find("td.cell__rank").first();
    const parsedRank = parseAcceptedRank(
      restoreSourceControls(
        (rankCell.length > 0 ? rankCell : $row.find("td").first()).text(),
      ).trim(),
    );
    if (!parsedRank) {
      const rankText = restoreSourceControls(
        (rankCell.length > 0 ? rankCell : $row.find("td").first()).text(),
      ).trim();
      excludedRowsByStatus.set(rankText, (excludedRowsByStatus.get(rankText) ?? 0) + 1);
      return;
    }

    const riderCell = $row.find("td.cell__rider").first();
    const riderAnchor = $row.find("td.cell__rider a, a[href*='/racer/']").first();
    const { riderId, name } = getRiderIdentity(
      riderAnchor.length > 0
        ? riderAnchor.text().trim()
        : riderCell.length > 0
          ? riderCell.text().trim()
          : $row.find("td").eq(1).text().trim(),
      riderAnchor.attr("href"),
      raceId,
      rowOrdinal + 1,
    );
    rows.push({
      riderId,
      name,
      status: parsedRank.status,
      numericPosition: parsedRank.numericPosition,
      ...(parsedRank.officialPositionLabel
        ? { officialPositionLabel: parsedRank.officialPositionLabel }
        : {}),
      lapCells: [],
      hasAnomaly: false,
    });
  });

  const maxFinisherPosition = rows.reduce(
    (max, r) => (r.numericPosition !== null ? Math.max(max, r.numericPosition) : max),
    0,
  );
  let dnfCount = 0;

  return {
    riders: rows.map((row) => ({
      riderId: row.riderId,
      name: row.name,
      status: row.status,
      ...(row.officialPositionLabel
        ? { officialPositionLabel: row.officialPositionLabel }
        : {}),
      finalPosition: row.numericPosition ?? maxFinisherPosition + ++dnfCount,
      lapCells: row.lapCells,
      hasAnomaly: row.hasAnomaly,
    })),
    excludedRowsByStatus: sortStatusCounts(excludedRowsByStatus),
  };
}

/**
 * table__result（順位表）のTime/Gap列から、各選手のゴールタイム（秒）を算出する。
 * 1位は絶対タイム、2位以降は1位との差分（+M:SS）で表記されているため、
 * 1位のタイムに差分を足し合わせて総合タイムを求める。
 */
function parseResultTotalTimes($: cheerio.CheerioAPI, raceId: string): Map<string, number> {
  const totals = new Map<string, number>();
  let leaderTotal: number | null = null;

  $("table.table__result tbody tr").each((rowOrdinal, rowEl) => {
    const $row = $(rowEl);
    const riderAnchor = $row.find("td.cell__rider a, a[href*='/racer/']").first();
    const { riderId } = getRiderIdentity(
      riderAnchor.text().trim(),
      riderAnchor.attr("href"),
      raceId,
      rowOrdinal + 1,
    );

    const rawText = $row.find("td.cell__timegap").first().text().trim();
    if (!rawText) return;

    if (rawText.startsWith("+")) {
      if (leaderTotal === null) return;
      const gapSec = parseClockToSec(rawText.slice(1));
      if (gapSec !== null) totals.set(riderId, leaderTotal + gapSec);
    } else {
      const absoluteSec = parseClockToSec(rawText);
      if (absoluteSec === null) return;
      if (leaderTotal === null) leaderTotal = absoluteSec;
      totals.set(riderId, absoluteSec);
    }
  });

  return totals;
}

/**
 * ラップタイムテーブルは、順位が下位の選手ほど最終周（ゴール地点）のスプリットが
 * 記録されていないことが多い（計測上の欠損）。完走者(status: "finished")については
 * table__resultの正式ゴールタイムで最終周のセルを補完する。注記付き順位は
 * 完走扱いのタイムを暗黙に補完できないため対象外とする。
 */
function backfillFinalLapFromResults(
  $: cheerio.CheerioAPI,
  rawRiders: RawRider[],
  lapNumbers: number[],
  raceId: string,
): void {
  if (lapNumbers.length === 0) return;
  const resultTotalTimes = parseResultTotalTimes($, raceId);

  for (const rider of rawRiders) {
    if (rider.status !== "finished") continue;

    const lastIndex = rider.lapCells.length - 1;
    const lastCell = rider.lapCells[lastIndex];
    if (!lastCell || lastCell.cumulativeTimeSec !== null) continue;

    const total = resultTotalTimes.get(rider.riderId);
    if (total === undefined) continue;

    const prevValid = [...rider.lapCells]
      .slice(0, lastIndex)
      .reverse()
      .find((c) => c.cumulativeTimeSec !== null);
    if (prevValid && total <= (prevValid.cumulativeTimeSec as number)) continue;

    rider.lapCells[lastIndex] = { lapNumber: lastCell.lapNumber, cumulativeTimeSec: total };
  }
}

/** 各周回について、その時点の累積タイム順に順位(rankAtLap)を算出する。 */
function buildRankAtLapMap(rawRiders: RawRider[]): Map<string, Map<number, number>> {
  const byLap = new Map<number, { riderId: string; cumulativeTimeSec: number }[]>();

  for (const rider of rawRiders) {
    for (const cell of rider.lapCells) {
      if (cell.cumulativeTimeSec === null) continue;
      const bucket = byLap.get(cell.lapNumber) ?? [];
      bucket.push({ riderId: rider.riderId, cumulativeTimeSec: cell.cumulativeTimeSec });
      byLap.set(cell.lapNumber, bucket);
    }
  }

  const rankAtLapByRider = new Map<string, Map<number, number>>();
  for (const [lapNumber, entries] of byLap) {
    entries.sort((a, b) => a.cumulativeTimeSec - b.cumulativeTimeSec);
    entries.forEach((entry, index) => {
      const riderMap = rankAtLapByRider.get(entry.riderId) ?? new Map<number, number>();
      riderMap.set(lapNumber, index + 1);
      rankAtLapByRider.set(entry.riderId, riderMap);
    });
  }

  return rankAtLapByRider;
}

function buildLapRecords(
  rider: RawRider,
  rankAtLapByRider: Map<string, Map<number, number>>
): LapRecord[] {
  const laps: LapRecord[] = [];
  let prevCumulative = 0;

  rider.lapCells.forEach((cell, i) => {
    if (cell.cumulativeTimeSec === null) return;

    const isFirstColumn = i === 0;
    // 開始周が1周でない場合、最初の列は「0からの累積時間」をそのままlapTimeSecとして扱う
    // （それ以前の周回データが存在しないための既知の限界）
    const contiguous = !isFirstColumn || cell.lapNumber === 1;
    const lapTimeSec = contiguous
      ? Math.round((cell.cumulativeTimeSec - prevCumulative) * 10) / 10
      : cell.cumulativeTimeSec;

    const rankAtLap = rankAtLapByRider.get(rider.riderId)?.get(cell.lapNumber) ?? rider.finalPosition;

    laps.push({
      lapNumber: cell.lapNumber,
      lapTimeSec,
      cumulativeTimeSec: cell.cumulativeTimeSec,
      rankAtLap,
    });
    prevCumulative = cell.cumulativeTimeSec;
  });

  return laps;
}

/**
 * 同じ大会（meet）内での昇格ラインを算出する。
 * 「昇格者テーブル」に、このraceIdへのリンクを持つ行がある場合、
 * その中で最も順位が低い（数字が大きい）選手の順位を昇格ラインとする。
 * 該当者がいない場合（最上位カテゴリー等）はundefinedを返す。
 */
function parsePromotionZoneRank(
  $: cheerio.CheerioAPI,
  raceId: string,
  riders: Rider[]
): number | undefined {
  const promotedRiderIds = new Set<string>();

  $("table.table__rankup tbody tr").each((_, rowEl) => {
    const $row = $(rowEl);
    const raceHref = $row.find("td.cell__races-category a").attr("href") ?? "";
    if (!raceHref.endsWith(`/race/${raceId}`)) return;

    const riderHref = $row.find("td.rankup_rider a").attr("href");
    const riderId = extractRiderIdFromHref(riderHref);
    if (riderId) promotedRiderIds.add(riderId);
  });

  if (promotedRiderIds.size === 0) return undefined;

  const promotedPositions = riders
    .filter((r) => promotedRiderIds.has(r.riderId))
    .map((r) => r.finalPosition);

  if (promotedPositions.length === 0) return undefined;
  return Math.max(...promotedPositions);
}

export function parseRaceHtml(raceId: string, html: string): RaceResult {
  const $ = cheerio.load(preserveSourceControls(html));

  const raceName = $("#js__page_title").text().trim();
  const category = $("#ec_name").text().trim();

  const lapTableSchema = parseLapTableSchema($);
  const sourceHasClockLikeLapValue =
    lapTableSchema.lapNumbers.length > 0 && hasClockLikeLapValue($);
  const raceLapNumbers = parseOfficialRaceLapNumbers($, lapTableSchema.lapNumbers);
  const parsedLapRiders = parseRawRiders($, lapTableSchema, raceId);
  const parsedResultRiders = parsedLapRiders.riders.length > 0
    ? null
    : parseResultRiders($, raceId);
  const parsed = parsedLapRiders.riders.length > 0
    ? parsedLapRiders
    : parsedResultRiders &&
        (parsedResultRiders.riders.length > 0 ||
          Object.keys(parsedResultRiders.excludedRowsByStatus).length > 0)
      ? parsedResultRiders
      : parsedLapRiders;
  const rawRiders = parsed.riders;
  backfillFinalLapFromResults($, rawRiders, lapTableSchema.lapNumbers, raceId);
  const rankAtLapByRider = buildRankAtLapMap(rawRiders);

  const riders: Rider[] = rawRiders.map((rawRider) => ({
    riderId: rawRider.riderId,
    name: rawRider.name,
    finalPosition: rawRider.finalPosition,
    status: rawRider.status,
    ...(rawRider.officialPositionLabel
      ? { officialPositionLabel: rawRider.officialPositionLabel }
      : {}),
    laps: buildLapRecords(rawRider, rankAtLapByRider),
    dataQuality: rawRider.hasAnomaly ? "error" : "ok",
  }));

  riders.sort((a, b) => a.finalPosition - b.finalPosition);

  // Only enforce the timing-table quality gate when at least one lap-table
  // row has an accepted rank. A table containing only unsupported statuses
  // (for example FIN/OPEN) is still useful as a diagnostic-only result and
  // must not be rejected merely because its source cells resemble clocks.
  if (
    sourceHasClockLikeLapValue &&
    parsedLapRiders.riders.length > 0 &&
    !riders.some(hasUsableLap)
  ) {
    throw new Error(`race ${raceId} lap table contains clock-like values but no usable lap records`);
  }

  const promotionZoneRank = parsePromotionZoneRank($, raceId, riders);

  return {
    raceId,
    raceName,
    category,
    updatedAt: new Date().toISOString(),
    ...(raceLapNumbers.length > 0
      ? { raceLapNumbers }
      : {}),
    ...(promotionZoneRank !== undefined ? { promotionZoneRank } : {}),
    ...(Object.keys(parsed.excludedRowsByStatus).length > 0
      ? { excludedRowsByStatus: parsed.excludedRowsByStatus }
      : {}),
    riders,
  };
}
