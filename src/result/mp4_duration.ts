import { boxes } from "../shared/mp4_boxes.js";

export async function capMp4PlaybackDuration(blob: Blob, seconds: number): Promise<Blob> {
  if (!Number.isFinite(seconds) || seconds <= 0) return blob;

  // The converter writes ftyp followed by moov with +faststart.
  const first = new DataView(await blob.slice(0, 8).arrayBuffer());
  if (first.byteLength < 8 || first.getUint32(4) !== 0x66747970) return blob;
  const offset = first.getUint32(0);
  if (offset < 8) return blob;
  const header = new DataView(await blob.slice(offset, offset + 8).arrayBuffer());
  if (header.byteLength < 8 || header.getUint32(4) !== 0x6d6f6f76) return blob;
  const size = header.getUint32(0);
  if (size < 8 || size > blob.size - offset) return blob;

  const data = new DataView(await blob.slice(offset, offset + size).arrayBuffer());
  const children = boxes(data, 8);
  const mvhd = children.find(box => box.type === "mvhd");
  if (!mvhd || mvhd.end - mvhd.start < 20 || data.getUint8(mvhd.start) !== 0) return blob;
  const limit = Math.round(seconds * data.getUint32(mvhd.start + 12));
  if (limit <= 0 || limit > 0xffffffff) return blob;

  let longestTrack = 0;
  let trackCount = 0;
  for (const track of children.filter(box => box.type === "trak")) {
    const headers = boxes(data, track.start, track.end);
    const tkhd = headers.find(box => box.type === "tkhd");
    const edts = headers.find(box => box.type === "edts");
    const elst = edts && boxes(data, edts.start, edts.end).find(box => box.type === "elst");
    if (!tkhd || tkhd.end - tkhd.start < 24 || data.getUint8(tkhd.start) !== 0
      || !elst || elst.end - elst.start < 20 || data.getUint8(elst.start) !== 0) return blob;

    const count = data.getUint32(elst.start + 4);
    if (count < 1 || count > 2 || elst.start + 8 + count * 12 !== elst.end) return blob;
    const edit = elst.start + 8 + (count - 1) * 12;
    const delay = count === 2 ? data.getUint32(elst.start + 8) : 0;
    if ((count === 2 && data.getInt32(elst.start + 12) !== -1)
      || delay >= limit || data.getInt32(edit + 4) < 0 || data.getUint32(edit + 8) !== 0x10000) return blob;

    // Keep decoding samples and the existing edit start. Only shorten its visible end.
    const duration = Math.min(data.getUint32(edit), limit - delay);
    if (duration <= 0) return blob;
    data.setUint32(edit, duration);
    data.setUint32(tkhd.start + 20, delay + duration);
    longestTrack = Math.max(longestTrack, delay + duration);
    trackCount++;
  }

  if (!trackCount) return blob;
  data.setUint32(mvhd.start + 16, longestTrack);
  return new Blob([blob.slice(0, offset), data.buffer, blob.slice(offset + size)], { type: blob.type });
}
