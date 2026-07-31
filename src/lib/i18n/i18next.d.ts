import type { en } from "./en";

// Typed keys for useTranslation()/t(): autocomplete and compile errors on
// unknown keys, driven by the English resource.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}
