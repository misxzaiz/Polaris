import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        // Cross-platform: Windows uses absolute node path, Linux (CI) uses npx
        val isWindows = Os.isFamily(Os.FAMILY_WINDOWS)
        val executable: String
        val cliEntry: String?
        if (isWindows) {
            executable = """D:\install\nodejs\node.exe"""
            cliEntry = "D:/space/base/Polaris/node_modules/@tauri-apps/cli/main.js"
        } else {
            // Linux (GitHub Actions CI): use standard npx entry point
            executable = "npx"
            cliEntry = null
        }
        try {
            runTauriCli(executable, cliEntry)
        } catch (e: Exception) {
            if (isWindows) {
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                )
                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback, cliEntry)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e
            }
        }
    }

    fun runTauriCli(executable: String, cliEntry: String?) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = if (cliEntry != null) {
            listOf(cliEntry, "android", "android-studio-script")
        } else {
            listOf("tauri", "android", "android-studio-script")
        }

        project.exec {
            workingDir(File(project.projectDir, rootDirRel))
            executable(executable)
            args(args)
            if (project.logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (project.logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}