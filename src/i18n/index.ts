import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import zhCNCommon from '../locales/zh-CN/common.json';
import zhCNSettings from '../locales/zh-CN/settings.json';
import zhCNChat from '../locales/zh-CN/chat.json';
import zhCNMenu from '../locales/zh-CN/menu.json';
import zhCNErrors from '../locales/zh-CN/errors.json';
import zhCNWorkspace from '../locales/zh-CN/workspace.json';
import zhCNGit from '../locales/zh-CN/git.json';
import zhCNFileExplorer from '../locales/zh-CN/fileExplorer.json';
import zhCNSystemPrompt from '../locales/zh-CN/systemPrompt.json';
import zhCNTools from '../locales/zh-CN/tools.json';
import zhCNCommands from '../locales/zh-CN/commands.json';
import zhCNPromptSnippet from '../locales/zh-CN/promptSnippet.json';

import enUSCommon from '../locales/en-US/common.json';
import enUSSettings from '../locales/en-US/settings.json';
import enUSChat from '../locales/en-US/chat.json';
import enUSMenu from '../locales/en-US/menu.json';
import enUSErrors from '../locales/en-US/errors.json';
import enUSWorkspace from '../locales/en-US/workspace.json';
import enUSGit from '../locales/en-US/git.json';
import enUSFileExplorer from '../locales/en-US/fileExplorer.json';
import enUSSystemPrompt from '../locales/en-US/systemPrompt.json';
import enUSTools from '../locales/en-US/tools.json';
import enUSCommands from '../locales/en-US/commands.json';
import enUSPromptSnippet from '../locales/en-US/promptSnippet.json';

export const resources = {
  'zh-CN': {
    common: zhCNCommon,
    settings: zhCNSettings,
    chat: zhCNChat,
    menu: zhCNMenu,
    errors: zhCNErrors,
    workspace: zhCNWorkspace,
    git: zhCNGit,
    fileExplorer: zhCNFileExplorer,
    systemPrompt: zhCNSystemPrompt,
    tools: zhCNTools,
    commands: zhCNCommands,
    promptSnippet: zhCNPromptSnippet,
  },
  'en-US': {
    common: enUSCommon,
    settings: enUSSettings,
    chat: enUSChat,
    menu: enUSMenu,
    errors: enUSErrors,
    workspace: enUSWorkspace,
    git: enUSGit,
    fileExplorer: enUSFileExplorer,
    systemPrompt: enUSSystemPrompt,
    tools: enUSTools,
    commands: enUSCommands,
    promptSnippet: enUSPromptSnippet,
  },
};

export const defaultNS = 'common';

const savedLanguage = typeof window !== 'undefined' 
  ? localStorage.getItem('i18n_language') || 'zh-CN'
  : 'zh-CN';

i18n.use(initReactI18next).init({
  resources,
  lng: savedLanguage,
  fallbackLng: 'zh-CN',
  defaultNS,
  interpolation: {
    escapeValue: false,
  },
});

i18n.on('languageChanged', (lng) => {
  localStorage.setItem('i18n_language', lng);
});

export default i18n;
