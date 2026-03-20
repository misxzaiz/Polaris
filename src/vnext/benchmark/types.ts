/**
 * Benchmark Types for Polaris Scheduler vNext
 */

/**
 * Benchmark result
 */
export interface BenchmarkResult {
  /** Benchmark name */
  name: string;
  /** Number of iterations */
  iterations: number;
  /** Total time in milliseconds */
  totalTime: number;
  /** Average time per iteration in milliseconds */
  avgTime: number;
  /** Minimum time in milliseconds */
  minTime: number;
  /** Maximum time in milliseconds */
  maxTime: number;
  /** Operations per second */
  opsPerSecond: number;
  /** Memory usage (if available) */
  memoryUsage?: {
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
}

/**
 * Benchmark suite result
 */
export interface BenchmarkSuiteResult {
  /** Suite name */
  suite: string;
  /** Individual benchmark results */
  benchmarks: BenchmarkResult[];
  /** Total suite time */
  totalTime: number;
  /** Timestamp */
  timestamp: number;
}

/**
 * Benchmark summary report
 */
export interface BenchmarkReport {
  /** Report generation timestamp */
  timestamp: number;
  /** Node.js version */
  nodeVersion?: string;
  /** Platform */
  platform?: string;
  /** Suite results */
  suites: BenchmarkSuiteResult[];
  /** Summary statistics */
  summary: BenchmarkSummary;
}

/**
 * Benchmark summary statistics
 */
export interface BenchmarkSummary {
  /** Total benchmarks run */
  totalBenchmarks: number;
  /** Total time for all benchmarks */
  totalTime: number;
  /** Fastest benchmark */
  fastest: {
    name: string;
    opsPerSecond: number;
  };
  /** Slowest benchmark */
  slowest: {
    name: string;
    opsPerSecond: number;
  };
  /** Average ops/sec across all benchmarks */
  avgOpsPerSecond: number;
}

/**
 * Performance threshold configuration
 */
export interface PerformanceThreshold {
  /** Benchmark name pattern */
  name: string;
  /** Minimum ops/sec required */
  minOpsPerSecond: number;
  /** Maximum avg time in ms allowed */
  maxAvgTime?: number;
}

/**
 * Performance check result
 */
export interface PerformanceCheckResult {
  /** Whether all thresholds were met */
  passed: boolean;
  /** Failed thresholds */
  failures: Array<{
    benchmark: string;
    threshold: PerformanceThreshold;
    actual: {
      opsPerSecond: number;
      avgTime: number;
    };
  }>;
}

/**
 * Benchmark comparison result
 */
export interface BenchmarkComparison {
  /** Benchmark name */
  name: string;
  /** Baseline result */
  baseline: {
    avgTime: number;
    opsPerSecond: number;
  };
  /** Current result */
  current: {
    avgTime: number;
    opsPerSecond: number;
  };
  /** Percentage change (positive = slower, negative = faster) */
  change: number;
  /** Whether change is significant (>5%) */
  significant: boolean;
}

/**
 * Benchmark history entry
 */
export interface BenchmarkHistoryEntry {
  /** Entry timestamp */
  timestamp: number;
  /** Git commit hash (if available) */
  commit?: string;
  /** Benchmark results */
  results: BenchmarkSuiteResult[];
}

/**
 * Benchmark configuration
 */
export interface BenchmarkConfig {
  /** Number of warmup iterations */
  warmupIterations?: number;
  /** Number of benchmark iterations */
  iterations?: number;
  /** Collect memory usage */
  collectMemory?: boolean;
}
