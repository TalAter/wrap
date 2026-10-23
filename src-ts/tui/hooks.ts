import { getTheme } from "wrap-core/theme";
import { useTheme } from "wrap-core/tui";
import type { WrapTheme } from "../core/theme.ts";

export const useWrapTheme = () => useTheme() as WrapTheme;
export const getWrapTheme = () => getTheme() as WrapTheme;
