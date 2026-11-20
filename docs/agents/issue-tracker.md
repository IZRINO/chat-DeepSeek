# Issue tracker: GitHub

工单与规格放在 [IZRINO/chat-DeepSeek 的 GitHub Issues](https://github.com/IZRINO/chat-DeepSeek/issues)。
仓库公开。按用户本次指示创建或修改工单，不提交密钥、私密聊天记录或附件。

使用 GitHub CLI，明确带上 `--repo IZRINO/chat-DeepSeek`：
- 发布规格或工单：`gh issue create --title "<标题>" --body-file "<正文文件>"`。
- 读取或列出工单：`gh issue view <编号> --json number,title,body,labels,comments` 或 `gh issue list --state open`。
- 更新工单：`gh issue edit` 调整标签；需要关闭时先用 `gh issue comment` 说明原因，再用 `gh issue close`。
- 子工单和阻塞关系优先用 GitHub 原生功能；不可用时在工单正文写 `Part of #<编号>` 或 `Blocked by: #<编号>`。

**PRs as a request surface: no.**
