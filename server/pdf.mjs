// Assemble a PDF from the page images that musescore.com serves for the viewer.
import { PDFDocument } from "pdf-lib";

/**
 * @param {Array<{url:string, bytes:Buffer}>} pages
 */
export async function buildPdfFromImages(pages) {
  const doc = await PDFDocument.create();
  doc.setTitle("MuseScore sheet music");
  doc.setProducer("LibreScoreAPP");

  for (const page of pages) {
    const isPng = page.bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
    const img = isPng ? await doc.embedPng(page.bytes) : await doc.embedJpg(page.bytes);
    const p = doc.addPage([img.width, img.height]);
    p.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  return Buffer.from(await doc.save());
}
