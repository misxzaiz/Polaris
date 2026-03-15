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
import type { ProtocolTemplate, CreateProtocolTemplateParams } from '../../types/protocolTemplate';

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
  const [defaultTriggerType, setDefaultTriggerType] = useState<'once' | 'cron' | 'interval'>(
    template?.defaultTriggerType || 'interval'
  );
  const [defaultTriggerValue, setDefaultTriggerValue] = useState(template?.defaultTriggerValue || '1h');
  const [defaultEngineId, setDefaultEngineId] = useState(template?.defaultEngineId || 'claude');

  const handleSave = () => {
    if (!name.trim()) {
      alert('请填写模板名称');
      return;
    }
    if (!missionTemplate.trim()) {
      alert('请填写任务目标模板');
      return;
    }

    onSave({
      name,
      description,
      category,
      missionTemplate,
      defaultTriggerType,
      defaultTriggerValue,
      defaultEngineId,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#16162a] rounded-lg w-[700px] max-h-[85vh] overflow-y-auto border border-[#2a2a4a]">
        <div className="p-4 border-b border-[#2a2a4a] flex items-center justify-between sticky top-0 bg-[#16162a]">
          <h2 className="text-lg font-medium text-white">
            {template ? '编辑模板' : '新建模板'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              模板名称 <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
              placeholder="例如：功能开发模板"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">模板描述</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 resize-none"
              placeholder="简短描述模板用途"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">模板类别</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ProtocolTemplateCategory)}
              className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
            >
              {Object.entries(ProtocolTemplateCategoryLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">
              任务目标模板 <span className="text-red-400">*</span>
            </label>
            <textarea
              value={missionTemplate}
              onChange={(e) => setMissionTemplate(e.target.value)}
              rows={8}
              className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 resize-none font-mono text-sm"
              placeholder="输入任务目标模板，支持占位符..."
            />
            <div className="mt-2 p-2 bg-[#12122a] rounded text-xs">
              <p className="text-gray-400 mb-1">支持的占位符：</p>
              <div className="flex flex-wrap gap-2">
                <code className="text-blue-400">{TEMPLATE_PLACEHOLDERS.dateTime}</code>
                <span className="text-gray-500">- 当前日期时间</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <code className="text-blue-400">{TEMPLATE_PLACEHOLDERS.date}</code>
                <span className="text-gray-500">- 当前日期</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <code className="text-blue-400">{TEMPLATE_PLACEHOLDERS.time}</code>
                <span className="text-gray-500">- 当前时间</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <code className="text-blue-400">{TEMPLATE_PLACEHOLDERS.mission}</code>
                <span className="text-gray-500">- 用户输入的任务内容</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">默认触发类型</label>
              <select
                value={defaultTriggerType}
                onChange={(e) => setDefaultTriggerType(e.target.value as 'once' | 'cron' | 'interval')}
                className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
              >
                <option value="interval">间隔执行</option>
                <option value="cron">Cron 表达式</option>
                <option value="once">单次执行</option>
              </select>
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">默认触发值</label>
              <input
                type="text"
                value={defaultTriggerValue}
                onChange={(e) => setDefaultTriggerValue(e.target.value)}
                className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 font-mono"
                placeholder="1h"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">默认引擎</label>
              <select
                value={defaultEngineId}
                onChange={(e) => setDefaultEngineId(e.target.value)}
                className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
              >
                <option value="claude">Claude Code</option>
                <option value="iflow">IFlow</option>
                <option value="codex">Codex</option>
                <option value="openai">OpenAI</option>
              </select>
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-[#2a2a4a] flex justify-end gap-2 sticky bottom-0 bg-[#16162a]">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-600/20 text-gray-300 hover:bg-gray-600/30 rounded transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
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
    <div className="bg-[#1a1a2e] rounded-lg p-4 border border-[#2a2a4a]">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-white font-medium">{template.name}</h3>
            {template.builtin ? (
              <span className="text-xs px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">内置</span>
            ) : (
              <span className="text-xs px-1.5 py-0.5 bg-green-500/20 text-green-400 rounded">自定义</span>
            )}
            <span className="text-xs px-1.5 py-0.5 bg-[#2a2a4a] text-gray-400 rounded">
              {ProtocolTemplateCategoryLabels[template.category]}
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-500 line-clamp-2">{template.description}</p>
          <div className="mt-2 text-xs text-gray-500">
            默认: {template.defaultTriggerType} - {template.defaultTriggerValue}
          </div>
        </div>
        {!template.builtin && (
          <div className="flex items-center gap-2">
            <button
              onClick={onEdit}
              className="px-3 py-1 text-sm bg-gray-600/20 text-gray-300 hover:bg-gray-600/30 rounded transition-colors"
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
          <h3 className="text-lg font-medium text-white">协议模板管理</h3>
          <p className="text-sm text-gray-500 mt-1">
            管理协议模式任务的模板，内置 {getAllTemplates().filter((t) => t.builtin).length} 个，自定义 {customTemplates.length} 个
          </p>
        </div>
        <button
          onClick={() => {
            setEditingTemplate(undefined);
            setShowEditor(true);
          }}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
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
                ? 'bg-blue-600 text-white'
                : 'bg-[#2a2a4a] text-gray-400 hover:bg-[#3a3a5a]'
            }`}
          >
            {cat === 'all' ? '全部' : ProtocolTemplateCategoryLabels[cat as keyof typeof ProtocolTemplateCategoryLabels]}
          </button>
        ))}
      </div>

      {/* 模板列表 */}
      <div className="space-y-3">
        {filteredTemplates.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
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
