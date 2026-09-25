; golive — Windows installer (Inno Setup 6)
; Compile via packaging/build-bundle.ps1 (which passes /DVersion and /DOutput).

#define MyAppName "golive"
#define MyAppExeName "golive-helper.exe"

[Setup]
AppId={{5E2A7C1F-3D77-4B1A-9D2E-8D5F1C6B4E77}
AppName={#MyAppName}
AppVersion={#Version}
AppPublisher=golive
DefaultDirName={localappdata}\Programs\golive
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#Output}
OutputBaseFilename=golive-setup-{#Version}
Compression=lzma2/max
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
CloseApplications=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop icon"; GroupDescription: "Additional icons:"
Name: "startup"; Description: "Start golive with &Windows"; GroupDescription: "Additional icons:"

[Files]
Source: "..\dist\golive\golive-helper.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\golive\THIRD-PARTY-NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\golive\gstreamer\bin\*"; DestDir: "{app}\gstreamer\bin"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\dist\golive\gstreamer\lib\*"; DestDir: "{app}\gstreamer\lib"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\dist\golive\gstreamer\libexec\*"; DestDir: "{app}\gstreamer\libexec"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName} helper"; Filename: "{app}\{#MyAppExeName}"; Parameters: "-tray"
Name: "{autodesktop}\{#MyAppName} helper"; Filename: "{app}\{#MyAppExeName}"; Parameters: "-tray"; Tasks: desktopicon
Name: "{userstartup}\{#MyAppName} helper"; Filename: "{app}\{#MyAppExeName}"; Parameters: "-tray"; Tasks: startup

[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: "-tray"; Description: "Launch {#MyAppName} helper"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\gstreamer"
Type: dirifempty; Name: "{app}"