import { useEffect, useState } from "react";

// Two-cell braille frames so the spinner sits in a fixed slot inside the
// dialog's bottom border without shifting the trailing dashes each tick.
export const SPINNER_FRAMES = ["⢎ ", "⠎⠁", "⠊⠑", "⠈⠱", " ⡱", "⢀⡰", "⢄⡠", "⢆⡀"];
export const SPINNER_INTERVAL = 80; // ms

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
  // index is always 0..len-1, so the lookup is never undefined; the fallback is a noUncheckedIndexedAccess satisfier.
  return SPINNER_FRAMES[index] ?? null;
}
