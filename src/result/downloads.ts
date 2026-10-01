import { createObjectUrlSource } from "./media.js";

const DOWNLOAD_URL_REVOKE_DELAY_MS = 1_000;

const SEQUENTIAL_DOWNLOAD_DELAY_MS = 350;

export function downloadSource(source: Blob | string, filename: string): void {
  const { url, revoke } = createObjectUrlSource(source);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  if (revoke) {
    window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_REVOKE_DELAY_MS);
  }
}

function waitForDownloadCompletion(downloadId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      error ? reject(error) : resolve();
    };
    const checkState = (state?: string, error?: string) => {
      if (state === "complete") {
        finish();
      } else if (state === "interrupted") {
        finish(new Error(`다운로드가 중단되었습니다${error ? `: ${error}` : "."}`));
      }
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === downloadId) {
        checkState(delta.state?.current, delta.error?.current);
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);
    void chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (!item) {
        finish(new Error("시작한 다운로드를 찾지 못했습니다."));
        return;
      }
      checkState(item.state, item.error);
    }, (error: unknown) => {
      finish(error instanceof Error ? error : new Error("다운로드 상태를 확인하지 못했습니다."));
    });
  });
}

async function beginConfirmedDownload(source: Blob | string, filename: string): Promise<{ completion: Promise<void> }> {
  const { url, revoke } = createObjectUrlSource(source);
  try {
    const downloadId = await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
    const completion = waitForDownloadCompletion(downloadId).finally(() => {
      if (revoke) {
        URL.revokeObjectURL(url);
      }
    });
    return { completion };
  } catch (error) {
    if (revoke) {
      URL.revokeObjectURL(url);
    }
    throw error;
  }
}

export async function downloadSourcesSequentially(items: Array<{ source: Blob | string; filename: string }>): Promise<void> {
  for (const item of [...items].sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))) {
    downloadSource(item.source, item.filename);
    await new Promise(resolve => window.setTimeout(resolve, SEQUENTIAL_DOWNLOAD_DELAY_MS));
  }
}

export async function downloadSourcesAndConfirm(items: Array<{ source: Blob | string; filename: string }>): Promise<void> {
  const completions: Array<Promise<Error | null>> = [];
  for (const item of [...items].sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))) {
    const { completion } = await beginConfirmedDownload(item.source, item.filename);
    completions.push(completion.then(
      () => null,
      (error: unknown) => error instanceof Error ? error : new Error("다운로드를 완료하지 못했습니다."),
    ));
    await new Promise(resolve => window.setTimeout(resolve, SEQUENTIAL_DOWNLOAD_DELAY_MS));
  }
  const error = (await Promise.all(completions)).find((result): result is Error => result !== null);
  if (error) {
    throw error;
  }
}
