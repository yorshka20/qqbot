# Claude Code 任务模板

你正在为 QQBot 项目执行一个开发任务。完成任务后，请通过 MCP API 通知 Bot。

## 项目信息

- **项目路径**: {{workingDirectory}}
- **任务ID**: {{taskId}}
- **MCP API 地址**: {{mcpApiUrl}}

## MCP API 使用说明

任务完成后，你**必须**通过以下 API 通知 Bot：

### 1. 通知任务状态

```bash
# 任务开始时
curl -X POST {{mcpApiUrl}}/api/notify \
  -H "Content-Type: application/json" \
  -d '{"taskId":"{{taskId}}","status":"started","message":"开始执行任务"}'

# 任务进度更新（可选）
curl -X POST {{mcpApiUrl}}/api/notify \
  -H "Content-Type: application/json" \
  -d '{"taskId":"{{taskId}}","status":"progress","progress":50,"message":"正在处理..."}'

# 任务完成时
curl -X POST {{mcpApiUrl}}/api/notify \
  -H "Content-Type: application/json" \
  -d '{"taskId":"{{taskId}}","status":"completed","result":"任务完成的简要描述"}'

# 任务失败时
curl -X POST {{mcpApiUrl}}/api/notify \
  -H "Content-Type: application/json" \
  -d '{"taskId":"{{taskId}}","status":"failed","error":"错误描述"}'
```

### 2. 发送消息给用户

```bash
curl -X POST {{mcpApiUrl}}/api/send \
  -H "Content-Type: application/json" \
  -d '{"target":{"type":"{{targetType}}","id":"{{targetId}}"},"content":"消息内容"}'
```

### 3. 执行 Bot 命令

```bash
# 执行 restart 命令（拉取代码、更新依赖、重启 Bot）
curl -X POST {{mcpApiUrl}}/api/command \
  -H "Content-Type: application/json" \
  -d '{"command":"restart","args":[]}'

# 其他可用命令
# - restart: 拉取代码、更新依赖、重启 Bot
# - reload-plugins: 重新加载插件
# - status: 获取 Bot 状态
```

## 任务要求

{{#if guidelines}}
### 特殊指导
{{guidelines}}
{{/if}}

### 你的任务

{{userPrompt}}

## 工作流程

1. **开始前**: 调用 `/api/notify` 通知任务开始
2. **执行任务**: 完成用户要求的开发工作
3. **测试验证**: 运行 `bun run typecheck` 和 `bun run lint` 确保代码质量
4. **完成后**:
   - 如果修改了代码，考虑是否需要执行 `restart` 命令
   - 调用 `/api/notify` 通知任务完成，并在 `result` 中总结所做的更改

## 注意事项

- 遵循项目的代码风格（参考 CLAUDE.md）
- 不要创建不必要的文件
- 优先编辑现有文件而非创建新文件
- 确保类型检查通过
- 任务完成后**务必**通知 Bot
