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
  lapCells: RawLapCell[];
  hasAnomaly: boolean;
}

/**
 * ラップタイムテーブルのヘッダー（例: "2周", "3周", ...）から
 * 列インデックス→周回番号のマッピングを作る。
 * レースによって開始周が1周からでない場合があるため、決め打ちにしない。
 */
function parseLapNumbers($: cheerio.CheerioAPI): number[] {
  const lapNumbers: number[] = [];
  $(".table__laptime thead th.cell__lapat").each((_, el) => {
    const label = $(el).text().trim();
    const match = label.match(/(\d+)\s*周/);
    if (match) lapNumbers.push(Number(match[1]));
  });
  return lapNumbers;
}

function parseRawRiders($: cheerio.CheerioAPI, lapNumbers: number[]): RawRider[] {
  const rawRiders: RawRider[] = [];

  $(".table__laptime tbody tr").each((_, rowEl) => {
    const $row = $(rowEl);
    const rankText = $row.find("td.cell__rank").first().text().trim();
    const finalPosition = Number(rankText);

    // DNF/DNS/欠損（数値でない順位）は比較対象として意味を持たないため除外する
    if (!Number.isInteger(finalPosition) || finalPosition <= 0) return;

    const riderAnchor = $row.find("td.cell__rider a").first();
    const name = riderAnchor.text().trim();
    const riderId = extractRiderIdFromHref(riderAnchor.attr("href")) ?? name;

    const lapCellEls = $row.find("td").slice(2).toArray();
    let prevCumulative = 0;
    let hasAnomaly = false;

    const lapCells: RawLapCell[] = lapCellEls.map((cellEl, i) => {
      const lapNumber = lapNumbers[i];
      const text = $(cellEl).text().trim();
      const cumulativeTimeSec = parseClockToSec(text);

      if (cumulativeTimeSec !== null) {
        if (cumulativeTimeSec < prevCumulative) {
          // 前の周回より累積タイムが減少している = 明らかな異常値
          hasAnomaly = true;
        }
        prevCumulative = cumulativeTimeSec;
      }

      return { lapNumber, cumulativeTimeSec };
    });

    rawRiders.push({ riderId, name, finalPosition, lapCells, hasAnomaly });
  });

  return rawRiders;
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

  const lapNumbers = parseLapNumbers($);
  const rawRiders = parseRawRiders($, lapNumbers);
  const rankAtLapByRider = buildRankAtLapMap(rawRiders);

  const riders: Rider[] = rawRiders.map((rawRider) => ({
    riderId: rawRider.riderId,
    name: rawRider.name,
    finalPosition: rawRider.finalPosition,
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
