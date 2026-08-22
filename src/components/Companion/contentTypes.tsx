/**
 * Companion 内容类型 → 图标 + 标签映射
 *
 * 集中管理，CompanionCard 与 CompanionPanel 共享。
 */

import {
  Sparkles,
  Lightbulb,
  GraduationCap,
  Compass,
  Trophy,
  BookOpen,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';
import type { CompanionContentType } from '@/services/companion';

export const CONTENT_TYPE_ICONS: Record<CompanionContentType, LucideIcon> = {
  project_insight: Lightbulb,
  learning_challenge: GraduationCap,
  skill_explore: Compass,
  achievement_celebrate: Trophy,
  tip_curiosity: Sparkles,
  daily_review: BookOpen,
  learning_followup: RotateCcw,
};

export const CONTENT_TYPE_LABELS: Record<CompanionContentType, string> = {
  project_insight: 'project_insight',
  learning_challenge: 'learning_challenge',
  skill_explore: 'skill_explore',
  achievement_celebrate: 'achievement_celebrate',
  tip_curiosity: 'tip_curiosity',
  daily_review: 'daily_review',
  learning_followup: 'learning_followup',
};
