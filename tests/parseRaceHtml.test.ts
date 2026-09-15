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

function resultRaceHtml(rows: string, officialLapCount?: number): string {
  return `
    <h1 id="js__page_title">Historical meet</h1>
    <div id="ec_name">OLD1</div>
    ${officialLapCount ? `<dl><dt>&#x5468;&#x56de;&#x6570;</dt><dd>0.1+2.5km&#xD7;${officialLapCount}Lap</dd></dl>` : ""}
    <table class="table__result">
      <thead><tr><th>Rank</th><th>Rider</th><th>Time/Gap</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function resultRow(
  rank: string,
  name: string,
  timeOrGap: string,
  id?: string,
): string {
  const rider = id
    ? `<a href="/racer/${id}">${name}</a>`
    : name;
  return `<tr><td class="cell__rank">${rank}</td><td class="cell__rider">${rider}</td><td class="cell__timegap">${timeOrGap}</td></tr>`;
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

test("parses lap clock cells surrounded by HTML whitespace and indentation", () => {
  const result = parseRaceHtml(
    "whitespace-laps",
    raceHtml(
      ["1\u5468", "2\u5468", "3\u5468"],
      riderRow("\n\t1\r", "R-1", "Indented rider", [
        "\n\t10:00.0\r\n",
        "\n  15:10.0\t",
        "\r\n20:30.0\n",
      ]),
    ),
  );

  assert.deepEqual(result.riders[0]?.laps.map((lap) => lap.cumulativeTimeSec), [600, 910, 1230]);
  assert.equal(result.riders[0]?.dataQuality, "ok");
});

test("accepts the old lap table shape and uses its ordered header axis", () => {
  const result = parseRaceHtml(
    "old-shape",
    `
      <h1 id="js__page_title">Old meet</h1>
      <div id="ec_name">ME1</div>
      <table class="table__laptime">
        <thead><tr><th>Rank</th><th>Rider</th><th>2周</th><th>3周</th></tr></thead>
        <tbody>
          <tr><td>1</td><td><a href="/racer/OLD-1">Old rider</a></td><td>10:00.0</td><td>15:10.0</td></tr>
        </tbody>
      </table>
    `,
  );

  assert.deepEqual(result.raceLapNumbers, [2, 3]);
  assert.deepEqual(result.riders[0].laps.map((lap) => lap.lapNumber), [2, 3]);
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

test("retains the final checkpoint on a 24579-equivalent six-lap table", () => {
  const result = parseRaceHtml(
    "24579",
    raceHtml(
      ["1\u5468", "2\u5468", "3\u5468", "4\u5468", "5\u5468", "6\u5468"],
      riderRow("1", "R-24579", "Six lap rider", [
        "9:48.5", "19:54.3", "30:15.5", "40:47.2", "51:17.2", "1:01:43.4",
      ]),
    ),
  );

  assert.equal(result.raceLapNumbers?.length, 6);
  assert.equal(result.riders[0]?.laps.length, 6);
  assert.equal(result.riders[0]?.laps.at(-1)?.lapNumber, 6);
});

test("retains the final checkpoint on a 25888-equivalent eight-lap table", () => {
  const result = parseRaceHtml(
    "25888",
    raceHtml(
      ["1\u5468", "2\u5468", "3\u5468", "4\u5468", "5\u5468", "6\u5468", "7\u5468", "8\u5468"],
      riderRow("1", "R-25888", "Eight lap rider", [
        "8:00.0", "16:10.0", "24:20.0", "32:30.0", "40:40.0", "48:50.0", "57:00.0", "1:05:10.0",
      ]),
    ),
  );

  assert.equal(result.raceLapNumbers?.length, 8);
  assert.equal(result.riders[0]?.laps.length, 8);
  assert.equal(result.riders[0]?.laps.at(-1)?.lapNumber, 8);
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

test("keeps a longer numbered timing header when historical metadata is stale", () => {
  const result = parseRaceHtml(
    "historical-axis-conflict",
    raceHtml(
      ["1\u5468", "2\u5468", "3\u5468", "4\u5468"],
      riderRow("1", "R-1", "Historical rider", ["7:08.2", "13:59.8", "20:32.9", "27:12.7"]),
      3,
    ),
  );

  assert.deepEqual(result.raceLapNumbers, [1, 2, 3, 4]);
  assert.equal(result.riders[0]?.laps.at(-1)?.lapNumber, 4);
});

test("retains valid result-only rows without inferring a lap axis", () => {
  const result = parseRaceHtml(
    "historical-result-only",
    resultRaceHtml(
      [
        resultRow("1", "Winner", "1:02:03.4", "R-1"),
        resultRow("DNF", "Stopped", "DNF", "R-2"),
      ].join(""),
    ),
  );

  assert.equal(result.raceLapNumbers, undefined);
  assert.deepEqual(result.riders, [
    {
      riderId: "R-1",
      name: "Winner",
      finalPosition: 1,
      status: "finished",
      laps: [],
      dataQuality: "ok",
    },
    {
      riderId: "R-2",
      name: "Stopped",
      finalPosition: 2,
      status: "dnf",
      laps: [],
      dataQuality: "ok",
    },
  ]);
});

test("keeps the official axis for result-only pages when metadata is available", () => {
  const result = parseRaceHtml(
    "historical-result-only-axis",
    resultRaceHtml(resultRow("1", "Winner", "1:02:03.4", "R-1"), 3),
  );

  assert.deepEqual(result.raceLapNumbers, [1, 2, 3]);
  assert.deepEqual(result.riders[0].laps, []);
});

test("assigns deterministic race-scoped IDs when result links are missing", () => {
  const html = resultRaceHtml(
    [
      resultRow("1", "Same Name", "1:00.0"),
      resultRow("2", "Same Name", "+0:05.0"),
    ].join(""),
  );

  const first = parseRaceHtml("missing-link-race", html);
  const second = parseRaceHtml("missing-link-race", html);

  assert.deepEqual(first.riders.map((rider) => rider.riderId), [
    "race-missing-link-race-row-1",
    "race-missing-link-race-row-2",
  ]);
  assert.deepEqual(second.riders.map((rider) => rider.riderId), first.riders.map((rider) => rider.riderId));
});

test("excludes unsupported result statuses without mapping them to finished or DNF", () => {
  const result = parseRaceHtml(
    "historical-statuses",
    resultRaceHtml(
      [
        resultRow("1", "Finished", "1:00.0", "R-1"),
        resultRow("DNF", "Stopped", "DNF", "R-2"),
        resultRow("DNS", "Did not start", "", "R-3"),
        resultRow("DSQ", "Disqualified", "", "R-4"),
        resultRow("OTL", "Over time", "", "R-5"),
        resultRow("?", "Unknown", "", "R-6"),
        resultRow("FIN", "Finished open", "", "R-7"),
        resultRow("FIN/OPEN", "Finished open", "", "R-8"),
        resultRow("DNS/OPEN", "Open did not start", "", "R-9"),
        resultRow("DNF/OPEN", "Open DNF", "", "R-10"),
      ].join(""),
    ),
  );

  assert.deepEqual(
    result.riders.map(({ riderId, finalPosition, status, officialPositionLabel }) => ({
      riderId,
      finalPosition,
      status,
      officialPositionLabel,
    })),
    [
      { riderId: "R-1", finalPosition: 1, status: "finished", officialPositionLabel: undefined },
      { riderId: "R-2", finalPosition: 2, status: "dnf", officialPositionLabel: undefined },
    ],
  );
  assert.deepEqual(result.excludedRowsByStatus, {
    "?": 1,
    DNS: 1,
    "DNS/OPEN": 1,
    DSQ: 1,
    "DNF/OPEN": 1,
    FIN: 1,
    "FIN/OPEN": 1,
    OTL: 1,
  });
});

test("retains excluded status diagnostics when every lap row is unsupported", () => {
  const result = parseRaceHtml(
    "unsupported-lap-statuses",
    raceHtml(
      ["1周"],
      [
        riderRow("DNS", "R-1", "Did not start", [""]),
        riderRow("DSQ", "R-2", "Disqualified", [""]),
      ].join(""),
    ),
  );

  assert.deepEqual(result.riders, []);
  assert.deepEqual(result.excludedRowsByStatus, { DNS: 1, DSQ: 1 });
});

test("preserves lap-down riders as finished with only their measured laps", () => {
  const result = parseRaceHtml(
    "lap-down",
    raceHtml(
      ["1\u5468", "2\u5468", "3\u5468"],
      [
        riderRow("1", "R-1", "Leader", ["5:00.0", "10:00.0", "15:00.0"]),
        riderRow("2", "R-2", "Lap-down", ["5:30.0", "11:00.0"]),
      ].join(""),
      3,
    ),
  );

  assert.deepEqual(result.raceLapNumbers, [1, 2, 3]);
  assert.equal(result.riders[1].status, "finished");
  assert.equal(result.riders[1].finalPosition, 2);
  assert.deepEqual(result.riders[1].laps.map((lap) => lap.lapNumber), [1, 2]);
});

test("accepts annotated numeric ranks and preserves DOM text as the official label", () => {
  const result = parseRaceHtml(
    "annotated-ranks",
    raceHtml(
      ["1周", "2周"],
      [
        riderRow(" \t11 <span>(80%Out)</span> ", "R-11", "Eighty percent out", ["5:00.0", "10:00.0"]),
        riderRow("15 <span>LapOut</span>", "R-15", "Lap out", ["5:10.0", "10:20.0"]),
        riderRow("16 (club note)", "R-16", "Other note", ["5:20.0", "10:40.0"]),
      ].join(""),
    ),
  );

  assert.deepEqual(
    result.riders.map(({ riderId, finalPosition, status, officialPositionLabel }) => ({
      riderId,
      finalPosition,
      status,
      officialPositionLabel,
    })),
    [
      { riderId: "R-11", finalPosition: 11, status: "annotated-rank", officialPositionLabel: "11 (80%Out)" },
      { riderId: "R-15", finalPosition: 15, status: "annotated-rank", officialPositionLabel: "15 LapOut" },
      { riderId: "R-16", finalPosition: 16, status: "annotated-rank", officialPositionLabel: "16 (club note)" },
    ],
  );
});

test("does not backfill a missing final lap for annotated ranks", () => {
  const result = parseRaceHtml(
    "annotated-no-backfill",
    `${raceHtml(
      ["1周", "2周"],
      riderRow("11 (80%Out)", "R-11", "Annotated", ["5:00.0", ""]),
    )}
    <table class="table__result"><tbody>
      ${resultRow("11 (80%Out)", "Annotated", "1:00.0", "R-11")}
    </tbody></table>`,
  );

  assert.equal(result.riders[0]?.status, "annotated-rank");
  assert.deepEqual(result.riders[0]?.laps.map((lap) => lap.lapNumber), [1]);
});

test("accepts annotated ranks through the result-table fallback", () => {
  const result = parseRaceHtml(
    "annotated-result-only",
    resultRaceHtml(
      [
        resultRow("11 <span>LapOut</span>", "Lap out", "1:00.0", "R-11"),
        resultRow("DNF", "Stopped", "DNF", "R-12"),
      ].join(""),
    ),
  );

  assert.deepEqual(result.riders.map(({ riderId, finalPosition, status, officialPositionLabel }) => ({
    riderId,
    finalPosition,
    status,
    officialPositionLabel,
  })), [
    { riderId: "R-11", finalPosition: 11, status: "annotated-rank", officialPositionLabel: "11 LapOut" },
    { riderId: "R-12", finalPosition: 12, status: "dnf", officialPositionLabel: undefined },
  ]);
});

test("rejects malformed numeric rank prefixes and records diagnostics", () => {
  const result = parseRaceHtml(
    "invalid-ranks",
    raceHtml(
      ["1周"],
      [
        riderRow("0", "R-0", "Zero", [""]),
        riderRow("-1", "R-negative", "Negative", [""]),
        riderRow("LapOut", "R-no-prefix", "No prefix", [""]),
        riderRow("9007199254740992", "R-overflow", "Overflow", [""]),
        riderRow("", "R-empty", "Empty", [""]),
        riderRow("1\u0000LapOut", "R-control", "Control", [""]),
        riderRow("&lt;b&gt;1&lt;/b&gt;", "R-html", "HTML", [""]),
        riderRow("１ LapOut", "R-fullwidth", "Full width", [""]),
        riderRow("DNS", "R-dns", "DNS", [""]),
        riderRow("DSQ", "R-dsq", "DSQ", [""]),
        riderRow("OTL", "R-otl", "OTL", [""]),
      ].join(""),
    ),
  );

  assert.deepEqual(result.riders, []);
  const diagnostics = result.excludedRowsByStatus ?? {};
  const invalidRankLabels = [
    "",
    "-1",
    "0",
    "1\u0000LapOut",
    "<b>1</b>",
    "１ LapOut",
    "9007199254740992",
    "DNS",
    "DSQ",
    "LapOut",
    "OTL",
  ];
  assert.equal(Object.keys(diagnostics).length, invalidRankLabels.length);
  for (const label of invalidRankLabels) assert.equal(diagnostics[label], 1, label);
});

test("fails a timing table that has clock-like source values but no usable laps", () => {
  assert.throws(
    () =>
      parseRaceHtml(
        "invalid-timing-table",
        raceHtml(
          ["1\u5468", "2\u5468"],
          riderRow("1", "R-1", "Unsafe timing", ["10:00.0\u0000", "20:00.0\u0000"]),
        ),
      ),
    /clock-like values but no usable lap records/,
  );
});

test("keeps FIN/OPEN-only clock rows as an empty diagnostic result", () => {
  const result = parseRaceHtml(
    "open-only-timing-table",
    raceHtml(
      ["1\u5468", "2\u5468"],
      riderRow("FIN/OPEN", "R-open", "Finished open", ["10:00.0", "20:00.0"]),
    ),
  );

  assert.deepEqual(result.riders, []);
  assert.deepEqual(result.excludedRowsByStatus, { "FIN/OPEN": 1 });
});
