

export interface WorkflowRef {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export type DownloadResult =
  | { readonly ok: true; readonly ref: WorkflowRef; readonly filePath: string }
  | { readonly ok: false; readonly ref: WorkflowRef; readonly error: string };

export interface DownloadStats {
  readonly total: number;
  readonly downloaded: number;
  readonly failed: number;
  readonly failures: ReadonlyArray<{
    readonly ref: WorkflowRef;
    readonly error: string;
  }>;
}

export interface AppConfig {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
  readonly targetBaseUrl?: string;
  readonly targetEmail?: string;
  readonly targetPassword?: string;
  readonly targetProjectId?: string;
  readonly headless: boolean;
  readonly exportDir: string;
  readonly scrollTimeout: number;
  readonly scrollDelay: number;
  readonly scrollAmount: number;
  readonly scrollMaxRounds: number;
  readonly pageTimeout: number;
  readonly sessionDir: string;
  readonly targetSessionDir?: string;
  readonly rulesPath?: string;
  readonly fallbackFolder?: string;
  readonly importOnly: boolean;
}

export interface LoginCredentials {
  readonly email: string;
  readonly password: string;
}

export interface CollectionOptions {
  readonly maxScrollRounds: number;
  readonly scrollDelay: number;
  readonly scrollAmount: number;
}


export interface CollectionProgress {
  readonly currentCount: number;
  readonly round: number;
  readonly maxRounds: number;
  readonly isScrolling: boolean;
  readonly newWorkflowsFound: number;
}


export type SuccessfulDownloadResult = Extract<DownloadResult, { ok: true }>;


export type FailedDownloadResult = Extract<DownloadResult, { ok: false }>;


export const isSuccessfulDownload = (
  result: DownloadResult,
): result is SuccessfulDownloadResult => {
  return result.ok === true;
};


export const isFailedDownload = (
  result: DownloadResult,
): result is FailedDownloadResult => {
  return result.ok === false;
};


export const isValidWorkflowRef = (
  ref: WorkflowRef | null,
): ref is WorkflowRef => {
  return ref !== null;
};


export type BrowserInstance = Awaited<
  ReturnType<typeof import("playwright").chromium.launch>
>;


export interface BrowserContextResult {
  readonly context: import("playwright").BrowserContext;
  readonly page: import("playwright").Page;
  readonly browser: BrowserInstance;
}


export type WorkflowRefArray = WorkflowRef[];
