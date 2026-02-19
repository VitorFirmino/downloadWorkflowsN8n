import path from "node:path";
import fs from "node:fs";
import type { Page, Download } from "playwright";
import type { WorkflowRef, DownloadResult } from "../../domain/types";
import {
  waitForDownload,
  clickByRole,
  navigate,
  waitForSelector,
  waitForURL,
} from "../../infrastructure/browser/playwright-browser.service";
import {
  ensureDirectory,
  generateFileName,
  joinPath,
} from "../../infrastructure/filesystem/file-system.service";
import { N8nSelectors } from "../../infrastructure/n8n/n8n-selectors";
import { delay } from "../../infrastructure/utils/delay";

const debugLog = (..._args: unknown[]): void => {};

interface DownloadWorkflowOptions {
  readonly exportDir: string;
  readonly timeout: number;
}


const extractExtension = (suggestedFilename: string): string => {
  if (suggestedFilename.toLowerCase().endsWith(".json")) {
    return ".json";
  }
  return path.extname(suggestedFilename) || ".json";
};


const openWorkflowMenu = async (page: Page): Promise<void> => {
  const selectors = [
    N8nSelectors.workflowMenu,
    ...N8nSelectors.workflowMenuFallbacks,
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;

    try {
      await locator.waitFor({ state: "visible", timeout: 2000 });
      await locator.click();
      return;
    } catch {
      
    }
  }

  
  const roleButton = page
    .getByRole("button", { name: /menu|more|actions|options/i })
    .first();
  const roleCount = await roleButton.count().catch(() => 0);
  if (roleCount > 0) {
    await roleButton.waitFor({ state: "visible", timeout: 2000 });
    await roleButton.click();
    return;
  }

  throw new Error("Workflow menu button not found");
};


const triggerDownload = async (
  page: Page,
  timeout: number,
): Promise<Download> => {
  
  const downloadMenuItem = page.getByRole("menuitem", { name: /download/i });
  await downloadMenuItem.waitFor({ state: "visible", timeout: 5000 });

  const downloadPromise = waitForDownload(page, timeout);
  await clickByRole(page, "menuitem", /download/i);
  return downloadPromise;
};


const saveDownloadFile = async (
  download: Download,
  ref: WorkflowRef,
  exportDir: string,
): Promise<string> => {
  const suggestedFilename = download.suggestedFilename();
  const extension = extractExtension(suggestedFilename);
  const fileName = generateFileName(ref, extension);
  const filePath = joinPath(exportDir, fileName);

  await download.saveAs(filePath);
  return filePath;
};


const downloadWithRetry = async (
  page: Page,
  ref: WorkflowRef,
  options: DownloadWorkflowOptions,
  maxRetries: number = 3,
): Promise<DownloadResult> => {
  const { exportDir, timeout } = options;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      ensureDirectory(exportDir);
      const expectedFileName = generateFileName(ref, ".json");
      const expectedPath = joinPath(exportDir, expectedFileName);
      if (fs.existsSync(expectedPath)) {
        debugLog(
          `[DEBUG] Arquivo já existe, pulando download: ${expectedPath}`,
        );
        return { ok: true, ref, filePath: expectedPath };
      }

      debugLog(
        `[DEBUG] Tentativa ${attempt}/${maxRetries}: Navegando para workflow: ${ref.name} (${ref.id}) - ${ref.url}`,
      );

      
      if (page.isClosed()) {
        throw new Error("Page has been closed");
      }

      await navigate(page, ref.url);

      
      try {
        await waitForURL(page, /\/workflow\//, timeout);
        debugLog(`[DEBUG] Navegação confirmada: ${page.url()}`);
      } catch (urlError) {
        debugLog(
          `[DEBUG] Aviso: waitForURL timeout na tentativa ${attempt}, mas continuando...`,
        );
        
        if (!page.url().includes("/workflow/")) {
          throw new Error(
            `Failed to navigate to workflow page. Current URL: ${page.url()}`,
          );
        }
      }

      
      await delay(1000);

      
      if (page.isClosed()) {
        throw new Error("Page was closed during download");
      }

      debugLog(`[DEBUG] Aguardando menu do workflow aparecer...`);
      await waitForSelector(page, N8nSelectors.workflowMenu, timeout);
      debugLog(`[DEBUG] Menu encontrado, abrindo...`);

      await openWorkflowMenu(page);
      await delay(500); 
      debugLog(`[DEBUG] Menu aberto, disparando download...`);

      const download = await triggerDownload(page, timeout);
      debugLog(`[DEBUG] Download iniciado, salvando arquivo...`);

      const filePath = await saveDownloadFile(download, ref, exportDir);
      debugLog(`[DEBUG] Arquivo salvo com sucesso: ${filePath}`);

      return { ok: true, ref, filePath };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const errorMessage = lastError.message;

      debugLog(
        `[DEBUG] Erro na tentativa ${attempt}/${maxRetries} para ${ref.name} (${ref.id}): ${errorMessage}`,
      );

      if (error instanceof Error && error.stack) {
        debugLog(`[DEBUG] Stack trace: ${error.stack}`);
      }

      
      if (attempt < maxRetries) {
        const waitTime = 1000 * attempt; 
        debugLog(
          `[DEBUG] Aguardando ${waitTime}ms antes da próxima tentativa...`,
        );
        await delay(waitTime);
        continue;
      }
    }
  }

  
  const finalErrorMessage = lastError?.message ?? "Unknown error after retries";
  const finalErrorStack =
    lastError instanceof Error && lastError.stack
      ? `\nStack: ${lastError.stack}`
      : "";
  const detailedError = `${finalErrorMessage}${finalErrorStack}`;

  debugLog(
    `[DEBUG] ❌ Todas as ${maxRetries} tentativas falharam para ${ref.name} (${ref.id})`,
  );
  debugLog(`[DEBUG] Erro final: ${detailedError}`);

  return { ok: false, ref, error: detailedError };
};


export const executeDownloadWorkflow = async (
  page: Page,
  ref: WorkflowRef,
  options: DownloadWorkflowOptions,
): Promise<DownloadResult> => {
  return downloadWithRetry(page, ref, options, 3);
};
