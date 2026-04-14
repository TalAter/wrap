import { createContext, useContext } from "react";
import { getTheme, type ThemeTokens } from "../core/theme.ts";

const ThemeContext = createContext<ThemeTokens | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <ThemeContext.Provider value={getTheme()}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeTokens {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme() must be inside <ThemeProvider>");
  return theme;
}
