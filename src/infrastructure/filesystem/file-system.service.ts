import fs from "node:fs";
import path from "node:path";
import type { WorkflowRef } from "../../domain/types";


export const ensureDirectory = (dir: string): void => {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
};


export const slugify = (value: string): string => {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
};


export const sanitizeFileName = (fileName: string): string => {
  return fileName.replace(/[\\/:"*?<>|]+/g, "_");
};


export const generateFileName = (
  ref: WorkflowRef,
  extension: string = ".json",
): string => {
  const slug = slugify(ref.name);
  const baseName = `${slug}__${ref.id}`;
  const sanitized = sanitizeFileName(baseName);
  return `${sanitized}${extension}`;
};


export const joinPath = (...segments: string[]): string => {
  return path.join(...segments);
};
