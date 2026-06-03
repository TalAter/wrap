import { tmpdir } from "node:os";
import { getConfig } from "../config/store.ts";
import { chrome } from "../core/output.ts";
import {
  type DeleteResult,
  deleteCache,
  deleteLogs,
  deleteMemory,
  deleteScratch,
} from "./forget-delete.ts";
import {
  cacheFootprint,
  type Footprint,
  logsFootprint,
  memoryFootprint,
  scratchFootprint,
} from "./forget-footprint.ts";
import type { Command } from "./types.ts";

type Bucket = "memory" | "logs" | "cache" | "scratch";

export const forgetCmd: Command = {
  kind: "command",
  flag: "--forget",
  id: "forget",
  description: "Delete persisted user data (memory, logs, cache, temp files)",
  usage: "w --forget [--yolo]",
  help: [
    "Interactive multi-select dialog. Select which of the four buckets to wipe:",
    "  Memory        ~/.wrap/memory.json + ~/.wrap/tool-watchlist.json",
    "  Logs          ~/.wrap/logs/ (wrap.jsonl + trace sidecars)",
    "  Cache         ~/.wrap/cache/",
    "  Temp files    $TMPDIR/wrap-scratch-*",
    "",
    "--yolo skips the dialog and deletes all four.",
    "config.jsonc is never touched — use `rm` if you want it gone.",
  ].join("\n"),
  run: async (args) => {
    const yolo = getConfig().yolo || args.includes("--yolo");
    const remaining = args.filter((a) => a !== "--yolo");
    if (remaining.length > 0) {
      chrome("--forget cannot be combined with a prompt.");
      process.exit(1);
    }

    const tmpBase = tmpdir();

    const footprints = {
      memory: memoryFootprint(),
      logs: logsFootprint(),
      cache: cacheFootprint(),
      scratch: scratchFootprint(tmpBase),
    };

    let selected: Bucket[];
    if (yolo) {
      selected = ["memory", "logs", "cache", "scratch"];
    } else {
      if (!process.stdin.isTTY) {
        chrome("Forget error: --forget requires a TTY or --yolo.");
        process.exit(1);
      }
      const values = await showDialog(footprints);
      if (values === null || values.length === 0) return;
      selected = values as Bucket[];
    }

    const results = performDeletes(selected, tmpBase);

    let anyFailure = false;
    let anyRemoved = false;
    for (const r of results) {
      if (r.removed) anyRemoved = true;
      for (const path of r.errors) {
        chrome(`Forget error: could not remove ${path}.`);
        anyFailure = true;
      }
    }

    if (anyRemoved) {
      chrome(formatForgotten());
    }
    if (anyFailure) process.exit(1);
  },
};

function performDeletes(selected: Bucket[], tmpBase: string): DeleteResult[] {
  const out: DeleteResult[] = [];
  for (const bucket of selected) {
    switch (bucket) {
      case "memory":
        out.push(deleteMemory());
        break;
      case "logs":
        out.push(deleteLogs());
        break;
      case "cache":
        out.push(deleteCache());
        break;
      case "scratch":
        out.push(deleteScratch(tmpBase));
        break;
    }
  }
  return out;
}

function formatForgotten(): string {
  const nerd = getConfig().nerdFonts;
  const icon = nerd ? "\uf1f8" : "🗑️";
  return `${icon} Forgotten.`;
}

async function showDialog(footprints: {
  memory: Footprint;
  logs: Footprint;
  cache: Footprint;
  scratch: Footprint;
}): Promise<string[] | null> {
  const [react, forgetDialog, tui] = await Promise.all([
    import("react"),
    import("../tui/forget-dialog.tsx"),
    import("wrap-core/tui").then(async (m) => {
      await m.preloadDialogRuntime();
      return m;
    }),
  ]);
  const { ForgetDialog } = forgetDialog;
  const { ThemeProvider, openDialog } = tui;
  const { getTheme } = await import("../core/theme.ts");

  return openDialog<string[] | null>((close) =>
    react.createElement(ThemeProvider, {
      theme: getTheme(),
      nerdFonts: getConfig().nerdFonts ?? false,
      children: react.createElement(ForgetDialog, {
        footprints,
        onSubmit: close,
        onCancel: () => close(null),
      }),
    }),
  );
}
