import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { forwardRef } from 'react'
import { cn } from '@renderer/lib/utils'

// —— Badge 基础组件（状态徽章，§5 任务进度）——
const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        default: 'bg-[var(--color-bg-3)] text-[var(--color-fg-1)]',
        brand: 'bg-[var(--color-brand-500)] text-white',
        success: 'bg-[var(--color-success)] text-white',
        warning: 'bg-[var(--color-warning)] text-white',
        danger: 'bg-[var(--color-danger)] text-white',
        info: 'bg-[var(--color-info)] text-white',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
  ),
)
Badge.displayName = 'Badge'
