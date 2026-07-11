import { useState } from 'react';
import { MobileConnectionGate } from './MobileConnectionGate';
import { MobileShell } from './MobileShell';
import '../index.css';

type MobileTab = 'sessions' | 'tasks' | 'workspaces' | 'settings';

export default function MobileApp() {
  const [activeTab, setActiveTab] = useState<MobileTab>('sessions');

  // 多会话状态由 MobileSessionRuntime 驱动（全局 WS 路由 + Tab 并行）。
  // 见 src/mobile/runtime/mobileSessionRuntime.ts

  const handleTabChange = (tab: MobileTab) => {
    setActiveTab(tab);
  };

  return (
    <MobileConnectionGate>
      {({ config, connected, serverUrl, openSettings }) => (
        <MobileShell
          activeTab={activeTab}
          config={config}
          connected={connected}
          serverUrl={serverUrl}
          onTabChange={handleTabChange}
          onOpenConnectionSettings={openSettings}
        />
      )}
    </MobileConnectionGate>
  );
}
