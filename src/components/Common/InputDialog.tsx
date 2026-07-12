/**
 * 自定义输入对话框组件
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface InputDialogProps {
  title: string;
  message: string;
  defaultValue?: string;
  placeholder?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
  validate?: (value: string) => string | null;
}

export function InputDialog({
  title,
  message,
  defaultValue = '',
  placeholder = '',
  onConfirm,
  onCancel,
  validate,
}: InputDialogProps) {
  const { t } = useTranslation('common');
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  const handleConfirm = () => {
    if (validate) {
      const validationError = validate(value);
      if (validationError) {
        setError(validationError);
        return;
      }
    }

    onConfirm(value.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
    setError(null);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl p-4 sm:p-6 w-full max-w-md border border-border shadow-glow">
        <h2 className="text-lg font-semibold text-text-primary mb-2">
          {title}
        </h2>

        {message && (
          <p className="text-sm text-text-secondary mb-4">
            {message}
          </p>
        )}

        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={`w-full px-3 py-2 bg-background-surface border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 transition-colors ${
            error
              ? 'border-danger focus:ring-danger'
              : 'border-border focus:ring-primary'
          }`}
        />

        {error && (
          <p className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors"
          >
            {t('buttons.cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!value.trim()}
            className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t('buttons.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
