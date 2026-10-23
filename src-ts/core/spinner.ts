import {
  startChromeSpinner as coreStartChromeSpinner,
  registerExitTeardown,
  resetExitGuard,
  SPINNER_FRAMES,
  SPINNER_INTERVAL,
  SPINNER_TEXT,
} from "wrap-core/chrome";
import { getConfig } from "../config/store.ts";

// Spinner + exit-guard plumbing lives in wrap-core/chrome (shared with sweep).
// Re-exported here so wrap's callers keep importing from `../core/spinner.ts`.
export { registerExitTeardown, resetExitGuard, SPINNER_FRAMES, SPINNER_INTERVAL, SPINNER_TEXT };

/** Test-only — delegates to wrap-core's `resetExitGuard`. */
export function _resetExitTeardownRegistryForTests(): void {
  resetExitGuard();
}

/**
 * Stderr chrome spinner. Thin wrapper over the wrap-core spinner that injects
 * wrap's `config.noAnimation` policy (CLI flag, WRAP_NO_ANIMATION, CI,
 * TERM=dumb, NO_COLOR — folded at config resolve time). See the wrap-core
 * implementation for the rendering/teardown contract.
 */
export function startChromeSpinner(text: string): () => void {
  return coreStartChromeSpinner(text, { noAnimation: getConfig().noAnimation });
}
