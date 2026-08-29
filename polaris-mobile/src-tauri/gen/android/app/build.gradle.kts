import java.io.File
import java.util.Properties

// Release 签名：环境变量齐备时读取固定 keystore，否则回退 debug 签名（本地开发/临时打包可用）。
// keystore 由 CI 从 GitHub Secrets 解码而来（POLARIS_KEYSTORE_BASE64），因此证书恒定，可覆盖安装。
// 注：signingConfigs 只在 android {} 作用域内可用，故声明必须放在 android { } 块内。
val releaseStoreFile = System.getenv("POLARIS_KEYSTORE_FILE")?.let(::File)
val releaseStorePassword = System.getenv("POLARIS_KEYSTORE_PASSWORD")
val releaseKeyAlias = System.getenv("POLARIS_KEY_ALIAS")
val releaseKeyPassword = System.getenv("POLARIS_KEY_PASSWORD")

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 35
    namespace = "com.polaris.mobile"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.polaris.mobile"
        minSdk = 24
        targetSdk = 35
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        // 仅在 keystore 路径存在且四个环境变量齐备时才创建，避免缺一项就把构建卡死。
        if (releaseStoreFile != null && releaseStoreFile.exists()
            && releaseStorePassword != null && releaseKeyAlias != null && releaseKeyPassword != null) {
            create("release") {
                storeFile = releaseStoreFile
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = false
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            // signingConfigs.getByName 在缺失时会抛异常，这正是我们想要的：
            // 发布产物绝不允许静默降级成 debug 签名（那会让证书漂移、必须卸载重装）。
            signingConfig = signingConfigs.getByName("release")
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
