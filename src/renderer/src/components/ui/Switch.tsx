import { Root, Thumb } from '@radix-ui/react-switch'
import type { ComponentPropsWithoutRef, ElementRef } from 'react'
import { forwardRef } from 'react'
import { cn } from '@renderer/lib/utils'

// —— Switch 基础组件（§4 设置页开关）——
export const Switch = forwardRef<
  ElementRef<typeof Root>,
  ComponentPropsWithoutRef<typeof Root>
>(({ className, ...props }, ref) => (
  <Root
    ref={ref}
    className={cn(
      'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-[var(--color-border)] transition-colors data-[state=checked]:bg-[var(--color-brand-500)] data-[state=unchecked]:bg-[var(--color-bg-3)]',
      className,
    )}
    {...props}
  >
    <Thumb className={cn('pointer-events-none block h-5 w-5 rounded-full bg-white shadow-[var(--shadow-1)] transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0.5')} />
  </Root>
))
Switch.displayName = 'Switch'
