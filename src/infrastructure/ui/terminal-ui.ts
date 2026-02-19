import type { CollectionProgress } from "../../domain/types";

const isTTY = process.stdout.isTTY ?? false;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PROGRESS_BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

let spinnerFrameIndex = 0;
let lastRenderTime = 0;
let isFirstRender = true;
const RENDER_INTERVAL = 100; 


const getSpinnerFrame = (): string => {
  const now = Date.now();
  if (now - lastRenderTime >= RENDER_INTERVAL) {
    spinnerFrameIndex = (spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
    lastRenderTime = now;
  }
  return SPINNER_FRAMES[spinnerFrameIndex];
};


const createProgressBar = (
  current: number,
  total: number,
  width: number = 30,
): string => {
  if (total === 0) return `[${" ".repeat(width)}] 0%`;

  const percentage = Math.min(100, Math.round((current / total) * 100));
  const filled = (current / total) * width;
  const fullBlocks = Math.floor(filled);
  const partialBlockIndex = Math.floor((filled - fullBlocks) * 8);

  const fullBar = "█".repeat(fullBlocks);
  const partialBar =
    partialBlockIndex > 0 ? PROGRESS_BLOCKS[partialBlockIndex] : "";
  const emptyBar = "░".repeat(
    Math.max(0, width - fullBlocks - (partialBar ? 1 : 0)),
  );

  return `[${fullBar}${partialBar}${emptyBar}] ${percentage}%`;
};


export const renderCollectionProgress = (
  progress: CollectionProgress,
): void => {
  if (!isTTY) {
    
    console.info(
      `Rodada ${progress.round}/${progress.maxRounds} | Encontrados: ${progress.currentCount} workflows`,
    );
    return;
  }

  const spinner = getSpinnerFrame();
  const progressBar = createProgressBar(progress.round, progress.maxRounds, 20);
  const status = progress.isScrolling ? "Scrolling..." : "Analisando...";
  const newWorkflowsText =
    progress.newWorkflowsFound > 0
      ? `│  Novos: +${progress.newWorkflowsFound}`
      : "";

  const line1 = `${spinner} Coletando workflows  │  Rodada: ${progress.round}/${progress.maxRounds}  │  Encontrados: ${progress.currentCount} workflows${newWorkflowsText}`;
  const line2 = `${progressBar}  │  Status: ${status}`;

  if (isFirstRender) {
    
    process.stdout.write(`${line1}\n${line2}\n`);
    isFirstRender = false;
  } else {
    
    process.stdout.write(`\x1b[2A\x1b[0J${line1}\n${line2}\n`);
  }
};


export const clearCollectionUI = (): void => {
  if (isTTY && !isFirstRender) {
    
    process.stdout.write(`\x1b[2A\x1b[0J`);
    isFirstRender = true;
  }
};


export const renderCollectionComplete = (total: number): void => {
  clearCollectionUI();
  console.info(`✅ Coleta concluída! Total: ${total} workflows encontrados\n`);
};
