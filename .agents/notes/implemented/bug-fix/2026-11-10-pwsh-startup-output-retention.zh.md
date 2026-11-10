# Agent Note: 跨就绪探测保留 PowerShell 启动输出

Status: implemented

[English](2026-11-10-pwsh-startup-output-retention.md) | 中文

## 问题

PowerShell 启动可能跨越一次因静默而结算的发送和后续精确就绪探测。两次操作之间到达的输出会进入保留的滚动缓冲区，却不属于任何一次发送的 viewport。因此，只发布最后一次 viewport 可能返回空启动消息，即使 shell 已打印受控提示符。

## 决策

[shell 后端](../../../../packages/terminal/terminal-bash/src/index.ts)在发布 PowerShell 会话时读取现有的有界滚动缓冲区。最后一次 `stdin_read` 结果仍决定就绪；保留文本提供启动消息，无需另建输出累加器或延长任何期限。普通读取的限制同样约束该消息。

[持久终端决策](../feature/2026-07-16-persistent-pty-sessions.zh.md)保留所有权、关闭和就绪策略。[PowerShell CI 决策](../testing/2026-09-07-pwsh-ci-observable-completion.zh.md)保留推断结算后的执行证明和录制 profile 期望；启动消息保留机制不取代这两项决策。

## 考虑过的替代方案

**拼接已结算发送的 viewport。** 这仍会丢失无发送收集时到达的输出，还需要另建一个会话已经拥有的有界累加器。

**增加静默超时或接受空消息。** 更长的时间窗口无法让操作局部输出覆盖全部启动区间。接受空消息则会向调用方隐藏已保留的输出。

## 影响

启动消息包含早期探测及其间隙中的保留输出，并受现有行数和字节限制约束。受控时钟回归使用真实会话，在探测之间发出提示符，同时验证保留输出和发布消息。移除保留读取会复现空消息失败。就绪分类、取消、启动超时和凭据清理仍独立执行。
