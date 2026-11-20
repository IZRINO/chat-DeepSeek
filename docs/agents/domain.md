# Domain Docs

采用单上下文（single-context）。网页版与 Tauri 安装版共用一份领域词汇表。

- 探索前读取根目录 `GLOSSARY.md` 和 `docs/adr/` 中与任务相关的架构决策记录（ADR）。文件不存在就继续，不预建空文件。
- 工单、测试名和技术方案沿用词汇表术语。术语或决策明确后，再通过 `/domain-modeling` 记录。
- 方案与现有 ADR 冲突时，明确写出 ADR 编号、冲突点和重新讨论的理由。
