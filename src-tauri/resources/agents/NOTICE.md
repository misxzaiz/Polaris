# NOTICE

本目录(`resources/agents/`)包含来自以下开源项目的 AI agent 定义文件(`corpus/*.md`)及派生元数据(catalog/divisions/rosters 等 JSON),依 MIT 许可证再分发:

## agency-agents-zh(corpus 主体,267 个 agent 定义)

- 仓库: https://github.com/jnMetaCode/agency-agents-zh
- 版权: © 2025 Michael Sitarzewski (original English version); © 2026 jnMetaCode (Chinese translation and localization)
- 许可证: MIT(见 `LICENSE-agency-agents-zh.txt`)
- 基线 commit: `244c37a188c5e4b8fbfdc62f1786a446836eabaf`(2026-07 快照,内容对应其追平上游 `3f78a30` 的状态)

## agency-agents(divisions/runbooks 元数据来源)

- 仓库: https://github.com/msitarzewski/agency-agents
- 版权: © 2025 AgentLand Contributors / Michael Sitarzewski
- 许可证: MIT(见 `LICENSE-agency-agents.txt`)
- 基线 commit: `459dce837db3bdfdc4763d3fefd1fd854e73c8f1`
- 使用范围: `divisions.json`(部门 label/icon/color)与 `strategy/runbooks.json`(场景 roster,经 `scripts/gen-agent-catalog.mjs` 转换为 `rosters.json`)

## 裁剪说明

再分发时已剔除与 agent 定义无关的内容:上游安装/转换脚本(`scripts/`)、各工具集成产物(`integrations/`)、赞助商资源(`assets/`)、CI 配置(`.github/`)。agent 定义正文保持原样,未做内容修改。

派生 JSON 由 `scripts/gen-agent-catalog.mjs` 生成,重新生成方式见该脚本头部注释。
