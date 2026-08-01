/**
 * 引擎搜索栏
 */
import { Search } from 'lucide-react';

interface EngineSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function EngineSearchBar({ value, onChange, placeholder = '搜索引擎或 Agent…' }: EngineSearchBarProps) {
  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-surface border border-border rounded-lg pl-8 pr-3 py-2 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-primary"
      />
      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
    </div>
  );
}