import fs from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { navigate, waitForSelector, waitForURL } from "../../infrastructure/browser/playwright-browser.service";
import { N8nSelectors } from "../../infrastructure/n8n/n8n-selectors";
import { logError, logProgress, logSuccess } from "../../logger";
import type { ImportStats } from "../../domain/types";

const debugLog = (..._args: unknown[]): void => {};

type FolderRef = {
  readonly id: string;
  readonly name: string;
  readonly path: string;
};

type Rule = {
  readonly folderPath: string;
  readonly pattern: RegExp;
};

type ImportOptions = {
  readonly baseUrl: string;
  readonly exportDir: string;
  readonly projectId?: string;
  readonly rulesPath?: string;
  readonly fallbackFolder?: string;
  readonly timeout: number;
};

const defaultRules: Rule[] = [
  { folderPath: "Financeiro", pattern: /boleto|pix|payment|invoice|fatura|cobranca/i },
  { folderPath: "Logistica", pattern: /logistica|frete|carrier|shipping|transport|delivery/i },
  { folderPath: "Atendimento", pattern: /support|ticket|atendimento|suporte|chat|whatsapp/i },
  { folderPath: "Integracoes", pattern: /webhook|api|integrat|sync|connector/i },
  { folderPath: "Sistema", pattern: /backup|system|notification|monitor|healthcheck|cron|schedule/i },
];

const ensureNonEmpty = (value: string, message: string) => {
  if (!value) throw new Error(message);
  return value;
};

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const takeDebugScreenshot = async ({
  page,
  name,
}: {
  page: Page;
  name: string;
}) => {
  try {
    const dir = path.join(process.cwd(), "screenshots");
    await fs.mkdir(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(dir, `${timestamp}-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    debugLog(`[SCREENSHOT] Salvo: ${filePath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`[SCREENSHOT] Erro ao salvar screenshot: ${message}`);
  }
};

const debugResourceItems = async ({ page }: { page: Page }) => {
  try {
    const data = await page.evaluate(() => {
      const items = Array.from(
        document.querySelectorAll('[data-test-id="folder-card-name"]'),
      ).slice(0, 5);
      return items.map((item) => {
        const text = item.textContent?.trim() ?? "";
        const link =
          item.closest('a[href*="/folders/"][href*="/workflows"]') ??
          item.querySelector('a[href*="/folders/"][href*="/workflows"]');
        const href = link?.getAttribute("href") ?? "";
        return { text, href };
      });
    });
    debugLog(`[DEBUG] Lista itens (parcial): ${JSON.stringify(data)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`[DEBUG] Falha ao inspecionar itens: ${message}`);
  }
};

const debugTextContext = async ({
  page,
  text,
}: {
  page: Page;
  text: string;
}) => {
  try {
    const escaped = escapeRegExp(text);
    const node = page.getByText(new RegExp(`^\\s*${escaped}\\s*$`, "i")).first();
    const count = await node.count().catch(() => 0);
    if (count === 0) {
      debugLog(`[DEBUG] Texto não encontrado: ${text}`);
      return;
    }
    const html = await node.evaluate((el) => el.outerHTML);
    const parentHtml = await node.evaluate(
      (el) => el.parentElement?.outerHTML ?? "",
    );
    const grandParentHtml = await node.evaluate(
      (el) => el.parentElement?.parentElement?.outerHTML ?? "",
    );
    debugLog(`[DEBUG] Texto encontrado: ${text}`);
    debugLog(`[DEBUG] Node: ${html.slice(0, 400)}`);
    debugLog(`[DEBUG] Parent: ${parentHtml.slice(0, 400)}`);
    debugLog(`[DEBUG] GrandParent: ${grandParentHtml.slice(0, 400)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`[DEBUG] Falha ao inspecionar texto: ${message}`);
  }
};

const debugButtons = async ({ page }: { page: Page }) => {
  try {
    const data = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button")).slice(0, 30);
      return buttons.map((button) => ({
        text: button.textContent?.trim() ?? "",
        ariaLabel: button.getAttribute("aria-label") ?? "",
        testId: button.getAttribute("data-test-id") ?? "",
        title: button.getAttribute("title") ?? "",
        className: button.className ?? "",
      }));
    });
    debugLog(`[DEBUG] Botões (parcial): ${JSON.stringify(data)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`[DEBUG] Falha ao inspecionar botões: ${message}`);
  }
};

const listRoleNames = async ({
  page,
  role,
}: {
  page: Page;
  role: "button" | "menuitem";
}) => {
  const locator = page.getByRole(role);
  const count = await locator.count().catch(() => 0);
  const names = await Promise.all(
    Array.from({ length: count }, async (_, i) =>
      locator.nth(i).innerText().catch(() => ""),
    ),
  );
  return names.map((name) => name.trim()).filter(Boolean);
};

const listJsonFiles = async (dir: string) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dir, entry.name));
};

const readWorkflowName = async (filePath: string) => {
  const raw = await fs.readFile(filePath, "utf-8");
  const data = JSON.parse(raw) as { name?: string };
  const name = data.name?.trim() ?? path.basename(filePath, ".json");
  return ensureNonEmpty(name, `Workflow name not found in ${filePath}`);
};

const getWorkflowFiles = async ({ exportDir }: { exportDir: string }) => {
  const files = await listJsonFiles(exportDir);
  const results = await Promise.all(
    files.map(async (filePath) => ({
      filePath,
      name: await readWorkflowName(filePath),
    })),
  );
  return results;
};

const parseRulesFile = async (rulesPath: string) => {
  const raw = await fs.readFile(rulesPath, "utf-8");
  const data = JSON.parse(raw) as Array<{ folderPath: string; pattern: string; flags?: string }>;
  return data.map((rule) => ({
    folderPath: rule.folderPath,
    pattern: new RegExp(rule.pattern, rule.flags ?? "i"),
  }));
};

const loadRules = async ({ rulesPath }: { rulesPath?: string }) => {
  if (!rulesPath) return defaultRules;
  try {
    return await parseRulesFile(rulesPath);
  } catch {
    return defaultRules;
  }
};

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

type ExistingFolderMatcher = {
  readonly folderPath: string;
  readonly normalizedName: string;
};

const buildExistingFolderMatchers = (folderMap: Map<string, FolderRef>) => {
  const seen = new Set<string>();
  const matchers: ExistingFolderMatcher[] = [];
  folderMap.forEach((ref) => {
    const normalizedName = normalizeText(ref.name);
    if (!normalizedName || normalizedName.length < 3) return;
    const key = `${ref.path}::${normalizedName}`;
    if (seen.has(key)) return;
    seen.add(key);
    matchers.push({ folderPath: ref.path, normalizedName });
  });
  return matchers;
};

const resolveExistingFolderByName = ({
  folderPath,
  matchers,
}: {
  folderPath: string;
  matchers: ExistingFolderMatcher[];
}) => {
  const target = normalizeText(folderPath);
  if (!target) return undefined;
  return matchers.find((matcher) => matcher.normalizedName === target)?.folderPath;
};

const classifyFolder = ({
  name,
  rules,
  matchers,
  fallbackFolder,
}: {
  name: string;
  rules: Rule[];
  matchers: ExistingFolderMatcher[];
  fallbackFolder?: string;
}) => {
  const ruleMatch = rules.find((rule) => rule.pattern.test(name));
  if (ruleMatch) {
    const existing = resolveExistingFolderByName({
      folderPath: ruleMatch.folderPath,
      matchers,
    });
    return existing ?? ruleMatch.folderPath;
  }

  const normalizedName = normalizeText(name);
  if (normalizedName) {
    const direct = matchers.find((matcher) =>
      normalizedName.includes(matcher.normalizedName),
    );
    if (direct) return direct.folderPath;
  }

  if (fallbackFolder) {
    const fallbackExisting = resolveExistingFolderByName({
      folderPath: fallbackFolder,
      matchers,
    });
    return fallbackExisting ?? fallbackFolder;
  }

  return null;
};

const getProjectWorkflowsUrl = ({ baseUrl, projectId }: { baseUrl: string; projectId: string }) =>
  `${baseUrl}/projects/${projectId}/workflows`;

const getFolderWorkflowsUrl = ({
  baseUrl,
  projectId,
  folderId,
}: {
  baseUrl: string;
  projectId: string;
  folderId: string;
}) => `${baseUrl}/projects/${projectId}/folders/${folderId}/workflows`;

const getNewWorkflowUrl = ({
  baseUrl,
  projectId,
  folderId,
}: {
  baseUrl: string;
  projectId: string;
  folderId?: string;
}) => {
  const url = new URL(`${baseUrl}/workflow/new`);
  url.searchParams.set("projectId", projectId);
  if (folderId) {
    url.searchParams.set("parentFolderId", folderId);
  }
  return url.toString();
};

const extractProjectIdFromUrl = (url: string) => {
  const match = url.match(/\/projects\/([^/]+)\/workflows/);
  return match?.[1] ?? "";
};

const findProjectIdFromLinks = async ({
  page,
  timeout,
}: {
  page: Page;
  timeout: number;
}) => {
  const link = page
    .locator('a[href*="/projects/"][href*="/workflows"]')
    .first();
  const ready = await link
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
  if (!ready) return "";
  const href = await link.getAttribute("href");
  return extractProjectIdFromUrl(href ?? "");
};

const resolveProjectId = async ({
  page,
  baseUrl,
  timeout,
  projectId,
}: {
  page: Page;
  baseUrl: string;
  timeout: number;
  projectId?: string;
}) => {
  if (projectId) return projectId;

  const currentFromUrl = extractProjectIdFromUrl(page.url());
  if (currentFromUrl) return currentFromUrl;

  await navigate(page, `${baseUrl}/projects`, { waitUntil: "domcontentloaded" });
  const fromProjects = await findProjectIdFromLinks({ page, timeout });
  if (fromProjects) return fromProjects;

  await navigate(page, `${baseUrl}/home/workflows`, { waitUntil: "domcontentloaded" });
  const fromHome = await findProjectIdFromLinks({ page, timeout });
  if (fromHome) return fromHome;

  throw new Error(
    "Project ID not found. Access /projects and ensure at least one project is visible.",
  );
};

const waitForAnySelector = async ({
  page,
  selectors,
  timeout,
}: {
  page: Page;
  selectors: string[];
  timeout: number;
}) => {
  const waits = selectors.map((selector) =>
    page.waitForSelector(selector, { timeout }).then(() => selector),
  );
  try {
    return await Promise.any(waits);
  } catch {
    throw new Error(`None of the selectors were found: ${selectors.join(", ")}`);
  }
};

const waitForProjectList = async ({
  page,
  timeout,
}: {
  page: Page;
  timeout: number;
}) => {
  return waitForAnySelector({
    page,
    timeout,
    selectors: [
      N8nSelectors.addFolderButton,
      N8nSelectors.resourcesList,
      N8nSelectors.resourcesListItem,
      N8nSelectors.folderLink,
      '[role="listitem"]',
      'button:has-text("Create workflow")',
    ],
  });
};

const extractFolderRefs = async ({ page }: { page: Page }) => {
  const fromLinks = await page.evaluate(() => {
    const items = Array.from(
      document.querySelectorAll('a[href*="/folders/"][href*="/workflows"]'),
    );
    return items
      .map((link) => ({
        href: link.getAttribute("href") ?? "",
        name: link.textContent?.trim() ?? "",
      }))
      .filter((item) => item.href && item.name);
  });

  const fromCards = await page.evaluate(() => {
    const items = Array.from(
      document.querySelectorAll('[data-test-id="folder-card-name"]'),
    );
    return items
      .map((node) => {
        const name = node.textContent?.trim() ?? "";
        const link = node.closest('a[href*="/folders/"][href*="/workflows"]');
        const href = link?.getAttribute("href") ?? "";
        return { name, href };
      })
      .filter((item) => item.name);
  });

  const combined = [...fromLinks, ...fromCards];
  const items = combined
    .map((item) => {
      const match = item.href?.match(/\/folders\/([^/]+)\/workflows/);
      if (!match || !item.name) return null;
      return { id: match[1], name: item.name };
    })
    .filter((item): item is { id: string; name: string } => Boolean(item));

  return items;
};

const findFolderRefByName = async ({
  page,
  name,
}: {
  page: Page;
  name: string;
}) => {
  const refs = await extractFolderRefs({ page });
  const target = name.trim().toLowerCase();
  return refs.find((ref) => ref.name.trim().toLowerCase() === target);
};

const openFolderByName = async ({
  page,
  name,
  timeout,
}: {
  page: Page;
  name: string;
  timeout: number;
}) => {
  const escaped = escapeRegExp(name);
  const cardName = page
    .locator(N8nSelectors.folderCardName)
    .filter({ hasText: new RegExp(`\\b${escaped}\\b`, "i") })
    .first();
  const cardCount = await cardName.count().catch(() => 0);
  if (cardCount > 0) {
    await cardName.click();
  } else {
    const link = page
      .locator(N8nSelectors.folderLink)
      .filter({ hasText: new RegExp(`\\b${escaped}\\b`, "i") })
      .first();
    const linkCount = await link.count().catch(() => 0);
    if (linkCount > 0) {
      await link.click();
    } else {
      const linkByRole = page
        .getByRole("link", { name: new RegExp(`^\\s*${escaped}\\s*$`, "i") })
        .first();
      const linkByRoleCount = await linkByRole.count().catch(() => 0);
      if (linkByRoleCount === 0) return "";
      await linkByRole.click();
    }
  }

  const navigated = await page
    .waitForURL(/\/folders\/[^/]+\/workflows/, { timeout })
    .then(() => true)
    .catch(() => false);
  if (!navigated && cardCount > 0) {
    await cardName.dblclick().catch(() => {});
    await page
      .waitForURL(/\/folders\/[^/]+\/workflows/, { timeout })
      .catch(() => {});
  }
  const match = page.url().match(/\/folders\/([^/]+)\/workflows/);
  return match?.[1] ?? "";
};

const syncFolderMap = async ({
  page,
  parentPath,
  folderMap,
}: {
  page: Page;
  parentPath: string;
  folderMap: Map<string, FolderRef>;
}) => {
  const refs = await extractFolderRefs({ page });
  refs.forEach((ref) => {
    const pathValue = parentPath ? `${parentPath}/${ref.name}` : ref.name;
    folderMap.set(pathValue, { ...ref, path: pathValue });
  });
};

const folderExistsByText = async ({
  page,
  name,
}: {
  page: Page;
  name: string;
}) => {
  const escaped = escapeRegExp(name);
  const cardName = page
    .locator(N8nSelectors.folderCardName)
    .filter({ hasText: new RegExp(`\\b${escaped}\\b`, "i") })
    .first();
  const count = await cardName.count().catch(() => 0);
  if (count > 0) return true;
  const link = page
    .locator(N8nSelectors.folderLink)
    .filter({ hasText: new RegExp(`\\b${escaped}\\b`, "i") })
    .first();
  const linkCount = await link.count().catch(() => 0);
  return linkCount > 0;
};

const clickCreateFolder = async ({ page, timeout }: { page: Page; timeout: number }) => {
  const addFolderButton = page.locator(N8nSelectors.addFolderButton).first();
  const addFolderCount = await addFolderButton.count().catch(() => 0);
  if (addFolderCount > 0) {
    await addFolderButton.waitFor({ state: "visible", timeout });
    await addFolderButton.click();
    return;
  }

  const directButton = page
    .getByRole("button", { name: /create folder|new folder|add folder|folder/i })
    .first();
  const directCount = await directButton.count().catch(() => 0);
  if (directCount > 0) {
    await directButton.waitFor({ state: "visible", timeout });
    await directButton.click();
    return;
  }

  const createButton = page
    .getByRole("button", { name: /create workflow|new workflow|create/i })
    .first();
  const createCount = await createButton.count().catch(() => 0);
  if (createCount === 0) {
    throw new Error("Create folder button not found");
  }

  await createButton.waitFor({ state: "visible", timeout });

  const group = createButton.locator("xpath=..");
  const groupButtons = group.locator("button");
  const groupCount = await groupButtons.count().catch(() => 0);
  if (groupCount > 1) {
    const caretButton = groupButtons.nth(groupCount - 1);
    await caretButton.click();
  } else {
    await createButton.click();
  }

  const menuContainer = page.locator('[role="menu"]').first();
  const menuVisible = await menuContainer
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);

  if (!menuVisible) {
    const caretButton = page.locator('button[aria-haspopup="menu"]').last();
    const caretCount = await caretButton.count().catch(() => 0);
    if (caretCount > 0) {
      await caretButton.click();
      const menuVisibleAfterCaret = await menuContainer
        .waitFor({ state: "visible", timeout })
        .then(() => true)
        .catch(() => false);
      if (menuVisibleAfterCaret) {
        
      } else {
        throw new Error("Create menu not visible after clicking caret");
      }
    } else {
      throw new Error("Create menu not visible after clicking create button");
    }
  }

  const menuItem = page
    .locator('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')
    .filter({ hasText: /folder/i })
    .first();
  const menuItemCount = await menuItem.count().catch(() => 0);
  if (menuItemCount > 0) {
    await menuItem.waitFor({ state: "visible", timeout });
    await menuItem.click();
    return;
  }

  const fallbackItem = menuContainer.locator("text=/folder/i").first();
  const fallbackCount = await fallbackItem.count().catch(() => 0);
  if (fallbackCount > 0) {
    await fallbackItem.click();
    return;
  }

  const dropdownCaret = page.locator('button[aria-haspopup="menu"]').last();
  const caretCount = await dropdownCaret.count().catch(() => 0);
  if (caretCount > 0) {
    await dropdownCaret.click();
    const caretMenuItem = page
      .locator('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')
      .filter({ hasText: /folder/i })
      .first();
    const caretItemCount = await caretMenuItem.count().catch(() => 0);
    if (caretItemCount > 0) {
      await caretMenuItem.click();
      return;
    }
  }

  await takeDebugScreenshot({ page, name: "import-folder-menu-not-found" });
  const buttonNames = await listRoleNames({ page, role: "button" }).catch(
    () => [],
  );
  const menuNames = await listRoleNames({ page, role: "menuitem" }).catch(
    () => [],
  );
  debugLog(
    `[DEBUG] Botões visíveis: ${buttonNames.slice(0, 20).join(" | ")}`,
  );
  debugLog(
    `[DEBUG] Menu items visíveis: ${menuNames.slice(0, 20).join(" | ")}`,
  );
  throw new Error("Folder menu item not found in create menu");
};

const submitFolderName = async ({
  page,
  name,
  timeout,
}: {
  page: Page;
  name: string;
  timeout: number;
}) => {
  const inputSelectors = [
    'input[placeholder*="folder" i]',
    'input[placeholder*="name" i]',
    'input[aria-label*="folder" i]',
    'input[aria-label*="name" i]',
    'input[name*="folder" i]',
    'input[name*="name" i]',
    'input[type="text"]',
  ];

  const dialog = page.getByRole("dialog").last();
  const dialogVisible = await dialog
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);

  let inputLocator: Locator | null = null;

  if (dialogVisible) {
    for (const selector of inputSelectors) {
      const candidate = dialog.locator(selector).first();
      const count = await candidate.count().catch(() => 0);
      if (count > 0) {
        inputLocator = candidate;
        break;
      }
    }
  }

  if (!inputLocator) {
    for (const selector of inputSelectors) {
      const candidate = page.locator(selector).first();
      const count = await candidate.count().catch(() => 0);
      if (count > 0) {
        inputLocator = candidate;
        break;
      }
    }
  }

  if (!inputLocator) {
    const dialogTextbox = dialogVisible
      ? dialog.getByRole("textbox").first()
      : null;
    const dialogTextboxCount = dialogTextbox
      ? await dialogTextbox.count().catch(() => 0)
      : 0;
    if (dialogTextboxCount > 0 && dialogTextbox) {
      inputLocator = dialogTextbox;
    }
  }

  if (!inputLocator) {
    const pageTextbox = page.getByRole("textbox").first();
    const pageTextboxCount = await pageTextbox.count().catch(() => 0);
    if (pageTextboxCount > 0) {
      inputLocator = pageTextbox;
    }
  }

  if (!inputLocator) {
    const editableSelector = 'input, textarea, [contenteditable="true"]';
    const dialogEditable = dialogVisible ? dialog.locator(editableSelector).first() : null;
    const dialogEditableCount = dialogEditable
      ? await dialogEditable.count().catch(() => 0)
      : 0;
    if (dialogEditableCount > 0 && dialogEditable) {
      inputLocator = dialogEditable;
    }
  }

  if (!inputLocator) {
    const editableSelector = 'input, textarea, [contenteditable="true"]';
    const pageEditable = page.locator(editableSelector).first();
    const pageEditableCount = await pageEditable.count().catch(() => 0);
    if (pageEditableCount > 0) {
      inputLocator = pageEditable;
    }
  }

  if (!inputLocator) {
    await takeDebugScreenshot({ page, name: "import-folder-input-not-found" });
    throw new Error(
      `None of the selectors were found: ${inputSelectors.join(", ")}`,
    );
  }

  await inputLocator.fill(name);

  const dialogSubmit = dialog.getByRole("button", { name: /create|save|add/i }).first();
  const dialogSubmitCount = dialogVisible
    ? await dialogSubmit.count().catch(() => 0)
    : 0;
  if (dialogSubmitCount > 0 && dialogVisible) {
    await dialogSubmit.waitFor({ state: "visible", timeout });
    await dialogSubmit.click();
    return;
  }

  const pageSubmit = page.getByRole("button", { name: /create|save|add/i }).first();
  const pageSubmitCount = await pageSubmit.count().catch(() => 0);
  if (pageSubmitCount > 0) {
    await pageSubmit.waitFor({ state: "visible", timeout });
    await pageSubmit.click();
    return;
  }

  await inputLocator.press("Enter").catch(() => {});
};

const ensureFolderPath = async ({
  page,
  baseUrl,
  projectId,
  folderPath,
  folderMap,
  timeout,
}: {
  page: Page;
  baseUrl: string;
  projectId: string;
  folderPath: string;
  folderMap: Map<string, FolderRef>;
  timeout: number;
}) => {
  const segments = folderPath.split("/").filter(Boolean);
  if (segments.length === 0) throw new Error("Folder path is empty");

  let currentPath = "";
  let parentPath = "";
  let parentId = "";

  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    const existing = folderMap.get(currentPath);
    if (existing) {
      parentId = existing.id;
      continue;
    }

    debugLog(`[DEBUG] Criando pasta: ${currentPath}`);

    const targetUrl = parentId
      ? getFolderWorkflowsUrl({ baseUrl, projectId, folderId: parentId })
      : getProjectWorkflowsUrl({ baseUrl, projectId });
    await navigate(page, targetUrl, { waitUntil: "domcontentloaded" });
    await waitForSelector(page, N8nSelectors.resourcesList, timeout).catch(() => {});
    await syncFolderMap({ page, parentPath, folderMap });

    const existingRef = await findFolderRefByName({ page, name: segment });
    if (existingRef) {
      const pathValue = parentPath
        ? `${parentPath}/${existingRef.name}`
        : existingRef.name;
      folderMap.set(pathValue, { ...existingRef, path: pathValue });
    }

    if (folderMap.has(currentPath)) {
      parentId = folderMap.get(currentPath)?.id ?? parentId;
      parentPath = currentPath;
      continue;
    }

    const existsByText = await folderExistsByText({ page, name: segment });
    const existingId = await openFolderByName({ page, name: segment, timeout });
    if (existingId) {
      folderMap.set(currentPath, { id: existingId, name: segment, path: currentPath });
      parentId = existingId;
      parentPath = currentPath;
      continue;
    }

    if (existsByText && !existingId) {
      await takeDebugScreenshot({ page, name: "import-folder-open-failed" });
      throw new Error(`Folder exists but could not open: ${currentPath}`);
    }

    await clickCreateFolder({ page, timeout });
    await submitFolderName({ page, name: segment, timeout });
    await waitForSelector(page, N8nSelectors.resourcesList, timeout).catch(() => {});
    await syncFolderMap({ page, parentPath, folderMap });

    const createdRef = folderMap.get(currentPath) ?? (await findFolderRefByName({ page, name: segment }));
    if (createdRef && !folderMap.has(currentPath)) {
      const pathValue = parentPath ? `${parentPath}/${createdRef.name}` : createdRef.name;
      folderMap.set(pathValue, { ...createdRef, path: pathValue });
    }

    let created = folderMap.get(currentPath);
    if (!created) {
      const createdId = await openFolderByName({ page, name: segment, timeout });
      if (createdId) {
        folderMap.set(currentPath, { id: createdId, name: segment, path: currentPath });
        created = folderMap.get(currentPath);
      }
    }
    if (!created) {
      await takeDebugScreenshot({ page, name: "import-folder-create-failed" });
      debugLog(`[DEBUG] URL atual: ${page.url()}`);
      await debugResourceItems({ page });
      await debugTextContext({ page, text: segment });
      throw new Error(`Failed to create folder: ${currentPath}`);
    }

    parentId = created.id;
    parentPath = currentPath;
  }

  return ensureNonEmpty(folderMap.get(currentPath)?.id ?? "", `Folder not found: ${currentPath}`);
};

const openCreateWorkflow = async ({ page, timeout }: { page: Page; timeout: number }) => {
  const button = page
    .getByRole("button", { name: /create workflow|new workflow|create/i })
    .first();
  const count = await button.count().catch(() => 0);
  if (count === 0) throw new Error("Create workflow button not found");
  await button.waitFor({ state: "visible", timeout });
  await button.click();
};

const openWorkflowMenu = async ({ page, timeout }: { page: Page; timeout: number }) => {
  const selectors = [
    N8nSelectors.workflowMenuButton,
    `${N8nSelectors.workflowMenu} button[role="button"]`,
    N8nSelectors.workflowMenu,
    N8nSelectors.workflowCommandBarButton,
    ...N8nSelectors.workflowMenuFallbacks,
  ];
  const found = await Promise.any(
    selectors.map(async (selector) => {
      const locator = page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (count === 0) throw new Error("not-found");
      await locator.waitFor({ state: "visible", timeout });
      if (selector === N8nSelectors.workflowMenu) {
        const button = locator.locator("button").first();
        const buttonCount = await button.count().catch(() => 0);
        if (buttonCount > 0) {
          await button.click();
        } else {
          await locator.click();
        }
      } else {
        await locator.click();
      }
      return selector;
    }),
  ).catch(() => null);

  if (found) return;

  const publishButton = page.getByRole("button", { name: /publish/i }).first();
  const publishCount = await publishButton.count().catch(() => 0);
  if (publishCount > 0) {
    const siblingMenu = publishButton.locator(
      "xpath=following-sibling::button[1]",
    );
    const siblingCount = await siblingMenu.count().catch(() => 0);
    if (siblingCount > 0) {
      await siblingMenu.click();
      return;
    }
  }

  const roleButton = page
    .getByRole("button", { name: /menu|more|actions|options/i })
    .first();
  const roleCount = await roleButton.count().catch(() => 0);
  if (roleCount > 0) {
    await roleButton.waitFor({ state: "visible", timeout });
    await roleButton.click();
    return;
  }

  const clickedEllipsis = await page
    .evaluate(() => {
      const symbols = new Set(["...", "…", "⋯", "⋮"]);
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>("[role='button'], button"),
      ).filter((el) => symbols.has((el.textContent ?? "").trim()));
      if (candidates[0]) {
        candidates[0].click();
        return true;
      }
      return false;
    })
    .catch(() => false);
  if (clickedEllipsis) return;

  const clickedByDataTestId = await page
    .evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>("[data-test-id]"),
      ).filter((el) =>
        /(menu|more|options)/i.test(el.getAttribute("data-test-id") ?? ""),
      );
      if (candidates[0]) {
        candidates[0].click();
        return true;
      }
      return false;
    })
    .catch(() => false);
  if (clickedByDataTestId) return;

  await takeDebugScreenshot({ page, name: "import-workflow-menu-not-found" });
  await debugButtons({ page });
  throw new Error("Workflow menu button not found");
};

const importFromWorkflowMenu = async ({
  page,
  filePath,
  timeout,
}: {
  page: Page;
  filePath: string;
  timeout: number;
}) => {
  const debugPresence = await page
    .evaluate(() => {
      const menu = document.querySelector('[data-test-id="workflow-menu"]');
      const input = document.querySelector('[data-test-id="workflow-import-input"]');
      const fileInputs = document.querySelectorAll('input[type="file"]').length;
      return {
        hasMenu: Boolean(menu),
        hasImportInput: Boolean(input),
        fileInputs,
      };
    })
    .catch(() => ({ hasMenu: false, hasImportInput: false, fileInputs: 0 }));
  debugLog(`[DEBUG] Editor import DOM: ${JSON.stringify(debugPresence)}`);
  const importFeedbackTimeout = Math.min(timeout, 8_000);

  const directInput = page.locator('[data-test-id="workflow-import-input"]').first();
  const directInputCount = await directInput.count().catch(() => 0);
  if (directInputCount > 0) {
    await directInput.setInputFiles(filePath);
    const toast = page.locator('text=/Workflow successfully created/i').first();
    await toast
      .waitFor({ state: "visible", timeout: importFeedbackTimeout })
      .catch(() => {});
    return true;
  }

  await openWorkflowMenu({ page, timeout });

  const debugImportTestIds = await page
    .evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>("[data-test-id]"),
      );
      return nodes
        .map((el) => el.getAttribute("data-test-id") ?? "")
        .filter((id) => /import/i.test(id))
        .slice(0, 20);
    })
    .catch(() => []);
  if (debugImportTestIds.length > 0) {
    debugLog(
      `[DEBUG] data-test-id com import (parcial): ${debugImportTestIds.join(" | ")}`,
    );
  }

  const menuItem = page
    .locator('[data-test-id="workflow-menu-item-import-from-file"]')
    .first();
  const menuItemVisible = await menuItem
    .waitFor({ state: "visible", timeout: Math.min(timeout, 5000) })
    .then(() => true)
    .catch(() => false);
  if (menuItemVisible) {
    await menuItem.click();
  }

  const inputSelector = await waitForAnySelector({
    page,
    selectors: ['[data-test-id="workflow-import-input"]', 'input[type="file"]'],
    timeout,
  }).catch(() => null);
  if (!inputSelector) return false;
  await page.locator(inputSelector).setInputFiles(filePath);
  const toast = page.locator('text=/Workflow successfully created/i').first();
  await toast
    .waitFor({ state: "visible", timeout: importFeedbackTimeout })
    .catch(() => {});
  return true;
};

const importWorkflow = async ({
  page,
  baseUrl,
  projectId,
  folderId,
  filePath,
  name,
  timeout,
}: {
  page: Page;
  baseUrl: string;
  projectId: string;
  folderId?: string;
  filePath: string;
  name: string;
  timeout: number;
}) => {
  debugLog(`[DEBUG] Importando workflow: ${name}`);
  const expectedEditorUrl = (url: URL) =>
    url.pathname.startsWith("/workflow/") &&
    url.searchParams.get("projectId") === projectId &&
    (folderId
      ? url.searchParams.get("parentFolderId") === folderId
      : !url.searchParams.get("parentFolderId"));

  let editorOpened = false;
  const directNewWorkflowUrl = getNewWorkflowUrl({ baseUrl, projectId, folderId });
  await navigate(page, directNewWorkflowUrl, { waitUntil: "domcontentloaded" });
  editorOpened = await waitForURL(page, expectedEditorUrl, Math.min(timeout, 8_000))
    .then(() => true)
    .catch(() => false);

  if (!editorOpened) {
    if (folderId) {
      const folderUrl = getFolderWorkflowsUrl({ baseUrl, projectId, folderId });
      await navigate(page, folderUrl, { waitUntil: "domcontentloaded" });
    } else {
      await navigate(page, getProjectWorkflowsUrl({ baseUrl, projectId }), {
        waitUntil: "domcontentloaded",
      });
    }
    await waitForSelector(page, N8nSelectors.resourcesList, timeout).catch(() => {});
    await openCreateWorkflow({ page, timeout });
    await waitForURL(page, expectedEditorUrl, timeout);
  }

  const editorReady = await waitForAnySelector({
    page,
    selectors: [
      '[data-test-id="workflow-menu"]',
      '[data-test-id="workflow-name-input"]',
      '[data-test-id="workflow-import-input"]',
      N8nSelectors.workflowCommandBarButton,
    ],
    timeout,
  })
    .then(() => true)
    .catch(() => false);
  if (!editorReady) {
    await takeDebugScreenshot({ page, name: "import-editor-not-ready" });
    throw new Error("Editor not ready after opening workflow");
  }

  const imported = await importFromWorkflowMenu({
    page,
    filePath,
    timeout,
  });

  if (!imported) {
    await takeDebugScreenshot({ page, name: "import-editor-all-strategies-failed" });
    const debugButtonsList = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("button,[role='button']"))
          .map((el) => ({
            text: (el.textContent ?? "").trim(),
            aria: el.getAttribute("aria-label") ?? "",
            title: el.getAttribute("title") ?? "",
            testId: el.getAttribute("data-test-id") ?? "",
          }))
          .slice(0, 40),
      )
      .catch(() => []);
    debugLog(
      `[DEBUG] Botões visíveis (parcial): ${JSON.stringify(debugButtonsList)}`,
    );
    throw new Error("Import failed in editor (no import action found)");
  }
  debugLog(`[DEBUG] Import concluído: ${name}`);
};

export const executeImportWorkflows = async (
  page: Page,
  options: ImportOptions,
): Promise<ImportStats> => {
  const { baseUrl, exportDir, projectId, rulesPath, fallbackFolder, timeout } = options;
  const rules = await loadRules({ rulesPath });
  const files = await getWorkflowFiles({ exportDir });
  if (files.length === 0) {
    throw new Error(`No workflow files found in ${exportDir}`);
  }

  debugLog(`[DEBUG] Arquivos para importar: ${files.length}`);
  const resolvedProjectId = await resolveProjectId({
    page,
    baseUrl,
    timeout,
    projectId,
  });
  debugLog(`[DEBUG] Usando projectId: ${resolvedProjectId}`);
  const folderMap = new Map<string, FolderRef>();
  debugLog("[DEBUG] Navegando para lista de workflows do projeto");
  await navigate(page, getProjectWorkflowsUrl({ baseUrl, projectId: resolvedProjectId }), {
    waitUntil: "domcontentloaded",
  });
  debugLog("[DEBUG] Aguardando lista de workflows do projeto carregar");
  const listReady = await waitForProjectList({ page, timeout })
    .then(() => true)
    .catch(() => false);
  if (!listReady) {
    await takeDebugScreenshot({ page, name: "import-project-list-not-found" });
    throw new Error("Project workflows list not visible");
  }
  debugLog("[DEBUG] Coletando pastas existentes");
  await syncFolderMap({ page, parentPath: "", folderMap });
  const existingMatchers = buildExistingFolderMatchers(folderMap);
  let imported = 0;
  const failures: Array<ImportStats["failures"][number]> = [];

  for (const [index, file] of files.entries()) {
    const current = index + 1;
    const folderPath = classifyFolder({
      name: file.name,
      rules,
      matchers: existingMatchers,
      fallbackFolder,
    });
    if (folderPath) {
      debugLog(`[DEBUG] Mapeado "${file.name}" -> pasta "${folderPath}"`);
    } else {
      debugLog(
        `[DEBUG] Sem pasta mapeada para "${file.name}", importando na raiz do projeto`,
      );
    }
    const destination = folderPath ?? "raiz do projeto";
    logProgress(current, files.length, `Importando "${file.name}" -> ${destination}`);

    try {
      const folderId = folderPath
        ? await ensureFolderPath({
            page,
            baseUrl,
            projectId: resolvedProjectId,
            folderPath,
            folderMap,
            timeout,
          })
        : undefined;
      await importWorkflow({
        page,
        baseUrl,
        projectId: resolvedProjectId,
        folderId,
        filePath: file.filePath,
        name: file.name,
        timeout,
      });
      imported += 1;
      logSuccess(`[${current}/${files.length}] Importado: ${file.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`[${current}/${files.length}] Falha em "${file.name}": ${message}`);
      failures.push({
        name: file.name,
        filePath: file.filePath,
        folderPath: folderPath ?? undefined,
        error: message,
      });
    }
  }

  return {
    total: files.length,
    imported,
    failed: failures.length,
    failures,
  };
};
