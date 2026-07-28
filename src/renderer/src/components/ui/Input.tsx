import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '@renderer/lib/utils'

// —— Input 基础组件（DESIGN：实色 bg-1 + 细描边，focus brand-500）——
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'h-9 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-1)] px-3 text-sm text-[var(--color-fg-1)] placeholder:text-[var(--color-fg-3)] focus:border-[var(--color-brand-500)] focus:outline-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
