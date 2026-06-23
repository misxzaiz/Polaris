import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onaudioend: ((ev: Event) => void) | null;
  onaudiostart: ((ev: Event) => void) | null;
  onend: ((ev: Event) => void) | null;
  onerror: ((ev: { error: string; message: string }) => void) | null;
  onnomatch: ((ev: Event) => void) | null;
  onresult: ((ev: { resultIndex: number; results: Array<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onsoundend: ((ev: Event) => void) | null;
  onsoundstart: ((ev: Event) => void) | null;
  onspeechend: ((ev: Event) => void) | null;
  onspeechstart: ((ev: Event) => void) | null;
  onstart: ((ev: Event) => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

function createRecognition(start = vi.fn()): MockRecognition {
  return {
    continuous: false,
    interimResults: false,
    lang: '',
    maxAlternatives: 0,
    onaudioend: null,
    onaudiostart: null,
    onend: null,
    onerror: null,
    onnomatch: null,
    onresult: null,
    onsoundend: null,
    onsoundstart: null,
    onspeechend: null,
    onspeechstart: null,
    onstart: null,
    start,
    stop: vi.fn(),
    abort: vi.fn(),
  };
}

describe('SpeechService', () => {
  beforeEach(() => {
    vi.resetModules();
    Reflect.deleteProperty(window, 'SpeechRecognition');
    Reflect.deleteProperty(window, 'webkitSpeechRecognition');
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'SpeechRecognition');
    Reflect.deleteProperty(window, 'webkitSpeechRecognition');
    vi.restoreAllMocks();
  });

  it('starts the underlying recognizer on the first start call', async () => {
    const instance = createRecognition();
    const Recognition = vi.fn(function MockSpeechRecognition() {
      return instance;
    });
    Object.defineProperty(window, 'webkitSpeechRecognition', {
      configurable: true,
      writable: true,
      value: Recognition,
    });

    const { SpeechService } = await import('./speechService');
    const service = new SpeechService();

    service.start();

    expect(Recognition).toHaveBeenCalledTimes(1);
    expect(instance.start).toHaveBeenCalledTimes(1);
  });

  it('does not call recognizer start twice while the first start is still pending', async () => {
    const instance = createRecognition();
    const Recognition = vi.fn(function MockSpeechRecognition() {
      return instance;
    });
    Object.defineProperty(window, 'webkitSpeechRecognition', {
      configurable: true,
      writable: true,
      value: Recognition,
    });

    const { SpeechService } = await import('./speechService');
    const service = new SpeechService();

    service.start();
    service.start();

    expect(instance.start).toHaveBeenCalledTimes(1);
  });

  it('reports listening after the recognizer emits onstart', async () => {
    const instance = createRecognition();
    const Recognition = vi.fn(function MockSpeechRecognition() {
      return instance;
    });
    Object.defineProperty(window, 'webkitSpeechRecognition', {
      configurable: true,
      writable: true,
      value: Recognition,
    });
    const onStatusChange = vi.fn();

    const { SpeechService } = await import('./speechService');
    const service = new SpeechService();
    service.setCallbacks({ onStatusChange });

    service.start();
    instance.onstart?.(new Event('start'));

    expect(onStatusChange).toHaveBeenCalledWith('listening');
  });

  it('allows stop to be called repeatedly while start is pending', async () => {
    const instance = createRecognition();
    Object.defineProperty(window, 'webkitSpeechRecognition', {
      configurable: true,
      writable: true,
      value: vi.fn(function MockSpeechRecognition() {
        return instance;
      }),
    });

    const { SpeechService } = await import('./speechService');
    const service = new SpeechService();

    service.start();

    expect(() => {
      service.stop();
      service.stop();
    }).not.toThrow();
    expect(instance.stop).toHaveBeenCalledTimes(1);
  });
});
