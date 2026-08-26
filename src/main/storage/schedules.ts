import { app } from 'electron'
import { join } from 'node:path'
import { readJsonFile, writeJsonFile, generateId } from './json-store'
import { logger } from '../logger'
import type { Schedule, ScheduleAction } from '@shared/types'

// —— 定时任务存储层（§定时任务）——
// 全部调度存单个 schedules.json（Schedule[]），原子写盘（临时文件 + rename，§11.4）。
// 主进程单线程 + 配置类小 JSON，沿用 json-store 的同步原子写（与 models/persona 同范式）。

const STORE_FILE = 'schedules.json'

function getPath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

function readAll(): Schedule[] {
  return readJsonFile<Schedule[]>(getPath(), [])
}

function writeAll(items: Schedule[]): void {
  writeJsonFile(getPath(), items)
}

export interface CreateScheduleInput {
  name: string
  enabled?: boolean
  cron: string
  timezone?: string
  action: ScheduleAction
  notifyOnComplete?: boolean
}

export function listSchedules(): Schedule[] {
  return readAll().sort((a, b) => a.createdAt - b.createdAt)
}

export function getSchedule(id: string): Schedule | null {
  return readAll().find((s) => s.id === id) ?? null
}

export function createSchedule(input: CreateScheduleInput): Schedule {
  const now = Date.now()
  const schedule: Schedule = {
    id: generateId('sch_'),
    name: input.name,
    enabled: input.enabled ?? true,
    cron: input.cron,
    timezone: input.timezone,
    action: input.action,
    notifyOnComplete: input.notifyOnComplete ?? false,
    lastFiredAt: null,
    createdAt: now,
    updatedAt: now,
  }
  const all = readAll()
  all.push(schedule)
  writeAll(all)
  return schedule
}

/** 局部更新；cron/timezone/action/enabled/name/notifyOnComplete 任一可改；更新 updatedAt */
export function updateSchedule(
  id: string,
  patch: Partial<Omit<Schedule, 'id' | 'createdAt' | 'updatedAt' | 'lastFiredAt'>>,
): Schedule | null {
  const all = readAll()
  const idx = all.findIndex((s) => s.id === id)
  if (idx < 0) return null
  const updated: Schedule = {
    ...all[idx],
    ...patch,
    updatedAt: Date.now(),
  }
  all[idx] = updated
  writeAll(all)
  return updated
}

export function removeSchedule(id: string): boolean {
  const all = readAll()
  const next = all.filter((s) => s.id !== id)
  if (next.length === all.length) return false
  writeAll(next)
  return true
}

/** 写回上次触发时刻（错过策略追平用）。返回是否写成功；失败仅告警（观测层不打断业务） */
export function setScheduleLastFired(id: string, ts: number): boolean {
  try {
    const all = readAll()
    const idx = all.findIndex((s) => s.id === id)
    if (idx < 0) return false
    all[idx] = { ...all[idx], lastFiredAt: ts, updatedAt: Date.now() }
    writeAll(all)
    return true
  } catch (e) {
    logger.warn(`[schedules] setScheduleLastFired 失败 id=${id}`, e)
    return false
  }
}
