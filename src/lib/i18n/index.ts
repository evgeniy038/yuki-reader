import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { en } from "./en";
import { ru } from "./ru";

// UI language. English is the default and the fallback; Russian kicks in for
// a Russian browser or an explicit pick in Settings. The choice is cached in
// localStorage ("yuki-lang") by the detector — a stored pick wins over the
// browser language. UI language has nothing to do with BOOK language.
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ru: { translation: ru },
    },
    supportedLngs: ["en", "ru"],
    nonExplicitSupportedLngs: true,
    fallbackLng: "en",
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "yuki-lang",
    },
    interpolation: {
      escapeValue: false, // React already escapes; `{{count, number}}` is
      // formatted by i18next's built-in Intl formatter.
    },
    returnNull: false,
  });

// Keep <html lang> in sync for typography, hyphens and assistive tech.
const syncLangAttribute = (lng: string) => {
  document.documentElement.lang = lng;
};
syncLangAttribute(i18n.resolvedLanguage ?? "en");
i18n.on("languageChanged", syncLangAttribute);

export default i18n;
