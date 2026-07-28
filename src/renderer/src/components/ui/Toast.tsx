import { Root, Viewport, Title, Description, Close } from '@radix-ui/react-toast'
import { X } from 'lucide-react'
import type { ComponentPropsWithoutRef, ElementRef } from 'react'
import { forwardRef } from 'react'
import { cn } from '@renderer/lib/utils'

// —— Toast 基础组件（§11.3 全局错误提示用）——
export const ToastProvider = Root
export const ToastViewport = forwardRef<
  ElementRef<typeof Viewport>,
  ComponentPropsWithoutRef<typeof Viewport>
>(({ className, ...props }, ref) => (
  <Viewport
    ref={ref}
    className={cn(
      'fixed bottom-4 right-4 z-[100] flex flex-col gap-2',
      className,
    )}
    {...props}
  />
))
ToastViewport.displayName = 'ToastViewport'

export const Toast = forwardRef<
  ElementRef<typeof Root>,
  ComponentPropsWithoutRef<typeof Root>
>(({ className, ...props }, ref) => (
  <Root
    ref={ref}
    className={cn(
      'rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-1)] p-4 shadow-[var(--shadow-2)]',
      className,
    )}
    {...props}
  />
))
Toast.displayName = 'Toast'

export const ToastTitle = forwardRef<
  ElementRef<typeof Title>,
  ComponentPropsWithoutRef<typeof Title>
>(({ className, ...props }, ref) => (
  <Title ref={ref} className={cn('text-sm font-semibold text-[var(--color-fg-1)]', className)} {...props} />
))
ToastTitle.displayName = 'ToastTitle'

export const ToastDescription = forwardRef<
  ElementRef<typeof Description>,
  ComponentPropsWithoutRef<typeof Description>
>(({ className, ...props }, ref) => (
  <Description ref={ref} className={cn('text-sm text-[var(--color-fg-2)]', className)} {...props} />
))
ToastDescription.displayName = 'ToastDescription'

export const ToastClose = forwardRef<
  ElementRef<typeof Close>,
  ComponentPropsWithoutRef<typeof Close>
>(({ className, ...props }, ref) => (
  <Close ref={ref} className={cn('rounded-full p-1 text-[var(--color-fg-2)] hover:bg-[var(--color-bg-3)]', className)} {...props}>
    <X size={14} />
  </Close>
))
ToastClose.displayName = 'ToastClose'
