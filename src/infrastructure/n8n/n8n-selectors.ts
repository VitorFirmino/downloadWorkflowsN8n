

export const N8nSelectors = {
  
  resourcesList: '[data-test-id="resources-list"]',
  resourcesListItem: '[data-test-id="resources-list-item"]',
  addFolderButton: '[data-test-id="add-folder-button"]',
  workflowCardName: '[data-test-id="workflow-card-name"]',
  workflowCardActions: '[data-test-id="workflow-card-actions"]',
  workflowActivatorStatus: '[data-test-id="workflow-activator-status"]',
  workflowLink: 'a[href^="/workflow/"]',
  folderLink: 'a[href*="/folders/"][href*="/workflows"]',
  folderCardName: '[data-test-id="folder-card-name"]',
  workflowSearchInput:
    'input[placeholder*="search" i], input[aria-label*="search" i]',
  
  resourceListLoading: ".resource-list-loading",
  skeletonLoader: ".el-skeleton",

  
  workflowMenu: '[data-test-id="workflow-menu"]',
  workflowMenuButton:
    '[data-test-id="workflow-menu"] button[aria-haspopup="menu"]',
  workflowMenuFallbacks: [
    'button[aria-label*="menu" i]',
    'button[aria-label*="more" i]',
    'button[aria-label*="actions" i]',
    'button[aria-label*="options" i]',
  ],
  workflowCommandBarButton: '[data-test-id="command-bar-button"]',
  workflowMenuItemDownload: "menuitem[name=/download/i]",
  commandPaletteButton:
    'button[aria-label*="command palette" i], button[title*="command palette" i]',
  commandPaletteInput:
    'input[placeholder*="command" i], input[aria-label*="command" i], input[type="text"]',

  
  emailInput:
    'input[type="email"], input[type="text"], input[name="email"], input[placeholder*="email" i], input[placeholder*="Email" i]',
  passwordInput: 'input[type="password"], input[name="password"]',
  loginButton:
    'button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Entrar")',
} as const;

export const N8nUrls = {
  signin: "/signin",
  workflows: "/home/workflows",
  workflowPattern: /\/workflow\/([^/?#]+)/,
} as const;
