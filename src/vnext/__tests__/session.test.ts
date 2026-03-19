/**
 * Scheduler vNext - Session Manager Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SessionManager,
  MockSession,
  getSessionManager,
  resetSessionManager,
  generateSessionId,
  createDefaultSessionInfo,
  isSessionActive,
  isSessionTerminal,
  DEFAULT_SESSION_CONFIG,
} from '../session';
import type { SessionConfig, SessionState } from '../session';

describe('Session Types', () => {
  describe('generateSessionId', () => {
    it('should generate unique session IDs', () => {
      const id1 = generateSessionId();
      const id2 = generateSessionId();

      expect(id1).toMatch(/^session_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^session_\d+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('createDefaultSessionInfo', () => {
    it('should create default session info', () => {
      const id = 'test-session';
      const config: SessionConfig = { engineId: 'engine-1' };
      const info = createDefaultSessionInfo(id, config);

      expect(info.id).toBe(id);
      expect(info.engineId).toBe('engine-1');
      expect(info.state).toBe('IDLE');
      expect(info.tokenUsage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      });
      expect(info.rounds).toBe(0);
    });
  });

  describe('isSessionActive', () => {
    it('should return true for active states', () => {
      expect(isSessionActive('IDLE')).toBe(true);
      expect(isSessionActive('RUNNING')).toBe(true);
      expect(isSessionActive('PAUSED')).toBe(true);
    });

    it('should return false for terminal states', () => {
      expect(isSessionActive('COMPLETED')).toBe(false);
      expect(isSessionActive('FAILED')).toBe(false);
      expect(isSessionActive('CANCELLED')).toBe(false);
    });
  });

  describe('isSessionTerminal', () => {
    it('should return true for terminal states', () => {
      expect(isSessionTerminal('COMPLETED')).toBe(true);
      expect(isSessionTerminal('FAILED')).toBe(true);
      expect(isSessionTerminal('CANCELLED')).toBe(true);
    });

    it('should return false for active states', () => {
      expect(isSessionTerminal('IDLE')).toBe(false);
      expect(isSessionTerminal('RUNNING')).toBe(false);
      expect(isSessionTerminal('PAUSED')).toBe(false);
    });
  });
});

describe('MockSession', () => {
  let session: MockSession;
  const config: SessionConfig = {
    engineId: 'test-engine',
    workDir: '/test/work',
  };

  beforeEach(() => {
    session = new MockSession(generateSessionId(), config);
  });

  describe('initial state', () => {
    it('should have correct initial state', () => {
      expect(session.state).toBe('IDLE');
      expect(session.messages).toHaveLength(0);
      expect(session.tokenUsage.totalTokens).toBe(0);
      expect(session.info.engineId).toBe('test-engine');
    });
  });

  describe('sendMessage', () => {
    it('should send message and return result', async () => {
      const result = await session.sendMessage('Test message');

      expect(result.success).toBe(true);
      expect(result.output).toContain('Mock');
      expect(result.tokenUsage.totalTokens).toBeGreaterThan(0);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should add messages to history', async () => {
      await session.sendMessage('Message 1');
      await session.sendMessage('Message 2');

      expect(session.messages.length).toBe(4); // 2 user + 2 assistant
    });

    it('should update token usage', async () => {
      await session.sendMessage('Test message');

      expect(session.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(session.tokenUsage.outputTokens).toBeGreaterThan(0);
    });

    it('should increment rounds', async () => {
      expect(session.info.rounds).toBe(0);

      await session.sendMessage('Message 1');
      expect(session.info.rounds).toBe(1);

      await session.sendMessage('Message 2');
      expect(session.info.rounds).toBe(2);
    });

    it('should emit events via callbacks', async () => {
      const thinkingCalls: string[] = [];
      const outputCalls: string[] = [];

      await session.sendMessageStream('Test', {
        onThinking: (t) => thinkingCalls.push(t),
        onOutput: (o) => outputCalls.push(o),
      });

      expect(thinkingCalls.length).toBeGreaterThan(0);
      expect(outputCalls.length).toBeGreaterThan(0);
    });
  });

  describe('pause/resume/cancel', () => {
    it('should transition to PAUSED state', () => {
      session.pause();
      expect(session.state).toBe('PAUSED');
    });

    it('should resume from PAUSED state', () => {
      session.pause();
      expect(session.state).toBe('PAUSED');

      session.resume();
      expect(session.state).toBe('RUNNING');
    });

    it('should cancel session', () => {
      session.cancel();
      expect(session.state).toBe('CANCELLED');
    });
  });

  describe('messages management', () => {
    it('should add message', () => {
      session.addMessage({
        role: 'user',
        content: 'Test',
        timestamp: Date.now(),
      });

      expect(session.messages).toHaveLength(1);
    });

    it('should clear messages', async () => {
      await session.sendMessage('Test');
      expect(session.messages.length).toBeGreaterThan(0);

      session.clearMessages();
      expect(session.messages).toHaveLength(0);
      expect(session.tokenUsage.totalTokens).toBe(0);
    });
  });

  describe('tool calls', () => {
    it('should record tool calls when profile requires tools', async () => {
      const sessionWithTools = new MockSession(generateSessionId(), {
        ...config,
        profile: {
          id: 'test-profile',
          name: 'Test',
          role: 'developer',
          systemPolicy: 'Test',
          executionStrategy: 'PLAN_FIRST',
          scoringRule: { criteria: [], minScore: 0, autoRollback: false },
          doneDefinition: { conditions: [], requireConfirmation: false },
          memoryPolicy: {
            maxActiveLines: 1000,
            maxTokens: 50000,
            compactionThreshold: 5,
            autoArchive: true,
            retentionDays: 30,
            semanticIndex: false,
          },
          iterationPolicy: {
            maxIterations: 10,
            maxRounds: 50,
            iterationTimeoutMs: 300000,
            allowEarlyTermination: true,
            cooldownMs: 1000,
          },
          outputProtocol: {
            requiredFields: [],
            format: 'markdown',
            requireSummary: false,
            requireCommitMessage: false,
          },
          selfEvolve: false,
          constraints: [],
          requiredTools: ['read'],
          tags: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      await sessionWithTools.sendMessage('Test');
      const toolCalls = sessionWithTools.getToolCalls();

      expect(toolCalls.length).toBeGreaterThan(0);
      expect(toolCalls[0].tool).toBe('read');
    });
  });
});

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    await manager.closeAllSessions();
  });

  describe('createSession', () => {
    it('should create session', async () => {
      const session = await manager.createSession({ engineId: 'test' });

      expect(session).toBeDefined();
      expect(session.id).toMatch(/^session_/);
    });

    it('should increment stats', async () => {
      await manager.createSession({ engineId: 'test' });
      const stats = manager.getStats();

      expect(stats.totalSessions).toBe(1);
      expect(stats.activeSessions).toBe(1);
    });
  });

  describe('getSession', () => {
    it('should return session by id', async () => {
      const created = await manager.createSession({ engineId: 'test' });
      const retrieved = manager.getSession(created.id);

      expect(retrieved).toBe(created);
    });

    it('should return undefined for non-existent session', () => {
      const session = manager.getSession('non-existent');
      expect(session).toBeUndefined();
    });
  });

  describe('getActiveSessions', () => {
    it('should return only active sessions', async () => {
      const s1 = await manager.createSession({ engineId: 'test' });
      const s2 = await manager.createSession({ engineId: 'test' });

      s1.cancel();

      const active = manager.getActiveSessions();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(s2.id);
    });
  });

  describe('closeSession', () => {
    it('should close session and update stats', async () => {
      const session = await manager.createSession({ engineId: 'test' });
      await session.sendMessage('Test');

      await manager.closeSession(session.id);

      expect(manager.getSession(session.id)).toBeUndefined();
      const stats = manager.getStats();
      expect(stats.activeSessions).toBe(0);
      expect(stats.totalTokenUsage.totalTokens).toBeGreaterThan(0);
    });
  });

  describe('closeAllSessions', () => {
    it('should close all sessions', async () => {
      await manager.createSession({ engineId: 'test' });
      await manager.createSession({ engineId: 'test' });

      await manager.closeAllSessions();

      expect(manager.getActiveSessions()).toHaveLength(0);
    });
  });

  describe('registerSessionFactory', () => {
    it('should use custom session factory', async () => {
      const customId = 'custom-session-id';
      manager.registerSessionFactory((id, config) => {
        const session = new MockSession(customId, config);
        return session;
      });

      const session = await manager.createSession({ engineId: 'test' });
      expect(session.id).toBe(customId);
    });
  });
});

describe('Global SessionManager', () => {
  beforeEach(() => {
    resetSessionManager();
  });

  afterEach(async () => {
    const manager = getSessionManager();
    await manager.closeAllSessions();
    resetSessionManager();
  });

  describe('getSessionManager', () => {
    it('should return singleton instance', () => {
      const m1 = getSessionManager();
      const m2 = getSessionManager();

      expect(m1).toBe(m2);
    });
  });

  describe('resetSessionManager', () => {
    it('should reset singleton instance', () => {
      const m1 = getSessionManager();
      resetSessionManager();
      const m2 = getSessionManager();

      expect(m1).not.toBe(m2);
    });
  });
});
