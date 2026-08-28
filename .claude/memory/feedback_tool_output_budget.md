---
name: feedback-tool-output-budget
description: "工具输出截断省下的 token 若逼出额外一轮调用就是负收益；截断必须配可控杠杆 + 明确的续读指引"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 50fe0e30-6208-4e1d-97d1-128b8d56b0cb
  modified: 2026-08-28
---

给 LLM 工具设输出上限时，**省下的 token 要和它逼出的额外调用轮次一起算账**。硬编码的
"只返回前 N 条"若让模型必须再调一轮（甚至自己发明分页策略），总成本反而更高。

**Why:** 2026-08-28 owner 就 `fetch_history_by_time` 的 50 条上限明确指出："我明白 50 条是为了
省 token，可如果这个操作导致 llm 必须多一轮调用，那将得不偿失。" 真机 dump 里模型为了拿全一天
389 条记录，在 thinking 里反复盘算分段策略并拆成 5 次并发调用，多烧两轮推理。

**How to apply:** 截断本身可以有，但要 ①给调用方可控杠杆（`limit` / `offset` / range），
②在结果里写清还剩多少、下一步具体怎么调，③字符预算只作兜底不作杠杆。上限对模型不可见、
不可控时，它只能猜。参见 [[feedback-no-defensive-optionals]]。
