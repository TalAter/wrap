import { useEffect, useState } from "react";
import { SPINNER_FRAMES, SPINNER_INTERVAL } from "../core/spinner.ts";

// Re-export so the dialog and tests have a single import path for spinner
// constants. The non-React `startChromeSpinner` lives in core/spinner.ts.
export { SPINNER_FRAMES, SPINNER_INTERVAL };

/**
 * React hook that returns the current spinner frame, advancing every
 * `SPINNER_INTERVAL` ms while `active` is true. Returns `null` when inactive
 * so callers narrow on `frame !== null` instead of conflating liveness with
 * the truthiness of a string (an empty/whitespace frame is still a frame).
 */
export function useSpinner(active: boolean): string | null {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return;
    const handle = setInterval(() => {
      setIndex((i) => (i + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL);
    return () => {
      clearInterval(handle);
    };
  }, [active]);
  if (!active) return null;
  // Index is bounded; the `?? null` satisfies noUncheckedIndexedAccess.
  return SPINNER_FRAMES[index] ?? null;
}
