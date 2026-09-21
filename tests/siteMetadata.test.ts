import assert from "node:assert/strict";
import test from "node:test";
import { createSiteMetadata, shouldPublishSiteMetadata } from "../lib/siteMetadata.js";

test("publishes metadata only when discovery or collection changes data", () => {
  assert.equal(shouldPublishSiteMetadata(0, 0), false);
  assert.equal(shouldPublishSiteMetadata(1, 0), true);
  assert.equal(shouldPublishSiteMetadata(0, 1), true);
});

test("creates a UTC ISO timestamp for the public metadata artifact", () => {
  assert.deepEqual(
    createSiteMetadata(new Date("2026-09-21T07:19:14.000Z")),
    { updatedAt: "2026-09-21T07:19:14.000Z" },
  );
});
