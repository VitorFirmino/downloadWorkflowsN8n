import type { Page } from "playwright";
import type { LoginCredentials } from "../../domain/types";
import { AuthenticationError } from "../../domain/errors";
import {
  getAllLocators,
  fillInput,
  clickByRole,
  waitForURL,
  navigate,
  waitForSelector,
} from "../../infrastructure/browser/playwright-browser.service";
import { N8nSelectors, N8nUrls } from "../../infrastructure/n8n/n8n-selectors";

interface LoginOptions {
  readonly baseUrl: string;
  readonly credentials: LoginCredentials;
  readonly timeout: number;
}


const fillEmail = async (
  page: Page,
  email: string,
  timeout: number,
): Promise<void> => {
  try {
    
    await waitForSelector(page, N8nSelectors.emailInput, timeout);

    const emailInputs = await getAllLocators(page, N8nSelectors.emailInput);
    if (emailInputs.length === 0) {
      
      const emailByRole = page.getByRole("textbox", { name: /email/i }).first();
      const count = await emailByRole.count();
      if (count > 0) {
        await emailByRole.fill(email);
        return;
      }
      throw new AuthenticationError("Email input not found after waiting");
    }
    await emailInputs[0].fill(email);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AuthenticationError(`Failed to fill email: ${message}`, error);
  }
};


const fillPassword = async (
  page: Page,
  password: string,
  timeout: number,
): Promise<void> => {
  await waitForSelector(page, N8nSelectors.passwordInput, timeout);
  await fillInput(page, N8nSelectors.passwordInput, password);
};


const clickLoginButton = async (page: Page): Promise<void> => {
  await clickByRole(page, "button", /sign in|login/i);
};


const waitForRedirect = async (page: Page, timeout: number): Promise<void> => {
  await Promise.any([
    waitForURL(page, "**/home/workflows", timeout),
    waitForURL(page, "**/projects/**/workflows", timeout),
  ]);
};


export const executeLogin = async (
  page: Page,
  options: LoginOptions,
): Promise<void> => {
  const { baseUrl, credentials, timeout } = options;
  const { email, password } = credentials;

  try {
    const signinUrl = `${baseUrl}${N8nUrls.signin}`;

    await navigate(page, signinUrl, { waitUntil: "networkidle" });

    await fillEmail(page, email, timeout);

    const passwordVisible = await page
      .locator(N8nSelectors.passwordInput)
      .first()
      .isVisible()
      .catch(() => false);
    if (!passwordVisible) {
      await clickLoginButton(page);
    }

    await fillPassword(page, password, timeout);

    await Promise.all([waitForRedirect(page, timeout), clickLoginButton(page)]);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AuthenticationError(`Login failed: ${message}`, error);
  }
};
