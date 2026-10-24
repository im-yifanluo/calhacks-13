"""Generate an Xcode project without third-party generator tools; rerun after adding Swift files."""
from pathlib import Path
import hashlib
import plistlib

ROOT = Path(__file__).resolve().parents[1]
folder = ROOT / 'apps' / 'ios' / 'SceneCapture'
project = ROOT / 'apps' / 'ios' / 'SceneCapture.xcodeproj'
project.mkdir(exist_ok=True)
def ident(s): return hashlib.sha1(s.encode()).hexdigest()[:24].upper()
def ref(s): return ident(s)
objects = []
def obj(name, fields): objects.append(f'{ref(name)} = {{ {fields} }};')
files = sorted(folder.glob('*.swift'))
for file in files:
    obj(file.name, f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {file.name}; sourceTree = "<group>";')
    obj('build'+file.name, f'isa = PBXBuildFile; fileRef = {ref(file.name)};')
obj('plist', 'isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>";')
obj('app', 'isa = PBXFileReference; explicitFileType = wrapper.application; path = SceneCapture.app; sourceTree = BUILT_PRODUCTS_DIR;')
obj('sourcegroup', f'isa = PBXGroup; path = SceneCapture; sourceTree = "<group>"; children = ({",".join(ref(f.name) for f in files)},{ref("plist")},);')
obj('products', f'isa = PBXGroup; name = Products; sourceTree = "<group>"; children = ({ref("app")},);')
obj('main', f'isa = PBXGroup; sourceTree = "<group>"; children = ({ref("sourcegroup")},{ref("products")},);')
obj('sources', f'isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ({",".join(ref("build"+f.name) for f in files)},); runOnlyForDeploymentPostprocessing = 0;')
obj('resources', 'isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;')
for module in ['MWDATCore', 'MWDATCamera']:
    obj(module, f'isa = XCSwiftPackageProductDependency; package = {ref("sdk")}; productName = {module};')
    obj('build'+module, f'isa = PBXBuildFile; productRef = {ref(module)};')
obj('frameworks', f'isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ({ref("buildMWDATCore")},{ref("buildMWDATCamera")},); runOnlyForDeploymentPostprocessing = 0;')
obj('sdk', 'isa = XCRemoteSwiftPackageReference; repositoryURL = "https://github.com/facebook/meta-wearables-dat-ios"; requirement = { kind = exactVersion; version = 1.0.1; };')
for level in ['project', 'target']:
    for mode in ['Debug', 'Release']:
        settings = '''CLANG_ENABLE_MODULES = YES; SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 17.2;
        SWIFT_VERSION = 5.0; SWIFT_STRICT_CONCURRENCY = minimal; TARGETED_DEVICE_FAMILY = 1;'''
        if level == 'target':
            settings += '''PRODUCT_NAME = "$(TARGET_NAME)"; PRODUCT_BUNDLE_IDENTIFIER = com.memreplay.SceneCapture;
            INFOPLIST_FILE = SceneCapture/Info.plist; CODE_SIGN_STYLE = Automatic;
            CURRENT_PROJECT_VERSION = 1; MARKETING_VERSION = 1.0; GENERATE_INFOPLIST_FILE = NO;
            LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks"; META_APP_ID = 0; CLIENT_TOKEN = "";'''
        settings += ' SWIFT_OPTIMIZATION_LEVEL = "-Onone"; DEBUG_INFORMATION_FORMAT = dwarf;' if mode == 'Debug' else ' SWIFT_OPTIMIZATION_LEVEL = "-O"; DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";'
        obj(level+mode, f'isa = XCBuildConfiguration; name = {mode}; buildSettings = {{ {settings} }};')
    obj(level+'configs', f'isa = XCConfigurationList; buildConfigurations = ({ref(level+"Debug")},{ref(level+"Release")},); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
obj('target', f'''isa = PBXNativeTarget; name = SceneCapture; productName = SceneCapture; productType = "com.apple.product-type.application";
    productReference = {ref('app')}; buildConfigurationList = {ref('targetconfigs')};
    buildPhases = ({ref('sources')},{ref('frameworks')},{ref('resources')},); buildRules = (); dependencies = ();
    packageProductDependencies = ({ref('MWDATCore')},{ref('MWDATCamera')},);''')
obj('project', f'''isa = PBXProject; attributes = {{ LastUpgradeCheck = 2640; }}; buildConfigurationList = {ref('projectconfigs')};
    compatibilityVersion = "Xcode 14.0"; developmentRegion = en; knownRegions = (en,Base,);
    mainGroup = {ref('main')}; productRefGroup = {ref('products')}; projectDirPath = ""; projectRoot = "";
    targets = ({ref('target')},); packageReferences = ({ref('sdk')},);''')
(project / 'project.pbxproj').write_text('// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n'+'\n'.join(objects)+f'\n}}; rootObject = {ref("project")}; }}\n')
info = {
    'CFBundleDisplayName': 'Memory Replay', 'CFBundleName': '$(PRODUCT_NAME)',
    'CFBundleIdentifier': '$(PRODUCT_BUNDLE_IDENTIFIER)', 'CFBundleExecutable': '$(EXECUTABLE_NAME)',
    'CFBundlePackageType': 'APPL', 'CFBundleVersion': '$(CURRENT_PROJECT_VERSION)',
    'CFBundleShortVersionString': '$(MARKETING_VERSION)', 'LSRequiresIPhoneOS': True,
    'UILaunchScreen': {}, 'UISupportedInterfaceOrientations': ['UIInterfaceOrientationPortrait'],
    'CFBundleURLTypes': [{'CFBundleURLName': '$(PRODUCT_BUNDLE_IDENTIFIER)', 'CFBundleURLSchemes': ['scenecapture']}],
    'MWDAT': {'AppLinkURLScheme': 'scenecapture://', 'MetaAppID': '$(META_APP_ID)',
              'ClientToken': '$(CLIENT_TOKEN)', 'TeamID': '$(DEVELOPMENT_TEAM)'},
    'UIBackgroundModes': ['processing', 'bluetooth-central', 'bluetooth-peripheral', 'external-accessory'],
    'UISupportedExternalAccessoryProtocols': ['com.meta.ar.wearable'],
    'NSBluetoothAlwaysUsageDescription': 'Connect to your glasses to capture scenes.',
    'NSLocalNetworkUsageDescription': 'Connect to your glasses and local scene server.',
    'NSBonjourServices': ['_bonjour._tcp'],
    'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
    'UIFileSharingEnabled': True, 'LSSupportsOpeningDocumentsInPlace': True,
}
(folder / 'Info.plist').write_bytes(plistlib.dumps(info))
schemes = project / 'xcshareddata' / 'xcschemes'
schemes.mkdir(parents=True, exist_ok=True)
buildref = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ref("target")}" BuildableName="SceneCapture.app" BlueprintName="SceneCapture" ReferencedContainer="container:SceneCapture.xcodeproj"/>'
(schemes / 'SceneCapture.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2640" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{buildref}</BuildActionEntry></BuildActionEntries></BuildAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{buildref}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release"><BuildableProductRunnable runnableDebuggingMode="0">{buildref}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')
print(project)
