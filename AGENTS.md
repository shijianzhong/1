# One — Agent 指南

> 本项目使用 Claude Code 开发，项目指南统一维护在 [`CLAUDE.md`](./CLAUDE.md)。
> 本文件面向其它 AI agent 工具（Cursor / Codex / Aider / Windsurf 等），内容与 CLAUDE.md 一致，以避免双份维护。

## 指南

所有项目约定、目录结构、构建命令、代码铁律、可简化项、协作流程见 **[CLAUDE.md](./CLAUDE.md)**。

请先读 CLAUDE.md，再读：

1. **[`task.md`](./task.md)** — **实现进度权威源**（阶段勾选、缺口清单）；勿凭过时文档假设「还在脚手架」
2. [`docs/REWRITE_PLAN.md`](./docs/REWRITE_PLAN.md) — 完整重写设计依据（§八 已与 task.md 对齐勾选）
3. [`docs/DESIGN.md`](./docs/DESIGN.md) — UI 规范
4. [`docs/UI_BRIEF.md`](./docs/UI_BRIEF.md) — UI 实现简报

[`docs/REVIEW_SUMMARY.md`](./docs/REVIEW_SUMMARY.md) 是设计文档 review 档案；文中「可进入阶段 0」等结论已过时，**不代表当前实现进度**。

## 一句话项目定位

**One**：把源项目 Proton（EClaw 智能助手，FastAPI + React Web 应用）重写为 Electron + React + 全 TypeScript 后端的纯桌面应用。后端全 TS 重写、纯桌面、前端重写不复用原 UI。

## 当前进度一句话（2026-08-03）

M0–M4 与 M5、部分 M6（含 mac dmg）已落地；Registry 共享 Phase 1–5 全链路完成（浏览导入/导出/Token+源管理/自动 PR/star/一键更新）；**Skill ContextProvider（7.4，铁律 22/23）已收口**（三处注入点统一 + discipline 注入 + skill_run_script async spawn）；**主战场是崩溃草稿 UI 闭环、工具生态深化（shell/MCP）与 i18n errors.\* 尾巴**。细节见 `task.md`「已知缺口」。
