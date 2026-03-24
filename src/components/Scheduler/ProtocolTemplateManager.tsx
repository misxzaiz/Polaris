/**
 * 协议模板管理组件
 *
 * 用于管理协议模式的任务模板，包括查看内置模板和管理自定义模板
 */

import { useState } from 'react';
import { useProtocolTemplateStore } from '../../stores/protocolTemplateStore';
import {
  ProtocolTemplateCategoryLabels,
  ProtocolTemplateCategory,
  TEMPLATE_PLACEHOLDERS,
} from '../../types/protocolTemplate';
import type { ProtocolTemplate, CreateProtocolTemplateParams, TemplateParam } from '../../types/protocolTemplate';

/** 模板编辑器 */
function TemplateEditor({
  template,
  onSave,
  onClose,
}: {
  template?: ProtocolTemplate;
  onSave: (params: CreateProtocolTemplateParams) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(template?.name || '');
  const [description, setDescription] = useState(template?.description || '');
  const [category, setCategory] = useState<ProtocolTemplateCategory>(template?.category || 'custom');
  const [missionTemplate, setMissionTemplate] = useState(template?.missionTemplate || '');
  const [fullTemplate, setFullTemplate] = useState(template?.fullTemplate || '# 任务协议\n' +
      '\n' +
      '> 任务ID: {taskId}\n' +
      '> 创建时间: {dateTime}\n' +
      '\n' +
      '## 任务目标\n' +
      '\n' +
      '{task}\n' +
      '\n' +
      '## 用户补充\n' +
      '\n' +
      '{userSupplement}\n' +
      '\n' +
      '## 工作区\n' +
      '\n' +
      '{workDir}\n' +
      '');
  const [templateParams, setTemplateParams] = useState<TemplateParam[]>(template?.templateParams || []);
  const [defaultTriggerType, setDefaultTriggerType] = useState<'once' | 'cron' | 'interval'>(
    template?.defaultTriggerType || 'interval'
  );
  const [defaultTriggerValue, setDefaultTriggerValue] = useState(template?.defaultTriggerValue || '1h');
  const [defaultEngineId, setDefaultEngineId] = useState(template?.defaultEngineId || 'claude');
  const [useFullTemplate, setUseFullTemplate] = useState(!!template?.fullTemplate);

  const handleSave = () => {
    if (!name.trim()) {
      alert('请填写模板名称');
      return;
    }
    // 完整模板模式和简单模式验证
    if (useFullTemplate) {
      if (!fullTemplate.trim()) {
        alert('请填写完整文档模板');
        return;
      }
    } else {
      if (!missionTemplate.trim()) {
        alert('请填写任务目标模板');
        return;
      }
    }

    onSave({
      name,
      description,
      category,
      missionTemplate,
      fullTemplate: useFullTemplate ? fullTemplate : undefined,
      templateParams: useFullTemplate ? templateParams : undefined,
      defaultTriggerType,
      defaultTriggerValue,
      defaultEngineId,
    });
  };

  // 添加模板参数
  const addTemplateParam = () => {
    setTemplateParams([
      ...templateParams,
      { key: '', label: '', type: 'text', required: false },
    ]);
  };

  // 更新模板参数
  const updateTemplateParam = (index: number, field: keyof TemplateParam, value: string | boolean) => {
    const updated = [...templateParams];
    updated[index] = { ...updated[index], [field]: value };
    setTemplateParams(updated);
  };

  // 删除模板参数
  const removeTemplateParam = (index: number) => {
    setTemplateParams(templateParams.filter((_, i) => i !== index));
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-lg w-[700px] max-h-[85vh] overflow-y-auto border border-border">
        <div className="p-4 border-b border-border flex items-center justify-between sticky top-0 bg-background-elevated">
          <h2 className="text-lg font-medium text-text-primary">
            {template ? '编辑模板' : '新建模板'}
          </h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              模板名称 <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-background-elevated border border-border rounded text-text-primary focus:outline-none focus:border-blue-500"
              placeholder="例如：功能开发模板"
            />
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">模板描述</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 bg-background-elevated border border-border rounded text-text-primary focus:outline-none focus:border-blue-500 resize-none"
              placeholder="简短描述模板用途"
            />
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">模板类别</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ProtocolTemplateCategory)}
              className="w-full px-3 py-2 bg-background-elevated border border-border rounded text-text-primary focus:outline-none focus:border-blue-500"
            >
              {Object.entries(ProtocolTemplateCategoryLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          {/* 模板模式选择 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">模板模式</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="templateMode"
                  checked={!useFullTemplate}
                  onChange={() => setUseFullTemplate(false)}
                  className="w-4 h-4"
                />
                <span className="text-text-primary">简单模式</span>
                <span className="text-xs text-text-tertiary">仅任务目标模板</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="templateMode"
                  checked={useFullTemplate}
                  onChange={() => setUseFullTemplate(true)}
                  className="w-4 h-4"
                />
                <span className="text-text-primary">完整模式</span>
                <span className="text-xs text-text-tertiary">完整 task.md 文档模板</span>
              </label>
            </div>
          </div>

          {/* 简单模式：任务目标模板 */}
          {!useFullTemplate && (
            <div>
              <label className="block text-sm text-text-secondary mb-1">
                任务目标模板 <span className="text-red-400">*</span>
              </label>
              <textarea
                value={missionTemplate}
                onChange={(e) => setMissionTemplate(e.target.value)}
                rows={8}
                className="w-full px-3 py-2 bg-background-elevated border border-border rounded text-text-primary focus:outline-none focus:border-blue-500 resize-none font-mono text-sm"
                placeholder="输入任务目标模板，支持占位符..."
              />
            </div>
          )}

          {/* 完整模式：完整文档模板 */}
          {useFullTemplate && (
            <>
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  完整文档模板 <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={fullTemplate}
                  onChange={(e) => setFullTemplate(e.target.value)}
                  rows={12}
                  className="w-full px-3 py-2 bg-background-elevated border border-border rounded text-text-primary focus:outline-none focus:border-blue-500 resize-none font-mono text-sm"
                  placeholder={`# 任务协议

> 任务ID: {taskId}
> 创建时间: {dateTime}

## 任务目标

{task}

## 用户补充

{userSupplement}

## 工作区

\`\`\`
{workDir}
\`\`\`
...`}
                />
              </div>

              {/* 模板参数配置 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm text-text-secondary">模板参数</label>
                  <button
                    type="button"
                    onClick={addTemplateParam}
                    className="px-2 py-1 text-xs bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded"
                  >
                    + 添加参数
                  </button>
                </div>
                {templateParams.length > 0 && (
                  <div className="space-y-2">
                    {templateParams.map((param, index) => (
                      <div key={index} className="flex items-center gap-2 p-2 bg-surface rounded">
                        <input
                          type="text"
                          value={param.key}
                          onChange={(e) => updateTemplateParam(index, 'key', e.target.value)}
                          className="flex-1 px-2 py-1 bg-background-elevated border border-border rounded text-text-primary text-sm"
                          placeholder="参数键 (如: task)"
                        />
                        <input
                          type="text"
                          value={param.label}
                          onChange={(e) => updateTemplateParam(index, 'label', e.target.value)}
                          className="flex-1 px-2 py-1 bg-background-elevated border border-border rounded text-text-primary text-sm"
                          placeholder="显示标签"
                        />
                        <select
                          value={param.type}
                          onChange={(e) => updateTemplateParam(index, 'type', e.target.value)}
                          className="px-2 py-1 bg-background-elevated border border-border rounded text-text-primary text-sm"
                        >
                          <option value="text">文本</option>
                          <option value="textarea">多行文本</option>
                          <option value="select">下拉选择</option>
                        </select>
                        <label className="flex items-center gap-1 text-xs text-text-secondary">
                          <input
                            type="checkbox"
                            checked={param.required}
                            onChange={(e) => updateTemplateParam(index, 'required', e.target.checked)}
                          />
                          必填
                        </label>
                        <button
                          type="button"
                          onClick={() => removeTemplateParam(index)}
                          className="px-2 py-1 text-xs text-red-400 hover:text-red-300"
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* 占位符说明 */}
          <div className="p-2 bg-surface rounded text-xs">
            <p className="text-text-secondary mb-1">支持的占位符：</p>
            <div className="grid grid-cols-2 gap-1">
              <div className="flex gap-2">
                <code className="text-blue-400">{TEMPLATE_PLACEHOLDERS.dateTime}</code>
                <span className="text-text-tertiary">- 当前日期时间</span>
              </div>
              <div className="flex gap-2">
                <code className="text-blue-400">{TEMPLATE_PLACEHOLDERS.date}</code>
                <span className="text-text-tertiary">- 当前日期</span>
              </div>
              <div className="flex gap-2">
                <code className="text-blue-400">{TEMPLATE_PLACEHOLDERS.time}</code>
                <span className="text-text-tertiary">- 当前时间</span>
              </div>
              <div className="flex gap-2">
                <code className="text-blue-400">{TEMPLATE_PLACEHOLDERS.task}</code>
                <span className="text-text-tertiary">- 任务描述</span>
              </div>
              <div className="flex gap-2">
                <code className="text-blue-400">{TEMPLATE_PLACEHOLDERS.mission}</code>
                <span className="text-text-tertiary">- 任务目标</span>
              </div>
              <div className="flex gap-2">
                <code className="text-blue-400">{TEMPLATE_PLACEHOLDERS.userSupplement}</code>
                <span className="text-text-tertiary">- 用户补充</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-text-secondary mb-1">默认触发类型</label>
              <select
                value={defaultTriggerType}
                onChange={(e) => setDefaultTriggerType(e.target.value as 'once' | 'cron' | 'interval')}
                className="w-full px-3 py-2 bg-background-elevated border border-border rounded text-text-primary focus:outline-none focus:border-blue-500"
              >
                <option value="interval">间隔执行</option>
                <option value="cron">Cron 表达式</option>
                <option value="once">单次执行</option>
              </select>
            </div>

            <div>
              <label className="block text-sm text-text-secondary mb-1">默认触发值</label>
              <input
                type="text"
                value={defaultTriggerValue}
                onChange={(e) => setDefaultTriggerValue(e.target.value)}
                className="w-full px-3 py-2 bg-background-elevated border border-border rounded text-text-primary focus:outline-none focus:border-blue-500 font-mono"
                placeholder="1h"
              />
            </div>

            <div>
              <label className="block text-sm text-text-secondary mb-1">默认引擎</label>
              <select
                value={defaultEngineId}
                onChange={(e) => setDefaultEngineId(e.target.value)}
                className="w-full px-3 py-2 bg-background-elevated border border-border rounded text-text-primary focus:outline-none focus:border-blue-500"
              >
                <option value="claude">Claude Code</option>
                <option value="iflow">IFlow</option>
                <option value="codex">Codex</option>
                <option value="openai">OpenAI</option>
              </select>
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-border flex justify-end gap-2 sticky bottom-0 bg-background-elevated">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-600/20 text-text-primary hover:bg-gray-600/30 rounded transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-text-primary rounded transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

/** 模板卡片 */
function TemplateCard({
  template,
  onEdit,
  onDelete,
}: {
  template: ProtocolTemplate;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="bg-background-elevated rounded-lg p-4 border border-border">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-text-primary font-medium">{template.name}</h3>
            {template.builtin ? (
              <span className="text-xs px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">内置</span>
            ) : (
              <span className="text-xs px-1.5 py-0.5 bg-green-500/20 text-green-400 rounded">自定义</span>
            )}
            <span className="text-xs px-1.5 py-0.5 bg-background-surface text-text-secondary rounded">
              {ProtocolTemplateCategoryLabels[template.category]}
            </span>
          </div>
          <p className="mt-1 text-sm text-text-tertiary line-clamp-2">{template.description}</p>
          <div className="mt-2 text-xs text-text-tertiary">
            默认: {template.defaultTriggerType} - {template.defaultTriggerValue}
          </div>
        </div>
        {!template.builtin && (
          <div className="flex items-center gap-2">
            <button
              onClick={onEdit}
              className="px-3 py-1 text-sm bg-gray-600/20 text-text-primary hover:bg-gray-600/30 rounded transition-colors"
            >
              编辑
            </button>
            <button
              onClick={onDelete}
              className="px-3 py-1 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded transition-colors"
            >
              删除
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 主组件 */
export function ProtocolTemplateManager() {
  const {
    customTemplates,
    getAllTemplates,
    addTemplate,
    updateTemplate,
    deleteTemplate,
  } = useProtocolTemplateStore();

  const [showEditor, setShowEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ProtocolTemplate | undefined>();
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const allTemplates = getAllTemplates();
  const filteredTemplates = selectedCategory === 'all'
    ? allTemplates
    : allTemplates.filter((t) => t.category === selectedCategory);

  const categories = ['all', 'development', 'optimization', 'fix', 'custom'];

  const handleCreate = (params: CreateProtocolTemplateParams) => {
    addTemplate(params);
    setShowEditor(false);
  };

  const handleUpdate = (params: CreateProtocolTemplateParams) => {
    if (editingTemplate) {
      updateTemplate(editingTemplate.id, params);
      setShowEditor(false);
      setEditingTemplate(undefined);
    }
  };

  const handleDelete = (id: string) => {
    if (confirm('确定要删除这个模板吗？')) {
      deleteTemplate(id);
    }
  };

  return (
    <div className="space-y-4">
      {/* 头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium text-text-primary">协议模板管理</h3>
          <p className="text-sm text-text-tertiary mt-1">
            管理协议模式任务的模板，内置 {getAllTemplates().filter((t) => t.builtin).length} 个，自定义 {customTemplates.length} 个
          </p>
        </div>
        <button
          onClick={() => {
            setEditingTemplate(undefined);
            setShowEditor(true);
          }}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-text-primary rounded transition-colors"
        >
          + 新建模板
        </button>
      </div>

      {/* 类别筛选 */}
      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`px-3 py-1.5 text-sm rounded transition-colors ${
              selectedCategory === cat
                ? 'bg-blue-600 text-text-primary'
                : 'bg-background-surface text-text-secondary hover:bg-background-hover'
            }`}
          >
            {cat === 'all' ? '全部' : ProtocolTemplateCategoryLabels[cat as keyof typeof ProtocolTemplateCategoryLabels]}
          </button>
        ))}
      </div>

      {/* 模板列表 */}
      <div className="space-y-3">
        {filteredTemplates.length === 0 ? (
          <div className="text-center text-text-tertiary py-8">
            暂无模板
          </div>
        ) : (
          filteredTemplates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onEdit={
                template.builtin
                  ? undefined
                  : () => {
                      setEditingTemplate(template);
                      setShowEditor(true);
                    }
              }
              onDelete={
                template.builtin
                  ? undefined
                  : () => handleDelete(template.id)
              }
            />
          ))
        )}
      </div>

      {/* 编辑弹窗 */}
      {showEditor && (
        <TemplateEditor
          template={editingTemplate}
          onSave={editingTemplate ? handleUpdate : handleCreate}
          onClose={() => {
            setShowEditor(false);
            setEditingTemplate(undefined);
          }}
        />
      )}
    </div>
  );
}

export default ProtocolTemplateManager;
