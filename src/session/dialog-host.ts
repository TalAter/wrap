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
  react: typeof import("react");
  ResponseDialog: typeof import("../tui/response-dialog.tsx").ResponseDialog;
  ThemeProvider: typeof import("wrap-core/tui").ThemeProvider;
  renderDialog: typeof import("wrap-core/tui").renderDialog;
  openDialog: typeof import("wrap-core/tui").openDialog;
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
  const [react, responseDialogModule, tuiModule] = await Promise.all([
    import("react"),
    import("../tui/response-dialog.tsx"),
    import("wrap-core/tui").then(async (m) => {
      // Warm Ink into wrap-core's cache in the same parallel batch so the
      // ink import still overlaps the first LLM call.
      await m.preloadDialogRuntime();
      return m;
    }),
  ]);
  responseCached = {
    react,
    ResponseDialog: responseDialogModule.ResponseDialog,
    ThemeProvider: tuiModule.ThemeProvider,
    renderDialog: tuiModule.renderDialog,
    openDialog: tuiModule.openDialog,
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
  const { react, ResponseDialog, ThemeProvider: TP, renderDialog } = responseCached;
  const nerdFonts = getConfig().nerdFonts ?? false;
  const mkTree = (p: typeof props) =>
    react.createElement(TP, {
      theme: getTheme(),
      nerdFonts,
      children: react.createElement(ResponseDialog, p),
    });
  const app = renderDialog(mkTree(props));
  return {
    rerender(nextProps) {
      app.rerender(mkTree(nextProps));
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
  const {
    react,
    ThemeProvider: TP,
    openDialog,
    // biome-ignore lint/style/noNonNullAssertion: populated by the awaits above
  } = responseCached!;
  const { ConfigWizardDialog } = wizardCached;

  return openDialog<WizardResult | null>((close) => {
    const props: WizardCallbacks = {
      ...callbacks,
      onDone: close,
      onCancel: () => close(null),
    };
    return react.createElement(TP, {
      theme: getTheme(),
      nerdFonts: getConfig().nerdFonts ?? false,
      children: react.createElement(ConfigWizardDialog, props),
    });
  });
}

/** Test-only — clear both lazy module caches. */
export function resetDialogHostCache(): void {
  responseCached = null;
  wizardCached = null;
}
