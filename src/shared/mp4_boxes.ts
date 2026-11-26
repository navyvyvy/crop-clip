interface Box { type: string; start: number; end: number }

export function boxes(data: DataView, start = 0, end = data.byteLength): Box[] {
  const result: Box[] = [];
  for (let pos = start; pos + 8 <= end;) {
    const size = data.getUint32(pos);
    if (size < 8 || size > end - pos) break;
    const type = String.fromCharCode(...new Uint8Array(data.buffer, data.byteOffset + pos + 4, 4));
    result.push({ type, start: pos + 8, end: pos + size });
    pos += size;
  }
  return result;
}

export function readMp4Tracks(data: DataView): { kind: number; codec: string; headers: Box[]; media: Box[] }[] {
  const moov = boxes(data).find(box => box.type === "moov");
  const tracks = [];
  for (const track of moov ? boxes(data, moov.start, moov.end) : []) {
    if (track.type !== "trak") continue;
    const headers = boxes(data, track.start, track.end);
    const mdia = headers.find(box => box.type === "mdia");
    if (!mdia) continue;
    const media = boxes(data, mdia.start, mdia.end);
    const handler = media.find(box => box.type === "hdlr");
    const minf = media.find(box => box.type === "minf");
    const stbl = minf && boxes(data, minf.start, minf.end).find(box => box.type === "stbl");
    const stsd = stbl && boxes(data, stbl.start, stbl.end).find(box => box.type === "stsd");
    if (!handler || handler.start + 12 > handler.end || !stsd) continue;
    const codec = boxes(data, stsd.start + 8, stsd.end)[0]?.type;
    if (codec) tracks.push({ kind: data.getUint32(handler.start + 8), codec, headers, media });
  }
  return tracks;
}

export async function readMp4VideoCodec(blob: Blob): Promise<string | undefined> {
  const maxMetadataBytes = 4 * 1024 * 1024;
  let offset = 0;
  for (let index = 0; index < 64 && offset + 8 <= blob.size; index++) {
    const header = new DataView(await blob.slice(offset, offset + 16).arrayBuffer());
    const shortSize = header.getUint32(0);
    const headerSize = shortSize === 1 ? 16 : 8;
    if (header.byteLength < headerSize) return;
    const size = shortSize === 1 ? Number(header.getBigUint64(8)) : shortSize || blob.size - offset;
    if (size < headerSize || size > blob.size - offset) return;
    if (header.getUint32(4) === 0x6d6f6f76) {
      if (headerSize !== 8 || size > maxMetadataBytes) return;
      const data = new DataView(await blob.slice(offset, offset + size).arrayBuffer());
      return readMp4Tracks(data).find(track => track.kind === 0x76696465)?.codec;
    }
    offset += size;
  }
  return undefined;
}
