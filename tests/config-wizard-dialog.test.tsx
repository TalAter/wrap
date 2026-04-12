import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { ProviderEntry } from "../src/config/config.ts";
import { stripAnsi } from "../src/core/ansi.ts";
import { ConfigWizardDialog, type WizardCallbacks } from "../src/tui/config-wizard-dialog.tsx";
import type { ModelsDevData } from "../src/wizard/models-filter.ts";

const FIXTURE: ModelsDevData = {
  anthropic: {
    id: "anthropic",
    models: {
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        release_date: "2026-03-01",
      },
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        release_date: "2025-11-01",
      },
    },
  },
  openai: {
    id: "openai",
    models: {
      "gpt-5": {
        id: "gpt-5",
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        release_date: "2026-01-01",
      },
    },
  },
  ollama: {
    id: "ollama",
    models: {
      "llama3.2": {
        id: "llama3.2",
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        release_date: "2024-10-01",
      },
    },
  },
};

const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));

function makeCallbacks(overrides?: Partial<WizardCallbacks>): WizardCallbacks & {
  result: { entries: Record<string, ProviderEntry>; defaultProvider: string } | null;
  cancelled: boolean;
} {
  const state = { result: null as ReturnType<typeof makeCallbacks>["result"], cancelled: false };
  return {
    fetchModels: () => Promise.resolve(FIXTURE),
    probeCliBinaries: () => ({}),
    onDone: (entries, defaultProvider) => {
      state.result = { entries, defaultProvider };
    },
    onCancel: () => {
      state.cancelled = true;
    },
    ...overrides,
    get result() {
      return state.result;
    },
    get cancelled() {
      return state.cancelled;
    },
  };
}

describe("ConfigWizardDialog", () => {
  test("renders provider selection on initial mount", async () => {
    const cb = makeCallbacks();
    const { lastFrame } = render(<ConfigWizardDialog {...cb} />);
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("LLM provider");
    expect(text).toContain("SELECT API PROVIDER");
    expect(text).toContain("Anthropic");
    expect(text).toContain("setup wizard");
  });

  test("Esc on provider selection triggers cancel", async () => {
    const cb = makeCallbacks();
    const { stdin } = render(<ConfigWizardDialog {...cb} />);
    await wait();
    stdin.write("\x1b");
    await wait();
    expect(cb.cancelled).toBe(true);
  });

  test("single API provider happy path: select → key → model → done", async () => {
    const cb = makeCallbacks();
    const { stdin, lastFrame } = render(<ConfigWizardDialog {...cb} />);
    await wait();

    // Select Anthropic (first item, already highlighted) → Space to toggle
    stdin.write(" ");
    await wait();
    // Submit selection
    stdin.write("\r");
    await wait(100);

    // Should be on API key screen after models load
    let text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("API key");

    // Type a key
    stdin.write("sk-ant-test-key");
    await wait();
    // Submit key
    stdin.write("\r");
    await wait();

    // Should be on model picker
    text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("model");

    // Submit (accept default = first model)
    stdin.write("\r");
    await wait();

    // Single provider → auto-default → done
    expect(cb.result).not.toBeNull();
    expect(cb.result?.defaultProvider).toBe("anthropic");
    expect(cb.result?.entries.anthropic?.apiKey).toBe("sk-ant-test-key");
    expect(cb.result?.entries.anthropic?.model).toBe("claude-sonnet-4-6");
  });

  test("CLI tools section hidden when no binaries found", async () => {
    const cb = makeCallbacks({ probeCliBinaries: () => ({}) });
    const { lastFrame } = render(<ConfigWizardDialog {...cb} />);
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).not.toContain("Claude Code");
  });

  test("CLI tools section shown when claude binary detected", async () => {
    const cb = makeCallbacks({
      probeCliBinaries: () => ({ "claude-code": true }),
    });
    const { lastFrame } = render(<ConfigWizardDialog {...cb} />);
    await wait();
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("Claude Code");
  });

  test("loading screen shows spinner text", async () => {
    let resolveModels: ((data: ModelsDevData) => void) | undefined;
    const fetchModels = () =>
      new Promise<ModelsDevData>((resolve) => {
        resolveModels = resolve;
      });
    const cb = makeCallbacks({ fetchModels });
    const { stdin, lastFrame } = render(<ConfigWizardDialog {...cb} />);
    await wait();

    // Select Anthropic + submit
    stdin.write(" ");
    await wait();
    stdin.write("\r");
    await wait();

    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("Loading models");

    // Resolve the fetch
    resolveModels?.(FIXTURE);
    await wait();
    expect(stripAnsi(lastFrame() ?? "")).toContain("API key");
  });
});
