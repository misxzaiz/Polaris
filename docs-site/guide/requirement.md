# 需求管理

需求管理模块支持需求的全生命周期，从创建到执行完成。

通过 ActivityBar 的 **ClipboardList** 图标打开需求队列面板。

## 需求生命周期

<div class="lifecycle">
  <div class="lifecycle-step">草稿</div>
  <div class="lifecycle-arrow">→</div>
  <div class="lifecycle-step">待审核</div>
  <div class="lifecycle-arrow">→</div>
  <div class="lifecycle-step active">已批准</div>
  <div class="lifecycle-arrow">→</div>
  <div class="lifecycle-step">执行中</div>
  <div class="lifecycle-arrow">→</div>
  <div class="lifecycle-step">已完成</div>
</div>

<div style="text-align:center;margin:-8px 0 16px;">
  <span style="color:var(--p-danger);font-size:13px;">已拒绝 ← ← 可重新提交</span>
</div>

状态说明：

| 状态 | 说明 |
|------|------|
| 草稿 | 初始创建状态 |
| 待审核 | 等待用户审核（AI 生成的需求自动进入此状态） |
| 已批准 | 审核通过，可安排执行 |
| 已拒绝 | 审核未通过，需填写拒绝原因 |
| 执行中 | 正在由 AI 执行 |
| 已完成 | 执行成功 |
| 执行失败 | 执行过程中出错 |

## 创建需求

### 手动创建

点击面板右上角「新建」按钮：

| 字段 | 说明 |
|------|------|
| 标题 | 需求名称 |
| 描述 | 详细描述 |
| 优先级 | 低 / 普通 / 高 / 紧急 |
| 标签 | 自定义标签分类 |
| 生成原型 | 开启后创建时同步生成 HTML 原型 |

### AI 生成

点击「AI 生成需求」打开生成对话框：

1. 选择范围：全局 / 前端 / 后端
2. 可补充上下文信息
3. 点击「开始生成」，AI 自动创建需求并进入「待审核」状态

<div class="info-card tip">
  <div class="card-title">提示</div>
  <p>可通过定时任务选择 <code>req-generate</code> 模板实现需求自动生成。</p>
</div>

## 需求详情

点击需求卡片打开详情视图：

| 信息 | 说明 |
|------|------|
| 基本信息 | 标题、描述、状态、优先级、标签、来源 |
| 时间记录 | 生成时间、审核时间、执行开始时间、完成时间 |
| 执行信息 | 执行错误、执行日志、执行配置、计划执行时间 |
| 原型预览 | 如果含原型，可在面板内预览或全屏查看 |

## 审核操作

| 操作 | 说明 |
|------|------|
| 批准 | 审核通过，可安排执行时间 |
| 拒绝 | 需填写拒绝原因或修改建议 |

## 筛选和排序

| 筛选维度 | 选项 |
|----------|------|
| 状态 | 全部状态 / 按具体状态 |
| 优先级 | 全部优先级 / 低 / 普通 / 高 / 紧急 |
| 来源 | 全部来源 / AI 生成 / 手动创建 |
| 范围 | 当前工作区 / 所有工作区 |

排序支持：优先级升降序、创建时间升降序。

## 统计信息

面板顶部显示汇总：

- 待审核数量
- 已批准数量
- 执行中数量
- 总需求数
