let ffmpegLoadPromise: Promise<FfmpegLike> | null = null;

export interface FfmpegLike {
  terminate(): void;
  on(event: "progress", callback: (event: { progress?: number; time?: number }) => void): void;
  load(options: { coreURL: string; wasmURL: string }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array): Promise<unknown>;
  exec(args: string[]): Promise<number>;
  readFile(path: string): Promise<Uint8Array | string>;
  listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>>;
  deleteFile(path: string): Promise<unknown>;
}

export async function loadFfmpeg(onProgress: (progress: number) => void): Promise<FfmpegLike> {
  if (!ffmpegLoadPromise) {
    ffmpegLoadPromise = (async () => {
      const module = await import(chrome.runtime.getURL("vendor/ffmpeg/ffmpeg/index.js")) as { FFmpeg: new () => FfmpegLike };
      const ffmpeg = new module.FFmpeg();
      ffmpeg.on("progress", ({ progress }) => {
        if (typeof progress === "number" && Number.isFinite(progress)) {
          onProgress(progress);
        }
      });
      try {
        await ffmpeg.load({
          coreURL: chrome.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.js"),
          wasmURL: chrome.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.wasm"),
        });
      } catch (error) {
        ffmpeg.terminate();
        throw error;
      }
      return ffmpeg;
    })().catch((error) => {
      ffmpegLoadPromise = null;
      throw error;
    });
  }

  return ffmpegLoadPromise;
}

export async function releaseFfmpeg(): Promise<void> {
  const pending = ffmpegLoadPromise;
  ffmpegLoadPromise = null;
  const ffmpeg = await pending?.catch(() => null);
  ffmpeg?.terminate();
}

export async function deleteFfmpegFile(ffmpeg: FfmpegLike, name: string, bestEffort = false): Promise<void> {
  try {
    await ffmpeg.deleteFile(name);
  } catch (error) {
    if (!bestEffort) {
      throw error;
    }
  }
}

export async function clearFfmpegOutputs(ffmpeg: FfmpegLike, bestEffort = false): Promise<void> {
  try {
    const files = await ffmpeg.listDir(".");
    await Promise.all(files
      .filter((file) => !file.isDir && (file.name === "input.webm" || file.name === "input.mp4" || file.name.startsWith("output")))
      .map((file) => deleteFfmpegFile(ffmpeg, file.name, bestEffort)));
  } catch (error) {
    if (!bestEffort) {
      throw error;
    }
  }
}

export async function readFfmpegBlob(ffmpeg: FfmpegLike, filename: string, mimeType: string): Promise<Blob> {
  const data = await ffmpeg.readFile(filename);
  if (typeof data === "string") {
    return new Blob([data], { type: mimeType });
  }

  const buffer = data.buffer instanceof ArrayBuffer
    ? data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data.buffer
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    : data.slice().buffer;
  return new Blob([buffer], { type: mimeType });
}
