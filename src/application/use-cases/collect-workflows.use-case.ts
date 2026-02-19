import type { Page, Locator } from "playwright";
import type {
  WorkflowRef,
  CollectionOptions,
  CollectionProgress,
} from "../../domain/types";
import { isValidWorkflowRef } from "../../domain/types";
import { WorkflowCollectionError } from "../../domain/errors";
import {
  getAllLocators,
  navigate,
  waitForSelector,
} from "../../infrastructure/browser/playwright-browser.service";
import { N8nSelectors, N8nUrls } from "../../infrastructure/n8n/n8n-selectors";
import { delay } from "../../infrastructure/utils/delay";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const debugLog = (..._args: unknown[]): void => {};

const takeScreenshot = async (page: Page, name: string): Promise<void> => {
  try {
    const screenshotsDir = join(process.cwd(), "screenshots");
    mkdirSync(screenshotsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = join(screenshotsDir, `${timestamp}-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    debugLog(`[SCREENSHOT] Salvo: ${filePath}`);
  } catch (error) {
    debugLog(
      `[SCREENSHOT] Erro ao tirar screenshot "${name}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

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

const buildWorkflowUrl = (href: string, baseUrl: string): string => {
  return href.startsWith("http") ? href : `${baseUrl}${href}`;
};

const isWorkflowActive = async (card: Locator): Promise<boolean> => {
  try {
    const statusElement = card.locator(N8nSelectors.workflowActivatorStatus);
    const statusCount = await statusElement.count().catch(() => 0);
    if (statusCount > 0) {
      const statusText = (
        await statusElement.innerText().catch(() => "")
      ).trim();
      return statusText.toLowerCase().includes("active");
    }

    const cardText = (await card.innerText().catch(() => "")).trim();
    if (!cardText) return true;
    return /active/i.test(cardText);
  } catch {
    return true;
  }
};

const extractCardData = async (
  card: Locator,
  baseUrl: string,
  page: Page,
  useFallback: boolean = false,
): Promise<WorkflowRef | null> => {
  try {
    const nameElement = card.locator(N8nSelectors.workflowCardName);
    const name = (await nameElement.innerText().catch(() => "")).trim();

    if (!name) return null;
    let restoreScroll = async (): Promise<void> => {};

    const extractionResult = await card
      .first()
      .evaluate((el) => {
        const debugInfo: {
          tagName: string;
          classes: string;
          attributes: Record<string, string>;
          innerHTML: string;
          foundElements: string[];
        } = {
          tagName: el.tagName,
          classes: el.className || "",
          attributes: {},
          innerHTML: el.innerHTML.substring(0, 500),
          foundElements: [],
        };

        Array.from(el.attributes).forEach((attr: any) => {
          debugInfo.attributes[attr.name] = attr.value;
        });

        const link = el.querySelector('a[href*="/workflow/"]') as any;
        if (link?.href) {
          try {
            const origin = (globalThis as any).window?.location?.origin ?? "";
            const url = new URL(link.href, origin || link.baseURI);
            debugInfo.foundElements.push(`link href: ${url.pathname}`);
            return { href: url.pathname, debugInfo };
          } catch {
            const hrefAttr = link.getAttribute("href");
            if (hrefAttr) {
              debugInfo.foundElements.push(`link href attr: ${hrefAttr}`);
              return { href: hrefAttr, debugInfo };
            }
          }
        }

        if (el.tagName === "A") {
          const hrefAttr = el.getAttribute("href");
          if (hrefAttr?.includes("/workflow/")) {
            debugInfo.foundElements.push(`card is link: ${hrefAttr}`);
            return { href: hrefAttr, debugInfo };
          }
        }

        const workflowId =
          el.getAttribute("data-workflow-id") ||
          el.getAttribute("data-id") ||
          el.getAttribute("data-resource-id") ||
          el.getAttribute("data-resource") ||
          el.closest("[data-workflow-id]")?.getAttribute("data-workflow-id") ||
          el.closest("[data-id]")?.getAttribute("data-id") ||
          el.closest("[data-resource-id]")?.getAttribute("data-resource-id") ||
          el.closest("[data-resource]")?.getAttribute("data-resource");

        if (workflowId) {
          if (workflowId.includes("/workflow/")) {
            debugInfo.foundElements.push(
              `data-workflow-id (full path): ${workflowId}`,
            );
            return {
              href: workflowId.startsWith("/") ? workflowId : `/${workflowId}`,
              debugInfo,
            };
          }

          debugInfo.foundElements.push(`data-workflow-id: ${workflowId}`);
          return { href: `/workflow/${workflowId}`, debugInfo };
        }

        const onclick = el.getAttribute("onclick");
        if (onclick) {
          const match = onclick.match(/\/workflow\/([^"'\s)]+)/);
          if (match) {
            debugInfo.foundElements.push(
              `onclick match: /workflow/${match[1]}`,
            );
            return { href: `/workflow/${match[1]}`, debugInfo };
          }
        }

        const linkElement = el.querySelector(
          '[class*="link" i], [class*="cardLink" i]',
        );
        if (linkElement) {
          const linkHref = linkElement.getAttribute("href");
          const linkTo = linkElement.getAttribute("to");
          if (linkHref?.includes("/workflow/")) {
            debugInfo.foundElements.push(`link element href: ${linkHref}`);
            return { href: linkHref, debugInfo };
          }
          if (linkTo?.includes("/workflow/")) {
            debugInfo.foundElements.push(`link element to: ${linkTo}`);
            return { href: linkTo, debugInfo };
          }
        }

        if (
          el.className &&
          (el.className.includes("link") || el.className.includes("cardLink"))
        ) {
          const childLink = el.querySelector(
            '[href*="/workflow/"], [to*="/workflow/"]',
          );
          if (childLink) {
            const childHref =
              childLink.getAttribute("href") || childLink.getAttribute("to");
            if (childHref) {
              debugInfo.foundElements.push(
                `child link in cardLink: ${childHref}`,
              );
              return { href: childHref, debugInfo };
            }
          }
        }

        const allElements = el.querySelectorAll(
          "a, [href], [onclick], [data-workflow-id], [data-id], [to], [class*='link' i]",
        );
        for (let i = 0; i < allElements.length; i += 1) {
          const elem = allElements[i];

          const hrefAttr = elem.getAttribute("href");
          if (hrefAttr?.includes("/workflow/")) {
            debugInfo.foundElements.push(`child href: ${hrefAttr}`);
            return { href: hrefAttr, debugInfo };
          }

          const toAttr = elem.getAttribute("to");
          if (toAttr?.includes("/workflow/")) {
            debugInfo.foundElements.push(`child to: ${toAttr}`);
            return { href: toAttr, debugInfo };
          }

          const dataId =
            elem.getAttribute("data-workflow-id") ||
            elem.getAttribute("data-id");
          if (dataId) {
            debugInfo.foundElements.push(`child data-id: ${dataId}`);
            return { href: `/workflow/${dataId}`, debugInfo };
          }

          const elemOnclick = elem.getAttribute("onclick");
          if (elemOnclick) {
            const match = elemOnclick.match(/\/workflow\/([^"'\s)]+)/);
            if (match) {
              debugInfo.foundElements.push(
                `child onclick: /workflow/${match[1]}`,
              );
              return { href: `/workflow/${match[1]}`, debugInfo };
            }
          }
        }

        const routerLink =
          el.closest('[to*="/workflow/"]') ||
          el.querySelector('[to*="/workflow/"]');
        if (routerLink) {
          const toAttr = routerLink.getAttribute("to");
          if (toAttr?.includes("/workflow/")) {
            debugInfo.foundElements.push(`router-link to: ${toAttr}`);
            return { href: toAttr, debugInfo };
          }
        }

        let parent = el.parentElement;
        let depth = 0;
        while (parent && depth < 5) {
          const parentHref = parent.getAttribute("href");
          const parentTo = parent.getAttribute("to");
          if (parentHref?.includes("/workflow/")) {
            debugInfo.foundElements.push(
              `parent href (depth ${depth}): ${parentHref}`,
            );
            return { href: parentHref, debugInfo };
          }
          if (parentTo?.includes("/workflow/")) {
            debugInfo.foundElements.push(
              `parent to (depth ${depth}): ${parentTo}`,
            );
            return { href: parentTo, debugInfo };
          }
          parent = parent.parentElement;
          depth += 1;
        }

        return { href: null, debugInfo };
      })
      .catch(() => ({ href: null, debugInfo: null }));

    const href = extractionResult?.href ?? null;
    const debugInfo = extractionResult?.debugInfo;

    if (!href && debugInfo) {
      debugLog(`[DEBUG] Card "${name}" - Estrutura do DOM:`);
      debugLog(`[DEBUG]   Tag: ${debugInfo.tagName}`);
      debugLog(`[DEBUG]   Classes: ${debugInfo.classes}`);
      debugLog(
        `[DEBUG]   Atributos principais:`,
        Object.keys(debugInfo.attributes).slice(0, 10).join(", "),
      );
      if (debugInfo.foundElements.length > 0) {
        debugLog(
          `[DEBUG]   Elementos encontrados: ${debugInfo.foundElements.join(", ")}`,
        );
      }
      debugLog(
        `[DEBUG]   HTML (primeiros 200 chars): ${debugInfo.innerHTML.substring(0, 200)}`,
      );
    }

    if (!href && useFallback) {
      try {
        debugLog(
          `[DEBUG] Tentando fallback: extraindo URL do card "${name}" sem navegar`,
        );

        if (page.isClosed()) {
          debugLog(
            `[DEBUG] Página foi fechada, não é possível usar fallback`,
          );
          return null;
        }

        const currentUrl = page.url();
        if (!currentUrl.includes("/home/workflows")) {
          debugLog(
            `[DEBUG] Não estamos na página de workflows (${currentUrl}), navegando...`,
          );
          await navigate(page, `${baseUrl}${N8nUrls.workflows}`);
          await delay(1500);
        }

        let fallbackUrl = await card.evaluate((el) => {
          const clickableElements = el.querySelectorAll(
            "a, [href], [onclick], [to], [class*='link' i], [class*='cardLink' i]",
          );

          for (let i = 0; i < clickableElements.length; i += 1) {
            const elem = clickableElements[i] as any;

            const href = elem.href || elem.getAttribute("href");
            if (href && href.includes("/workflow/")) {
              try {
                const origin =
                  (globalThis as any).window?.location?.origin ?? "";
                const url = new URL(href, origin || elem.baseURI);
                return url.pathname;
              } catch {
                if (href.startsWith("/")) {
                  return href;
                }
                if (href.includes("/workflow/")) {
                  const match = href.match(/\/workflow\/[^/?#]+/);
                  return match ? match[0] : null;
                }
              }
            }

            const to = elem.getAttribute("to");
            if (to && to.includes("/workflow/")) {
              return to.startsWith("/") ? to : `/${to}`;
            }

            const onclick = elem.getAttribute("onclick");
            if (onclick) {
              const match = onclick.match(/\/workflow\/([^"'\s)]+)/);
              if (match) {
                return `/workflow/${match[1]}`;
              }
            }
          }

          let parent = el.parentElement;
          let depth = 0;
          while (parent && depth < 5) {
            const parentHref = parent.getAttribute("href");
            const parentTo = parent.getAttribute("to");
            if (parentHref?.includes("/workflow/")) {
              return parentHref.startsWith("/") ? parentHref : `/${parentHref}`;
            }
            if (parentTo?.includes("/workflow/")) {
              return parentTo.startsWith("/") ? parentTo : `/${parentTo}`;
            }
            parent = parent.parentElement;
            depth += 1;
          }

          return null;
        });

        if (!fallbackUrl) {
          try {
            debugLog(
              `[DEBUG] Fallback: Clicando no card "${name}" para capturar URL...`,
            );

            const currentUrlBefore = page.url();
            const scrollState = await page
              .evaluate(() => {
                const doc = (globalThis as any).document;
                const list = doc.querySelector(
                  '[data-test-id="resources-list"]',
                );
                return {
                  scrollTop: list ? list.scrollTop : null,
                };
              })
              .catch(() => ({ scrollTop: null }));

            const navigationPromise = page
              .waitForURL(/\/workflow\/[^/?#]+/, { timeout: 5000 })
              .catch(() => null);

            restoreScroll = async (): Promise<void> => {
              if (scrollState.scrollTop === null) return;
              await page
                .evaluate((top) => {
                  const doc = (globalThis as any).document;
                  const list = doc.querySelector(
                    '[data-test-id="resources-list"]',
                  );
                  if (list) {
                    list.scrollTop = top;
                  }
                }, scrollState.scrollTop)
                .catch(() => {});
              await delay(200);
            };

            const directLink = card.locator('a[href^="/workflow/"]').first();
            const directLinkCount = await directLink.count().catch(() => 0);
            if (directLinkCount > 0) {
              await directLink.click({ timeout: 4000 });
            } else {
              const cardContent = card
                .locator('[data-test-id="card-content"]')
                .first();
              const cardContentExists = await cardContent
                .count()
                .catch(() => 0);

              if (cardContentExists > 0) {
                await cardContent.click({
                  timeout: 4000,
                  position: { x: 10, y: 10 },
                  force: true,
                });
              } else {
                const cardElement = card.first();
                const boundingBox = await cardElement
                  .boundingBox()
                  .catch(() => null);
                if (boundingBox) {
                  await cardElement.click({
                    timeout: 4000,
                    position: { x: 20, y: 20 },
                    force: true,
                  });
                } else {
                  await cardElement.click({ timeout: 4000, force: true });
                }
              }
            }

            const navigatedUrl = await navigationPromise;

            if (navigatedUrl !== null) {
              const currentUrlAfterNav = page.url();
              const urlMatch = currentUrlAfterNav.match(
                /\/workflow\/([^/?#]+)/,
              );
              if (urlMatch) {
                fallbackUrl = `/workflow/${urlMatch[1]}`;
                debugLog(
                  `[DEBUG] Fallback: ✅ URL capturada via clique: ${fallbackUrl}`,
                );

                await page
                  .goBack({ waitUntil: "domcontentloaded", timeout: 8000 })
                  .catch(() => {});

                try {
                  await page.waitForURL(/\/home\/workflows/, { timeout: 8000 });

                  await page
                    .locator(N8nSelectors.resourcesListItem)
                    .first()
                    .waitFor({
                      state: "visible",
                      timeout: 5000,
                    });
                  await restoreScroll();
                  await delay(200);
                } catch {
                  await navigate(page, `${baseUrl}${N8nUrls.workflows}`);
                  await delay(500);
                  await restoreScroll();
                }
              }
            } else {
              await delay(400);
              const currentUrlAfter = page.url();

              if (
                currentUrlAfter !== currentUrlBefore &&
                currentUrlAfter.includes("/workflow/")
              ) {
                const urlMatch = currentUrlAfter.match(/\/workflow\/([^/?#]+)/);
                if (urlMatch) {
                  fallbackUrl = `/workflow/${urlMatch[1]}`;
                  debugLog(
                    `[DEBUG] Fallback: ✅ URL capturada após clique (sem waitForURL): ${fallbackUrl}`,
                  );

                  await page
                    .goBack({ waitUntil: "domcontentloaded", timeout: 8000 })
                    .catch(() => {});

                  try {
                    await page.waitForURL(/\/home\/workflows/, {
                      timeout: 8000,
                    });
                    await page
                      .locator(N8nSelectors.resourcesListItem)
                      .first()
                      .waitFor({
                        state: "visible",
                        timeout: 5000,
                      });
                    await restoreScroll();
                    await delay(200);
                  } catch {
                    await navigate(page, `${baseUrl}${N8nUrls.workflows}`);
                    await delay(500);
                    await restoreScroll();
                  }
                }
              } else {
                debugLog(
                  `[DEBUG] Fallback: ❌ URL não mudou após clique (antes: ${currentUrlBefore}, depois: ${currentUrlAfter})`,
                );

                if (!currentUrlAfter.includes("/home/workflows")) {
                  await page
                    .goBack({ waitUntil: "domcontentloaded", timeout: 8000 })
                    .catch(() => {});

                  try {
                    await page.waitForURL(/\/home\/workflows/, {
                      timeout: 8000,
                    });
                    await page
                      .locator(N8nSelectors.resourcesListItem)
                      .first()
                      .waitFor({
                        state: "visible",
                        timeout: 5000,
                      });
                    await restoreScroll();
                    await delay(200);
                  } catch {
                    await navigate(page, `${baseUrl}${N8nUrls.workflows}`);
                    await delay(500);
                    await restoreScroll();
                  }
                }
              }
            }
          } catch (error) {
            debugLog(
              `[DEBUG] Fallback: Erro ao clicar e capturar URL: ${error instanceof Error ? error.message : String(error)}`,
            );

            try {
              const currentUrl = page.url();
              if (!currentUrl.includes("/home/workflows")) {
                await page
                  .goBack({ waitUntil: "domcontentloaded", timeout: 8000 })
                  .catch(() => {});

                try {
                  await page.waitForURL(/\/home\/workflows/, { timeout: 8000 });
                  await page
                    .locator(N8nSelectors.resourcesListItem)
                    .first()
                    .waitFor({
                      state: "visible",
                      timeout: 5000,
                    });
                  await restoreScroll();
                  await delay(200);
                } catch {
                  await navigate(page, `${baseUrl}${N8nUrls.workflows}`);
                  await delay(500);
                  await restoreScroll();
                }
              }
            } catch {}
          }
        }

        if (fallbackUrl) {
          const url = buildWorkflowUrl(fallbackUrl, baseUrl);
          const id = extractWorkflowId(url);

          if (id) {
            const isActive = await isWorkflowActive(card).catch(() => {
              debugLog(
                `[DEBUG] Não foi possível verificar status do workflow "${name}", assumindo Active`,
              );
              return true;
            });

            if (!isActive) {
              debugLog(
                `[DEBUG] Workflow "${name}" está Inactive, ignorando...`,
              );
              return null;
            }

            debugLog(`[DEBUG] Fallback bem-sucedido: ${name} -> ${url}`);
            return { id, name, url };
          }
        }

        debugLog(
          `[DEBUG] Fallback: Não foi possível extrair URL do card "${name}"`,
        );
      } catch (error) {
        debugLog(
          `[DEBUG] Erro no fallback para "${name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (!href) return null;

    const url = buildWorkflowUrl(href, baseUrl);
    const id = extractWorkflowId(url);

    if (!id) return null;

    const isActive = await isWorkflowActive(card);
    if (!isActive) {
      debugLog(`[DEBUG] Workflow "${name}" está Inactive, ignorando...`);
      return null;
    }

    return { id, name, url };
  } catch {
    return null;
  }
};

const processCard = async (
  card: Locator,
  index: number,
  total: number,
  page: Page,
  baseUrl: string,
  useFallback: boolean,
): Promise<WorkflowRef | null> => {
  try {
    if (page.isClosed()) {
      debugLog(
        `[DEBUG] Card ${index + 1}/${total}: Página foi fechada durante processamento`,
      );
      return null;
    }
    const result = await extractCardData(card, baseUrl, page, useFallback);
    if (!result) {
      debugLog(
        `[DEBUG] Card ${index + 1}/${total}: Não foi possível extrair dados (href não encontrado)`,
      );
    } else {
      debugLog(
        `[DEBUG] Card ${index + 1}/${total}: ✅ ${result.name} -> ${result.url}`,
      );
    }
    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack =
      error instanceof Error && error.stack ? `\n  Stack: ${error.stack}` : "";
    debugLog(
      `[DEBUG] Card ${index + 1}/${total}: ❌ Erro ao extrair - ${errorMsg}${errorStack}`,
    );
    return null;
  }
};

const getWorkflowCards = async (page: Page): Promise<Locator[]> => {
  const list = page.locator(N8nSelectors.resourcesList).first();
  const listCount = await list.count().catch(() => 0);

  if (listCount > 0) {
    const items = list.locator(N8nSelectors.resourcesListItem);
    const count = await items.count();
    return Array.from({ length: count }, (_, i) => items.nth(i));
  }

  return getAllLocators(page, N8nSelectors.resourcesListItem);
};

const collectVisibleRefs = async (
  page: Page,
  baseUrl: string,
  useFallback: boolean = false,
): Promise<WorkflowRef[]> => {
  if (page.isClosed()) {
    debugLog(`[DEBUG] Página foi fechada durante coleta de refs visíveis`);
    return [];
  }

  const currentUrl = page.url();
  if (!currentUrl.includes("/home/workflows")) {
    debugLog(
      `[DEBUG] Não estamos na página de workflows (${currentUrl}), navegando...`,
    );
    await navigate(page, `${baseUrl}${N8nUrls.workflows}`);
    await waitForSelector(page, N8nSelectors.resourcesList, 10000).catch(
      () => {},
    );
    await delay(1000);
  }

  const cards = await getWorkflowCards(page);
  const cardCount = cards.length;

  if (cardCount === 0) {
    debugLog(`[DEBUG] AVISO: Nenhum card encontrado na lista`);
    return [];
  }

  debugLog(
    `[DEBUG] Processando ${cardCount} cards...${useFallback ? " (com fallback habilitado - processamento sequencial)" : ""}`,
  );

  const workflowRefs = useFallback
    ? await cards.reduce<Promise<WorkflowRef[]>>(
        async (accPromise, card, index) => {
          const acc = await accPromise;
          const result = await processCard(
            card,
            index,
            cardCount,
            page,
            baseUrl,
            useFallback,
          );
          return result ? [...acc, result] : acc;
        },
        Promise.resolve([]),
      )
    : await Promise.all(
        cards.map((card, index) =>
          processCard(card, index, cardCount, page, baseUrl, useFallback),
        ),
      );

  const validRefs = workflowRefs.filter(isValidWorkflowRef);
  const failedCount = cardCount - validRefs.length;

  debugLog(
    `[DEBUG] Coleta concluída: ${cardCount} cards encontrados, ${validRefs.length} workflows extraídos com sucesso, ${failedCount} falharam na extração`,
  );

  if (validRefs.length === 0 && !useFallback && cardCount > 0) {
    debugLog(
      `[DEBUG] Nenhum workflow encontrado sem fallback, tentando novamente com fallback habilitado...`,
    );
    return collectVisibleRefs(page, baseUrl, true);
  }

  if (validRefs.length < cardCount * 0.5 && !useFallback && cardCount > 3) {
    debugLog(
      `[DEBUG] Poucos workflows extraídos (${validRefs.length}/${cardCount}), tentando com fallback...`,
    );
    const fallbackRefs = await collectVisibleRefs(page, baseUrl, true);

    return deduplicateById([...validRefs, ...fallbackRefs]);
  }

  return validRefs;
};

const deduplicateById = (workflowRefs: WorkflowRef[]): WorkflowRef[] => {
  const workflowMap = new Map(
    workflowRefs.map((workflowRef) => [workflowRef.id, workflowRef]),
  );
  return [...workflowMap.values()];
};

const findScrollableContainerSelector = async (
  page: Page,
): Promise<string | null> => {
  try {
    const listElement = page.locator(N8nSelectors.resourcesList).first();
    const exists = await listElement.count().catch(() => 0);
    debugLog(
      `[DEBUG] findScrollableContainerSelector: Tentando resourcesList, existe: ${exists}`,
    );
    if (exists > 0) {
      debugLog(
        `[DEBUG] findScrollableContainerSelector: Encontrado resourcesList`,
      );
      return N8nSelectors.resourcesList;
    }

    const firstCard = page.locator(N8nSelectors.resourcesListItem).first();
    const cardExists = await firstCard.count().catch(() => 0);
    debugLog(
      `[DEBUG] findScrollableContainerSelector: Tentando via card, existe: ${cardExists}`,
    );

    if (cardExists > 0) {
      const scrollableInfo = await firstCard.evaluate((card) => {
        let element: any = card as any;
        let depth = 0;
        const foundElements: Array<{
          depth: number;
          tag: string;
          classes: string;
          overflow: string;
          scrollHeight: number;
          clientHeight: number;
        }> = [];

        while (element && depth < 10) {
          const style = (globalThis as any).window.getComputedStyle(element);
          const overflowY = style.overflowY || style.overflow;
          const scrollHeight = element.scrollHeight;
          const clientHeight = element.clientHeight;

          foundElements.push({
            depth,
            tag: element.tagName,
            classes: element.className || "",
            overflow: overflowY,
            scrollHeight,
            clientHeight,
          });

          if (
            (overflowY === "auto" || overflowY === "scroll") &&
            scrollHeight > clientHeight
          ) {
            const testId = element.getAttribute("data-test-id");
            if (testId) {
              return {
                selector: `[data-test-id="${testId}"]`,
                found: true,
                foundElements,
              };
            }

            const classes = element.className;
            if (classes && typeof classes === "string") {
              const classList = classes.split(" ").filter((c) => c.length > 0);
              if (classList.length > 0) {
                return {
                  selector: `.${classList[0]}`,
                  found: true,
                  foundElements,
                };
              }
            }
            return { selector: null, found: true, foundElements };
          }
          element = element.parentElement;
          depth += 1;
        }
        return { selector: null, found: false, foundElements };
      });

      debugLog(
        `[DEBUG] findScrollableContainerSelector: Elementos encontrados na hierarquia:`,
      );
      scrollableInfo.foundElements.forEach((el) => {
        debugLog(
          `  [${el.depth}] ${el.tag} - overflow: ${el.overflow}, scrollHeight: ${el.scrollHeight}, clientHeight: ${el.clientHeight}`,
        );
      });

      if (scrollableInfo.found && scrollableInfo.selector) {
        debugLog(
          `[DEBUG] findScrollableContainerSelector: Encontrado via card: ${scrollableInfo.selector}`,
        );
        return scrollableInfo.selector;
      }
    }

    debugLog(
      `[DEBUG] findScrollableContainerSelector: Nenhum container scrollável encontrado`,
    );
    return null;
  } catch (error) {
    debugLog(
      `[DEBUG] findScrollableContainerSelector: Erro - ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
};

const hasReachedScrollEnd = async (page: Page): Promise<boolean> => {
  try {
    const selector = await findScrollableContainerSelector(page);
    if (!selector) {
      const cards = await getAllLocators(page, N8nSelectors.resourcesListItem);

      return cards.length < 10;
    }

    const scrollInfo = await page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const scrollTop = el.scrollTop;
        const scrollHeight = el.scrollHeight;
        const clientHeight = el.clientHeight;

        const threshold = 5;
        return {
          scrollTop,
          scrollHeight,
          clientHeight,
          isAtEnd: scrollTop + clientHeight >= scrollHeight - threshold,
        };
      });
    return scrollInfo.isAtEnd;
  } catch {
    return false;
  }
};

const scrollAndWait = async (
  page: Page,
  scrollAmount: number,
  scrollDelay: number,
): Promise<void> => {
  if (page.isClosed()) {
    throw new Error("Page has been closed");
  }

  const selector = await findScrollableContainerSelector(page);
  debugLog(`[DEBUG] Scroll: Seletor encontrado: ${selector ?? "null"}`);

  if (!selector) {
    debugLog(`[DEBUG] Scroll: Fazendo scroll na página (window.scrollBy)`);
    await page.evaluate((amount) => {
      (globalThis as any).window.scrollBy(0, amount);
    }, scrollAmount);
    await delay(scrollDelay);
    return;
  }

  const scrollable = page.locator(selector).first();

  const beforeScroll = await scrollable.evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    cardCount: el.querySelectorAll('[data-test-id="resources-list-item"]')
      .length,
  }));

  debugLog(
    `[DEBUG] Scroll: Antes - scrollTop: ${beforeScroll.scrollTop}, scrollHeight: ${beforeScroll.scrollHeight}, clientHeight: ${beforeScroll.clientHeight}, cards: ${beforeScroll.cardCount}`,
  );

  await scrollable.evaluate((el, amount) => {
    el.scrollBy(0, amount);
  }, scrollAmount);

  await delay(scrollDelay);

  let attempts = 0;
  const maxAttempts = 10;
  while (attempts < maxAttempts) {
    const afterScroll = await scrollable.evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      cardCount: el.querySelectorAll('[data-test-id="resources-list-item"]')
        .length,
    }));

    debugLog(
      `[DEBUG] Scroll: Depois (tentativa ${attempts + 1}) - scrollTop: ${afterScroll.scrollTop}, scrollHeight: ${afterScroll.scrollHeight}, clientHeight: ${afterScroll.clientHeight}, cards: ${afterScroll.cardCount}`,
    );

    if (
      afterScroll.cardCount > beforeScroll.cardCount ||
      afterScroll.scrollTop !== beforeScroll.scrollTop
    ) {
      debugLog(
        `[DEBUG] Scroll: Novos itens detectados! Cards: ${beforeScroll.cardCount} -> ${afterScroll.cardCount}, ScrollTop: ${beforeScroll.scrollTop} -> ${afterScroll.scrollTop}`,
      );

      await delay(scrollDelay);
      break;
    }

    await delay(200);
    attempts += 1;
  }

  if (attempts >= maxAttempts) {
    debugLog(`[DEBUG] Scroll: Timeout aguardando novos itens após scroll`);
  }
};

const processScrollRound = async (
  page: Page,
  baseUrl: string,
  currentRefs: WorkflowRef[],
  useFallback: boolean = false,
): Promise<WorkflowRef[]> => {
  const visibleRefs = await collectVisibleRefs(page, baseUrl, useFallback);
  return deduplicateById([...currentRefs, ...visibleRefs]);
};

const notifyProgress = (
  onProgress: ((progress: CollectionProgress) => void) | undefined,
  currentCount: number,
  round: number,
  maxRounds: number,
  isScrolling: boolean,
  previousCount: number,
): void => {
  if (!onProgress) return;

  const newWorkflowsFound = currentCount - previousCount;
  onProgress({
    currentCount,
    round,
    maxRounds,
    isScrolling,
    newWorkflowsFound,
  });
};

const collectWithScroll = async (
  page: Page,
  baseUrl: string,
  collection: CollectionOptions,
  currentRefs: WorkflowRef[],
  lastCount: number,
  round: number,
  onProgress?: (progress: CollectionProgress) => void,
  useFallback: boolean = false,
): Promise<WorkflowRef[]> => {
  const { maxScrollRounds, scrollDelay, scrollAmount } = collection;

  if (round >= maxScrollRounds) {
    debugLog(
      `[DEBUG] Limite de rodadas atingido (${maxScrollRounds}), finalizando coleta`,
    );
    notifyProgress(
      onProgress,
      currentRefs.length,
      round,
      maxScrollRounds,
      false,
      lastCount,
    );
    return currentRefs;
  }

  if (!page.isClosed() && !page.url().includes("/home/workflows")) {
    debugLog(
      `[DEBUG] Não estamos na página de workflows (${page.url()}), navegando de volta...`,
    );
    await navigate(page, `${baseUrl}${N8nUrls.workflows}`);
    await waitForSelector(page, N8nSelectors.resourcesList, 10000).catch(
      () => {},
    );
    await delay(1000);
  }

  if (round > 0) {
    debugLog(
      `[DEBUG] Rodada ${round}: Fazendo scroll antes de coletar workflows...`,
    );
    await scrollAndWait(page, scrollAmount, scrollDelay);
  }

  notifyProgress(
    onProgress,
    currentRefs.length,
    round,
    maxScrollRounds,
    round > 0,
    lastCount,
  );

  const uniqueRefs = await processScrollRound(
    page,
    baseUrl,
    currentRefs,
    useFallback,
  );

  debugLog(
    `[DEBUG] Rodada ${round}: Coletados ${uniqueRefs.length} workflows únicos (${uniqueRefs.length - lastCount} novos)`,
  );

  const isAtEnd = await hasReachedScrollEnd(page);
  if (isAtEnd && uniqueRefs.length === lastCount) {
    debugLog(
      `[DEBUG] Scroll chegou ao final e não há novos workflows, finalizando coleta`,
    );
    notifyProgress(
      onProgress,
      uniqueRefs.length,
      round,
      maxScrollRounds,
      false,
      lastCount,
    );
    return uniqueRefs;
  }

  if (uniqueRefs.length === lastCount) {
    notifyProgress(
      onProgress,
      uniqueRefs.length,
      round,
      maxScrollRounds,
      true,
      lastCount,
    );

    const isAtEndAfterCheck = await hasReachedScrollEnd(page);

    if (isAtEndAfterCheck) {
      debugLog(
        `[DEBUG] Scroll chegou ao final absoluto, finalizando coleta`,
      );
      notifyProgress(
        onProgress,
        uniqueRefs.length,
        round,
        maxScrollRounds,
        false,
        lastCount,
      );
      return uniqueRefs;
    }

    debugLog(
      `[DEBUG] Não chegou ao final do scroll ainda (${uniqueRefs.length} workflows), continuando...`,
    );
    return collectWithScroll(
      page,
      baseUrl,
      collection,
      uniqueRefs,
      uniqueRefs.length,
      round + 1,
      onProgress,
      useFallback,
    );
  }

  debugLog(
    `[DEBUG] Encontrou ${uniqueRefs.length - lastCount} novos workflows, continuando scroll...`,
  );
  return collectWithScroll(
    page,
    baseUrl,
    collection,
    uniqueRefs,
    uniqueRefs.length,
    round + 1,
    onProgress,
    useFallback,
  );
};

const collectAllWithSimpleScroll = async (
  page: Page,
  baseUrl: string,
  scrollAmount: number,
  scrollDelay: number,
  onProgress?: (progress: CollectionProgress) => void,
): Promise<WorkflowRef[]> => {
  const allWorkflows: WorkflowRef[] = [];
  let round = 0;
  const maxRounds = 200;

  debugLog(`[DEBUG] Iniciando coleta com scroll simples...`);
  await takeScreenshot(page, "04-inicio-coleta");

  let roundsWithoutNewWorkflows = 0;
  const maxRoundsWithoutNew = 3;
  let lastScrollTop: number | null = null;
  let stagnantScrolls = 0;

  while (round < maxRounds) {
    const visibleCardsCount = await getAllLocators(
      page,
      N8nSelectors.resourcesListItem,
    ).then((cards) => cards.length);

    const scrollInfoBefore = await page
      .evaluate(() => {
        const doc = (globalThis as any).document;
        const scrollable =
          doc.querySelector('[data-test-id="resources-list"]') ||
          doc.querySelector(".recycle-scroller-wrapper") ||
          doc.body;
        return {
          scrollTop: scrollable.scrollTop,
          scrollHeight: scrollable.scrollHeight,
          clientHeight: scrollable.clientHeight,
        };
      })
      .catch(() => ({
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
      }));

    debugLog(
      `[DEBUG] Rodada ${round}: Cards visíveis: ${visibleCardsCount}, Scroll: ${scrollInfoBefore.scrollTop}/${scrollInfoBefore.scrollHeight} (${scrollInfoBefore.clientHeight}px visível)`,
    );

    if (
      lastScrollTop !== null &&
      scrollInfoBefore.scrollTop === lastScrollTop
    ) {
      stagnantScrolls += 1;
    } else {
      stagnantScrolls = 0;
    }
    lastScrollTop = scrollInfoBefore.scrollTop;

    const visibleRefs = await collectVisibleRefs(page, baseUrl, true);
    const newRefs = visibleRefs.filter(
      (ref) => !allWorkflows.some((w) => w.id === ref.id),
    );

    debugLog(
      `[DEBUG] Rodada ${round}: Extraídos ${visibleRefs.length} workflows de ${visibleCardsCount} cards visíveis, ${newRefs.length} novos`,
    );

    if (newRefs.length > 0) {
      allWorkflows.push(...newRefs);
      roundsWithoutNewWorkflows = 0;
      debugLog(
        `[DEBUG] Rodada ${round}: ✅ Coletados ${newRefs.length} novos workflows (total: ${allWorkflows.length})`,
      );
    } else {
      roundsWithoutNewWorkflows += 1;
      debugLog(
        `[DEBUG] Rodada ${round}: ⚠️ Nenhum novo workflow encontrado (total: ${allWorkflows.length}, rodadas sem novos: ${roundsWithoutNewWorkflows})`,
      );
    }

    if (onProgress) {
      notifyProgress(
        onProgress,
        allWorkflows.length,
        round,
        maxRounds,
        true,
        allWorkflows.length - newRefs.length,
      );
    }

    const isAtEnd = await hasReachedScrollEnd(page);
    debugLog(`[DEBUG] Rodada ${round}: Chegou ao final? ${isAtEnd}`);

    if (roundsWithoutNewWorkflows >= maxRoundsWithoutNew && isAtEnd) {
      debugLog(
        `[DEBUG] Parando: ${roundsWithoutNewWorkflows} rodadas sem novos workflows e chegou ao final do scroll. Total coletado: ${allWorkflows.length} workflows`,
      );
      await takeScreenshot(page, `05-final-scroll-rodada-${round}`);
      break;
    }

    if (roundsWithoutNewWorkflows >= maxRoundsWithoutNew && !isAtEnd) {
      debugLog(
        `[DEBUG] Parando por segurança: ${roundsWithoutNewWorkflows} rodadas sem novos workflows, fim do scroll não detectado. Total coletado: ${allWorkflows.length} workflows`,
      );
      await takeScreenshot(page, `05-final-scroll-rodada-${round}`);
      break;
    }

    if (stagnantScrolls >= 2) {
      debugLog(
        `[DEBUG] Parando por estagnação do scroll (${stagnantScrolls} rodadas sem avançar). Total coletado: ${allWorkflows.length} workflows`,
      );
      await takeScreenshot(page, `05-final-scroll-rodada-${round}`);
      break;
    }

    if (isAtEnd && allWorkflows.length < 10) {
      debugLog(
        `[DEBUG] Chegou ao final mas coletou poucos workflows (${allWorkflows.length}), continuando por mais algumas rodadas...`,
      );
    } else if (isAtEnd) {
      debugLog(
        `[DEBUG] Chegou ao final do scroll. Total coletado: ${allWorkflows.length} workflows`,
      );
      await takeScreenshot(page, `05-final-scroll-rodada-${round}`);
      break;
    }

    debugLog(`[DEBUG] Rodada ${round}: Fazendo scroll...`);
    await takeScreenshot(page, `06-antes-scroll-rodada-${round}`);
    await scrollAndWait(page, scrollAmount, scrollDelay);
    await takeScreenshot(page, `07-depois-scroll-rodada-${round}`);
    round += 1;
  }

  const finalWorkflows = deduplicateById(allWorkflows);

  debugLog(`\n[DEBUG] ========================================`);
  debugLog(
    `[DEBUG] Coleta finalizada após ${round} rodadas. Total coletado: ${finalWorkflows.length} workflows`,
  );
  if (finalWorkflows.length > 0) {
    debugLog(`[DEBUG] Workflows coletados:`);
    finalWorkflows.forEach((wf, idx) => {
      debugLog(`[DEBUG]   ${idx + 1}. ${wf.name} (${wf.id}) - ${wf.url}`);
    });
  }
  debugLog(`[DEBUG] ========================================\n`);

  try {
    const totalCardsInList = await getAllLocators(
      page,
      N8nSelectors.resourcesListItem,
    ).then((cards) => cards.length);

    debugLog(
      `[DEBUG] Validação final: ${finalWorkflows.length} workflows coletados de ${totalCardsInList} cards visíveis na lista`,
    );

    if (
      finalWorkflows.length < totalCardsInList * 0.7 &&
      totalCardsInList > 10
    ) {
      debugLog(
        `[DEBUG] ⚠️ Coletou menos workflows (${finalWorkflows.length}) que cards visíveis (${totalCardsInList}), fazendo uma última tentativa de scroll...`,
      );
      await scrollAndWait(page, scrollAmount * 2, scrollDelay * 2);
      await delay(scrollDelay * 2);

      const finalCheckRefs = await collectVisibleRefs(page, baseUrl, true);
      const finalCheckNew = finalCheckRefs.filter(
        (ref) => !finalWorkflows.some((w) => w.id === ref.id),
      );

      if (finalCheckNew.length > 0) {
        debugLog(
          `[DEBUG] ✅ Última tentativa encontrou ${finalCheckNew.length} workflows adicionais`,
        );
        return deduplicateById([...finalWorkflows, ...finalCheckNew]);
      }
    }
  } catch (error) {
    debugLog(
      `[DEBUG] Erro na validação final: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return finalWorkflows;
};

export const executeCollectWorkflows = async (
  page: Page,
  options: CollectWorkflowsOptions,
): Promise<WorkflowRef[]> => {
  const { baseUrl, timeout, collection, onProgress } = options;

  try {
    debugLog(`[DEBUG] Navegando para: ${baseUrl}${N8nUrls.workflows}`);
    const workflowsUrl = `${baseUrl}${N8nUrls.workflows}`;

    if (page.isClosed()) {
      throw new WorkflowCollectionError("Page was closed before navigation");
    }

    await navigate(page, workflowsUrl);
    await takeScreenshot(page, "01-apos-navegar-workflows");

    if (page.isClosed()) {
      throw new WorkflowCollectionError("Page was closed after navigation");
    }

    await delay(1000);
    await takeScreenshot(page, "02-apos-delay-inicial");

    debugLog(
      `[DEBUG] Aguardando cards de workflows aparecerem (timeout: ${timeout}ms)...`,
    );

    try {
      await page
        .locator(N8nSelectors.resourcesListItem)
        .first()
        .waitFor({ timeout: 30000, state: "visible" });
      debugLog(`[DEBUG] Cards encontrados, continuando...`);
      await takeScreenshot(page, "03-cards-encontrados");
    } catch (error) {
      await takeScreenshot(page, "03-erro-cards-nao-encontrados");

      const pageContent = await page.content().catch(() => "");
      const hasSkeleton = pageContent.includes("el-skeleton");
      const hasResourceListLoading = pageContent.includes(
        "resource-list-loading",
      );

      throw new WorkflowCollectionError(
        `Cards de workflows não apareceram após 30s. URL atual: ${page.url()}. ` +
          `Skeleton presente: ${hasSkeleton}, Loading presente: ${hasResourceListLoading}`,
      );
    }

    const activeWorkflows = await collectAllWithSimpleScroll(
      page,
      baseUrl,
      collection.scrollAmount,
      collection.scrollDelay,
      onProgress,
    );

    let totalCardsInList = 0;
    try {
      if (!page.isClosed()) {
        const allCards = await getAllLocators(
          page,
          N8nSelectors.resourcesListItem,
        );
        totalCardsInList = allCards.length;
      }
    } catch {}

    debugLog(
      `[DEBUG] Coleta concluída: ${activeWorkflows.length} workflows Active únicos encontrados${totalCardsInList > 0 ? ` de ${totalCardsInList} cards totais` : ""}`,
    );

    if (activeWorkflows.length > 0) {
      debugLog(`[DEBUG] Lista de workflows Active que serão baixados:`);
      activeWorkflows.forEach((ref, index) => {
        debugLog(`[DEBUG]   ${index + 1}. ${ref.name} (${ref.id})`);
      });
    } else {
      debugLog(`[DEBUG] AVISO: Nenhum workflow Active foi encontrado`);
    }

    return activeWorkflows;
  } catch (error) {
    if (error instanceof WorkflowCollectionError) {
      debugLog(`[DEBUG] Erro de coleta: ${error.message}`);
      if (error.cause) {
        debugLog(
          `[DEBUG] Causa: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
        );
      }
      throw error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorDetails =
      error instanceof Error && error.stack ? `\nStack: ${error.stack}` : "";

    const fullMessage = `Failed to collect workflows: ${errorMessage}${errorDetails}`;
    debugLog(`[DEBUG] Erro na coleta: ${fullMessage}`);

    throw new WorkflowCollectionError(fullMessage, error);
  }
};
