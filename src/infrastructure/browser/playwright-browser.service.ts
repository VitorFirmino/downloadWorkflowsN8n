import type { Page, Download, Locator } from "playwright";

interface NavigateOptions {
  readonly waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

interface ClickOptions {
  readonly timeout?: number;
}

interface ScrollOptions {
  readonly x?: number;
  readonly y?: number;
}


export const navigate = async (
  page: Page,
  url: string,
  options?: NavigateOptions,
): Promise<void> => {
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await page.goto(url, {
        waitUntil: options?.waitUntil ?? "networkidle",
        timeout: 60_000,
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }

      throw lastError;
    }
  }
};


export const waitForSelector = async (
  page: Page,
  selector: string,
  timeout?: number,
): Promise<void> => {
  await page.waitForSelector(selector, { timeout });
};


export const waitForURL = async (
  page: Page,
  pattern: string | RegExp | ((url: URL) => boolean),
  timeout?: number,
): Promise<void> => {
  await page.waitForURL(pattern as Parameters<Page["waitForURL"]>[0], {
    timeout,
  });
};


export const fillInput = async (
  page: Page,
  selector: string,
  value: string,
): Promise<void> => {
  await page.locator(selector).fill(value);
};


export const click = async (
  page: Page,
  selector: string,
  options?: ClickOptions,
): Promise<void> => {
  await page.locator(selector).click(options);
};


export const clickByRole = async (
  page: Page,
  role: "button" | "menuitem",
  name: string | RegExp,
): Promise<void> => {
  await page.getByRole(role, { name }).click();
};


export const getText = async (
  page: Page,
  selector: string,
): Promise<string> => {
  return page.locator(selector).innerText();
};


export const getAttribute = async (
  page: Page,
  selector: string,
  attribute: string,
): Promise<string | null> => {
  return page.locator(selector).getAttribute(attribute);
};


export const getLocator = (page: Page, selector: string): Locator => {
  return page.locator(selector);
};


export const scrollElement = async (
  page: Page,
  selector: string,
  options: ScrollOptions,
): Promise<void> => {
  const element = page.locator(selector);
  await element.evaluate((el, opts) => {
    el.scrollBy(opts.x ?? 0, opts.y ?? 0);
  }, options);
};


export const waitForDownload = async (
  page: Page,
  timeout?: number,
): Promise<Download> => {
  return page.waitForEvent("download", { timeout });
};


export const countElements = async (
  page: Page,
  selector: string,
): Promise<number> => {
  return page.locator(selector).count();
};


export const getAllLocators = async (
  page: Page,
  selector: string,
): Promise<Locator[]> => {
  const count = await countElements(page, selector);
  return Array.from({ length: count }, (_, i) => page.locator(selector).nth(i));
};
