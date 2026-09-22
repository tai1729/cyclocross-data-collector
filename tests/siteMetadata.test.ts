import assert from "node:assert/strict";
import test from "node:test";
import { createSiteMetadata } from "../lib/siteMetadata.js";

test("creates a UTC ISO timestamp for every successful collector run", () => {
  assert.deepEqual(
    createSiteMetadata(new Date("2026-09-21T07:19:14.000Z")),
    { updatedAt: "2026-09-21T07:19:14.000Z" },
  );
});
