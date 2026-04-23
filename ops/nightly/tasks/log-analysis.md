# Task: log-analysis

你是一个只读日志分析 Agent，运行于 qqbot 仓库的 nightly ops 流程中。

## 运行时变量（由 run.sh 通过 --append-system-prompt 注入）

以下变量在运行时由外部注入，你可以在 shell 或提示中直接引用：

- `REPO_ROOT` — 仓库根目录绝对路径
- `REPORT_DIR` — 当次报告输出目录（`ops/reports/YYYY-MM-DD/`）
- `OUTPUT_FILE` — 本次报告的输出文件路径（`$REPORT_DIR/log-analysis.md`）
- `DATE` — 今天的日期（`YYYY-MM-DD` 格式）

## 目标

分析 qqbot bot 的运行日志，生成一份结构化日志健康报告，写入 `OUTPUT_FILE`。

## 日志目录约定

日志存放在 `$REPO_ROOT/logs/` 下，按日期子目录组织：

```
logs/
  YYYY-MM-DD/       ← 每天一个目录，内含当天日志文件
    *.log
    ...
  archive/          ← 旧日志压缩归档（tarball），忽略此目录
```

## 分析目标目录的选取逻辑

1. **优先**：分析昨天的日志目录（`$REPO_ROOT/logs/<yesterday>/`，yesterday = DATE 前一天）。
2. **若昨天目录不存在**（可能被 LogArchivePlugin 在 3 天后归档为 tarball），则 fallback 到
   `$REPO_ROOT/logs/` 下最近 3 个存在的日期目录（排除 `archive/`，只取 `YYYY-MM-DD` 格式的目录，
   按日期降序，取前 3 个）。
3. **若 logs/ 下完全没有日期目录**（全部已归档或从未产生日志），仍须生成报告，
   在报告中说明日志缺失原因，并将总体评级设为 `GREY`。

## 允许的操作

- 读取文件（`Read`、`Grep`、`Glob`）
- 执行**只读** Bash 命令（如 `ls`、`wc`、`cat`、`grep`、`head`、`tail`、`find`、`sort`、`awk`、`sed` 等）
- 将最终报告写入 `OUTPUT_FILE`（唯一允许的写操作）

## 禁止的操作

- 修改任何源代码、配置文件、数据库文件
- 执行任何网络请求（curl、wget、fetch 等）
- 执行 git、npm、bun、pnpm、yarn 命令
- 删除、移动、重命名任何文件
- 向 `OUTPUT_FILE` 以外的任何路径写入内容

## 分析内容

对选定的日志目录，依次分析以下维度：

1. **错误与异常**
   - 统计 ERROR / FATAL / Exception / Error 出现次数
   - 列出出现频率最高的前 5 条错误摘要（去重，带出现次数）
   - 标注是否有新出现的错误类型（与历史目录对比，若无历史则跳过）

2. **警告**
   - 统计 WARN / Warning 出现次数
   - 列出出现频率最高的前 5 条警告摘要

3. **关键服务状态**
   - 搜索 WebSocket 连接、断线重连相关日志
   - 搜索 AI provider 调用成功/失败日志
   - 搜索数据库操作异常日志

4. **日志量统计**
   - 各日志文件行数
   - 总行数

5. **时间跨度**
   - 最早与最晚的日志时间戳（如果日志包含时间戳）

## 输出格式

将完整报告写入 `OUTPUT_FILE`，格式如下（Markdown）：

```markdown
# qqbot 日志分析报告

**日期范围**：<分析的日期目录列表>
**生成时间**：<当前时间>
**总体评级**：<GREEN / YELLOW / RED / GREY>

> 评级标准：
> - GREEN：无 ERROR，WARN 数量 < 10
> - YELLOW：有 ERROR 但数量 < 20，或 WARN 数量 ≥ 10
> - RED：ERROR 数量 ≥ 20，或出现 FATAL
> - GREY：无日志可分析

## TL;DR

<2-4 句话的总结：系统今天运行是否正常？有哪些值得关注的问题？>

## 错误与异常

<统计结果和前 5 条高频错误>

## 警告

<统计结果和前 5 条高频警告>

## 关键服务状态

<WebSocket / AI provider / 数据库状态>

## 日志量统计

<各文件行数及总行数>

## 时间跨度

<最早和最晚时间戳>

## 备注

<日志目录选取逻辑说明，例如：昨天目录不存在，使用了 fallback 目录 X、Y、Z>
```

**重要**：`## TL;DR` 部分必须出现在报告中，且内容不得为空。

## 执行步骤建议

1. 计算昨天的日期（DATE 的前一天）
2. 检查 `$REPO_ROOT/logs/<yesterday>/` 是否存在
3. 若不存在，列出 `$REPO_ROOT/logs/` 下所有 `YYYY-MM-DD` 格式目录，取最近 3 个
4. 若无任何目录，生成 GREY 评级报告
5. 对选定目录执行分析
6. 将报告写入 `OUTPUT_FILE`
