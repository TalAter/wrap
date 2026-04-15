import { defaultTheme, extendTheme, ThemeProvider as InkUIThemeProvider } from "@inkjs/ui";
import { createContext, useContext } from "react";
import { getTheme, type ThemeTokens, themeHex } from "../core/theme.ts";

const ThemeContext = createContext<ThemeTokens | null>(null);

function buildInkUITheme(t: ThemeTokens) {
  const focused = themeHex(t.text.primary);
  const idle = themeHex(t.text.secondary);
  const selected = themeHex(t.select.selected);
  return extendTheme(defaultTheme, {
    components: {
      Select: {
        styles: {
          focusIndicator: () => ({ color: focused }),
          selectedIndicator: () => ({ color: selected }),
          label: ({ isFocused, isSelected }: { isFocused: boolean; isSelected: boolean }) => ({
            color: isFocused ? focused : isSelected ? selected : idle,
          }),
        },
      },
    },
  });
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const tokens = getTheme();
  return (
    <ThemeContext.Provider value={tokens}>
      <InkUIThemeProvider theme={buildInkUITheme(tokens)}>{children}</InkUIThemeProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeTokens {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme() must be inside <ThemeProvider>");
  return theme;
}
