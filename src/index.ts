import { config } from "./config";
import {
  logInfo,
  logSuccess,
  logError,
  logSection,
  logSummary,
} from "./logger";
import { executeLogin } from "./application/use-cases/login.use-case";
import { executeCollectWorkflows } from "./application/use-cases/collect-workflows.use-case";
import { executeDownloadAllWorkflows } from "./application/use-cases/download-all-workflows.use-case";
import { executeImportWorkflows } from "./application/use-cases/import-workflows.use-case";
import {
  renderCollectionProgress,
  clearCollectionUI,
  renderCollectionComplete,
} from "./infrastructure/ui/terminal-ui";
import {
  createPersistentContext,
  isSessionValid,
  closeContextAndSaveCookies,
} from "./infrastructure/auth/session-manager";
import type { BrowserContextResult, WorkflowRefArray } from "./domain/types";
import type { Page } from "playwright";

const debugLog = (..._args: unknown[]): void => {};


const createBrowserContext = async (headless: boolean, sessionDir: string) =>
  createPersistentContext(headless, sessionDir);


const performLogin = async (
  page: Page,
  creds: { baseUrl: string; email: string; password: string },
): Promise<void> => {
  const { baseUrl, email, password } = creds;
  const { pageTimeout } = config;

  logSection("Login");
  await executeLogin(page, {
    baseUrl,
    credentials: { email, password },
    timeout: pageTimeout,
  });
  logSuccess("Login realizado com sucesso");
};


const collectWorkflows = async (page: Page, baseUrl: string): Promise<WorkflowRefArray> => {
  const { pageTimeout, scrollMaxRounds, scrollDelay, scrollAmount } = config;
  const safeScrollDelay = Math.max(scrollDelay, 1000);
  const safeScrollAmount = Math.max(80, Math.min(scrollAmount, 260));

  logSection("Coleta de Workflows");
  debugLog(); 

  const workflows = await executeCollectWorkflows(page, {
    baseUrl,
    timeout: pageTimeout,
    collection: {
      maxScrollRounds: scrollMaxRounds,
      scrollDelay: safeScrollDelay,
      scrollAmount: safeScrollAmount,
    },
    onProgress: renderCollectionProgress,
  });

  clearCollectionUI();
  renderCollectionComplete(workflows.length);

  return workflows;
};


const downloadWorkflows = async (page: Page, workflows: WorkflowRefArray): Promise<void> => {
  const { exportDir, pageTimeout } = config;

  logSection("Download dos Workflows");
  const stats = await executeDownloadAllWorkflows(page, workflows, {
    exportDir,
    timeout: pageTimeout,
  });

  logSummary(stats);
};


const run = async (): Promise<void> => {
  const {
    headless,
    sessionDir,
    baseUrl,
    email,
    password,
    targetBaseUrl,
    targetEmail,
    targetPassword,
    targetProjectId,
    targetSessionDir,
    pageTimeout,
    importOnly,
  } = config;
  let browserContext: BrowserContextResult | null = null;

  try {
    logInfo("Iniciando processo...");
    if (!importOnly) {
      browserContext = await createBrowserContext(headless, sessionDir);
      const { page } = browserContext;

      logInfo("Browser criado, verificando sessão...");

      
      const sessionIsValid = await isSessionValid(page, baseUrl, pageTimeout);

      logInfo(`Sessão válida: ${sessionIsValid}`);

      if (!sessionIsValid) {
        logInfo("Sessão inválida, realizando login...");
        await performLogin(page, { baseUrl, email, password });
      } else {
        logSuccess("Sessão válida encontrada, pulando login");
      }

      const workflows = await collectWorkflows(page, baseUrl);

      debugLog(`\n[DEBUG] Total de workflows coletados: ${workflows.length}`);
      if (workflows.length > 0) {
        debugLog(`[DEBUG] Workflows que serão processados:`);
        workflows.forEach((wf, idx) => {
          debugLog(`[DEBUG]   ${idx + 1}. ${wf.name} (${wf.id}) - ${wf.url}`);
        });
      }

      if (workflows.length === 0) {
        logInfo("Nenhum workflow encontrado. Encerrando.");
        
        try {
          if (browserContext) {
            await closeContextAndSaveCookies(
              browserContext.context,
              browserContext.browser,
            ).catch((err) => {
              console.error("Erro ao fechar context:", err);
            });
            browserContext = null;
          }
        } catch (cleanupError) {
          console.error("Erro no cleanup:", cleanupError);
        }

        
        process.exit(0);
      }

      debugLog(
        `\n[DEBUG] Iniciando download de ${workflows.length} workflows...`,
      );
      await downloadWorkflows(page, workflows);
      await closeContextAndSaveCookies(
        browserContext.context,
        browserContext.browser,
      ).catch((err) => {
        console.error("Erro ao fechar context:", err);
      });
      browserContext = null;
    }

    if (targetBaseUrl && !(targetEmail && targetPassword)) {
      throw new Error(
        "Target environment is partially configured. Set N8N_EMAIL_TARGET and N8N_PASSWORD_TARGET.",
      );
    }

    if (targetBaseUrl && targetEmail && targetPassword) {
      const targetDir = targetSessionDir ?? `${sessionDir}-target`;
      browserContext = await createBrowserContext(headless, targetDir);
      const { page: targetPage } = browserContext;

      const targetSessionValid = await isSessionValid(
        targetPage,
        targetBaseUrl,
        pageTimeout,
      );
      if (!targetSessionValid) {
        logInfo("Sessão alvo inválida, realizando login...");
        await performLogin(targetPage, {
          baseUrl: targetBaseUrl,
          email: targetEmail,
          password: targetPassword,
        });
      } else {
        logSuccess("Sessão alvo válida encontrada, pulando login");
      }

      logSection("Importação de Workflows");
      await executeImportWorkflows(targetPage, {
        baseUrl: targetBaseUrl,
        exportDir: config.exportDir,
        projectId: targetProjectId,
        rulesPath: config.rulesPath,
        fallbackFolder: config.fallbackFolder,
        timeout: pageTimeout,
      });
      logSuccess("Importação concluída com sucesso!");
      return;
    }
    logSuccess("Processo concluído com sucesso!");
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    logError(`Erro fatal: ${message}`);

    if (error instanceof Error) {
      console.error("\n=== Detalhes do Erro ===");
      console.error("Nome:", error.name);
      console.error("Mensagem:", error.message);
      if (error.stack) {
        console.error("\nStack trace:");
        console.error(error.stack);
      }
      if (error.cause) {
        console.error("\nCausa:", error.cause);
      }
    }

    process.exit(1);
  } finally {
    try {
      if (browserContext) {
        debugLog("[DEBUG] Fechando browser context no finally...");
        await closeContextAndSaveCookies(
          browserContext.context,
          browserContext.browser,
        ).catch((err) => {
          console.error("Erro ao fechar context:", err);
        });
        browserContext = null;
      }
    } catch (cleanupError) {
      console.error("Erro no cleanup:", cleanupError);
    }
  }
};


process.on("unhandledRejection", (reason, promise) => {
  logError(`Unhandled Rejection em: ${String(promise)}`);
  logError(`Razão: ${String(reason)}`);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logError(`Uncaught Exception: ${error.message}`);
  console.error(error);
  process.exit(1);
});

run().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  logError(`Erro não tratado: ${message}`);
  console.error("\n=== Erro Completo ===");
  console.error(error);
  process.exit(1);
});
