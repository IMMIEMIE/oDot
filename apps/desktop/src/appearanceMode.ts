export type AppearanceMode = "float" | "window";

export const APPEARANCE_MODE_STORAGE_KEY = "odot.appearanceMode";

export function readAppearanceMode(): AppearanceMode {
  return localStorage.getItem(APPEARANCE_MODE_STORAGE_KEY) === "float" ? "float" : "window";
}

export function saveAppearanceMode(mode: AppearanceMode) {
  localStorage.setItem(APPEARANCE_MODE_STORAGE_KEY, mode);
}
