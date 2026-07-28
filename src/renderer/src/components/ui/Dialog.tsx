import { Root, Trigger, Portal, Overlay, Content, Title, Description, Close } from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ComponentPropsWithoutRef, ElementRef } from 'react'
import { forwardRef } from 'react'
import { cn } from '@renderer/lib/utils'

// —— Dialog 基础组件（ShadCN 范式 + 玻璃态）——
export const Dialog = Root
export const DialogTrigger = Trigger
export const DialogClose = Close

export const DialogContent = forwardRef<
  ElementRef<typeof Content>,
  ComponentPropsWithoutRef<typeof Content> & { hideClose?: boolean }
>(({ className, children, hideClose, ...props }, ref) => (
  <Portal>
    <Overlay className="fixed inset-0 z-50 bg-[var(--overlay-bg)] backdrop-blur-sm" />
    <Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-[var(--color-border)] bg-[var(--color-bg-1)] p-6 shadow-[var(--shadow-3)]',
        className,
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        <Close className="absolute right-4 top-4 rounded-full p-1 text-[var(--color-fg-2)] hover:bg-[var(--color-bg-3)]">
          <X size={16} />
        </Close>
      )}
    </Content>
  </Portal>
))
DialogContent.displayName = 'DialogContent'

export const DialogTitle = forwardRef<
  ElementRef<typeof Title>,
  ComponentPropsWithoutRef<typeof Title>
>(({ className, ...props }, ref) => (
  <Title ref={ref} className={cn('text-base font-semibold text-[var(--color-fg-1)]', className)} {...props} />
))
DialogTitle.displayName = 'DialogTitle'

export const DialogDescription = forwardRef<
  ElementRef<typeof Description>,
  ComponentPropsWithoutRef<typeof Description>
>(({ className, ...props }, ref) => (
  <Description ref={ref} className={cn('text-sm text-[var(--color-fg-2)]', className)} {...props} />
))
DialogDescription.displayName = 'DialogDescription'
