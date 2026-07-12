/**
 * Skill 状态管理
 *
 * 扫描配置的目录读取 Markdown Skill 文件，供 / 命令建议列表使用。
 * 每个 Skill 文件支持两种格式：
 *   1. .polaris/skills/<name>/SKILL.md  — 子目录格式（对齐后端 SimpleAI skill 系统）
 *   2. .polaris/agents/<name>.md         — 平铺文件格式（对齐 .polaris/agents/ 现有文件）
 *   3. 任意目录中的 *.md 文件             — 用户自定义路径
 *
 * 默认扫描路径（用户未自定义 skillPaths 时）：
 *   - 当前工作区下 .polaris/skills、.polaris/agents
 *   - 数据存储根目录（DataRoot）下 skills、agents
 *     这样用户放在全局存储路径下的 Skill 也能被自动发现，不必每个工作区都复制一份。
 */

import { create } from 'zustand';
import * as tauri from '@/services/tauri';
import { getDataRootInfo } from '@/services/dataRootService';
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

/** 扫描单个路径，去重后追加到 allSkills */
async function _collectAndDedup(
  dirPath: string,
  seenIds: Set<string>,
  allSkills: SkillItem[],
): Promise<void> {
  const subdirSkills = await scanSubdirFormat(dirPath);
  for (const skill of subdirSkills) {
    if (!seenIds.has(skill.id)) {
      seenIds.add(skill.id);
      allSkills.push(skill);
    }
  }
  const flatSkills = await scanFlatFormat(dirPath);
  for (const skill of flatSkills) {
    if (!seenIds.has(skill.id)) {
      seenIds.add(skill.id);
      allSkills.push(skill);
    }
  }
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

    // 1. 用户自定义路径优先；否则使用工作区默认 + DataRoot 默认
    let workspaceRelativePaths: string[] = [];
    let absolutePaths: string[] = [];

    if (configuredPaths && configuredPaths.length > 0) {
      for (const p of configuredPaths) {
        if (!p) continue;
        const isAbsolute = /^(?:[a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(p);
        if (isAbsolute) {
          absolutePaths.push(p);
        } else {
          workspaceRelativePaths.push(p);
        }
      }
    } else {
      // 默认：工作区下 .polaris/skills、.polaris/agents
      workspaceRelativePaths = ['.polaris/skills', '.polaris/agents'];
    }

    const workspacePath = useWorkspaceStore.getState().getCurrentWorkspace()?.path;

    // 2. 获取 DataRoot 根目录
    let dataRootPath = '';
    let dataRootRelativePaths: string[] = [];
    try {
      const info = await getDataRootInfo();
      dataRootPath = info.root;
      // 3. DataRoot 路径仅在用户未自定义时生效（避免用户路径 + DataRoot 路径重复）
      if (!configuredPaths || configuredPaths.length === 0) {
        dataRootRelativePaths = ['skills', 'agents'];
      }
    } catch {
      // 非 Tauri 环境或调用失败，DataRoot 路径静默降级为空
    }

    const allSkills: SkillItem[] = [];
    const seenIds = new Set<string>();

    // 4. 扫描工作区相对路径（相对路径按当前工作区解析）
    for (const rawPath of workspaceRelativePaths) {
      if (!rawPath) continue;
      const resolvedPath = workspacePath
        ? `${workspacePath.replace(/[\\/]$/, '')}/${rawPath.replace(/^[\\/]/, '')}`
        : rawPath;
      await _collectAndDedup(resolvedPath, seenIds, allSkills);
    }

    // 5. 扫描 DataRoot 下的默认路径（仅用户未自定义 skillPaths 时）
    for (const rawPath of dataRootRelativePaths) {
      if (!dataRootPath || !rawPath) continue;
      const resolvedPath = `${dataRootPath.replace(/[\\/]$/, '')}/${rawPath.replace(/^[\\/]/, '')}`;
      await _collectAndDedup(resolvedPath, seenIds, allSkills);
    }

    // 6. 扫描用户自定义的绝对路径
    for (const absPath of absolutePaths) {
      await _collectAndDedup(absPath, seenIds, allSkills);
    }

const allPaths = [...workspaceRelativePaths, ...dataRootRelativePaths, ...absolutePaths];
    log.info('Skill 加载完成', { count: allSkills.length, paths: allPaths });
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
