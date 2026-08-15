import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { extractText, getDocumentProxy, getMeta } from "unpdf";

export interface PdfExtract {
  content: string;
  totalPages: number;
  title?: string;
  author?: string;
}

export async function extractPdf(path: string): Promise<PdfExtract> {
  const buffer = await readFile(path);
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  // Pages come back as an array and are joined once, rather than repeatedly
  // concatenating a growing string across a large document.
  const { totalPages, text } = await extractText(pdf);
  const content = text.map((page) => page.trim()).filter(Boolean).join("\n\n");

  let title: string | undefined;
  let author: string | undefined;
  try {
    const { info } = await getMeta(pdf);
    if (typeof info?.Title === "string" && info.Title.trim()) title = info.Title.trim();
    if (typeof info?.Author === "string" && info.Author.trim()) author = info.Author.trim();
  } catch {
    // metadata is best-effort
  }

  return {
    content,
    totalPages,
    title: title ?? basename(path).replace(/\.pdf$/i, ""),
    author,
  };
}
