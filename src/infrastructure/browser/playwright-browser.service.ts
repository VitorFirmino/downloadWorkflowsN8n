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

const BLOCKER_HEADLINES = [
  /restore pages?/i,
  /change (your )?password/i,
  /change password/i,
  /password checkup/i,
  /your password/i,
  /password (?:is )?(?:in danger|compromised|exposed|leaked)/i,
];

const BLOCKER_ACTIONS = [
  /close/i,
  /dismiss/i,
  /not now/i,
  /cancel/i,
  /ignore/i,
  /skip/i,
  /later/i,
  /ok/i,
  /entendi/i,
  /fechar/i,
];

const hasBlockingModal = async (page: Page): Promise<boolean> => {
  for (const pattern of BLOCKER_HEADLINES) {
    const visible = await page
      .getByText(pattern)
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) return true;
  }
  return false;
};

const clickBlockingAction = async (page: Page): Promise<boolean> => {
  const dialogScopedButtons = [
    '[role="dialog"] button:has-text("OK")',
    '[role="dialog"] button:has-text("Ok")',
    '[role="dialog"] button:has-text("Not now")',
    '[role="dialog"] button:has-text("Close")',
    '[role="dialog"] button:has-text("Dismiss")',
    '[role="dialog"] button:has-text("Fechar")',
  ];
  for (const selector of dialogScopedButtons) {
    const button = page.locator(selector).first();
    const visible = await button.isVisible().catch(() => false);
    if (!visible) continue;
    await button.click({ timeout: 1_500 }).catch(() => {});
    return true;
  }

  for (const name of BLOCKER_ACTIONS) {
    const button = page.getByRole("button", { name }).first();
    const visible = await button.isVisible().catch(() => false);
    if (!visible) continue;
    await button.click({ timeout: 1_500 }).catch(() => {});
    return true;
  }
  return false;
};

export const dismissBlockingModals = async (page: Page): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const blocked = await hasBlockingModal(page);
    if (!blocked) return;

    await page.keyboard.press("Escape").catch(() => {});
    const clicked = await clickBlockingAction(page);
    if (!clicked) {
      await page
        .evaluate(() => {
          const candidates = Array.from(
            document.querySelectorAll("button, [role='button']"),
          ) as HTMLElement[];
          const target = candidates.find((el) =>
            /ok|not now|close|dismiss|fechar/i.test(el.textContent ?? ""),
          );
          target?.click();
        })
        .catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};


export const navigate = async (
  page: Page,
  url: string,
  options?: NavigateOptions,
): Promise<void> => {
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await dismissBlockingModals(page);
      await page.goto(url, {
        waitUntil: options?.waitUntil ?? "networkidle",
        timeout: 60_000,
      });
      await dismissBlockingModals(page);
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
