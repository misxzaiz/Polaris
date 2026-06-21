import type { PolarisPluginManifest } from './types'
import { pluginRegistry } from './registry'
import { pluginPanelRegistry } from './panelRegistry'
import { computerPluginManifest } from '@/plugins/computer/manifest'
import { requirementPluginManifest } from '@/plugins/requirement/manifest'
import { schedulerPluginManifest } from '@/plugins/scheduler/manifest'
import { todoPluginManifest } from '@/plugins/todo/manifest'
import { personalHubPluginManifest } from '@/plugins/personal-hub/manifest'
import { gitInsightPluginManifest } from '@/plugins/git-insight/manifest'
import { portManagerPluginManifest } from '@/plugins/port-manager/manifest'
import { httpClientPluginManifest } from '@/plugins/http-client/manifest'
import { jsonFormatterPluginManifest } from '@/plugins/json-formatter/manifest'
import { yamlValidatorPluginManifest } from '@/plugins/yaml-validator/manifest'
import { xmlFormatterPluginManifest } from '@/plugins/xml-formatter/manifest'
import { toolMenuPluginManifest } from '@/plugins/tool-menu/manifest'
import { markdownToolsPluginManifest } from '@/plugins/markdown-tools/manifest'
import { processMonitorPluginManifest } from '@/plugins/process-monitor/manifest'
import { diskAnalyzerPluginManifest } from '@/plugins/disk-analyzer/manifest'
import { networkDiagnosticPluginManifest } from '@/plugins/network-diagnostic/manifest'
import { envManagerPluginManifest } from '@/plugins/env-manager/manifest'
import { hostEditorPluginManifest } from '@/plugins/host-editor/manifest'
import { logViewerPluginManifest } from '@/plugins/log-viewer/manifest'
import { systemInfoPluginManifest } from '@/plugins/system-info/manifest'
import { textTransformerPluginManifest } from '@/plugins/text-transformer/manifest'
import { diffViewerPluginManifest } from '@/plugins/diff-viewer/manifest'
import { batchRenamePluginManifest } from '@/plugins/batch-rename/manifest'
import { csvViewerPluginManifest } from '@/plugins/csv-viewer/manifest'
import { jsonTreePluginManifest } from '@/plugins/json-tree/manifest'
import { apiTesterPluginManifest } from '@/plugins/api-tester/manifest'
import { dataConverterPluginManifest } from '@/plugins/data-converter/manifest'
import { encodingDetectorPluginManifest } from '@/plugins/encoding-detector/manifest'
import { complexityAnalyzerPluginManifest } from '@/plugins/complexity-analyzer/manifest'
import { dependencyGraphPluginManifest } from '@/plugins/dependency-graph/manifest'
import { deadCodeDetectorPluginManifest } from '@/plugins/dead-code-detector/manifest'
import { testCoveragePluginManifest } from '@/plugins/test-coverage/manifest'
import { testGeneratorPluginManifest } from '@/plugins/test-generator/manifest'
import { mutationTestingPluginManifest } from '@/plugins/mutation-testing/manifest'
import { vulnerabilityScannerPluginManifest } from '@/plugins/vulnerability-scanner/manifest'
import { dependencyAuditPluginManifest } from '@/plugins/dependency-audit/manifest'
import { secretScannerPluginManifest } from '@/plugins/secret-scanner/manifest'
import { bundleAnalyzerPluginManifest } from '@/plugins/bundle-analyzer/manifest'

const corePluginManifest: PolarisPluginManifest = {
  id: 'polaris.core',
  name: 'Polaris Core',
  version: '0.1.0',
  description: 'Polaris 内置基础面板入口。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'files.panel',
        area: 'activityBar',
        panelType: 'files',
        icon: 'Files',
        labelKey: 'labels.fileExplorer',
        labelDefault: 'File Explorer',
        order: 10,
      },
      {
        id: 'git.panel',
        area: 'activityBar',
        panelType: 'git',
        icon: 'GitPullRequest',
        labelKey: 'labels.gitPanel',
        labelDefault: 'Git',
        order: 20,
      },
      {
        id: 'translate.panel',
        area: 'activityBar',
        panelType: 'translate',
        icon: 'Languages',
        labelKey: 'labels.translatePanel',
        labelDefault: 'Translate',
        order: 40,
      },
      {
        id: 'terminal.panel',
        area: 'activityBar',
        panelType: 'terminal',
        icon: 'Terminal',
        labelKey: 'labels.terminalPanel',
        labelDefault: 'Terminal',
        order: 70,
      },
      {
        id: 'developer.panel',
        area: 'activityBar',
        panelType: 'developer',
        icon: 'Code2',
        labelKey: 'labels.developerPanel',
        labelDefault: 'Developer',
        order: 80,
      },
      {
        id: 'integration.panel',
        area: 'activityBar',
        panelType: 'integration',
        icon: 'Bot',
        labelKey: 'labels.integrationPanel',
        labelDefault: 'Integration',
        order: 90,
      },
      {
        id: 'aiConsole.panel',
        area: 'activityBar',
        panelType: 'aiConsole',
        icon: 'Activity',
        labelKey: 'labels.aiConsolePanel',
        labelDefault: 'AI Console',
        order: 95,
      },
      {
        id: 'problems.panel',
        area: 'activityBar',
        panelType: 'problems',
        icon: 'AlertCircle',
        labelKey: 'labels.problemsPanel',
        labelDefault: 'Problems',
        order: 110,
        badge: 'problems',
      },
    ],
  },
  permissions: {},
}

export function registerBuiltinPlugins(): void {
  pluginRegistry.register(corePluginManifest)
  pluginRegistry.register(schedulerPluginManifest)
  pluginRegistry.register(todoPluginManifest)
  pluginRegistry.register(requirementPluginManifest)
  pluginRegistry.register(computerPluginManifest)
  pluginRegistry.register(personalHubPluginManifest)
  pluginRegistry.register(gitInsightPluginManifest)
  pluginRegistry.register(portManagerPluginManifest)
  pluginRegistry.register(httpClientPluginManifest)
  pluginRegistry.register(jsonFormatterPluginManifest)
  pluginRegistry.register(yamlValidatorPluginManifest)
  pluginRegistry.register(xmlFormatterPluginManifest)
  pluginRegistry.register(markdownToolsPluginManifest)
  pluginRegistry.register(processMonitorPluginManifest)
  pluginRegistry.register(diskAnalyzerPluginManifest)
  pluginRegistry.register(networkDiagnosticPluginManifest)
  pluginRegistry.register(envManagerPluginManifest)
  pluginRegistry.register(hostEditorPluginManifest)
  pluginRegistry.register(logViewerPluginManifest)
  pluginRegistry.register(systemInfoPluginManifest)
  pluginRegistry.register(textTransformerPluginManifest)
  pluginRegistry.register(diffViewerPluginManifest)
  pluginRegistry.register(batchRenamePluginManifest)
  pluginRegistry.register(csvViewerPluginManifest)
  pluginRegistry.register(jsonTreePluginManifest)
  pluginRegistry.register(apiTesterPluginManifest)
  pluginRegistry.register(dataConverterPluginManifest)
  pluginRegistry.register(encodingDetectorPluginManifest)
  pluginRegistry.register(toolMenuPluginManifest)
  pluginRegistry.register(complexityAnalyzerPluginManifest)
  pluginRegistry.register(dependencyGraphPluginManifest)
  pluginRegistry.register(deadCodeDetectorPluginManifest)
  pluginRegistry.register(testCoveragePluginManifest)
  pluginRegistry.register(testGeneratorPluginManifest)
  pluginRegistry.register(mutationTestingPluginManifest)
  pluginRegistry.register(vulnerabilityScannerPluginManifest)
  pluginRegistry.register(dependencyAuditPluginManifest)
  pluginRegistry.register(secretScannerPluginManifest)
  pluginRegistry.register(bundleAnalyzerPluginManifest)

  // builtin 插件无 installPath，registry 不会自动注册 panel，需手动注册懒加载入口
  pluginPanelRegistry.register('personalHub', 'polaris.personal-hub', () =>
    import('@/components/PersonalHub/PersonalHubPanel').then((m) => ({ default: m.PersonalHubPanel })),
  )
  pluginPanelRegistry.register('gitInsight', 'polaris.git-insight', () =>
    import('@/components/GitInsight/GitInsightPanel').then((m) => ({ default: m.GitInsightPanel })),
  )
  pluginPanelRegistry.register('portManager', 'polaris.port-manager', () =>
    import('@/components/PortManagerPanel/PortManagerPanel').then((m) => ({ default: m.PortManagerPanel })),
  )
  pluginPanelRegistry.register('httpClient', 'polaris.http-client', () =>
    import('@/components/HttpClientPanel/HttpClientPanel').then((m) => ({ default: m.HttpClientPanel })),
  )
  pluginPanelRegistry.register('jsonFormatter', 'polaris.json-formatter', () =>
    import('@/components/JsonFormatterPanel/JsonFormatterPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('yamlValidator', 'polaris.yaml-validator', () =>
    import('@/components/YamlValidatorPanel/YamlValidatorPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('xmlFormatter', 'polaris.xml-formatter', () =>
    import('@/components/XmlFormatterPanel/XmlFormatterPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('markdownTools', 'polaris.markdown-tools', () =>
    import('@/components/MarkdownToolsPanel/MarkdownToolsPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('toolMenu', 'polaris.tool-menu', () =>
    import('@/components/ToolMenuPanel/ToolMenuPanel').then((m) => ({ default: m.ToolMenuPanel })),
  )
  pluginPanelRegistry.register('processMonitor', 'polaris.process-monitor', () =>
    import('@/components/ProcessMonitorPanel/ProcessMonitorPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('diskAnalyzer', 'polaris.disk-analyzer', () =>
    import('@/components/DiskAnalyzerPanel/DiskAnalyzerPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('networkDiagnostic', 'polaris.network-diagnostic', () =>
    import('@/components/NetworkDiagnosticPanel/NetworkDiagnosticPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('envManager', 'polaris.env-manager', () =>
    import('@/components/EnvManagerPanel/EnvManagerPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('hostEditor', 'polaris.host-editor', () =>
    import('@/components/HostEditorPanel/HostEditorPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('logViewer', 'polaris.log-viewer', () =>
    import('@/components/LogViewerPanel/LogViewerPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('systemInfo', 'polaris.system-info', () =>
    import('@/components/SystemInfoPanel/SystemInfoPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('textTransformer', 'polaris.text-transformer', () =>
    import('@/components/TextTransformerPanel/TextTransformerPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('diffViewer', 'polaris.diff-viewer', () =>
    import('@/components/DiffViewerPanel/DiffViewerPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('batchRename', 'polaris.batch-rename', () =>
    import('@/components/BatchRenamePanel/BatchRenamePanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('csvViewer', 'polaris.csv-viewer', () =>
    import('@/components/CsvViewerPanel/CsvViewerPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('jsonTree', 'polaris.json-tree', () =>
    import('@/components/JsonTreePanel/JsonTreePanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('apiTester', 'polaris.api-tester', () =>
    import('@/components/ApiTesterPanel/ApiTesterPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('dataConverter', 'polaris.data-converter', () =>
    import('@/components/DataConverterPanel/DataConverterPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('encodingDetector', 'polaris.encoding-detector', () =>
    import('@/components/EncodingDetectorPanel/EncodingDetectorPanel').then((m) => ({ default: m.default })),
  )
  pluginPanelRegistry.register('testCoverage', 'polaris.test-coverage', () =>
    import('@/components/TestCoveragePanel/TestCoveragePanel').then((m) => ({ default: m.TestCoveragePanel })),
  )
  pluginPanelRegistry.register('testGenerator', 'polaris.test-generator', () =>
    import('@/components/TestGeneratorPanel/TestGeneratorPanel').then((m) => ({ default: m.TestGeneratorPanel })),
  )
  pluginPanelRegistry.register('mutationTesting', 'polaris.mutation-testing', () =>
    import('@/components/MutationTestingPanel/MutationTestingPanel').then((m) => ({ default: m.MutationTestingPanel })),
  )
  pluginPanelRegistry.register('vulnerabilityScanner', 'polaris.vulnerability-scanner', () =>
    import('@/components/VulnerabilityScannerPanel/VulnerabilityScannerPanel').then((m) => ({ default: m.VulnerabilityScannerPanel })),
  )
  pluginPanelRegistry.register('dependencyAudit', 'polaris.dependency-audit', () =>
    import('@/components/DependencyAuditPanel/DependencyAuditPanel').then((m) => ({ default: m.DependencyAuditPanel })),
  )
  pluginPanelRegistry.register('secretScanner', 'polaris.secret-scanner', () =>
    import('@/components/SecretScannerPanel/SecretScannerPanel').then((m) => ({ default: m.SecretScannerPanel })),
  )
  pluginPanelRegistry.register('bundleAnalyzer', 'polaris.bundle-analyzer', () =>
    import('@/components/BundleAnalyzerPanel/BundleAnalyzerPanel').then((m) => ({ default: m.BundleAnalyzerPanel })),
  )
}

registerBuiltinPlugins()
