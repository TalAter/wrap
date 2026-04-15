import type { ProviderEntry } from "../config/config.ts";
import type { WizardCallbacks } from "../tui/config-wizard-dialog.tsx";
import type { ModelsDevData } from "../wizard/models-filter.ts";
import type { AppEvent, AppState } from "./state.ts";

export type DialogHost = {
  rerender(props: { state: AppState; dispatch: (e: AppEvent) => void }): void;
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
  ThemeProvider: typeof import("../tui/theme-context.tsx").ThemeProvider;
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
  const [ink, react, responseDialogModule, themeModule] = await Promise.all([
    import("ink"),
    import("react"),
    import("../tui/response-dialog.tsx"),
    import("../tui/theme-context.tsx"),
  ]);
  responseCached = {
    ink,
    react,
    ResponseDialog: responseDialogModule.ResponseDialog,
    ThemeProvider: themeModule.ThemeProvider,
  };
}

export function mountResponseDialog(props: {
  state: AppState;
  dispatch: (e: AppEvent) => void;
}): DialogHost {
  if (!responseCached) {
    throw new Error("mountResponseDialog: preloadResponseDialogModules() must resolve first");
  }
  const { ink, react, ResponseDialog, ThemeProvider: TP } = responseCached;
  const app = ink.render(
    react.createElement(TP, null, react.createElement(ResponseDialog, props)),
    {
      stdout: process.stderr,
      patchConsole: false,
      alternateScreen: true,
    },
  );
  return {
    rerender(nextProps) {
      app.rerender(react.createElement(TP, null, react.createElement(ResponseDialog, nextProps)));
    },
    unmount() {
      app.unmount();
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
  const { ink, react, ThemeProvider: TP } = responseCached!;
  const { ConfigWizardDialog } = wizardCached;

  return new Promise<WizardResult | null>((resolve) => {
    const props: WizardCallbacks = {
      ...callbacks,
      onDone: (result) => {
        app.unmount();
        resolve(result);
      },
      onCancel: () => {
        app.unmount();
        resolve(null);
      },
    };
    const app = ink.render(
      react.createElement(TP, null, react.createElement(ConfigWizardDialog, props)),
      {
        stdout: process.stderr,
        patchConsole: false,
        alternateScreen: true,
      },
    );
  });
}

/** Test-only — clear both lazy module caches. */
export function resetDialogHostCache(): void {
  responseCached = null;
  wizardCached = null;
}
