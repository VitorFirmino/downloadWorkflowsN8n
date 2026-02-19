

export class WorkflowDownloadError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly workflowName: string,
    message: string,
    cause?: unknown
  ) {
    super(`Failed to download workflow "${workflowName}" (${workflowId}): ${message}`);
    this.name = 'WorkflowDownloadError';
    this.cause = cause;
  }
}

export class WorkflowCollectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`Failed to collect workflows: ${message}`);
    this.name = 'WorkflowCollectionError';
    this.cause = cause;
  }
}

export class AuthenticationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`Authentication failed: ${message}`);
    this.name = 'AuthenticationError';
    this.cause = cause;
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(`Configuration error: ${message}`);
    this.name = 'ConfigurationError';
  }
}
