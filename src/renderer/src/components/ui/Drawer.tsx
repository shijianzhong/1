import { Root, Portal, Overlay, Content, Title, Close } from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ComponentPropsWithoutRef, ElementRef } from 'react'
import { forwardRef } from 'react'
import { cn } from '@renderer/lib/utils'

// —— Drawer（右侧抽屉，§3 编辑抽屉 600px 玻璃）——
// 复用 Radix Dialog 作 side sheet。
export const Drawer = Root
export const DrawerClose = Close

export const DrawerContent = forwardRef<
  ElementRef<typeof Content>,
  ComponentPropsWithoutRef<typeof Content> & { width?: number }
>(({ className, children, width = 600, ...props }, ref) => (
  <Portal>
    <Overlay className="fixed inset-0 z-50 bg-[var(--overlay-bg)] backdrop-blur-sm" />
    <Content
      ref={ref}
      style={{ width }}
      className={cn(
        'fixed right-0 top-0 z-50 h-full border-l border-[var(--color-border)] bg-[var(--glass-bg)] backdrop-blur-[var(--glass-blur-strong)] p-6 shadow-[var(--shadow-3)]',
        className,
      )}
      {...props}
    >
      {children}
      <Close className="absolute right-4 top-4 rounded-full p-1 text-[var(--color-fg-2)] hover:bg-[var(--color-bg-3)]">
        <X size={16} />
      </Close>
    </Content>
  </Portal>
))
DrawerContent.displayName = 'DrawerContent'

export const DrawerTitle = forwardRef<
  ElementRef<typeof Title>,
  ComponentPropsWithoutRef<typeof Title>
>(({ className, ...props }, ref) => (
  <Title ref={ref} className={cn('text-base font-semibold text-[var(--color-fg-1)]', className)} {...props} />
))
DrawerTitle.displayName = 'DrawerTitle'
