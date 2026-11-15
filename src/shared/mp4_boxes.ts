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
