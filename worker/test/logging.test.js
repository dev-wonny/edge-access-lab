import { test } from "node:test";
import assert from "node:assert/strict";
import { log } from "../src/logging.js";

test("all levels identify the Worker and retain event context", () => {
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const records = [];
  try {
    for (const name of Object.keys(originals)) {
      console[name] = (line) => records.push({ name, entry: JSON.parse(line) });
    }
    for (const level of ["info", "warn", "error"]) {
      log[level]({ event: "test_event", requestId: "test-id", service: "spoof", runtime: "node" });
    }
  } finally {
    Object.assign(console, originals);
  }
  assert.deepEqual(records.map(r => r.name), ["log", "warn", "error"]);
  assert.deepEqual(records.map(r => r.entry.level), ["INFO", "WARN", "ERROR"]);
  for (const { entry } of records) {
    assert.equal(entry.service, "edge-access-lab-worker");
    assert.equal(entry.runtime, "cloudflare-workers");
    assert.equal(entry.component, "edge");
    assert.equal(entry.event, "test_event");
    assert.equal(entry.requestId, "test-id");
    assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
  }
});
