let ffmpegLoadPromise: Promise<FfmpegLike> | null = null;
let activeFfmpeg: FfmpegLike | null = null;

export interface FfmpegLike {
  terminate(): void;
  on(event: "progress", callback: (event: { progress?: number; time?: number }) => void): void;
  load(options: { coreURL: string; wasmURL: string }): Promise<unknown>;
  createDir(path: string): Promise<unknown>;
  mount(type: "WORKERFS", options: { blobs: { name: string; data: Blob }[] }, path: string): Promise<boolean>;
  mount(type: "CROPCLIP_OUTPUT", options: { file: FileSystemFileHandle }, path: string): Promise<boolean>;
  unmount(path: string): Promise<boolean>;
  exec(args: string[]): Promise<number>;
  ffprobe(args: string[], timeout: number): Promise<number>;
  readFile(path: string): Promise<Uint8Array | string>;
  readFile(path: string, encoding: "blob"): Promise<Blob>;
  listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>>;
  deleteFile(path: string): Promise<unknown>;
}

export async function loadFfmpeg(onProgress: (progress: number) => void): Promise<FfmpegLike> {
  if (!ffmpegLoadPromise) {
    const pending: Promise<FfmpegLike> = import(chrome.runtime.getURL("vendor/ffmpeg/ffmpeg/index.js")).then(async (module: { FFmpeg: new () => FfmpegLike }) => {
      if (ffmpegLoadPromise !== pending) throw new DOMException("Conversion closed", "AbortError");
      const ffmpeg = activeFfmpeg = new module.FFmpeg();
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
        await ffmpeg.createDir("/source");
      } catch (error) {
        if (activeFfmpeg === ffmpeg) {
          activeFfmpeg = null;
          ffmpeg.terminate();
        }
        throw error;
      }
      return ffmpeg;
    }).catch((error) => {
      if (ffmpegLoadPromise === pending) ffmpegLoadPromise = null;
      throw error;
    });
    ffmpegLoadPromise = pending;
  }

  return ffmpegLoadPromise;
}

export async function releaseFfmpeg(): Promise<void> {
  const ffmpeg = activeFfmpeg;
  ffmpegLoadPromise = null;
  activeFfmpeg = null;
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
      .filter((file) => !file.isDir && file.name.startsWith("output"))
      .map((file) => deleteFfmpegFile(ffmpeg, file.name, bestEffort)));
  } catch (error) {
    if (!bestEffort) {
      throw error;
    }
  }
}

export async function readFfmpegBlob(ffmpeg: FfmpegLike, filename: string, mimeType: string): Promise<Blob> {
  const blob = await ffmpeg.readFile(filename, "blob");
  return blob.slice(0, blob.size, mimeType);
}
