import assert from "node:assert/strict";
import test from "node:test";
import { parseRaceHtml } from "../lib/parseRaceHtml.js";

function raceHtml(headers: string[], rows: string): string {
  return `
    <h1 id="js__page_title">テスト大会</h1>
    <div id="ec_name">ME1</div>
    <table class="table__laptime">
      <thead><tr><th>順位</th><th>選手</th>${headers.map((header) => `<th class="cell__lapat">${header}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function riderRow(rank: string, id: string, name: string, times: string[]): string {
  return `<tr><td class="cell__rank">${rank}</td><td class="cell__rider"><a href="/racer/${id}">${name}</a></td>${times.map((time) => `<td>${time}</td>`).join("")}</tr>`;
}

test("累積タイム形式を従来どおり解析する", () => {
  const result = parseRaceHtml(
    "1",
    raceHtml(
      ["2周", "3周", "4周"],
      riderRow("1", "R-1", "完走者", ["10:00.0", "15:10.0", "20:30.0"]),
    ),
  );

  assert.deepEqual(result.riders[0].laps, [
    { lapNumber: 2, lapTimeSec: 600, cumulativeTimeSec: 600, rankAtLap: 1 },
    { lapNumber: 3, lapTimeSec: 310, cumulativeTimeSec: 910, rankAtLap: 1 },
    { lapNumber: 4, lapTimeSec: 320, cumulativeTimeSec: 1230, rankAtLap: 1 },
  ]);
  assert.equal(result.riders[0].dataQuality, "ok");
});

test("StartLoop形式の各周タイムを累積タイムへ変換する", () => {
  const result = parseRaceHtml(
    "2",
    raceHtml(
      ["StartLoop", "1周", "2周", "3周"],
      [
        riderRow("1", "R-1", "完走者", ["0.0", "5:00.0", "5:02.0", "5:04.0"]),
        riderRow("DNF", "R-2", "途中棄権", ["0.0", "6:00.0", "", ""]),
      ].join(""),
    ),
  );

  assert.deepEqual(result.riders[0].laps, [
    { lapNumber: 1, lapTimeSec: 300, cumulativeTimeSec: 300, rankAtLap: 1 },
    { lapNumber: 2, lapTimeSec: 302, cumulativeTimeSec: 602, rankAtLap: 1 },
    { lapNumber: 3, lapTimeSec: 304, cumulativeTimeSec: 906, rankAtLap: 1 },
  ]);
  assert.deepEqual(result.riders[1].laps, [
    { lapNumber: 1, lapTimeSec: 360, cumulativeTimeSec: 360, rankAtLap: 2 },
  ]);
  assert.equal(result.riders[0].dataQuality, "ok");
  assert.equal(result.riders[1].dataQuality, "ok");
});

test("累積タイムが増えていない選手を異常データとして扱う", () => {
  const result = parseRaceHtml(
    "3",
    raceHtml(
      ["1周", "2周", "3周"],
      riderRow("1", "R-1", "計時異常", ["5:56.0", "5:56.0", "17:40.1"]),
    ),
  );

  assert.equal(result.riders[0].dataQuality, "error");
});
