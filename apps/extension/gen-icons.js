// One-off icon generator, run once with `node gen-icons.js` then deleted.
// Produces flat-color pixel-art PNGs (a simple sprout glyph) at 16/48/128px
// using only node:zlib, so the extension stays dependency-free at runtime.
// Not part of the shipped extension; not referenced by manifest.json at
// build time, only its output files are.
const fs = require('fs')
const zlib = require('zlib')
const path = require('path')

function crc32(buf) {
  let c
  const table = crc32.table || (crc32.table = (() => {
    const t = []
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })())
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

// grid: 16x16 design, 1=outline(dark ink), 2=accent(#2f4bd4), 3=leaf light(#8bd48f), 0=transparent
const G = [
  '0000000000000000',
  '0000000110000000',
  '0000001221000000',
  '0000012223100000',
  '0000112223210000',
  '0000012223100000',
  '0000001221000000',
  '0000000110000000',
  '0000000110000000',
  '0000001111100000',
  '0000113333110000',
  '0001133333311000',
  '0001133333311000',
  '0000113333110000',
  '0000001111100000',
  '0000000000000000',
]
const PALETTE = {
  '0': [0, 0, 0, 0],
  '1': [20, 20, 22, 255],
  '2': [47, 75, 212, 255],
  '3': [139, 212, 143, 255],
}

function buildPNG(size) {
  const scale = size / 16
  const width = size
  const height = size
  const raw = Buffer.alloc((width * 4 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0 // filter type none
    const gy = Math.floor(y / scale)
    for (let x = 0; x < width; x++) {
      const gx = Math.floor(x / scale)
      const [r, g, b, a] = PALETTE[G[gy][gx]]
      raw[offset++] = r
      raw[offset++] = g
      raw[offset++] = b
      raw[offset++] = a
    }
  }
  const idat = zlib.deflateSync(raw)

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const outDir = path.join(__dirname, 'icons')
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), buildPNG(size))
  console.log(`wrote icon${size}.png`)
}
