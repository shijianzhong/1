import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// —— ShadCN 标准 cn 工具：clsx + tailwind-merge ——
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
