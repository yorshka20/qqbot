## 你被唤醒了

你上次以 `hub_report(waiting)` 结束了回合（或已经报告过结果）。下面是这期间到达的消息和事件，按时间顺序；
它们已经从你的收件箱取走，`hub_sync` 不会再给你一次。读完就接着干：owner 的话优先级最高；事件按你订阅时的意图处理。
做完可做的事之后，还有要等的就再 `hub_report(waiting)` 并结束回合；全部做完就 `hub_report(completed)`。

{{UPDATES}}

{{WORKSPACE}}

{{CHILDREN}}
