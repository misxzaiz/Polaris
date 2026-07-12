import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFileExplorerStore } from '@/stores';

function useDebounce(value: string, delay: number): string {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

export function SearchBar() {
  const { t } = useTranslation('fileExplorer');
  const {
    search_query,
    set_search_query,
    search_results_count,
    search_is_deep_loading
  } = useFileExplorerStore();

  const [localQuery, setLocalQuery] = useState(search_query);
  const previousDebouncedQuery = useRef<string>('');

  useEffect(() => {
    setLocalQuery(search_query);
    previousDebouncedQuery.current = search_query;
  }, [search_query]);

  const debouncedQuery = useDebounce(localQuery, 300);

  useEffect(() => {
    if (previousDebouncedQuery.current !== debouncedQuery) {
      previousDebouncedQuery.current = debouncedQuery;
      set_search_query(debouncedQuery);
    }
  }, [debouncedQuery, set_search_query]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalQuery(e.target.value);
  };

  const handleClear = () => {
    setLocalQuery('');
    set_search_query('');
  };

  return (
    <form onSubmit={(e) => e.preventDefault()} className="p-2 border-b border-border">
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <svg className="w-4 h-4 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        <input
          type="text"
          value={localQuery}
          onChange={handleChange}
          placeholder={t('searchPlaceholder')}
          className="w-full pl-10 pr-10 py-1.5 bg-background-surface border border-border rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
        />

        {localQuery && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute inset-y-0 right-0 pr-3 flex items-center text-text-tertiary hover:text-text-primary transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {search_query && (
        <div className="mt-1 text-xs text-text-tertiary flex items-center gap-1">
          {search_is_deep_loading ? (
            <>
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>{t('searching', { count: search_results_count })}</span>
            </>
          ) : (
            <span>{t('searchResults', { count: search_results_count })}</span>
          )}
        </div>
      )}
    </form>
  );
}
