/** 用用户提供的 Snap 原图生成平台图标；裁去空白和适配格式，不重绘图形。 */
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeJsonFileAtomic } from '../src/main/lib/safe-file'

const resources = resolve(dirname(fileURLToPath(import.meta.url)), '../resources')
const rendererAssets = resolve(resources, '../src/renderer/assets')
const source = readFileSync(resolve(resources, 'brand/snap-source.jpg'))
const decoded = await sharp(source).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true })
const { width, height, channels } = decoded.info
let left = width, top = height, right = -1, bottom = -1
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const p = (y * width + x) * channels
    const r = decoded.data[p]!, g = decoded.data[p + 1]!, b = decoded.data[p + 2]!
    if (b > 100 && b - r > 50 && b - g > 35 && r < 150) {
      left = Math.min(left, x); top = Math.min(top, y)
      right = Math.max(right, x); bottom = Math.max(bottom, y)
    }
  }
}
if (right < left || bottom < top) throw new Error('Snap 原图未识别到蓝色标志，未生成图标')
const markSize = Math.max(right - left + 1, bottom - top + 1)
const side = Math.min(width, height, markSize + Math.round(markSize * .32))
const crop = {
  left: Math.max(0, Math.min(width - side, Math.floor((left + right + 1 - side) / 2))),
  top: Math.max(0, Math.min(height - side, Math.floor((top + bottom + 1 - side) / 2))),
  width: side, height: side,
}
const cropped = await sharp(source).rotate().extract(crop).png().toBuffer()
// 只处理外框，蓝色手势和原图的浅色底保持原样。
const mask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" rx="224" fill="white"/></svg>')
const brandIcon = await sharp(cropped).resize(1024, 1024).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()
// Dock 图标四边各留 100px 透明边距，使底板与常见 macOS 应用图标视觉等大。
const macOSInset = 100, macOSContentSize = 1024 - macOSInset * 2
const icon = await sharp(brandIcon).resize(macOSContentSize, macOSContentSize)
  .extend({ top: macOSInset, bottom: macOSInset, left: macOSInset, right: macOSInset, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png().toBuffer()
writeFileSync(resolve(resources, 'icon.png'), icon)
const sizes = [16, 32, 64, 128, 256, 512, 1024]
const pngs = new Map<number, Buffer>()
for (const size of sizes) pngs.set(size, await sharp(icon).resize(size, size).png().toBuffer())

// ICNS 和 ICO 使用同一图像的多分辨率 PNG 表示。
const types = ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10']
const chunks = sizes.map((size, index) => {
  const png = pngs.get(size)!, h = Buffer.alloc(8)
  h.write(types[index]!, 0, 4, 'ascii'); h.writeUInt32BE(png.length + 8, 4)
  return Buffer.concat([h, png])
})
const icns = Buffer.alloc(8)
icns.write('icns', 0, 4, 'ascii'); icns.writeUInt32BE(8 + chunks.reduce((sum, c) => sum + c.length, 0), 4)
writeFileSync(resolve(resources, 'icon.icns'), Buffer.concat([icns, ...chunks]))
// Windows 保留原品牌图的现有尺寸，macOS 的边距只用于 PNG / ICNS。
const icoPngs = new Map<number, Buffer>()
for (const size of [16, 32, 64, 128, 256]) icoPngs.set(size, await sharp(brandIcon).resize(size, size).png().toBuffer())
const icoSizes = [16, 32, 64, 128, 256], ico = Buffer.alloc(6 + icoSizes.length * 16)
ico.writeUInt16LE(1, 2); ico.writeUInt16LE(icoSizes.length, 4)
let offset = ico.length
for (const [index, size] of icoSizes.entries()) {
  const entry = 6 + index * 16, png = icoPngs.get(size)!
  ico[entry] = size === 256 ? 0 : size; ico[entry + 1] = size === 256 ? 0 : size
  ico.writeUInt16LE(1, entry + 4); ico.writeUInt16LE(32, entry + 6)
  ico.writeUInt32LE(png.length, entry + 8); ico.writeUInt32LE(offset, entry + 12)
  offset += png.length
}
writeFileSync(resolve(resources, 'icon.ico'), Buffer.concat([ico, ...icoSizes.map(s => icoPngs.get(s)!)]))

// 系统托盘需要同一轮廓的透明单色模板，颜色跟随系统主题。
const raw = await sharp(cropped).removeAlpha().raw().toBuffer({ resolveWithObject: true })
const pixels = Buffer.alloc(side * side * 4), backgroundRed = decoded.data[0]!
for (let p = 0; p < side * side; p++) {
  const coverage = Math.max(0, Math.min(1, (backgroundRed - raw.data[p * raw.info.channels]!) / (backgroundRed - 22)))
  pixels[p * 4 + 3] = coverage < .05 ? 0 : Math.round(coverage * 255)
}
const tray = await sharp(pixels, { raw: { width: side, height: side, channels: 4 } }).png().toBuffer()
for (const scale of [1, 2, 3]) {
  const suffix = scale === 1 ? '' : `@${scale}x`
  writeFileSync(resolve(resources, `snap-logos/iconTemplate${suffix}.png`), await sharp(tray).resize(22 * scale, 22 * scale).png().toBuffer())
}

// 保留已有资源文件名以兼容引用，内容统一为 Snap 标志。
writeFileSync(resolve(rendererAssets, 'models/snap.png'), brandIcon)
writeJsonFileAtomic(resolve(resources, 'brand/snap-icon-manifest.json'), {
  version: 2, source: 'snap-source.jpg', sourceSha256: createHash('sha256').update(source).digest('hex'),
  originalDimensions: { width, height }, blueMarkBounds: { left, top, right, bottom }, crop,
  outputDimensions: { width: 1024, height: 1024 },
  macOSCanvas: { size: 1024, contentSize: macOSContentSize, transparentInset: macOSInset },
  processing: '原图像素裁去外围空白、等比缩放、外框圆角；macOS PNG / ICNS 使用 824px 底板与四边 100px 透明边距。蓝色手势不重绘；网页、应用内标志与 Windows 图标保留原尺寸。托盘按同轮廓生成系统单色模板。',
})
console.log('[品牌] 已从用户原图生成 Snap PNG / ICNS / ICO / 托盘 / 模型 / 启动画面与网页资源')
