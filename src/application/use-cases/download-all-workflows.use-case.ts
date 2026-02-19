import type { Page } from "playwright";
import type {
  WorkflowRef,
  DownloadResult,
  DownloadStats,
  SuccessfulDownloadResult,
  FailedDownloadResult,
} from "../../domain/types";
import { isSuccessfulDownload, isFailedDownload } from "../../domain/types";
import { executeDownloadWorkflow } from "./download-workflow.use-case";
import { logProgress } from "../../logger";

const debugLog = (..._args: unknown[]): void => {};

interface DownloadAllWorkflowsOptions {
  readonly exportDir: string;
  readonly timeout: number;
}


const processWorkflow = async (
  page: Page,
  ref: WorkflowRef,
  index: number,
  total: number,
  options: DownloadAllWorkflowsOptions,
): Promise<DownloadResult> => {
  debugLog(`\n[DEBUG] ========================================`);
  debugLog(`[DEBUG] Processando workflow ${index + 1}/${total}:`);
  debugLog(`[DEBUG]   Nome: ${ref.name}`);
  debugLog(`[DEBUG]   ID: ${ref.id}`);
  debugLog(`[DEBUG]   URL: ${ref.url}`);
  debugLog(`[DEBUG] ========================================`);

  const result = await executeDownloadWorkflow(page, ref, options);
  logProgress(index + 1, total, `${ref.name} (${ref.id})`);

  if (result.ok) {
    debugLog(`✅ ${ref.name} (${ref.id}) - ${result.filePath}`);
  } else {
    debugLog(`❌ ${ref.name} (${ref.id}) -> ${result.error}`);
  }

  return result;
};


const processAllWorkflows = async (
  page: Page,
  refs: WorkflowRef[],
  options: DownloadAllWorkflowsOptions,
): Promise<DownloadResult[]> => {
  return refs.reduce<Promise<DownloadResult[]>>(
    async (resultsPromise, workflowRef, index) => {
      const accumulatedResults = await resultsPromise;
      const downloadResult = await processWorkflow(
        page,
        workflowRef,
        index,
        refs.length,
        options,
      );
      return [...accumulatedResults, downloadResult];
    },
    Promise.resolve([]),
  );
};


const separateResults = (
  results: DownloadResult[],
): {
  readonly successful: ReadonlyArray<SuccessfulDownloadResult>;
  readonly failed: ReadonlyArray<FailedDownloadResult>;
} => {
  const successful = results.filter(isSuccessfulDownload);
  const failed = results.filter(isFailedDownload);

  return { successful, failed };
};


export const executeDownloadAllWorkflows = async (
  page: Page,
  refs: WorkflowRef[],
  options: DownloadAllWorkflowsOptions,
): Promise<DownloadStats> => {
  const uniqueRefs = Array.from(
    new Map(refs.map((ref) => [ref.id, ref])).values(),
  );
  debugLog(
    `\n[DEBUG] executeDownloadAllWorkflows: Recebidos ${refs.length} workflows para processar`,
  );

  if (uniqueRefs.length === 0) {
    debugLog(
      `[DEBUG] Nenhum workflow para processar, retornando stats vazias`,
    );
    return {
      total: 0,
      downloaded: 0,
      failed: 0,
      failures: [],
    };
  }

  debugLog(
    `[DEBUG] Iniciando processamento sequencial de ${uniqueRefs.length} workflows únicos...`,
  );
  const results = await processAllWorkflows(page, uniqueRefs, options);
  const { successful, failed } = separateResults(results);

  debugLog(`\n[DEBUG] Processamento concluído:`);
  debugLog(`[DEBUG]   - Sucessos: ${successful.length}`);
  debugLog(`[DEBUG]   - Falhas: ${failed.length}`);

  return {
    total: uniqueRefs.length,
    downloaded: successful.length,
    failed: failed.length,
    failures: failed.map((failedResult) => ({
      ref: failedResult.ref,
      error: failedResult.error,
    })),
  };
};
