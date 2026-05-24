/**
 * Tests for Hotfix 25 client-fetch-queue. Pins:
 *   • Concurrency ceiling is enforced (no more than MAX in flight).
 *   • Releases drain queued waiters in FIFO order.
 *   • Empty release is a no-op (defensive against pair-mismatched calls).
 *   • activeCount never goes below zero.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  acquireSlot,
  releaseSlot,
  __resetQueueForTests,
  __getQueueStateForTests,
  MAX_CONCURRENT_CLIENT_FETCHES,
} from "./client-fetch-queue";

beforeEach(() => {
  __resetQueueForTests();
});

describe("client-fetch-queue", () => {
  it("admits up to MAX_CONCURRENT_CLIENT_FETCHES callers without queueing", async () => {
    expect(MAX_CONCURRENT_CLIENT_FETCHES).toBe(3);
    await Promise.all([acquireSlot(), acquireSlot(), acquireSlot()]);
    expect(__getQueueStateForTests()).toEqual({
      activeCount: 3,
      queueLength: 0,
    });
  });

  it("queues overflow callers and releases them in FIFO order", async () => {
    await Promise.all([acquireSlot(), acquireSlot(), acquireSlot()]);

    const order: number[] = [];
    const w1 = acquireSlot().then(() => order.push(1));
    const w2 = acquireSlot().then(() => order.push(2));
    const w3 = acquireSlot().then(() => order.push(3));

    // Three queued; activeCount still capped at 3.
    await Promise.resolve();
    expect(__getQueueStateForTests()).toMatchObject({
      activeCount: 3,
      queueLength: 3,
    });

    // Release one — first waiter resolves.
    releaseSlot();
    await w1;
    expect(order).toEqual([1]);

    releaseSlot();
    await w2;
    expect(order).toEqual([1, 2]);

    releaseSlot();
    await w3;
    expect(order).toEqual([1, 2, 3]);
  });

  it("never lets activeCount drop below zero (defensive against pair-mismatch)", () => {
    releaseSlot();
    releaseSlot();
    releaseSlot();
    expect(__getQueueStateForTests().activeCount).toBe(0);
  });

  it("under sustained load, the in-flight count never exceeds the cap", async () => {
    let inFlight = 0;
    let peak = 0;
    async function task() {
      await acquireSlot();
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      releaseSlot();
    }
    await Promise.all(Array.from({ length: 12 }, () => task()));
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_CLIENT_FETCHES);
  });
});
