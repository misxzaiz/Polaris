/**
 * 文档模式模板存储服务
 *
 * 管理协议模式任务的模板，包括内置模板和用户自定义模板
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  ProtocolTemplate,
  CreateProtocolTemplateParams,
  ProtocolTemplateCategory,
} from '../types/protocolTemplate';
import { BUILTIN_PROTOCOL_TEMPLATES } from '../types/protocolTemplate';

interface ProtocolTemplateState {
  /** 用户自定义模板 */
  customTemplates: ProtocolTemplate[];

  /** 获取所有模板（内置 + 自定义） */
  getAllTemplates: () => ProtocolTemplate[];

  /** 按类别获取模板 */
  getTemplatesByCategory: (category: ProtocolTemplateCategory) => ProtocolTemplate[];

  /** 获取单个模板 */
  getTemplate: (id: string) => ProtocolTemplate | undefined;

  /** 添加自定义模板 */
  addTemplate: (params: CreateProtocolTemplateParams) => ProtocolTemplate;

  /** 更新自定义模板 */
  updateTemplate: (id: string, params: Partial<CreateProtocolTemplateParams>) => boolean;

  /** 删除自定义模板 */
  deleteTemplate: (id: string) => boolean;

  /** 检查是否为内置模板 */
  isBuiltinTemplate: (id: string) => boolean;
}

export const useProtocolTemplateStore = create<ProtocolTemplateState>()(
  persist(
    (set, get) => ({
      customTemplates: [],

      getAllTemplates: () => {
        const { customTemplates } = get();
        return [...BUILTIN_PROTOCOL_TEMPLATES, ...customTemplates];
      },

      getTemplatesByCategory: (category) => {
        const all = get().getAllTemplates();
        return all.filter((t) => t.category === category);
      },

      getTemplate: (id) => {
        const all = get().getAllTemplates();
        return all.find((t) => t.id === id);
      },

      addTemplate: (params) => {
        const now = Date.now();
        const template: ProtocolTemplate = {
          id: `custom-${now}`,
          name: params.name,
          description: params.description,
          category: params.category,
          builtin: false,
          missionTemplate: params.missionTemplate,
          fullTemplate: params.fullTemplate,
          templateParams: params.templateParams,
          protocolTemplate: params.protocolTemplate,
          defaultTriggerType: params.defaultTriggerType,
          defaultTriggerValue: params.defaultTriggerValue,
          defaultEngineId: params.defaultEngineId,
          createdAt: now,
          updatedAt: now,
        };

        set((state) => ({
          customTemplates: [...state.customTemplates, template],
        }));

        return template;
      },

      updateTemplate: (id, params) => {
        const { customTemplates } = get();

        // 不能更新内置模板
        if (BUILTIN_PROTOCOL_TEMPLATES.some((t) => t.id === id)) {
          return false;
        }

        const index = customTemplates.findIndex((t) => t.id === id);
        if (index === -1) {
          return false;
        }

        const updated: ProtocolTemplate = {
          ...customTemplates[index],
          ...params,
          updatedAt: Date.now(),
        };

        set((state) => ({
          customTemplates: state.customTemplates.map((t) =>
            t.id === id ? updated : t
          ),
        }));

        return true;
      },

      deleteTemplate: (id) => {
        const { customTemplates } = get();

        // 不能删除内置模板
        if (BUILTIN_PROTOCOL_TEMPLATES.some((t) => t.id === id)) {
          return false;
        }

        const exists = customTemplates.some((t) => t.id === id);
        if (!exists) {
          return false;
        }

        set((state) => ({
          customTemplates: state.customTemplates.filter((t) => t.id !== id),
        }));

        return true;
      },

      isBuiltinTemplate: (id) => {
        return BUILTIN_PROTOCOL_TEMPLATES.some((t) => t.id === id);
      },
    }),
    {
      name: 'protocol-templates',
      partialize: (state) => ({
        customTemplates: state.customTemplates,
      }),
    }
  )
);
