import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import { useEffect } from 'react';
import { useConfigStore } from '../../stores';

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const updateConfigPatch = useConfigStore((state) => state.updateConfigPatch);

  useEffect(() => {
    if (config?.language && config.language !== i18n.language) {
      i18n.changeLanguage(config.language);
    }
  }, [config?.language, i18n]);

  const toggleLanguage = async () => {
    const newLang = i18n.language === 'zh-CN' ? 'en-US' : 'zh-CN';
    i18n.changeLanguage(newLang);
    if (config) {
      await updateConfigPatch({ language: newLang });
    }
  };

  return (
    <button
      onClick={toggleLanguage}
      className="flex items-center gap-1.5 px-2 py-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
      title={i18n.language === 'zh-CN' ? 'Switch to English' : '切换到中文'}
    >
      <Globe size={14} />
      {i18n.language === 'zh-CN' ? 'EN' : '中文'}
    </button>
  );
}
