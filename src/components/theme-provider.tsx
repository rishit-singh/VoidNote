"use client";

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react";

type Theme = "dark" | "light" | "system";

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined);
const themeChangeEvent = "voidnote:theme-change";

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
}: ThemeProviderProps) {
  const subscribe = useCallback((onChange: () => void) => {
    window.addEventListener("storage", onChange);
    window.addEventListener(themeChangeEvent, onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener(themeChangeEvent, onChange);
    };
  }, []);

  const getTheme = useCallback((): Theme => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      return saved === "light" || saved === "dark" || saved === "system" ? saved : defaultTheme;
    } catch {
      return defaultTheme;
    }
  }, [defaultTheme, storageKey]);

  // The server and hydration render use the same default. React reads the
  // browser's preference after subscribing, without copying it in an effect.
  const theme = useSyncExternalStore(subscribe, getTheme, () => defaultTheme);

  useEffect(() => {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const selectedTheme = theme === "system" ? (systemTheme.matches ? "dark" : "light") : theme;
      document.documentElement.classList.remove("light", "dark");
      document.documentElement.classList.add(selectedTheme);
    };

    applyTheme();
    systemTheme.addEventListener("change", applyTheme);
    return () => systemTheme.removeEventListener("change", applyTheme);
  }, [theme]);

  const setTheme = (nextTheme: Theme) => {
    try {
      window.localStorage.setItem(storageKey, nextTheme);
      window.dispatchEvent(new Event(themeChangeEvent));
    } catch (error) {
      console.error("Could not save theme preference:", error);
    }
  };

  return (
    <ThemeProviderContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};
