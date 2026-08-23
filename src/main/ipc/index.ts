import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, join, relative } from 'node:path'
import { app, BrowserWindow, dialog, nativeImage } from 'electron'
import {
  DEFAULT_THEME,
  type SystemPingResponse,
  type ThemeBackgroundConfig,
  type ThemeConfig,
} from '@shared/types'
import { withHandler } from './handler'
import { parseFileDialogLabels } from './dialog-labels'
import { getBackgroundDir } from '../storage/paths'
import { registerCapabilitiesHandlers } from './capabilities'
import { registerAgentsHandlers } from './agents'
import { registerSkillsHandlers } from './skills'
import { registerModelsHandlers } from './models'
import { registerPersonaHandlers } from './persona'
import { registerSessionsHandlers } from './sessions'
import { registerTasksHandlers } from './tasks'
import { registerSecretsHandlers } from './secrets'
import { registerHomeHandlers } from './home'
import { registerOrchestrateHandlers } from './orchestrate'
import { registerNativeHandlers } from './native'
import { registerProvidersHandlers } from './providers'
import { registerRegistryHandlers } from './registry'
import { registerMcpHandlers } from './mcp'
import { registerKnowledgeHandlers } from './knowledge'
import { registerTopicsHandlers } from './topics'
import { registerReviewsHandlers } from './reviews'
import { registerRunsHandlers } from './runs'
import { registerStyleProfilesHandlers } from './styleProfiles'
import { registerSampleArticlesHandlers } from './sampleArticles'
import { registerUpdaterHandlers } from '../updater'
import { startupMarkFromRenderer } from '../startup-log'

const THEME_FILE = 'theme.json'

// —— 原子写盘：临时文件 + rename（§11.4）——
async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await ensureDir(filePath)
  // 临时名必须每次唯一：同文件并发写（如主题快速调整连发）若共用 pid 临时名，
  // 后者 writeFile 截断前者尚未 rename 的临时文件 → ENOENT 风暴
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  try {
    await rename(tmp, filePath)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

function getThemePath(): string {
  return join(app.getPath('userData'), THEME_FILE)
}

async function loadTheme(): Promise<ThemeConfig> {
  try {
    const raw = await readFile(getThemePath(), 'utf8')
    return {
      ...DEFAULT_THEME,
      ...JSON.parse(raw),
    } as ThemeConfig
  } catch {
    return DEFAULT_THEME
  }
}

async function saveTheme(theme: ThemeConfig): Promise<ThemeConfig> {
  const nextTheme: ThemeConfig = { ...DEFAULT_THEME, ...theme }
  await writeJsonAtomic(getThemePath(), nextTheme)
  return nextTheme
}

// —— 背景图管理（§12.6.1）——
/** 背景图压缩上限：宽 1920px + JPEG 82。原图动辄几 MB，loadBackground 全量
 *  base64 过 IPC 进渲染内存（P2-2），压缩后通常几百 KB */
const BG_MAX_WIDTH = 1920
const BG_JPEG_QUALITY = 82

async function importBackground(filePath: string): Promise<{ imageId: string }> {
  const ext = extname(filePath).toLowerCase() || '.png'
  const imageId = randomUUID()
  const dir = getBackgroundDir()
  await mkdir(dir, { recursive: true })
  // 静态图统一压缩成 JPEG（gif 保留原样：重编码会丢动画）
  if (ext !== '.gif') {
    const img = nativeImage.createFromPath(filePath)
    if (!img.isEmpty()) {
      const { width } = img.getSize()
      const resized = width > BG_MAX_WIDTH ? img.resize({ width: BG_MAX_WIDTH }) : img
      await writeFile(join(dir, `${imageId}.jpg`), resized.toJPEG(BG_JPEG_QUALITY))
      return { imageId }
    }
  }
  const dest = join(dir, `${imageId}${ext}`)
  await copyFile(filePath, dest)
  return { imageId }
}

async function loadBackgroundDataUrl(
  bg: ThemeBackgroundConfig,
): Promise<{ dataUrl: string | null; stale?: boolean }> {
  if (bg.type !== 'image' || !bg.imageId) return { dataUrl: null }
  // 在 bg 目录找匹配 imageId 的文件
  const dir = getBackgroundDir()
  const { readdir } = await import('node:fs/promises')
  let found: string | null = null
  try {
    const files = await readdir(dir)
    found = files.find((f) => f.startsWith(bg.imageId!)) ?? null
    if (found) found = join(dir, found)
  } catch {
    // bg 目录不存在
  }
  if (!found || !existsSync(found)) {
    // path 失效（用户删了原图）→ stale
    return { dataUrl: null, stale: true }
  }
  const buf = await readFile(found)
  const ext = extname(found).slice(1) || 'png'
  return { dataUrl: `data:image/${ext};base64,${buf.toString('base64')}` }
}

async function removeBackgroundFile(imageId?: string): Promise<void> {
  if (!imageId) return
  const dir = getBackgroundDir()
  const { readdir } = await import('node:fs/promises')
  try {
    const files = await readdir(dir)
    for (const f of files) {
      if (f.startsWith(imageId)) {
        await unlink(join(dir, f)).catch(() => {})
      }
    }
  } catch {
    // 无目录
  }
}

export function registerIpcHandlers(): void {
  // —— system + theme ——
  withHandler<SystemPingResponse>('system:ping', (): SystemPingResponse => ({
    ok: true,
    appVersion: app.getVersion(),
    platform: process.platform,
  }))
  // 启动诊断埋点：渲染层上报，写入 userData/logs/startup.log
  withHandler<void>('system:startupMark', (_e, payloadRaw) => {
    const payload = payloadRaw as {
      phase?: string
      rendererT?: number
      detail?: Record<string, unknown>
    }
    if (payload?.phase) {
      startupMarkFromRenderer({
        phase: payload.phase,
        rendererT: payload.rendererT,
        detail: payload.detail,
      })
    }
  })
  withHandler<ThemeConfig>('theme:get', async () => loadTheme())
  withHandler<ThemeConfig>('theme:set', async (_event, themeRaw) =>
    saveTheme(themeRaw as ThemeConfig),
  )
  // 对话框文案由渲染层 i18n 后传入（铁律 T2：主进程不硬编码中文，review #27）
  withHandler<{ filePath: string } | null>('theme:pickBackground', async (_e, labelsRaw) => {
    const labels = parseFileDialogLabels(labelsRaw, 'errors:theme.invalid_input')
    const result = await dialog.showOpenDialog({
      title: labels.title,
      properties: ['openFile'],
      filters: [
        { name: labels.fileLabel, extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: labels.allFilesLabel, extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return { filePath: result.filePaths[0] }
  })
  withHandler<string | null>('app:pickDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // —— 附件选择 + 读取（聊天输入框 + 号）——
  withHandler<import('@shared/types').Attachment | null>(
    'app:selectAttachment',
    async (_e, typeRaw) => {
      const type = typeRaw as 'image' | 'file' | 'folder'
      if (type === 'image') {
        const result = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
        })
        if (result.canceled || result.filePaths.length === 0) return null
        const filePath = result.filePaths[0]
        const ext = extname(filePath).slice(1).toLowerCase()
        const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
        const buf = await readFile(filePath)
        const base64Data = buf.toString('base64')
        const s = await stat(filePath)
        return {
          id: randomUUID(),
          type: 'image',
          name: basename(filePath),
          path: filePath,
          size: s.size,
          dataUrl: `data:${mediaType};base64,${base64Data}`,
          base64Data,
          mediaType,
        }
      }
      if (type === 'file') {
        const result = await dialog.showOpenDialog({ properties: ['openFile'] })
        if (result.canceled || result.filePaths.length === 0) return null
        const filePath = result.filePaths[0]
        const s = await stat(filePath)
        const att: import('@shared/types').Attachment = {
          id: randomUUID(),
          type: 'file',
          name: basename(filePath),
          path: filePath,
          size: s.size,
        }
        // 文本文件（<=100KB）读取内容
        if (s.size <= 100 * 1024) {
          const ext = extname(filePath).slice(1).toLowerCase()
          const textExts = ['txt', 'md', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'yaml', 'yml', 'xml', 'html', 'css', 'scss', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'sql', 'toml', 'ini', 'env', 'gitignore', 'dockerfile']
          if (textExts.includes(ext) || s.size < 1024) {
            att.textContent = (await readFile(filePath, 'utf-8')).slice(0, 100 * 1024)
          }
        }
        return att
      }
      // folder
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      if (result.canceled || result.filePaths.length === 0) return null
      const dirPath = result.filePaths[0]
      const s = await stat(dirPath)
      const att: import('@shared/types').Attachment = {
        id: randomUUID(),
        type: 'folder',
        name: basename(dirPath),
        path: dirPath,
        size: s.size,
      }
      // 生成目录树摘要（最多 3 层，每层最多 50 项）
      att.treeSummary = await buildTreeSummary(dirPath, dirPath, 0, 3)
      return att
    },
  )
  withHandler<{ imageId: string }>('theme:importBackground', async (_e, filePathRaw) => {
    const filePath = filePathRaw as string
    return importBackground(filePath)
  })
  withHandler<{ dataUrl: string | null; stale?: boolean }>(
    'theme:loadBackground',
    async (_e, bgRaw) => loadBackgroundDataUrl(bgRaw as ThemeBackgroundConfig),
  )
  withHandler<void>('theme:removeBackground', async (_e, imageIdRaw) =>
    removeBackgroundFile(imageIdRaw as string | undefined),
  )

  // —— 阶段1 实体 CRUD ——
  registerCapabilitiesHandlers()
  registerAgentsHandlers()
  registerSkillsHandlers()
  registerModelsHandlers()
  registerPersonaHandlers()
  registerSessionsHandlers()
  registerTasksHandlers()
  registerSecretsHandlers()
  registerHomeHandlers()
  registerOrchestrateHandlers()
  registerProvidersHandlers()
  registerRegistryHandlers()
  registerMcpHandlers()
  registerKnowledgeHandlers()
  registerNativeHandlers(() => BrowserWindow.getAllWindows()[0] ?? null)
  registerUpdaterHandlers()
  // —— 内容生产管线资产（docs/CONTENT_PIPELINE_PLAN.md §2.3）——
  registerTopicsHandlers()
  registerReviewsHandlers()
  registerStyleProfilesHandlers()
  registerSampleArticlesHandlers()
  registerRunsHandlers()
}

/** 递归生成目录树摘要（用于 folder 附件） */
async function buildTreeSummary(root: string, dir: string, depth: number, maxDepth: number): Promise<string> {
  if (depth >= maxDepth) return ''
  const entries = await readdir(dir, { withFileTypes: true })
  const lines: string[] = []
  const indent = '  '.repeat(depth)
  for (const entry of entries.slice(0, 50)) {
    const fullPath = join(dir, entry.name)
    const rel = relative(root, fullPath)
    if (entry.isDirectory()) {
      lines.push(`${indent}📁 ${rel}/`)
      const sub = await buildTreeSummary(root, fullPath, depth + 1, maxDepth)
      if (sub) lines.push(sub)
    } else {
      lines.push(`${indent}📄 ${rel}`)
    }
  }
  return lines.join('\n')
}
