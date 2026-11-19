import { open } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { webSink } from './web.js'

/** @param {string | URL} path @param {{overwrite?: boolean}} [options] */
export async function fileSink(path, { overwrite = false } = {}) {
  const file = await open(path, overwrite ? 'w' : 'wx')
  return {
    /** @param {Uint8Array} bytes */
    async write(bytes) {
      let offset = 0
      while (offset < bytes.length) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset)
        if (!bytesWritten) throw new Error('File write did not advance')
        offset += bytesWritten
      }
    },
    close: () => file.close(),
    abort: () => file.close(),
  }
}

/** @param {Writable} stream */
export function streamSink(stream) {
  return webSink(Writable.toWeb(stream))
}
