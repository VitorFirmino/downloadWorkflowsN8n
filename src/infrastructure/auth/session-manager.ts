import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { waitForSelector } from "../browser/playwright-browser.service";
import { N8nSelectors } from "../n8n/n8n-selectors";
import type { BrowserContextResult } from "../../domain/types";


export const createPersistentContext = async (
  headless: boolean,
  sessionDir: string,
): Promise<BrowserContextResult> => {
  try {
    const context = await chromium.launchPersistentContext(sessionDir, {
      headless,
      acceptDownloads: true,
    });

    const page = context.pages()[0] ?? (await context.newPage());
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
