const EDIT_OUTPUT_PREFIX = "cropclip-edit-";

function editOutputName(recordingId: string): string {
  return `${EDIT_OUTPUT_PREFIX}${encodeURIComponent(recordingId)}`;
}

export async function openEditOutputs(recordingId: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(editOutputName(recordingId), { create: true });
}

export async function removeEditOutputs(recordingId: string): Promise<void> {
  if (!navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(editOutputName(recordingId), { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
}
