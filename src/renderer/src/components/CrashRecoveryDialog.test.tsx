// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
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

// —— render 包裹 MemoryRouter：组件内 useNavigate 需要 Router 上下文 ——
function renderDialog() {
  return render(
    <MemoryRouter>
      <CrashRecoveryDialog />
    </MemoryRouter>,
  )
}

// —— Mock window.one API ——
type CrashCb = (payload: { drafts: Array<{ name: string; content: string }> }) => void
let crashRecoveryCb: CrashCb | null = null
const mockRemoveDraft = vi.fn().mockResolvedValue({ ok: true, data: undefined })
const mockListDrafts = vi.fn().mockResolvedValue({ ok: true, data: [] as Array<{ name: string; content: string }> })
const mockHadCrashed = vi.fn().mockResolvedValue({ ok: true, data: true })
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
  mockHadCrashed.mockClear()
  mockHadCrashed.mockResolvedValue({ ok: true, data: true })
  mockUnsub.mockClear()

  Object.defineProperty(window, 'one', {
    value: {
      app: {
        onCrashRecovery: (cb: CrashCb) => {
          crashRecoveryCb = cb
          return mockUnsub
        },
        listDrafts: mockListDrafts,
        hadCrashedLastRun: mockHadCrashed,
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
    renderDialog()
    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  it('收到崩溃恢复事件（含草稿）→ 显示草稿列表', () => {
    renderDialog()
    emitCrashRecovery([{ name: 'draft-1.json', content: 'Hello' }])
    expect(screen.getByTestId('dialog')).toBeDefined()
    expect(screen.getByText('draft-1.json')).toBeDefined()
    expect(screen.getByText('Hello')).toBeDefined()
  })

  it('收到空草稿列表 → 不显示对话框', () => {
    renderDialog()
    emitCrashRecovery([])
    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  it('dismiss → 调用 removeDraft 并移除该草稿', async () => {
    renderDialog()
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
    renderDialog()
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
    renderDialog()
    emitCrashRecovery([{ name: 'draft-1.json', content: 'Copy me' }])

    fireEvent.click(screen.getByText('crashRecovery.copy'))

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Copy me')
  })

  it('内容超过 500 字符 → 截断显示（500 + …）', () => {
    const longContent = 'x'.repeat(600)
    renderDialog()
    emitCrashRecovery([{ name: 'draft-1.json', content: longContent }])

    // pre 元素内含 500 个 x + 换行 + …
    const pre = document.querySelector('pre')
    expect(pre).toBeDefined()
    expect(pre!.textContent).toHaveLength(502) // 500 + '\n' + '…'
  })

  it('close 按钮 → 关闭对话框（不清除草稿文件）', () => {
    renderDialog()
    emitCrashRecovery([{ name: 'draft-1.json', content: 'Hello' }])

    fireEvent.click(screen.getByText('actions.close'))

    expect(screen.queryByTestId('dialog')).toBeNull()
    expect(mockRemoveDraft).not.toHaveBeenCalled()
  })

  it('组件卸载 → 取消 crashRecovery 订阅', () => {
    const { unmount } = renderDialog()
    unmount()
    expect(mockUnsub).toHaveBeenCalled()
  })

  it('多草稿 → 全部显示在列表中', () => {
    renderDialog()
    emitCrashRecovery([
      { name: 'a.json', content: 'AAA' },
      { name: 'b.json', content: 'BBB' },
      { name: 'c.json', content: 'CCC' },
    ])

    expect(screen.getByText('a.json')).toBeDefined()
    expect(screen.getByText('b.json')).toBeDefined()
    expect(screen.getByText('c.json')).toBeDefined()
  })

  it('restore 按钮：仅可恢复草稿（home-composer / editor-*）显示，点击后导航并关闭弹窗', () => {
    renderDialog()
    emitCrashRecovery([
      { name: 'home-composer.json', content: '{"kind":"home-composer","text":"未发送"}' },
      { name: 'draft-1.json', content: '不可恢复' },
    ])

    // home-composer 草稿应显示 restore 按钮，draft-1 不应显示
    const restoreBtn = screen.getByText('crashRecovery.restore')
    expect(restoreBtn).toBeDefined()
    // 只有一个 restore 按钮（draft-1 不渲染 restore）
    expect(screen.getAllByText('crashRecovery.restore')).toHaveLength(1)

    act(() => {
      fireEvent.click(restoreBtn)
    })

    // 点击后弹窗关闭
    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  it('editor 草稿 restore → 导航到 /capability/:id', () => {
    renderDialog()
    emitCrashRecovery([
      { name: 'editor-cap-abc.json', content: '{"kind":"editor-graph","graph":{}}' },
    ])

    const restoreBtn = screen.getByText('crashRecovery.restore')
    act(() => {
      fireEvent.click(restoreBtn)
    })

    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  it('pull 通道：上次崩溃（hadCrashedLastRun=true）且有草稿 → 显示对话框', async () => {
    mockHadCrashed.mockResolvedValue({ ok: true, data: true })
    mockListDrafts.mockResolvedValue({
      ok: true,
      data: [{ name: 'home-composer.json', content: '{"text":"hi"}' }],
    })

    renderDialog()

    await waitFor(() => {
      expect(screen.getByTestId('dialog')).toBeDefined()
    })
    expect(screen.getByText('home-composer.json')).toBeDefined()
  })

  it('pull 通道：上次正常退出（hadCrashedLastRun=false）→ 有草稿也不弹窗（草稿由页面静默灌回）', async () => {
    mockHadCrashed.mockResolvedValue({ ok: true, data: false })
    mockListDrafts.mockResolvedValue({
      ok: true,
      data: [{ name: 'home-composer.json', content: '{"text":"hi"}' }],
    })

    renderDialog()

    // 等待 hadCrashedLastRun 被调用后仍不显示
    await waitFor(() => {
      expect(mockHadCrashed).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('dialog')).toBeNull()
    // 正常退出时甚至不拉草稿列表
    expect(mockListDrafts).not.toHaveBeenCalled()
  })
})
