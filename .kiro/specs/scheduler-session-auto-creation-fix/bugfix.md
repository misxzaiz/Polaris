# Bugfix Requirements Document

## Introduction

本文档描述定时任务系统中的两个bug修复需求。这两个bug影响了用户体验：第一个bug导致定时任务执行时会自动创建不必要的会话标签页，干扰用户的工作流；第二个bug导致用户无法直观地看到定时任务是否已经执行完成。

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN 用户点击"执行任务"按钮或定时任务自动触发时 THEN 系统立即在标签栏自动创建一个新的会话标签页

1.2 WHEN 定时任务执行完成后 THEN 系统仅将状态更新为 'idle'，但用户在定时任务列表中看不到明显的完成标识

### Expected Behavior (Correct)

2.1 WHEN 用户点击"执行任务"按钮或定时任务自动触发时 THEN 系统SHALL在后台执行任务，不创建会话标签页

2.2 WHEN 用户点击"查询日志"按钮时 THEN 系统SHALL创建会话标签页来显示执行日志

2.3 WHEN 定时任务执行完成后 THEN 系统SHALL在定时任务列表中显示明确的完成状态标识（如完成图标、完成时间等）

### Unchanged Behavior (Regression Prevention)

3.1 WHEN 用户点击"查询日志"按钮订阅正在运行的任务时 THEN 系统SHALL CONTINUE TO正确创建会话标签页并显示实时日志

3.2 WHEN 定时任务执行过程中产生事件时 THEN 系统SHALL CONTINUE TO正确路由事件到对应的会话存储

3.3 WHEN 定时任务执行失败时 THEN 系统SHALL CONTINUE TO正确更新任务状态为 'failed'

3.4 WHEN 多个定时任务并行执行时 THEN 系统SHALL CONTINUE TO正确隔离各个任务的会话和事件

3.5 WHEN 用户切换活跃会话时 THEN 系统SHALL CONTINUE TO正确同步当前活跃会话的事件到旧架构（EventChatStore）
