import type { ProviderEntry } from "../config/config.ts";
import { getConfig } from "../config/store.ts";
import { getTheme } from "../core/theme.ts";
import type { WizardCallbacks } from "../tui/config-wizard-dialog.tsx";
import type { ModelsDevData } from "../wizard/models-filter.ts";
import type { AppEvent, AppState } from "./state.ts";

export type DialogHost = {
  rerender(props: {
    state: AppState;
    dispatch: (e: AppEvent) => void;
    continuationPrompt?: string;
  }): void;
  unmount(): void;
};

export type WizardResult = {
  entries: Record<string, ProviderEntry>;
  defaultProvider: string;
  nerdFonts?: boolean;
};

type ResponseModules = {
  ink: typeof import("ink");
  react: typeof import("react");
  ResponseDialog: typeof import("../tui/response-dialog.tsx").ResponseDialog;
  ThemeProvider: typeof import("wrap-core/tui").ThemeProvider;
  chooseDialogStdin: typeof import("wrap-core/tui").chooseDialogStdin;
  DIALOG_INK_OPTIONS: typeof import("wrap-core/tui").DIALOG_INK_OPTIONS;
};

type WizardModule = {
  ConfigWizardDialog: typeof import("../tui/config-wizard-dialog.tsx").ConfigWizardDialog;
};

let responseCached: ResponseModules | null = null;
let wizardCached: WizardModule | null = null;

/**
 * Lazy-load Ink + React + ResponseDialog. Fired in parallel with the first
 * LLM call so the await before a response dialog mount is free in practice.
 * Does NOT load the config wizard — that lives behind a separate first-run
 * path and is pulled lazily by `mountConfigWizardDialog`.
 */
export async function preloadResponseDialogModules(): Promise<void> {
  if (responseCached) return;
  const [ink, react, responseDialogModule, tuiModule] = await Promise.all([
    import("ink"),
    import("react"),
    import("../tui/response-dialog.tsx"),
    import("wrap-core/tui"),
  ]);
  responseCached = {
    ink,
    react,
    ResponseDialog: responseDialogModule.ResponseDialog,
    ThemeProvider: tuiModule.ThemeProvider,
    chooseDialogStdin: tuiModule.chooseDialogStdin,
    DIALOG_INK_OPTIONS: tuiModule.DIALOG_INK_OPTIONS,
  };
}

export function mountResponseDialog(props: {
  state: AppState;
  dispatch: (e: AppEvent) => void;
  continuationPrompt?: string;
}): DialogHost {
  if (!responseCached) {
    throw new Error("mountResponseDialog: preloadResponseDialogModules() must resolve first");
  }
  const {
    ink,
    react,
    ResponseDialog,
    ThemeProvider: TP,
    chooseDialogStdin,
    DIALOG_INK_OPTIONS,
  } = responseCached;
  const { stream: stdin, fd: ownedFd } = chooseDialogStdin();
  const nerdFonts = getConfig().nerdFonts ?? false;
  const mkTree = (p: typeof props) =>
    react.createElement(TP, {
      theme: getTheme(),
      nerdFonts,
      children: react.createElement(ResponseDialog, p),
    });
  const app = ink.render(mkTree(props), { ...DIALOG_INK_OPTIONS, stdin });
  return {
    rerender(nextProps) {
      app.rerender(mkTree(nextProps));
    },
    unmount() {
      app.unmount();
      if (ownedFd !== null && typeof (stdin as { destroy?: () => void }).destroy === "function") {
        (stdin as { destroy: () => void }).destroy();
      }
    },
  };
}

/**
 * Mount the config wizard in Ink's alt-screen. Ensures the shared response
 * runtime (ink/react/theme) is loaded, then lazy-imports the wizard module
 * on first call — keeps 68KB+ of wizard/animation code out of the hot path
 * where config already exists. Returns `null` on user cancel.
 */
export async function mountConfigWizardDialog(callbacks: {
  fetchModels: () => Promise<ModelsDevData>;
  probeCliBinaries: () => Record<string, boolean>;
}): Promise<WizardResult | null> {
  await preloadResponseDialogModules();
  if (!wizardCached) {
    const m = await import("../tui/config-wizard-dialog.tsx");
    wizardCached = { ConfigWizardDialog: m.ConfigWizardDialog };
  }
  // biome-ignore lint/style/noNonNullAssertion: populated by the awaits above
  const { ink, react, ThemeProvider: TP, chooseDialogStdin, DIALOG_INK_OPTIONS } = responseCached!;
  const { ConfigWizardDialog } = wizardCached;

  return new Promise<WizardResult | null>((resolve) => {
    const { stream: stdin, fd: ownedFd } = chooseDialogStdin();
    const cleanup = () => {
      app.unmount();
      if (ownedFd !== null && typeof (stdin as { destroy?: () => void }).destroy === "function") {
        (stdin as { destroy: () => void }).destroy();
      }
    };
    const props: WizardCallbacks = {
      ...callbacks,
      onDone: (result) => {
        cleanup();
        resolve(result);
      },
      onCancel: () => {
        cleanup();
        resolve(null);
      },
    };
    const app = ink.render(
      react.createElement(TP, {
        theme: getTheme(),
        nerdFonts: getConfig().nerdFonts ?? false,
        children: react.createElement(ConfigWizardDialog, props),
      }),
      { ...DIALOG_INK_OPTIONS, stdin },
    );
  });
}

/** Test-only — clear both lazy module caches. */
export function resetDialogHostCache(): void {
  responseCached = null;
  wizardCached = null;
}
