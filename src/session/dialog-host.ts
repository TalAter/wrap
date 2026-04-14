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

type DialogModules = {
  ink: typeof import("ink");
  react: typeof import("react");
  ResponseDialog: typeof import("../tui/response-dialog.tsx").ResponseDialog;
  ConfigWizardDialog: typeof import("../tui/config-wizard-dialog.tsx").ConfigWizardDialog;
  ThemeProvider: typeof import("../tui/theme-context.tsx").ThemeProvider;
};

let cached: DialogModules | null = null;

/**
 * Lazy-load Ink + React + both dialog components. Idempotent.
 */
export async function preloadDialogModules(): Promise<void> {
  if (cached) return;
  const [ink, react, responseDialogModule, wizardModule, themeModule] = await Promise.all([
    import("ink"),
    import("react"),
    import("../tui/response-dialog.tsx"),
    import("../tui/config-wizard-dialog.tsx"),
    import("../tui/theme-context.tsx"),
  ]);
  cached = {
    ink,
    react,
    ResponseDialog: responseDialogModule.ResponseDialog,
    ConfigWizardDialog: wizardModule.ConfigWizardDialog,
    ThemeProvider: themeModule.ThemeProvider,
  };
}

export function mountResponseDialog(props: {
  state: AppState;
  dispatch: (e: AppEvent) => void;
}): DialogHost {
  if (!cached) {
    throw new Error("mountResponseDialog: preloadDialogModules() must resolve first");
  }
  const { ink, react, ResponseDialog, ThemeProvider: TP } = cached;
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
 * Mount the config wizard in Ink's alt-screen. Returns a promise that
 * resolves with the wizard result on success or `null` on user cancel.
 */
export async function mountConfigWizardDialog(callbacks: {
  fetchModels: () => Promise<ModelsDevData>;
  probeCliBinaries: () => Record<string, boolean>;
}): Promise<WizardResult | null> {
  if (!cached) await preloadDialogModules();
  // preloadDialogModules guarantees cached is populated
  const modules = cached;
  if (!modules) throw new Error("mountConfigWizardDialog: preloadDialogModules() failed");
  const { ink, react, ConfigWizardDialog, ThemeProvider: TP } = modules;

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

/** Test-only — clear the lazy module cache. */
export function resetDialogHostCache(): void {
  cached = null;
}
