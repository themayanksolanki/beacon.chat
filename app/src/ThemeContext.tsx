import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";

import { darkColors, lightColors, type ThemeColors } from "./theme";
import { loadThemePreference, saveThemePreference, type ThemePreference } from "./storage/themeStore";

type ThemeContextValue = {
  colors: ThemeColors;
  scheme: "light" | "dark";
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  colors: lightColors,
  scheme: "light",
  preference: "system",
  setPreference: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme() === "dark" ? "dark" : "light";
  const [preference, setPreferenceState] = useState<ThemePreference>("system");

  useEffect(() => {
    loadThemePreference().then(setPreferenceState);
  }, []);

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    void saveThemePreference(next);
  };

  const scheme = preference === "system" ? systemScheme : preference;
  const value = useMemo<ThemeContextValue>(
    () => ({ colors: scheme === "dark" ? darkColors : lightColors, scheme, preference, setPreference }),
    [scheme, preference]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
