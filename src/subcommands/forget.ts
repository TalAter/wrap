import { tmpdir } from "node:os";
import { getConfig } from "../config/store.ts";
import { chrome } from "../core/output.ts";
import { getWrapHome } from "../fs/home.ts";
import {
  deleteCache,
  deleteLogs,
  deleteMemory,
  deleteScratch,
  type DeleteResult,
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
    "  Logs          ~/.wrap/logs/wrap.jsonl",
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

    const wrapHome = getWrapHome();
    const tmpBase = tmpdir();

    const footprints = {
      memory: memoryFootprint(wrapHome),
      logs: logsFootprint(wrapHome),
      cache: cacheFootprint(wrapHome),
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

    const results = performDeletes(selected, wrapHome, tmpBase);

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

function performDeletes(
  selected: Bucket[],
  wrapHome: string,
  tmpBase: string,
): DeleteResult[] {
  const out: DeleteResult[] = [];
  for (const bucket of selected) {
    switch (bucket) {
      case "memory":
        out.push(deleteMemory(wrapHome));
        break;
      case "logs":
        out.push(deleteLogs(wrapHome));
        break;
      case "cache":
        out.push(deleteCache(wrapHome));
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
  const [ink, react, forgetDialog, theme] = await Promise.all([
    import("ink"),
    import("react"),
    import("../tui/forget-dialog.tsx"),
    import("../tui/theme-context.tsx"),
  ]);
  const { ForgetDialog } = forgetDialog;
  const { ThemeProvider } = theme;

  return new Promise<string[] | null>((resolve) => {
    const onSubmit = (values: string[]) => {
      app.unmount();
      resolve(values);
    };
    const onCancel = () => {
      app.unmount();
      resolve(null);
    };
    const app = ink.render(
      react.createElement(
        ThemeProvider,
        null,
        react.createElement(ForgetDialog, { footprints, onSubmit, onCancel }),
      ),
      {
        stdout: process.stderr,
        patchConsole: false,
        alternateScreen: true,
      },
    );
  });
}
