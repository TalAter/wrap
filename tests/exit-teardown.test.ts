import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SHOW_CURSOR } from "../src/core/ansi.ts";
import {
  _resetExitTeardownRegistryForTests,
  registerExitTeardown,
} from "../src/core/spinner.ts";

let originalOn: typeof process.on;
let originalWrite: typeof process.stderr.write;
let originalIsTTY: boolean | undefined;
let exitListeners: Array<() => void>;
let sigintListeners: Array<() => void>;
let sigtermListeners: Array<() => void>;
let writes: string[];

beforeEach(() => {
  _resetExitTeardownRegistryForTests();
  originalOn = process.on.bind(process);
  originalWrite = process.stderr.write.bind(process.stderr);
  originalIsTTY = process.stderr.isTTY;
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  exitListeners = [];
  sigintListeners = [];
  sigtermListeners = [];
  process.on = ((event: string, listener: () => void) => {
    if (event === "exit") exitListeners.push(listener);
    else if (event === "SIGINT") sigintListeners.push(listener);
    else if (event === "SIGTERM") sigtermListeners.push(listener);
    return process;
  }) as typeof process.on;
  writes = [];
  process.stderr.write = ((s: string) => {
    writes.push(s);
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.on = originalOn;
  process.stderr.write = originalWrite;
  Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
});

describe("registerExitTeardown", () => {
  test("first registration installs process listeners exactly once", () => {
    registerExitTeardown("\x1b[<u");
    registerExitTeardown("\x1b[?25h");
    expect(exitListeners.length).toBe(1);
    expect(sigintListeners.length).toBe(1);
    expect(sigtermListeners.length).toBe(1);
  });

  test("registered bytes are written on exit", () => {
    registerExitTeardown("\x1b[<u");
    registerExitTeardown(SHOW_CURSOR);
    writes.length = 0;
    for (const l of exitListeners) l();
    const joined = writes.join("");
    expect(joined).toContain("\x1b[<u");
    expect(joined).toContain(SHOW_CURSOR);
  });

  test("unregister removes the subscriber before teardown fires", () => {
    const unregister = registerExitTeardown("\x1b[<u");
    registerExitTeardown(SHOW_CURSOR);
    unregister();
    writes.length = 0;
    for (const l of exitListeners) l();
    const joined = writes.join("");
    expect(joined).not.toContain("\x1b[<u");
    expect(joined).toContain(SHOW_CURSOR);
  });

  test("teardown is a no-op when stderr is not a TTY", () => {
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    registerExitTeardown("\x1b[<u");
    writes.length = 0;
    for (const l of exitListeners) l();
    expect(writes.join("")).toBe("");
  });
});
