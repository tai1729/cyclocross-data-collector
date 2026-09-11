import assert from "node:assert/strict";
import test from "node:test";
import { parseRaceHtml } from "../lib/parseRaceHtml.js";

function raceHtml(headers: string[], rows: string, officialLapCount?: number): string {
  return `
    <h1 id="js__page_title">Test meet</h1>
    <div id="ec_name">ME1</div>
    ${officialLapCount ? `<dl><dt>&#x5468;&#x56de;&#x6570;</dt><dd>0.1+2.5km&#xD7;${officialLapCount}Lap</dd></dl>` : ""}
    <table class="table__laptime">
      <thead><tr><th>Rank</th><th>Rider</th>${headers
        .map((header) => `<th class="cell__lapat">${header}</th>`)
        .join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function riderRow(rank: string, id: string, name: string, times: string[]): string {
  return `<tr><td class="cell__rank">${rank}</td><td class="cell__rider"><a href="/racer/${id}">${name}</a></td>${times
    .map((time) => `<td>${time}</td>`)
    .join("")}</tr>`;
}

test("parses cumulative lap tables and preserves numbered headers", () => {
  const result = parseRaceHtml(
    "1",
    raceHtml(
      ["2\u5468", "3\u5468", "4\u5468"],
      riderRow("1", "R-1", "Finisher", ["10:00.0", "15:10.0", "20:30.0"]),
    ),
  );

  assert.deepEqual(result.raceLapNumbers, [2, 3, 4]);
  assert.deepEqual(result.riders[0].laps, [
    { lapNumber: 2, lapTimeSec: 600, cumulativeTimeSec: 600, rankAtLap: 1 },
    { lapNumber: 3, lapTimeSec: 310, cumulativeTimeSec: 910, rankAtLap: 1 },
    { lapNumber: 4, lapTimeSec: 320, cumulativeTimeSec: 1230, rankAtLap: 1 },
  ]);
});

test("excludes StartLoop from metadata and converts lap-time columns", () => {
  const result = parseRaceHtml(
    "2",
    raceHtml(
      ["StartLoop", "1\u5468", "2\u5468", "3\u5468"],
      [
        riderRow("1", "R-1", "Finisher", ["0.0", "5:00.0", "5:02.0", "5:04.0"]),
        riderRow("DNF", "R-2", "DNF rider", ["0.0", "6:00.0", "", ""]),
      ].join(""),
    ),
  );

  assert.deepEqual(result.raceLapNumbers, [1, 2, 3]);
  assert.deepEqual(result.riders[0].laps, [
    { lapNumber: 1, lapTimeSec: 300, cumulativeTimeSec: 300, rankAtLap: 1 },
    { lapNumber: 2, lapTimeSec: 302, cumulativeTimeSec: 602, rankAtLap: 1 },
    { lapNumber: 3, lapTimeSec: 304, cumulativeTimeSec: 906, rankAtLap: 1 },
  ]);
  assert.deepEqual(result.riders[1].laps, [
    { lapNumber: 1, lapTimeSec: 360, cumulativeTimeSec: 360, rankAtLap: 2 },
  ]);
});

test("marks non-increasing cumulative times as anomalous", () => {
  const result = parseRaceHtml(
    "3",
    raceHtml(
      ["1\u5468", "2\u5468", "3\u5468"],
      riderRow("1", "R-1", "Bad data", ["5:56.0", "5:56.0", "17:40.1"]),
    ),
  );

  assert.equal(result.riders[0].dataQuality, "error");
});

test("accepts H:MM:SS lap totals and retains the final lap", () => {
  const result = parseRaceHtml(
    "27834",
    raceHtml(
      ["9\u5468", "10\u5468", "11\u5468"],
      riderRow("1", "R-1", "Finisher", ["57:52.4", "1:03:09.2", "1:09:25.6"]),
    ),
  );

  assert.deepEqual(result.raceLapNumbers, [9, 10, 11]);
  assert.deepEqual(result.riders[0].laps.map((lap) => lap.lapNumber), [9, 10, 11]);
  assert.equal(result.riders[0].laps.at(-1)?.cumulativeTimeSec, 4165.6);
});

test("preserves the official numbered axis when measured columns begin at lap 2", () => {
  const result = parseRaceHtml(
    "27770",
    raceHtml(
      [
        "2\u5468", "3\u5468", "4\u5468", "5\u5468", "6\u5468",
        "7\u5468", "8\u5468", "9\u5468", "10\u5468", "11\u5468",
      ],
      riderRow("1", "R-1", "Finisher", [
        "10:00.0", "15:10.0", "20:30.0", "25:50.0", "31:10.0",
        "36:30.0", "41:50.0", "47:10.0", "52:30.0", "57:50.0",
      ]),
    ),
  );

  assert.deepEqual(result.raceLapNumbers, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(result.riders[0].laps.map((lap) => lap.lapNumber), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("uses official race lap count when the timing table begins at lap 2", () => {
  const result = parseRaceHtml(
    "official-lap-count",
    raceHtml(
      ["2\u5468", "3\u5468", "4\u5468"],
      riderRow("1", "R-1", "Finisher", ["10:00.0", "15:10.0", "20:30.0"]),
      11,
    ),
  );

  assert.deepEqual(result.raceLapNumbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(result.riders[0].laps.map((lap) => lap.lapNumber), [2, 3, 4]);
});
