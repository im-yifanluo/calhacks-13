"""Generate an Xcode project without third-party generator tools; rerun after adding Swift files."""

import hashlib
import json
import plistlib
import re
import subprocess
from pathlib import Path


def generate(demo):
    IOS = Path(__file__).resolve().parents[1]
    folder = IOS / "SceneCapture"
    name = "SceneCaptureDemo" if demo else "SceneCapture"
    project = IOS / f"{name}.xcodeproj"
    project.mkdir(exist_ok=True)
    # Xcode may have saved a user's signing team or app registration settings.
    # Retain these when regenerating source membership instead of resetting setup.
    personal = {}
    existing = project / "project.pbxproj"
    if existing.exists():
        previous = json.loads(subprocess.check_output(["plutil", "-convert", "json", "-o", "-", str(existing)]))[
            "objects"
        ]
        keep = {
            "DEVELOPMENT_TEAM",
            "PRODUCT_BUNDLE_IDENTIFIER",
            "CODE_SIGN_IDENTITY",
            "PROVISIONING_PROFILE_SPECIFIER",
            "META_APP_ID",
            "CLIENT_TOKEN",
        }
        for target in previous.values():
            if target.get("isa") == "PBXNativeTarget" and target.get("name") == name:
                for config_id in previous[target["buildConfigurationList"]]["buildConfigurations"]:
                    config = previous[config_id]
                    personal[config["name"]] = {
                        key: value for key, value in config["buildSettings"].items() if key in keep
                    }

    def ident(s):
        return hashlib.sha1(s.encode()).hexdigest()[:24].upper()

    def ref(s):
        return ident(s)

    objects = []

    def obj(name, fields):
        objects.append(f"{ref(name)} = {{ {fields} }};")

    files = [
        f for f in sorted(folder.glob("*.swift")) if f.name != ("GlassesCapture.swift" if demo else "DemoCapture.swift")
    ]
    for file in files:
        obj(
            file.name,
            f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {file.name}; sourceTree = "<group>";',
        )
        obj("build" + file.name, f"isa = PBXBuildFile; fileRef = {ref(file.name)};")
    plist_name = "Info-Demo.plist" if demo else "Info.plist"
    obj(
        "plist",
        f'isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = {plist_name}; sourceTree = "<group>";',
    )
    obj(
        "app",
        f"isa = PBXFileReference; explicitFileType = wrapper.application; path = {name}.app; sourceTree = BUILT_PRODUCTS_DIR;",
    )
    obj(
        "sourcegroup",
        f'isa = PBXGroup; path = SceneCapture; sourceTree = "<group>"; children = ({",".join(ref(f.name) for f in files)},{ref("plist")},);',
    )
    obj("products", f'isa = PBXGroup; name = Products; sourceTree = "<group>"; children = ({ref("app")},);')
    obj("main", f'isa = PBXGroup; sourceTree = "<group>"; children = ({ref("sourcegroup")},{ref("products")},);')
    obj(
        "sources",
        f"isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ({','.join(ref('build' + f.name) for f in files)},); runOnlyForDeploymentPostprocessing = 0;",
    )
    obj(
        "resources",
        "isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;",
    )
    if not demo:
        for module in ["MWDATCore", "MWDATCamera"]:
            obj(module, f"isa = XCSwiftPackageProductDependency; package = {ref('sdk')}; productName = {module};")
            obj("build" + module, f"isa = PBXBuildFile; productRef = {ref(module)};")
        obj(
            "frameworks",
            f"isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ({ref('buildMWDATCore')},{ref('buildMWDATCamera')},); runOnlyForDeploymentPostprocessing = 0;",
        )
        obj(
            "sdk",
            'isa = XCRemoteSwiftPackageReference; repositoryURL = "https://github.com/facebook/meta-wearables-dat-ios"; requirement = { kind = exactVersion; version = 1.0.1; };',
        )
    else:
        obj(
            "frameworks",
            "isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;",
        )
    for level in ["project", "target"]:
        for mode in ["Debug", "Release"]:
            settings = """CLANG_ENABLE_MODULES = YES; SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 17.2;
            SWIFT_VERSION = 5.0; SWIFT_STRICT_CONCURRENCY = minimal; TARGETED_DEVICE_FAMILY = 1;"""
            if level == "target":
                settings += """PRODUCT_NAME = "$(TARGET_NAME)"; PRODUCT_BUNDLE_IDENTIFIER = com.memreplay.SceneCapture;
                INFOPLIST_FILE = SceneCapture/Info.plist; CODE_SIGN_STYLE = Automatic;
                CURRENT_PROJECT_VERSION = 1; MARKETING_VERSION = 1.0; GENERATE_INFOPLIST_FILE = NO;
                LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks"; META_APP_ID = 0; CLIENT_TOKEN = "";"""
            if demo:
                settings = settings.replace("com.memreplay.SceneCapture", "com.memreplay.SceneCaptureDemo").replace(
                    "SceneCapture/Info.plist", "SceneCapture/Info-Demo.plist"
                )
                settings += " SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEMO_APP;"
            settings += (
                ' SWIFT_OPTIMIZATION_LEVEL = "-Onone"; DEBUG_INFORMATION_FORMAT = dwarf;'
                if mode == "Debug"
                else ' SWIFT_OPTIMIZATION_LEVEL = "-O"; DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";'
            )
            if level == "target":
                for key, value in sorted(personal.get(mode, {}).items()):
                    settings = re.sub(r"(?<![A-Za-z0-9_])" + key + r'\s*=\s*(?:"(?:[^"\\]|\\.)*"|[^;]*);', "", settings)
                    settings += f" {key} = {json.dumps(value)};"
            settings = "\n".join(line.rstrip() for line in settings.splitlines())
            obj(level + mode, f"isa = XCBuildConfiguration; name = {mode}; buildSettings = {{ {settings} }};")
        obj(
            level + "configs",
            f"isa = XCConfigurationList; buildConfigurations = ({ref(level + 'Debug')},{ref(level + 'Release')},); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;",
        )
    sdk_products = "" if demo else f"{ref('MWDATCore')},{ref('MWDATCamera')},"
    sdk_refs = "" if demo else ref("sdk") + ","
    obj(
        "target",
        f"""isa = PBXNativeTarget; name = {name}; productName = {name}; productType = "com.apple.product-type.application";
        productReference = {ref("app")}; buildConfigurationList = {ref("targetconfigs")};
        buildPhases = ({ref("sources")},{ref("frameworks")},{ref("resources")},); buildRules = (); dependencies = ();
        packageProductDependencies = ({sdk_products});""",
    )
    obj(
        "project",
        f"""isa = PBXProject; attributes = {{ LastUpgradeCheck = 2640; }}; buildConfigurationList = {ref("projectconfigs")};
        compatibilityVersion = "Xcode 14.0"; developmentRegion = en; knownRegions = (en,Base,);
        mainGroup = {ref("main")}; productRefGroup = {ref("products")}; projectDirPath = ""; projectRoot = "";
        targets = ({ref("target")},); packageReferences = ({sdk_refs});""",
    )
    (project / "project.pbxproj").write_text(
        "// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n"
        + "\n".join(objects)
        + f"\n}}; rootObject = {ref('project')}; }}\n"
    )
    info = {
        "CFBundleDisplayName": "Memory Replay",
        "CFBundleName": "$(PRODUCT_NAME)",
        "CFBundleIdentifier": "$(PRODUCT_BUNDLE_IDENTIFIER)",
        "CFBundleExecutable": "$(EXECUTABLE_NAME)",
        "CFBundlePackageType": "APPL",
        "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
        "CFBundleShortVersionString": "$(MARKETING_VERSION)",
        "LSRequiresIPhoneOS": True,
        "UILaunchScreen": {},
        "UISupportedInterfaceOrientations": ["UIInterfaceOrientationPortrait"],
        "CFBundleURLTypes": [
            {"CFBundleURLName": "$(PRODUCT_BUNDLE_IDENTIFIER)", "CFBundleURLSchemes": ["scenecapture"]}
        ],
        "MWDAT": {
            "AppLinkURLScheme": "scenecapture://",
            "MetaAppID": "$(META_APP_ID)",
            "ClientToken": "$(CLIENT_TOKEN)",
            "TeamID": "$(DEVELOPMENT_TEAM)",
        },
        "UIBackgroundModes": ["processing", "bluetooth-central", "bluetooth-peripheral", "external-accessory"],
        "UISupportedExternalAccessoryProtocols": ["com.meta.ar.wearable"],
        "NSBluetoothAlwaysUsageDescription": "Connect to your glasses to capture scenes.",
        "NSMicrophoneUsageDescription": "Include glasses microphone audio in your scene recording.",
        "NSLocalNetworkUsageDescription": "Connect to your glasses and local scene server.",
        "NSBonjourServices": ["_bonjour._tcp"],
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        "UIFileSharingEnabled": True,
        "LSSupportsOpeningDocumentsInPlace": True,
    }
    if demo:
        info["CFBundleDisplayName"] = "Replay Demo"
        for key in [
            "MWDAT",
            "CFBundleURLTypes",
            "UIBackgroundModes",
            "UISupportedExternalAccessoryProtocols",
            "NSBluetoothAlwaysUsageDescription",
            "NSMicrophoneUsageDescription",
            "NSBonjourServices",
        ]:
            info.pop(key, None)
        info["NSLocalNetworkUsageDescription"] = "Upload your recordings to the Memory Replay server on your Mac."
    (folder / plist_name).write_bytes(plistlib.dumps(info))
    schemes = project / "xcshareddata" / "xcschemes"
    schemes.mkdir(parents=True, exist_ok=True)
    buildref = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ref("target")}" BuildableName="{name}.app" BlueprintName="{name}" ReferencedContainer="container:{name}.xcodeproj"/>'
    (schemes / f"{name}.xcscheme").write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
    <Scheme LastUpgradeVersion="2640" version="1.3">
    <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{buildref}</BuildActionEntry></BuildActionEntries></BuildAction>
    <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{buildref}</BuildableProductRunnable></LaunchAction>
    <ProfileAction buildConfiguration="Release"><BuildableProductRunnable runnableDebuggingMode="0">{buildref}</BuildableProductRunnable></ProfileAction>
    <AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
    </Scheme>""")
    print(project)


if __name__ == "__main__":
    generate(demo=True)
    generate(demo=False)
