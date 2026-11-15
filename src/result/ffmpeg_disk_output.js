// Loaded by the packaged FFmpeg worker for disk-backed outputs.
export async function attachDiskOutput(fs, path, file) {
  const handle = await file.createSyncAccessHandle();
  try {
    handle.truncate(0);
    const node = fs.create(path);
    const { setattr } = node.node_ops;
    node.node_ops = {
      ...node.node_ops,
      setattr(target, attrs) {
        if (attrs.size !== undefined) {
          handle.truncate(attrs.size);
          target.usedBytes = attrs.size;
        }
        const { size, ...metadata } = attrs;
        setattr(target, metadata);
      },
    };
    node.stream_ops = {
      llseek: node.stream_ops.llseek,
      read(_stream, bytes, offset, length, position) {
        return handle.read(bytes.subarray(offset, offset + length), { at: position });
      },
      write(_stream, bytes, offset, length, position) {
        const written = handle.write(bytes.subarray(offset, offset + length), { at: position });
        if (written !== length) throw new Error("Incomplete temporary output write");
        node.usedBytes = Math.max(node.usedBytes, position + written);
        return written;
      },
    };
    return () => handle.close();
  } catch (error) {
    handle.close();
    throw error;
  }
}
