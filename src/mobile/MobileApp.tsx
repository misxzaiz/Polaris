import { useState } from 'react';
import { MobileConnectionGate } from './MobileConnectionGate';
import { MobileShell } from './MobileShell';
import type { MobileSessionDetail } from './MobileSessions';
import '../index.css';

type MobileTab = 'sessions' | 'tasks' | 'workspaces' | 'settings';

export default function MobileApp() {
  const [activeTab, setActiveTab] = useState<MobileTab>('sessions');
  const [activeSession, setActiveSession] = useState<MobileSessionDetail | null>(null);

  const handleTabChange = (tab: MobileTab) => {
    setActiveTab(tab);
    if (tab !== 'sessions') {
      setActiveSession(null);
    }
  };

  return (
    <MobileConnectionGate>
      {({ config, connected, serverUrl, openSettings }) => (
        <MobileShell
          activeTab={activeTab}
          activeSession={activeSession}
          config={config}
          connected={connected}
          serverUrl={serverUrl}
          onTabChange={handleTabChange}
          onOpenSession={setActiveSession}
          onCloseSession={() => setActiveSession(null)}
          onOpenConnectionSettings={openSettings}
        />
      )}
    </MobileConnectionGate>
  );
}
