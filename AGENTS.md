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

## 当前进度一句话（2026-07-30）

M0–M3 与 M5 骨架、部分 M6（含 mac dmg）已落地；**主战场是 M4 编排保真收口**（shouldRespond / fan-in / manager / 首页组队路由）以及 i18n 清零、Skill/工具深化。细节见 `task.md`「已知缺口」。
