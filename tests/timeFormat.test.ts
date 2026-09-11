import assert from "node:assert/strict";
import test from "node:test";
import { parseClockToSec } from "../lib/timeFormat.js";

test("parses minute clocks with optional tenths", () => {
  assert.equal(parseClockToSec("14:32.2"), 872.2);
  assert.equal(parseClockToSec("57:35"), 3455);
});

test("parses hour-prefixed clocks with optional tenths", () => {
  assert.equal(parseClockToSec("1:03:09.2"), 3789.2);
  assert.equal(parseClockToSec("1:03:45.6"), 3825.6);
});

test("rejects malformed or out-of-range clock values", () => {
  assert.equal(parseClockToSec(""), null);
  assert.equal(parseClockToSec("1:60.0"), null);
  assert.equal(parseClockToSec("1:02:60.0"), null);
  assert.equal(parseClockToSec("1:2:03.0"), null);
});
