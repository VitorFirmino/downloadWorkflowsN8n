import type { Locator, Page } from "playwright";
import type {
  CollectionOptions,
  CollectionProgress,
  WorkflowRef,
} from "../../domain/types";
import { WorkflowCollectionError } from "../../domain/errors";
import {
  dismissBlockingModals,
  navigate,
  waitForSelector,
} from "../../infrastructure/browser/playwright-browser.service";
import { N8nSelectors, N8nUrls } from "../../infrastructure/n8n/n8n-selectors";
import { delay } from "../../infrastructure/utils/delay";

interface CollectWorkflowsOptions {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly collection: CollectionOptions;
  readonly onProgress?: (progress: CollectionProgress) => void;
}

const extractWorkflowId = (url: string): string => {
  const match = url.match(N8nUrls.workflowPattern);
  return match?.[1] ?? "";
};

const notifyProgress = (
  onProgress: ((progress: CollectionProgress) => void) | undefined,
  currentCount: number,
  round: number,
  maxRounds: number,
  previousCount: number,
): void => {
  if (!onProgress) return;

  onProgress({
    currentCount,
    round,
    maxRounds,
    isScrolling: true,
    newWorkflowsFound: currentCount - previousCount,
  });
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getScrollContainerSelector = async (page: Page): Promise<string> => {
  const resourcesList = page.locator(N8nSelectors.resourcesList).first();
  const hasResourcesList = await resourcesList.count().catch(() => 0);
  if (hasResourcesList > 0) return N8nSelectors.resourcesList;

  const recycleWrapper = page.locator(".recycle-scroller-wrapper").first();
  const hasRecycleWrapper = await recycleWrapper.count().catch(() => 0);
  if (hasRecycleWrapper > 0) return ".recycle-scroller-wrapper";

  return "body";
};

const getScrollTop = async (page: Page, selector: string): Promise<number> => {
  if (selector === "body") {
    return page
      .evaluate(() => globalThis.scrollY || document.documentElement.scrollTop || 0)
      .catch(() => 0);
  }

  return page
    .locator(selector)
    .first()
    .evaluate((el) => el.scrollTop)
    .catch(() => 0);
};

const setScrollTop = async (
  page: Page,
  selector: string,
  nextTop: number,
): Promise<void> => {
  if (selector === "body") {
    await page
      .evaluate((top) => {
        globalThis.scrollTo(0, top);
      }, nextTop)
      .catch(() => {});
    return;
  }

  await page
    .locator(selector)
    .first()
    .evaluate((el, top) => {
      el.scrollTop = top;
    }, nextTop)
    .catch(() => {});
};

const isScrollAtEnd = async (page: Page, selector: string): Promise<boolean> => {
  if (selector === "body") {
    return page
      .evaluate(() => {
        const top = globalThis.scrollY || document.documentElement.scrollTop || 0;
        const viewportHeight = globalThis.innerHeight;
        const fullHeight = document.documentElement.scrollHeight;
        return top + viewportHeight >= fullHeight - 6;
      })
      .catch(() => false);
  }

  return page
    .locator(selector)
    .first()
    .evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 6)
    .catch(() => false);
};

const scrollStep = async (
  page: Page,
  selector: string,
  amount: number,
): Promise<void> => {
  if (selector === "body") {
    await page.evaluate((stepAmount) => {
      globalThis.scrollBy(0, stepAmount);
    }, amount);
    return;
  }

  await page
    .locator(selector)
    .first()
    .evaluate((el, stepAmount) => {
      el.scrollBy(0, stepAmount);
    }, amount);
};

const getVisibleWorkflowNames = async (page: Page): Promise<string[]> => {
  return page
    .evaluate(() => {
      const names = Array.from(
        document.querySelectorAll('[data-test-id="workflow-card-name"]'),
      )
        .map((el) => (el.textContent ?? "").trim())
        .filter(Boolean);
      return [...new Set(names)];
    })
    .catch(() => []);
};

const getCardByWorkflowName = (page: Page, name: string): Locator => {
  const pattern = new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`, "i");
  const nameLocator = page
    .locator(N8nSelectors.workflowCardName)
    .filter({ hasText: pattern })
    .first();
  return nameLocator.locator(
    'xpath=ancestor::*[@data-test-id="resources-list-item"][1]',
  );
};

const ensureListPage = async (
  page: Page,
  workflowsUrl: string,
  timeout: number,
): Promise<void> => {
  if (!page.url().includes("/workflows")) {
    await navigate(page, workflowsUrl, { waitUntil: "domcontentloaded" });
  }
  await waitForSelector(page, N8nSelectors.resourcesListItem, timeout).catch(
    () => {},
  );
};

const openCardAndExtractRef = async ({
  page,
  baseUrl,
  timeout,
  name,
  scrollContainer,
  workflowsUrl,
}: {
  page: Page;
  baseUrl: string;
  timeout: number;
  name: string;
  scrollContainer: string;
  workflowsUrl: string;
}): Promise<WorkflowRef | null> => {
  const listUrlBefore = page.url();
  const scrollBefore = await getScrollTop(page, scrollContainer);

  try {
    const card = getCardByWorkflowName(page, name);
    const visible = await card
      .waitFor({ state: "visible", timeout: Math.min(timeout, 6_000) })
      .then(() => true)
      .catch(() => false);

    if (!visible) return null;

    const nameNode = card.locator(N8nSelectors.workflowCardName).first();
    await nameNode
      .click({ timeout: Math.min(timeout, 5_000), force: true })
      .catch(async () => {
        await card.click({ timeout: Math.min(timeout, 5_000), force: true });
      });

    const navigated = await page
      .waitForURL(/\/workflow\/[^/?#]+/, { timeout: Math.min(timeout, 8_000) })
      .then(() => true)
      .catch(() => false);

    if (!navigated) return null;

    const workflowUrl = page.url();
    const workflowId = extractWorkflowId(workflowUrl);
    if (!workflowId) return null;

    return {
      id: workflowId,
      name,
      url: workflowUrl.startsWith("http")
        ? workflowUrl
        : `${baseUrl}${workflowUrl}`,
    };
  } catch {
    return null;
  } finally {
    if (page.url().includes("/workflow/")) {
      await page
        .goBack({ waitUntil: "domcontentloaded", timeout: Math.min(timeout, 8_000) })
        .catch(() => {});
    }

    await ensureListPage(page, workflowsUrl, Math.min(timeout, 8_000));
    await setScrollTop(page, scrollContainer, scrollBefore);
    await dismissBlockingModals(page);
    await delay(140);

    if (!page.url().includes("/workflows")) {
      await navigate(page, listUrlBefore, { waitUntil: "domcontentloaded" }).catch(
        () => {},
      );
      await setScrollTop(page, scrollContainer, scrollBefore);
      await delay(100);
    }
  }
};

const collectViaUi = async (
  page: Page,
  baseUrl: string,
  timeout: number,
  collection: CollectionOptions,
  onProgress?: (progress: CollectionProgress) => void,
): Promise<WorkflowRef[]> => {
  const refsById = new Map<string, WorkflowRef>();
  const resolvedNames = new Set<string>();
  const workflowsUrl = `${baseUrl}${N8nUrls.workflows}`;
  const scrollContainer = await getScrollContainerSelector(page);

  let roundsWithoutNew = 0;
  let roundsWithoutVisibleItems = 0;
  let unchangedScrollRounds = 0;
  let previousScrollTop = -1;

  for (let round = 0; round < collection.maxScrollRounds; round += 1) {
    await dismissBlockingModals(page);
    await ensureListPage(page, workflowsUrl, Math.min(timeout, 7_000));

    const visibleNames = await getVisibleWorkflowNames(page);
    const previousCount = refsById.size;
    let newInRound = 0;

    if (visibleNames.length === 0) {
      roundsWithoutVisibleItems += 1;
    } else {
      roundsWithoutVisibleItems = 0;
    }

    for (const name of visibleNames) {
      if (resolvedNames.has(name)) continue;

      const ref = await openCardAndExtractRef({
        page,
        baseUrl,
        timeout,
        name,
        scrollContainer,
        workflowsUrl,
      });

      if (!ref) continue;

      if (!refsById.has(ref.id)) {
        refsById.set(ref.id, ref);
        newInRound += 1;
      }
      resolvedNames.add(name);
    }

    notifyProgress(
      onProgress,
      refsById.size,
      round,
      collection.maxScrollRounds,
      previousCount,
    );

    if (newInRound === 0) {
      roundsWithoutNew += 1;
    } else {
      roundsWithoutNew = 0;
    }

    const currentScrollTop = await getScrollTop(page, scrollContainer);
    if (Math.abs(currentScrollTop - previousScrollTop) <= 1) {
      unchangedScrollRounds += 1;
    } else {
      unchangedScrollRounds = 0;
    }
    previousScrollTop = currentScrollTop;

    const atEnd = await isScrollAtEnd(page, scrollContainer);
    if (atEnd && roundsWithoutNew >= 1) break;
    if (roundsWithoutNew >= 4 && unchangedScrollRounds >= 2) break;
    if (roundsWithoutVisibleItems >= 3) break;

    await scrollStep(page, scrollContainer, collection.scrollAmount);
    await delay(collection.scrollDelay);
  }

  return [...refsById.values()];
};

export const executeCollectWorkflows = async (
  page: Page,
  options: CollectWorkflowsOptions,
): Promise<WorkflowRef[]> => {
  const { baseUrl, timeout, collection, onProgress } = options;

  try {
    const workflowsUrl = `${baseUrl}${N8nUrls.workflows}`;
    await navigate(page, workflowsUrl);

    await dismissBlockingModals(page);
    await delay(350);
    await dismissBlockingModals(page);

    await waitForSelector(page, N8nSelectors.resourcesListItem, timeout).catch(
      async () => {
        const createButtonVisible = await page
          .getByRole("button", { name: /create workflow/i })
          .first()
          .isVisible()
          .catch(() => false);

        if (!createButtonVisible) {
          throw new WorkflowCollectionError(
            `Cards de workflows não apareceram. URL atual: ${page.url()}`,
          );
        }
      },
    );

    return collectViaUi(page, baseUrl, timeout, collection, onProgress);
  } catch (error) {
    if (error instanceof WorkflowCollectionError) throw error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new WorkflowCollectionError(
      `Failed to collect workflows: ${errorMessage}`,
      error,
    );
  }
};
