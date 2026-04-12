import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchCached } from "../src/core/cache.ts";
import { tmpHome } from "./helpers.ts";

let home: string;
let prevHome: string | undefined;
let realFetch: typeof fetch;

beforeEach(() => {
  home = tmpHome();
  prevHome = process.env.WRAP_HOME;
  process.env.WRAP_HOME = home;
  realFetch = globalThis.fetch;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.WRAP_HOME;
  else process.env.WRAP_HOME = prevHome;
  globalThis.fetch = realFetch;
});

function mockFetch(fn: (url: string) => Promise<Response>) {
  globalThis.fetch = ((input: string | URL | Request) =>
    fn(typeof input === "string" ? input : input.toString())) as typeof fetch;
}

describe("fetchCached", () => {
  test("fresh cache hit returns cached content without fetching", async () => {
    writeFileSync(join(home, "cached.json"), '{"from":"disk"}');
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
    expect(readFileSync(join(home, "cache/models.dev.json"), "utf-8")).toBe('{"from":"network"}');
  });

  test("stale cache with network success refetches and overwrites", async () => {
    writeFileSync(join(home, "stale.json"), '{"old":true}');
    // Backdate so mtime + ttlMs < now.
    const past = new Date(Date.now() - 120_000);
    utimesSync(join(home, "stale.json"), past, past);
    mockFetch(async () => new Response('{"new":true}'));

    const result = await fetchCached({
      url: "https://example.com/data.json",
      path: "stale.json",
      ttlMs: 60_000,
    });

    expect(result).toEqual({ stale: false, content: '{"new":true}' });
  });

  test("stale cache + network failure returns stale content", async () => {
    writeFileSync(join(home, "offline.json"), '{"last":"known"}');
    const past = new Date(Date.now() - 120_000);
    utimesSync(join(home, "offline.json"), past, past);
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
    expect(existsSync(join(home, "should-not-exist.json"))).toBe(false);
  });

  test("creates cache subdirectories lazily", async () => {
    mockFetch(async () => new Response("ok"));

    await fetchCached({
      url: "https://example.com/data.json",
      path: "cache/nested/deep.json",
      ttlMs: 60_000,
    });

    expect(existsSync(join(home, "cache/nested/deep.json"))).toBe(true);
  });
});
