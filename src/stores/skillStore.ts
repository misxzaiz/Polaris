/**
 * Skill 状态管理
 *
 * 扫描配置的目录读取 Markdown Skill 文件，供 / 命令建议列表使用。
 * 每个 Skill 文件支持两种格式：
 *   1. .polaris/skills/<name>/SKILL.md  — 子目录格式（对齐后端 SimpleAI skill 系统）
 *   2. .polaris/agents/<name>.md         — 平铺文件格式（对齐 .polaris/agents/ 现有文件）
 *   3. 任意目录中的 *.md 文件             — 用户自定义路径
 */

import { create } from 'zustand';
import * as tauri from '@/services/tauri';
import type { SkillItem } from '@/types/skill';
import { useConfigStore } from './configStore';
import { useWorkspaceStore } from './workspaceStore';
import { createLogger } from '@/utils/logger';

const log = createLogger('SkillStore');

/** 从 Markdown 内容中提取第一个 # 标题 */
function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/** 从 Markdown 内容中提取第一个非空段落（标题后的第一个段落）作为描述 */
function extractDescription(content: string): string | null {
  // 去掉 frontmatter（--- ... ---）
  const noFrontmatter = content.replace(/^---[\s\S]*?---\n*/m, '');
  // 去掉标题行
  const noTitle = noFrontmatter.replace(/^#\s+.*$/m, '');
  // 找到第一个非空非标题行
  const lines = noTitle.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
      // 取前 120 个字符
      return trimmed.length > 120 ? trimmed.slice(0, 120) + '…' : trimmed;
    }
  }
  return null;
}

/** 从文件名（不含扩展名）生成 display name */
function nameFromFileName(fileName: string): string {
  const name = fileName.replace(/\.md$/i, '');
  // 中划线/下划线转空格
  return name.replace(/[-_]/g, ' ');
}

/** 解析单个 Skill 文件内容 */
function parseSkillContent(content: string, filePath: string, fileName: string): SkillItem {
  const title = extractTitle(content);
  const description = extractDescription(content);
  const id = fileName.replace(/\.md$/i, '');

  return {
    id,
    name: title ?? nameFromFileName(fileName),
    description: description ?? undefined,
    filePath,
    mtime: Date.now(),
  };
}

/** 扫描子目录格式：.polaris/skills/<name>/SKILL.md */
async function scanSubdirFormat(dirPath: string): Promise<SkillItem[]> {
  const results: SkillItem[] = [];
  try {
    const entries = await tauri.readDirectory(dirPath) as Array<{ name: string; path: string; isDir: boolean }>;
    for (const entry of entries) {
      if (entry.isDir) {
        const skillMdPath = `${dirPath}/${entry.name}/SKILL.md`;
        try {
          const content = await tauri.readFile(skillMdPath);
          results.push(parseSkillContent(content, skillMdPath, entry.name));
        } catch {
          // 子目录没有 SKILL.md，跳过
        }
      }
    }
  } catch {
    // 目录不存在，跳过
  }
  return results;
}

/** 扫描平铺文件格式：<dir>/*.md */
async function scanFlatFormat(dirPath: string): Promise<SkillItem[]> {
  const results: SkillItem[] = [];
  try {
    const entries = await tauri.readDirectory(dirPath) as Array<{ name: string; path: string; isDir: boolean }>;
    for (const entry of entries) {
      if (!entry.isDir && entry.name.toLowerCase().endsWith('.md')) {
        const filePath = `${dirPath}/${entry.name}`;
        try {
          const content = await tauri.readFile(filePath);
          results.push(parseSkillContent(content, filePath, entry.name));
        } catch {
          log.warn('读取 Skill 文件失败', { path: filePath });
        }
      }
    }
  } catch {
    // 目录不存在，跳过
  }
  return results;
}

interface SkillState {
  /** 已加载的 Skill 列表 */
  skills: SkillItem[];
  /** 加载中 */
  loading: boolean;
  /** 最后一次加载时间戳 */
  lastLoadedAt: number;

  /** 加载所有 Skill */
  loadSkills: () => Promise<void>;
  /** 按名称/描述搜索 Skill */
  searchSkills: (query: string) => SkillItem[];
  /** 刷新 Skill 列表 */
  refreshSkills: () => Promise<void>;
}

export const useSkillStore = create<SkillState>((set, get) => ({
  skills: [],
  loading: false,
  lastLoadedAt: 0,

  loadSkills: async () => {
    set({ loading: true });
    const config = useConfigStore.getState().config;
    const configuredPaths = config?.skillPaths;
    const skillPaths = configuredPaths && configuredPaths.length > 0
      ? configuredPaths
      : ['.polaris/skills', '.polaris/agents'];
    const workspacePath = useWorkspaceStore.getState().getCurrentWorkspace()?.path;
    const allSkills: SkillItem[] = [];
    const seenIds = new Set<string>();

    for (const rawPath of skillPaths) {
      if (!rawPath) continue;
      const isAbsolute = /^(?:[a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(rawPath);
      const resolvedPath = isAbsolute || !workspacePath
        ? rawPath
        : `${workspacePath.replace(/[\\/]$/, '')}/${rawPath.replace(/^[\\/]/, '')}`;

      // 尝试扫描子目录格式（SKILL.md）
      const subdirSkills = await scanSubdirFormat(resolvedPath);
      for (const skill of subdirSkills) {
        if (!seenIds.has(skill.id)) {
          seenIds.add(skill.id);
          allSkills.push(skill);
        }
      }

      // 尝试扫描平铺格式（*.md）
      const flatSkills = await scanFlatFormat(resolvedPath);
      for (const skill of flatSkills) {
        if (!seenIds.has(skill.id)) {
          seenIds.add(skill.id);
          allSkills.push(skill);
        }
      }
    }

    log.info('Skill 加载完成', { count: allSkills.length, paths: skillPaths });
    set({ skills: allSkills, loading: false, lastLoadedAt: Date.now() });
  },

  searchSkills: (query: string) => {
    const { skills } = get();
    if (!query) return skills;
    const lower = query.toLowerCase();
    return skills.filter(
      s =>
        s.name.toLowerCase().includes(lower) ||
        (s.description?.toLowerCase().includes(lower) ?? false)
    );
  },

  refreshSkills: async () => {
    return get().loadSkills();
  },
}));