import type { CSSProperties } from "react";

export interface JurisdictionTheme {
  label: string;
  accent: string;
  accentSoft: string;
  accentSofter: string;
  border: string;
  text: string;
}

const DEFAULT_THEME: JurisdictionTheme = {
  label: "default",
  accent: "#7f1d1d",
  accentSoft: "#f6eded",
  accentSofter: "#fbf7f4",
  border: "#d7d0c0",
  text: "#17202a",
};

const THEMES_BY_JURISDICTION: Record<string, JurisdictionTheme> = {
  "United States": {
    label: "United States",
    accent: "#3f6f9d",
    accentSoft: "#eef5fb",
    accentSofter: "#f7fbfe",
    border: "#bfd5e8",
    text: "#2e5f89",
  },
  Germany: {
    label: "Germany",
    accent: "#9a7a24",
    accentSoft: "#f6f1df",
    accentSofter: "#fcfaf1",
    border: "#ded0a3",
    text: "#725b1f",
  },
  France: {
    label: "France",
    accent: "#75598d",
    accentSoft: "#f4eef8",
    accentSofter: "#fbf7fd",
    border: "#d9c8e3",
    text: "#674d7b",
  },
};

const SOURCE_TO_JURISDICTION: Record<string, string> = {
  "us-scotus": "United States",
  "de-bverfg": "Germany",
  "fr-conseil-constitutionnel": "France",
};

export function themeForJurisdiction(jurisdiction?: string | null) {
  return jurisdiction ? THEMES_BY_JURISDICTION[jurisdiction] ?? DEFAULT_THEME : DEFAULT_THEME;
}

export function themeForSource(sourceKey?: string | null) {
  return themeForJurisdiction(sourceKey ? SOURCE_TO_JURISDICTION[sourceKey] : null);
}

export function jurisdictionThemeStyle(theme: JurisdictionTheme): CSSProperties {
  return {
    "--country-accent": theme.accent,
    "--country-accent-soft": theme.accentSoft,
    "--country-accent-softer": theme.accentSofter,
    "--country-border": theme.border,
    "--country-text": theme.text,
  } as CSSProperties;
}
