import * as cheerio from "cheerio";
import type { RaceResult, Rider, LapRecord } from "./types.js";
import { parseClockToSec } from "./timeFormat.js";

function extractRiderIdFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const match = href.match(/\/racer\/([^/?#]+)/);
  return match ? match[1] : null;
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
  lapCells: RawLapCell[];
  hasAnomaly: boolean;
}

interface LapTableSchema {
  lapNumbers: number[];
  cellOffset: number;
  valueType: "cumulative" | "lap-time";
}

/**
 * ラップタイムテーブルのヘッダー（例: "2周", "3周", ...）から
 * 列インデックス→周回番号のマッピングを作る。
 * レースによって開始周が1周からでない場合があるため、決め打ちにしない。
 */
function parseLapTableSchema($: cheerio.CheerioAPI): LapTableSchema {
  const labels = $(".table__laptime thead th.cell__lapat")
    .toArray()
    .map((el) => $(el).text().trim());
  const hasStartLoop = labels[0] === "StartLoop";
  const lapNumbers: number[] = [];
  for (const label of labels) {
    const match = label.match(/(\d+)\s*周/);
    if (match) lapNumbers.push(Number(match[1]));
  }

  return {
    lapNumbers,
    cellOffset: hasStartLoop ? 1 : 0,
    valueType: hasStartLoop ? "lap-time" : "cumulative",
  };
}

interface ParsedRow {
  riderId: string;
  name: string;
  status: Rider["status"];
  /** 完走者のみ実際の順位。DNFはnull（後で連番を割り当てる） */
  numericPosition: number | null;
  lapCells: RawLapCell[];
  hasAnomaly: boolean;
}

function parseRawRiders($: cheerio.CheerioAPI, schema: LapTableSchema): RawRider[] {
  const rows: ParsedRow[] = [];

  $(".table__laptime tbody tr").each((_, rowEl) => {
    const $row = $(rowEl);
    const rankText = $row.find("td.cell__rank").first().text().trim();

    // DNS（欠場）はラップデータが存在しないため完全に除外する
    if (rankText === "DNS") return;

    const numericPosition = Number(rankText);
    const isFinished = Number.isInteger(numericPosition) && numericPosition > 0;

    // DNFでも完走順位でもない想定外の値は除外する
    if (!isFinished && rankText !== "DNF") return;

    const riderAnchor = $row.find("td.cell__rider a").first();
    const name = riderAnchor.text().trim();
    const riderId = extractRiderIdFromHref(riderAnchor.attr("href")) ?? name;

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
      status: isFinished ? "finished" : "dnf",
      numericPosition: isFinished ? numericPosition : null,
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

  return rows.map((row) => ({
    riderId: row.riderId,
    name: row.name,
    status: row.status,
    finalPosition: row.numericPosition ?? maxFinisherPosition + ++dnfCount,
    lapCells: row.lapCells,
    hasAnomaly: row.hasAnomaly,
  }));
}

/**
 * table__result（順位表）のTime/Gap列から、各選手のゴールタイム（秒）を算出する。
 * 1位は絶対タイム、2位以降は1位との差分（+M:SS）で表記されているため、
 * 1位のタイムに差分を足し合わせて総合タイムを求める。
 */
function parseResultTotalTimes($: cheerio.CheerioAPI): Map<string, number> {
  const totals = new Map<string, number>();
  let leaderTotal: number | null = null;

  $("table.table__result tbody tr").each((_, rowEl) => {
    const $row = $(rowEl);
    const riderHref = $row.find("td a").first().attr("href");
    const riderId = extractRiderIdFromHref(riderHref);
    if (!riderId) return;

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
 * table__resultの正式ゴールタイムで最終周のセルを補完する。
 */
function backfillFinalLapFromResults(
  $: cheerio.CheerioAPI,
  rawRiders: RawRider[],
  lapNumbers: number[]
): void {
  if (lapNumbers.length === 0) return;
  const resultTotalTimes = parseResultTotalTimes($);

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
  const $ = cheerio.load(html);

  const raceName = $("#js__page_title").text().trim();
  const category = $("#ec_name").text().trim();

  const lapTableSchema = parseLapTableSchema($);
  const rawRiders = parseRawRiders($, lapTableSchema);
  backfillFinalLapFromResults($, rawRiders, lapTableSchema.lapNumbers);
  const rankAtLapByRider = buildRankAtLapMap(rawRiders);

  const riders: Rider[] = rawRiders.map((rawRider) => ({
    riderId: rawRider.riderId,
    name: rawRider.name,
    finalPosition: rawRider.finalPosition,
    status: rawRider.status,
    laps: buildLapRecords(rawRider, rankAtLapByRider),
    dataQuality: rawRider.hasAnomaly ? "error" : "ok",
  }));

  riders.sort((a, b) => a.finalPosition - b.finalPosition);

  const promotionZoneRank = parsePromotionZoneRank($, raceId, riders);

  return {
    raceId,
    raceName,
    category,
    updatedAt: new Date().toISOString(),
    ...(promotionZoneRank !== undefined ? { promotionZoneRank } : {}),
    riders,
  };
}
