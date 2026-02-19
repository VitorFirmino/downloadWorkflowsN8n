import "dotenv/config";
import type { AppConfig } from "./domain/types";
import { ConfigurationError } from "./domain/errors";

const mustGetEnv = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new ConfigurationError(
      `Missing required environment variable: ${key}`,
    );
  }
  return value;
};

const toBool = (value: string | undefined): boolean => {
  return (value ?? "").toLowerCase() === "true";
};

const toNumber = (value: string | undefined, defaultValue: number): number => {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
};

const readOptional = (key: string): string | undefined => {
  const value = process.env[key]?.trim();
  return value || undefined;
};

const readRequired = (key: string): string => mustGetEnv(key);

const baseUrl = readRequired("N8N_BASE_URL");
const email = readRequired("N8N_EMAIL");
const password = readRequired("N8N_PASSWORD");

const targetBaseUrl =
  readOptional("N8N_BASE_URL_TARGET") ?? readOptional("N8N_BASE_URL_TWO");
const targetEmail =
  readOptional("N8N_EMAIL_TARGET") ?? readOptional("N8N_EMAIL_TWO");
const targetPassword =
  readOptional("N8N_PASSWORD_TARGET") ?? readOptional("N8N_PASSWORD_TWO");
const targetProjectId =
  readOptional("N8N_PROJECT_ID_TARGET") ?? readOptional("N8N_PROJECT_ID_TWO");

export const config: AppConfig = Object.freeze({
  baseUrl,
  email,
  password,
  targetBaseUrl,
  targetEmail,
  targetPassword,
  targetProjectId,
  headless: toBool(process.env.HEADLESS),
  exportDir: process.env.EXPORT_DIR?.trim() ?? "exports",
  scrollTimeout: toNumber(process.env.SCROLL_TIMEOUT, 60_000),
  scrollDelay: toNumber(process.env.SCROLL_DELAY, 1_200),
  scrollAmount: toNumber(process.env.SCROLL_AMOUNT, 180),
  scrollMaxRounds: toNumber(process.env.SCROLL_MAX_ROUNDS, 220),
  pageTimeout: toNumber(process.env.PAGE_TIMEOUT, 60_000),
  sessionDir:
    process.env.PLAYWRIGHT_SESSION_DIR?.trim() ?? ".playwright-session",
  targetSessionDir:
    process.env.PLAYWRIGHT_SESSION_DIR_TARGET?.trim() ??
    process.env.PLAYWRIGHT_SESSION_DIR_TWO?.trim(),
  rulesPath: process.env.N8N_RULES_PATH?.trim(),
  fallbackFolder: process.env.N8N_FALLBACK_FOLDER?.trim() ?? "Externo",
  importOnly: toBool(process.env.N8N_IMPORT_ONLY),
});
