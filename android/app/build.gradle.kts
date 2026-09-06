plugins {
    alias(libs.plugins.android.application)
}

val releaseStoreFile = providers.gradleProperty("BMO_RELEASE_STORE_FILE")
val releaseStorePassword = providers.gradleProperty("BMO_RELEASE_STORE_PASSWORD")
val releaseKeyAlias = providers.gradleProperty("BMO_RELEASE_KEY_ALIAS")
val releaseKeyPassword = providers.gradleProperty("BMO_RELEASE_KEY_PASSWORD")

val releaseSigningConfigured =
    releaseStoreFile.isPresent &&
        releaseStorePassword.isPresent &&
        releaseKeyAlias.isPresent &&
        releaseKeyPassword.isPresent

val releaseBuildRequested =
    gradle.startParameter.taskNames.any {
        it.contains("release", ignoreCase = true)
    }

if (releaseBuildRequested && !releaseSigningConfigured) {
    throw GradleException(
        "Release signing is not configured. " +
            "Set BMO_RELEASE_STORE_FILE, BMO_RELEASE_STORE_PASSWORD, " +
            "BMO_RELEASE_KEY_ALIAS, and BMO_RELEASE_KEY_PASSWORD " +
            "in the user-level Gradle properties file."
    )
}

android {
    namespace = "com.sapphi.bmo"

    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.sapphi.bmo"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.9.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("release") {
                storeFile = file(releaseStoreFile.get())
                storePassword = releaseStorePassword.get()
                keyAlias = releaseKeyAlias.get()
                keyPassword = releaseKeyPassword.get()
            }
        }
    }

    buildTypes {
        release {
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("release")
            }

            optimization {
                enable = false
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.core.ktx)
    implementation(libs.material)

    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    implementation(files("libs/spotify-app-remote-release-0.8.0.aar"))
    implementation("com.google.code.gson:gson:2.11.0")

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
}
