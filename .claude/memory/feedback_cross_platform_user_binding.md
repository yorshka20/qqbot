---
name: Preserve cross-platform user-identity binding optionality in persona/memory work
description: Future feature — bind same user across QQ / WeChat / Discord / Bilibili etc to a unified persona memory. Don't close this door.
type: feedback
originSessionId: 4b19e2c0-8568-4314-a019-c7c45a8d473e
---
未来要实现的方向：跨平台账号绑定，让用户在 QQ / WeChat / Discord / Bilibili 等平台账号绑到同一个 `unified_user_id`，bot 在任意平台都"立刻认识"这个人，因为关系 / 记忆是同一份。**当前先不实现**，但所有 persona / memory / relationship / epigenetics 相关改动**必须保留这个可能性**，不能把"用户 ID = QQ 数字 ID"硬编进去。

**Why**：用户希望"我在 WeChat 接入 bot 后，绑定 QQ 号，bot 立即继承我在 QQ 的关系/记忆"。这不是 nice-to-have——是"远大想象"的一部分。如果今天的代码假设 userId 永远是 QQ 数字，未来要重构会很痛。

**当前已具备的好基础（**别破坏**）：

- `persona_relationships` 的 key 是 `(personaId, userId)`，**不带 groupId** —— 同 QQ 用户跨群+私聊已经共享同一行
- `EpigeneticsStore.getRelationship(personaId, userId)` 接口干净
- `userId` 在大部分 API 已经是 `string` 而非死锁 `number`

**How to apply** —— 实现新功能时：

1. **不要**在新增表/列里把 `qq_user_id` / `qq_group_id` 这种 platform-specific 名字烧进 schema（用 `user_id` / `group_id` 即可，platform 维度走另开字段或 `(platform, platform_user_id)` 复合 key）
2. **不要**把 `userId: number` 当强类型契约——`string` 更兼容（QQ 是数字，WeChat 是 wxid，Discord 是 snowflake string，等等）
3. **不要**把 `(groupId, userId)` 复合作 relationship 主键——已经避免了，保持
4. 涉及 user-身份解析的地方，将来可以塞一层 `resolveUnifiedUserId(platform, platformUserId) → unifiedUserId`；今天 identity-passthrough 不要写得太死（避免长函数链里多处显式 cast）
5. 反思 / memory 提取的输出 schema 不要把 "QQ 群名 / 平台特征" 当成 user 属性（应是 stimulus 的 metadata，不是 persona 关系本身的字段）

**绑定 / 解绑机制设计预想（不实现，仅参考）**：

- 用户主动：`/bind <one-time-token>` 在 platform A 输出 token，在 platform B 输入相同 token → 后端把两个 platform_user_id 关联到同一 unified_user_id
- 默认**不绑**——隔离是默认
- 每 persona 可独立选"看不看见绑定"（同 persona 跨平台共享 / 不同 persona 平台间扮不同角色）
- 解绑 `/unbind <platform>`，旧数据保留还是清除可选

**工程量预估**：实际实现成本不高（中间层加 userId resolver 即可，所有 store 调用 site 走 resolver），前提是今天的代码不在多处把 platform_user_id 当 unified_user_id。
