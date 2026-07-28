import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@renderer/lib/utils'

// —— Button 基础组件（ShadCN 范式 + DESIGN 令牌）——
// 玻璃是框，实色是内容：default 用实色 brand-500，ghost/outline 用玻璃/描边。
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-[var(--color-brand-500)] text-white hover:bg-[var(--color-brand-600)]',
        secondary: 'bg-[var(--color-bg-3)] text-[var(--color-fg-1)] hover:opacity-80',
        ghost: 'bg-transparent text-[var(--color-fg-2)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg-1)]',
        outline: 'border border-[var(--color-border)] bg-transparent text-[var(--color-fg-1)] hover:bg-[var(--color-bg-2)]',
        danger: 'bg-[var(--color-danger)] text-white hover:opacity-90',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-11 px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
)
Button.displayName = 'Button'

export { buttonVariants }
