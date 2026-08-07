// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import type { ReactNode } from 'react'

// —— Mock react-i18next ——
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// —— Mock UI 组件（避免 Radix Portal 在 jsdom 中的复杂性）——
vi.mock('./ui/Dialog', () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: ReactNode
    open: boolean
    onOpenChange?: (o: boolean) => void
  }) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}))

vi.mock('./ui/Button', () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}))

import { CrashRecoveryDialog } from './CrashRecoveryDialog'

// —— Mock window.one API ——
type CrashCb = (payload: { drafts: Array<{ name: string; content: string }> }) => void
let crashRecoveryCb: CrashCb | null = null
const mockRemoveDraft = vi.fn().mockResolvedValue({ ok: true, data: undefined })
const mockListDrafts = vi.fn().mockResolvedValue({ ok: true, data: [] as Array<{ name: string; content: string }> })
const mockUnsub = vi.fn()

/** 辅助：模拟主进程推送 crashRecovery 事件（包裹 act 确保重渲染） */
function emitCrashRecovery(drafts: Array<{ name: string; content: string }>) {
  act(() => {
    crashRecoveryCb?.({ drafts })
  })
}

beforeEach(() => {
  crashRecoveryCb = null
  mockRemoveDraft.mockClear()
  mockListDrafts.mockClear()
  mockListDrafts.mockResolvedValue({ ok: true, data: [] })
  mockUnsub.mockClear()

  Object.defineProperty(window, 'one', {
    value: {
      app: {
        onCrashRecovery: (cb: CrashCb) => {
          crashRecoveryCb = cb
          return mockUnsub
        },
        listDrafts: mockListDrafts,
        removeDraft: mockRemoveDraft,
      },
    },
    writable: true,
    configurable: true,
  })

  // Mock clipboard
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CrashRecoveryDialog', () => {
  it('无草稿时不显示对话框', () => {
    render(<CrashRecoveryDialog />)
    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  it('收到崩溃恢复事件（含草稿）→ 显示草稿列表', () => {
    render(<CrashRecoveryDialog />)
    emitCrashRecovery([{ name: 'draft-1.json', content: 'Hello' }])
    expect(screen.getByTestId('dialog')).toBeDefined()
    expect(screen.getByText('draft-1.json')).toBeDefined()
    expect(screen.getByText('Hello')).toBeDefined()
  })

  it('收到空草稿列表 → 不显示对话框', () => {
    render(<CrashRecoveryDialog />)
    emitCrashRecovery([])
    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  it('dismiss → 调用 removeDraft 并移除该草稿', async () => {
    render(<CrashRecoveryDialog />)
    emitCrashRecovery([{ name: 'draft-1.json', content: 'Hello' }])

    await act(async () => {
      fireEvent.click(screen.getByText('crashRecovery.dismiss'))
    })

    expect(mockRemoveDraft).toHaveBeenCalledWith('draft-1.json')
    await waitFor(() => {
      expect(screen.queryByTestId('dialog')).toBeNull()
    })
  })

  it('dismissAll → 调用 removeDraft 全部并清空列表', async () => {
    render(<CrashRecoveryDialog />)
    emitCrashRecovery([
      { name: 'draft-1.json', content: 'A' },
      { name: 'draft-2.json', content: 'B' },
    ])

    await act(async () => {
      fireEvent.click(screen.getByText('crashRecovery.dismissAll'))
    })

    expect(mockRemoveDraft).toHaveBeenCalledTimes(2)
    expect(mockRemoveDraft).toHaveBeenCalledWith('draft-1.json')
    expect(mockRemoveDraft).toHaveBeenCalledWith('draft-2.json')
    await waitFor(() => {
      expect(screen.queryByTestId('dialog')).toBeNull()
    })
  })

  it('copy → 调用 clipboard.writeText', () => {
    render(<CrashRecoveryDialog />)
    emitCrashRecovery([{ name: 'draft-1.json', content: 'Copy me' }])

    fireEvent.click(screen.getByText('crashRecovery.copy'))

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Copy me')
  })

  it('内容超过 500 字符 → 截断显示（500 + …）', () => {
    const longContent = 'x'.repeat(600)
    render(<CrashRecoveryDialog />)
    emitCrashRecovery([{ name: 'draft-1.json', content: longContent }])

    // pre 元素内含 500 个 x + 换行 + …
    const pre = document.querySelector('pre')
    expect(pre).toBeDefined()
    expect(pre!.textContent).toHaveLength(502) // 500 + '\n' + '…'
  })

  it('close 按钮 → 关闭对话框（不清除草稿文件）', () => {
    render(<CrashRecoveryDialog />)
    emitCrashRecovery([{ name: 'draft-1.json', content: 'Hello' }])

    fireEvent.click(screen.getByText('actions.close'))

    expect(screen.queryByTestId('dialog')).toBeNull()
    expect(mockRemoveDraft).not.toHaveBeenCalled()
  })

  it('组件卸载 → 取消 crashRecovery 订阅', () => {
    const { unmount } = render(<CrashRecoveryDialog />)
    unmount()
    expect(mockUnsub).toHaveBeenCalled()
  })

  it('多草稿 → 全部显示在列表中', () => {
    render(<CrashRecoveryDialog />)
    emitCrashRecovery([
      { name: 'a.json', content: 'AAA' },
      { name: 'b.json', content: 'BBB' },
      { name: 'c.json', content: 'CCC' },
    ])

    expect(screen.getByText('a.json')).toBeDefined()
    expect(screen.getByText('b.json')).toBeDefined()
    expect(screen.getByText('c.json')).toBeDefined()
  })
})
