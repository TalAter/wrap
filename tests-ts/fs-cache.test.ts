import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchCached } from "../src/fs/cache.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

let realFetch: typeof fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(fn: (url: string) => Promise<Response>) {
  globalThis.fetch = ((input: string | URL | Request) =>
    fn(typeof input === "string" ? input : input.toString())) as typeof fetch;
}

describe("fetchCached", () => {
  test("fresh cache hit returns cached content without fetching", async () => {
    writeFileSync(join(TEST_HOME, "cached.json"), '{"from":"disk"}');
    let called = false;
    mockFetch(async () => {
      called = true;
      return new Response("should not be used");
    });

    const result = await fetchCached({
      url: "https://example.com/data.json",
      path: "cached.json",
      ttlMs: 60_000,
    });

    expect(result).toEqual({ stale: false, content: '{"from":"disk"}' });
    expect(called).toBe(false);
  });

  test("cache miss fetches network and writes cache", async () => {
    mockFetch(async () => new Response('{"from":"network"}'));

    const result = await fetchCached({
      url: "https://example.com/data.json",
      path: "cache/models.dev.json",
      ttlMs: 60_000,
    });

    expect(result).toEqual({ stale: false, content: '{"from":"network"}' });
    expect(readFileSync(join(TEST_HOME, "cache/models.dev.json"), "utf-8")).toBe(
      '{"from":"network"}',
    );
  });

  test("stale cache with network success refetches and overwrites", async () => {
    writeFileSync(join(TEST_HOME, "stale.json"), '{"old":true}');
    const past = new Date(Date.now() - 120_000);
    utimesSync(join(TEST_HOME, "stale.json"), past, past);
    mockFetch(async () => new Response('{"new":true}'));

    const result = await fetchCached({
      url: "https://example.com/data.json",
      path: "stale.json",
      ttlMs: 60_000,
    });

    expect(result).toEqual({ stale: false, content: '{"new":true}' });
  });

  test("stale cache + network failure returns stale content", async () => {
    writeFileSync(join(TEST_HOME, "offline.json"), '{"last":"known"}');
    const past = new Date(Date.now() - 120_000);
    utimesSync(join(TEST_HOME, "offline.json"), past, past);
    mockFetch(async () => {
      throw new Error("network down");
    });

    const result = await fetchCached({
      url: "https://example.com/data.json",
      path: "offline.json",
      ttlMs: 60_000,
    });

    expect(result).toEqual({ stale: true, content: '{"last":"known"}' });
  });

  test("no cache + network failure throws", async () => {
    mockFetch(async () => {
      throw new Error("network down");
    });

    await expect(
      fetchCached({
        url: "https://example.com/data.json",
        path: "missing.json",
        ttlMs: 60_000,
      }),
    ).rejects.toThrow();
  });

  test("no cache + non-OK response throws and does not write cache", async () => {
    mockFetch(async () => new Response("not found", { status: 404 }));

    await expect(
      fetchCached({
        url: "https://example.com/data.json",
        path: "should-not-exist.json",
        ttlMs: 60_000,
      }),
    ).rejects.toThrow();
    expect(existsSync(join(TEST_HOME, "should-not-exist.json"))).toBe(false);
  });

  test("creates cache subdirectories lazily", async () => {
    mockFetch(async () => new Response("ok"));

    await fetchCached({
      url: "https://example.com/data.json",
      path: "cache/nested/deep.json",
      ttlMs: 60_000,
    });

    expect(existsSync(join(TEST_HOME, "cache/nested/deep.json"))).toBe(true);
  });
});
