import { invoke } from "@tauri-apps/api/core";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zh from "./locales/zh.json";

export type AppLocale = "zh" | "en";

export const LOCALE_STORAGE_KEY = "odot.locale";
export const PLAN_EXECUTION_MARKER = "[odot-plan-execution]";

function detectLocale(): AppLocale {
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored === "zh" || stored === "en") {
    return stored;
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

const initialLocale = detectLocale();
document.documentElement.lang = initialLocale;

void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en }
  },
  lng: initialLocale,
  fallbackLng: "zh",
  interpolation: {
    escapeValue: false
  }
});

async function syncBackendLocale(locale: AppLocale) {
  try {
    await invoke("set_app_locale", { locale });
  } catch {
    /* web-only dev */
  }
}

void syncBackendLocale(initialLocale);

export function getAppLocale(): AppLocale {
  return i18n.language === "en" ? "en" : "zh";
}

export async function setAppLocale(locale: AppLocale) {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  document.documentElement.lang = locale;
  await i18n.changeLanguage(locale);
  await syncBackendLocale(locale);
}

export function appT(key: string, options?: Record<string, unknown>) {
  return i18n.t(key, options);
}

export function buildPlanExecutionPrompt(planText: string) {
  return `${PLAN_EXECUTION_MARKER}\n\n${appT("agent.planExecutionRequirements")}\n\n${appT("agent.planContentLabel")}\n${planText}`;
}

export function recoveryActionLabel(id: string, fallback: string) {
  const key = `recoverAction.${id}`;
  const translated = appT(key);
  return translated === key ? fallback : translated;
}

export function recoveryActionDescription(id: string, fallback: string) {
  const key = `recoverAction.${id}Desc`;
  const translated = appT(key);
  return translated === key ? fallback : translated;
}

export default i18n;
