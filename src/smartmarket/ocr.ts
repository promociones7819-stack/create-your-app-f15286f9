// OCR 100% local. Nada sale del dispositivo: tesseract.js corre en el navegador
// mediante WebAssembly y pdfjs-dist extrae el texto del PDF en local.

export type OcrProgress = (stage: string, progress: number) => void;

/**
 * PDF.js usa Promise.withResolvers, que no está disponible en algunas versiones
 * de Safari todavía presentes en iPhone, iPad y macOS. Debe instalarse antes del
 * import dinámico porque PDF.js la invoca al evaluar el módulo.
 */
function ensurePdfJsCompatibility(): void {
  const PromiseWithResolvers = Promise as typeof Promise & {
    withResolvers?: <T>() => {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  };

  if (!PromiseWithResolvers.withResolvers) {
    PromiseWithResolvers.withResolvers = <T>() => {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      return { promise, resolve, reject };
    };
  }
}

async function loadPdfJs() {
  ensurePdfJsCompatibility();
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs;
}

async function pdfToText(file: File, onProgress?: OcrProgress): Promise<string> {
  const pdfjs = await loadPdfJs();

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(`Leyendo página ${i}/${pdf.numPages}`, i / pdf.numPages);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const lines = new Map<number, string[]>();
    for (const item of content.items) {
      if (!("str" in item) || typeof item.str !== "string") continue;
      const y = Math.round(item.transform[5]);
      const list = lines.get(y) ?? [];
      list.push(item.str);
      lines.set(y, list);
    }
    const ordered = [...lines.entries()].sort((a, b) => b[0] - a[0]);
    text += ordered.map(([, parts]) => parts.join(" ")).join("\n") + "\n";
  }
  return text;
}

async function pdfFirstPageToCanvas(file: File): Promise<HTMLCanvasElement> {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2.2 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d")!, viewport, canvas }).promise;
  return canvas;
}

async function imageToText(
  source: File | HTMLCanvasElement,
  onProgress?: OcrProgress,
): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("spa", 1, {
    logger: (m) => {
      if (m.status === "recognizing text") onProgress?.("Reconociendo texto", m.progress);
      else onProgress?.("Preparando motor OCR local", m.progress ?? 0);
    },
  });
  try {
    const recognizeSource: Parameters<typeof worker.recognize>[0] = source;
    const { data } = await worker.recognize(recognizeSource);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

/** Extrae texto de una imagen o PDF sin salir del dispositivo. */
export async function extractText(file: File, onProgress?: OcrProgress): Promise<string> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    const text = await pdfToText(file, onProgress);
    if (text.replace(/\s/g, "").length > 40) return text;
    onProgress?.("PDF escaneado: aplicando OCR local", 0);
    const canvas = await pdfFirstPageToCanvas(file);
    return imageToText(canvas, onProgress);
  }
  return imageToText(file, onProgress);
}
