# Spring Boot 调试运行工具

## 概述

轻量级 Spring Boot 项目调试运行工具，集成在 Polaris 开发辅助平台中。

## 功能特性

### 1. 项目检测
- 自动识别 Maven (`pom.xml`) 和 Gradle (`build.gradle` / `build.gradle.kts`) 项目
- 提取 Spring Boot 版本、Java 版本、主类等信息
- 检测 devtools 依赖
- 读取配置的端口号

### 2. 启动配置
- **调试模式**: 启用 JVM 远程调试 (`-agentlib:jdwp=...`)
- **端口配置**: 自定义应用端口和调试端口
- **JVM 参数**: 添加额外的 JVM 启动参数
- **Maven/Gradle 参数**: 添加构建工具参数

### 3. 运行管理
- 一键启动 `mvn spring-boot:run` 或 `gradle bootRun`
- 实时状态监控 (启动中/运行中/停止/错误)
- 停止运行中的应用

### 4. 调试支持
- 默认调试端口: 5005
- 支持 IDE 远程调试连接
- 配合 spring-boot-devtools 实现热重载

## 使用方法

### 1. 打开 Spring Boot 面板
- 点击左侧 Activity Bar 中的 ☕ 图标
- 或通过工具切换器 (Ctrl+Shift+P) 搜索 "Spring Boot"

### 2. 检测项目
1. 输入或粘贴 Spring Boot 项目路径
2. 点击 "检测" 按钮
3. 系统会自动分析项目信息

### 3. 配置启动参数
- **启用调试模式**: 勾选后可配置调试端口
- **应用端口**: 默认读取项目配置，可手动覆盖
- **额外 JVM 参数**: 如 `-Xmx512m -Dspring.profiles.active=dev`

### 4. 启动应用
- 点击 "启动应用" 按钮
- 终端会自动打开并显示启动日志
- 状态会实时更新

### 5. 连接调试器
1. 在 IDE (IntelliJ IDEA / VS Code) 中配置远程调试
2. 设置调试主机: `localhost`
3. 设置调试端口: `5005` (或自定义端口)
4. 启动调试连接

## 命令说明

### Maven 项目
```bash
# 普通启动
./mvnw spring-boot:run

# 带调试模式
./mvnw spring-boot:run -Dspring-boot.run.jvmArguments="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005"

# 指定端口
./mvnw spring-boot:run -Dserver.port=8081
```

### Gradle 项目
```bash
# 普通启动
./gradlew bootRun

# 带调试模式
./gradlew bootRun --args="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005"

# 指定端口
./gradlew bootRun -Dserver.port=8081
```

## 技术架构

### 后端 (Rust)
- `src-tauri/src/commands/spring_boot.rs`: 核心命令模块
- `SpringBootManager`: 管理运行中的应用实例
- 复用现有终端 PTY 模块执行命令

### 前端 (React)
- `src/stores/springBootStore.ts`: 状态管理
- `src/components/SpringBoot/SpringBootPanel.tsx`: UI 组件
- 集成到插件系统，支持懒加载

## 测试验证

使用 `temp/spring-boot-demo` 项目进行测试:
- Spring Boot 3.2.5
- Maven 构建
- 包含 devtools 依赖
- 配置端口: 8080

## 后续优化

1. **日志过滤**: 支持按级别过滤日志输出
2. **端口检测**: 启动前检测端口占用
3. **多实例管理**: 同时管理多个 Spring Boot 项目
4. **热重载状态**: 显示 devtools 热重载状态
5. **配置文件编辑**: 快速编辑 application.properties/yml
