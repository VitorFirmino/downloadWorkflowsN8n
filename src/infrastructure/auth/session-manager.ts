import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { waitForSelector } from "../browser/playwright-browser.service";
import { N8nSelectors } from "../n8n/n8n-selectors";
import type { BrowserContextResult } from "../../domain/types";

const STARTUP_PAGES_TO_CLOSE = [
  "about:blank",
  "chrome://new-tab-page/",
  "chrome://newtab/",
  "chrome://welcome/",
  "chrome://password-manager/",
  "chrome://settings/passwords",
];

const shouldCloseStartupPage = (url: string): boolean => {
  const normalized = url.trim().toLowerCase();
  return STARTUP_PAGES_TO_CLOSE.some((prefix) => normalized.startsWith(prefix));
};

const setNestedValue = (
  target: Record<string, unknown>,
  dottedPath: string,
  value: unknown,
) => {
  const keys = dottedPath.split(".");
  let cursor: Record<string, unknown> = target;

  keys.forEach((key, index) => {
    const isLast = index === keys.length - 1;
    if (isLast) {
      cursor[key] = value;
      return;
    }

    const next = cursor[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  });
};

const prepareChromiumProfilePreferences = async (
  sessionDir: string,
): Promise<void> => {
  const profileDir = path.join(sessionDir, "Default");
  const preferencesPath = path.join(profileDir, "Preferences");

  await fs.mkdir(profileDir, { recursive: true });

  let preferences: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(preferencesPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      preferences = parsed as Record<string, unknown>;
    }
  } catch {
    preferences = {};
  }

  setNestedValue(preferences, "credentials_enable_service", false);
  setNestedValue(preferences, "profile.password_manager_enabled", false);
  setNestedValue(preferences, "profile.password_manager_leak_detection", false);
  setNestedValue(preferences, "profile.exited_cleanly", true);
  setNestedValue(preferences, "profile.exit_type", "Normal");
  setNestedValue(preferences, "session.restore_on_startup", 5);
  setNestedValue(preferences, "autofill.enabled", false);
  setNestedValue(preferences, "autofill.profile_enabled", false);
  setNestedValue(preferences, "autofill.credit_card_enabled", false);

  await fs.writeFile(preferencesPath, JSON.stringify(preferences, null, 2));

  await Promise.all(
    [
      path.join(profileDir, "Last Session"),
      path.join(profileDir, "Last Tabs"),
      path.join(profileDir, "Current Session"),
      path.join(profileDir, "Current Tabs"),
    ].map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})),
  );
};

const sanitizeContextPages = async (context: BrowserContext): Promise<Page> => {
  const pages = context.pages();
  let mainPage = pages.find((page) => !shouldCloseStartupPage(page.url()));

  if (!mainPage) {
    mainPage = pages[0] ?? (await context.newPage());
  }

  for (const page of pages) {
    if (page === mainPage) continue;
    if (shouldCloseStartupPage(page.url())) {
      await page.close().catch(() => {});
    }
  }

  return mainPage;
};

export const createPersistentContext = async (
  headless: boolean,
  sessionDir: string,
): Promise<BrowserContextResult> => {
  try {
    await prepareChromiumProfilePreferences(sessionDir);

    const context = await chromium.launchPersistentContext(sessionDir, {
      headless,
      acceptDownloads: true,
      args: [
        "--disable-session-crashed-bubble",
        "--hide-crash-restore-bubble",
        "--disable-save-password-bubble",
        "--disable-sync",
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "--disable-features=PasswordLeakDetection,PasswordManagerOnboarding,PasswordCheck,PasswordManagerEnabled,EnablePasswordsAccountStorage,AutofillServerCommunication",
      ],
    });

    context.on("page", (popup) => {
      const popupUrl = popup.url().toLowerCase();
      if (
        popupUrl.startsWith("chrome://password-manager") ||
        popupUrl.startsWith("chrome://settings/passwords")
      ) {
        void popup.close().catch(() => {});
      }
    });
    context.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => {});
    });

    const page = await sanitizeContextPages(context);
    const browser = context.browser();

    if (!browser) {
      throw new Error("Browser instance not available on persistent context");
    }

    return { context, page, browser };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create persistent context: ${message}`);
  }
};


export const closeContextAndSaveCookies = async (
  context: BrowserContext,
  browser: Awaited<ReturnType<typeof chromium.launch>>,
): Promise<void> => {
  try {
    await context.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to close browser context: ${message}`);
  }

  try {
    await browser.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to close browser: ${message}`);
  }
};


export const isSessionValid = async (
  page: Page,
  baseUrl: string,
  timeout: number,
): Promise<boolean> => {
  try {
    const workflowsUrl = `${baseUrl}/home/workflows`;

    const response = await page.goto(workflowsUrl, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(timeout, 10_000), 
    });

    
    if (response?.url().includes("/signin")) {
      return false;
    }

    const hasList = await waitForSelector(page, N8nSelectors.resourcesList, 5_000)
      .then(() => true)
      .catch(() => false);
    if (hasList) return true;

    const createButton = page
      .getByRole("button", { name: /create workflow/i })
      .first();
    const createCount = await createButton.count().catch(() => 0);
    if (createCount > 0) return true;

    return false;
  } catch (error) {
    
    if (error instanceof Error) {
      if (
        error.message.includes("closed") ||
        error.message.includes("Target closed")
      ) {
        return false;
      }
    }
    return false;
  }
};


export const clearSession = async (sessionDir: string): Promise<void> => {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fullPath = path.resolve(sessionDir);
    if (!fs.existsSync(fullPath)) return;
    fs.rmSync(fullPath, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to clear session: ${message}`);
  }
};
