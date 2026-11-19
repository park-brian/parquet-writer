/** @param {WritableStream<Uint8Array>} stream */
export function webSink(stream) {
  const writer = stream.getWriter()
  return {
    /** @param {Uint8Array} bytes */
    write: bytes => writer.write(bytes),
    async close() {
      try { await writer.close() } finally { writer.releaseLock() }
    },
    /** @param {unknown} reason */
    async abort(reason) {
      try { await writer.abort(reason) } finally { writer.releaseLock() }
    },
  }
}
