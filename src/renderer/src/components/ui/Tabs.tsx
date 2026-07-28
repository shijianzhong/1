import { Root, List, Trigger, Content } from '@radix-ui/react-tabs'
import type { ComponentPropsWithoutRef, ElementRef } from 'react'
import { forwardRef } from 'react'
import { cn } from '@renderer/lib/utils'

// —— Tabs 基础组件（Inspector Tab，§2）——
export const Tabs = Root

export const TabsList = forwardRef<
  ElementRef<typeof List>,
  ComponentPropsWithoutRef<typeof List>
>(({ className, ...props }, ref) => (
  <List
    ref={ref}
    className={cn('inline-flex items-center gap-1 rounded-xl bg-[var(--color-bg-2)] p-1', className)}
    {...props}
  />
))
TabsList.displayName = 'TabsList'

export const TabsTrigger = forwardRef<
  ElementRef<typeof Trigger>,
  ComponentPropsWithoutRef<typeof Trigger>
>(({ className, ...props }, ref) => (
  <Trigger
    ref={ref}
    className={cn(
      'inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-sm text-[var(--color-fg-2)] transition-colors hover:text-[var(--color-fg-1)] data-[state=active]:bg-[var(--color-bg-1)] data-[state=active]:text-[var(--color-fg-1)] data-[state=active]:shadow-[var(--shadow-1)]',
      className,
    )}
    {...props}
  />
))
TabsTrigger.displayName = 'TabsTrigger'

export const TabsContent = forwardRef<
  ElementRef<typeof Content>,
  ComponentPropsWithoutRef<typeof Content>
>(({ className, ...props }, ref) => (
  <Content ref={ref} className={cn('mt-2', className)} {...props} />
))
TabsContent.displayName = 'TabsContent'
