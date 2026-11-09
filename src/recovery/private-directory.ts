import { execFile } from "node:child_process";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const filename = "archive.sqlite";
const archiveFiles = new Set([filename, `${filename}-journal`, `${filename}-wal`, `${filename}-shm`]);
const sessionDirectory = /^session-[0-9a-f]{64}$/;
const payloadFile = /^lc1_[0-9a-f]{32}\.json$/;

// POSIX modes do not restrict other Windows users. Provision and check a private DACL there.
const secureWindowsDirectory = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:OPENCODE_LIVE_COMPACT_ACL_DIR
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$sidType = [System.Security.Principal.SecurityIdentifier]
$allow = [System.Security.AccessControl.AccessControlType]::Allow

function Read-OwnedAcl($item) {
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Unexpected reparse point' }
  if ($item -is [System.IO.DirectoryInfo]) { $acl = [System.IO.Directory]::GetAccessControl($item.FullName) }
  else { $acl = [System.IO.File]::GetAccessControl($item.FullName) }
  if ($acl.GetOwner($sidType) -ne $user) { throw 'Unexpected archive owner' }
  return $acl
}

function Is-Private($acl) {
  $ownerAllowed = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
    if ($rule.AccessControlType -ne $allow) { continue }
    if ($rule.IdentityReference -ne $user -and $rule.IdentityReference -ne $system) { return $false }
    if ($rule.IdentityReference -eq $user) { $ownerAllowed = $true }
  }
  return $ownerAllowed
}

$directory = [System.IO.DirectoryInfo]::new($path)
$acl = Read-OwnedAcl $directory
if (-not $acl.AreAccessRulesProtected -or -not (Is-Private $acl)) {
  if ($directory.GetFileSystemInfos().Length -ne 0) { throw 'Existing archive directory is not private' }
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($user)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  foreach ($sid in @($user, $system)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', $allow)
    $acl.AddAccessRule($rule)
  }
  [System.IO.Directory]::SetAccessControl($path, $acl)
  $acl = Read-OwnedAcl $directory
}
if (-not $acl.AreAccessRulesProtected -or -not (Is-Private $acl)) { throw 'Archive directory ACL is not private' }

$pending = [System.Collections.Generic.Stack[System.IO.FileSystemInfo]]::new()
foreach ($file in $directory.GetFileSystemInfos()) { $pending.Push($file) }
while ($pending.Count -gt 0) {
  $file = $pending.Pop()
  if (-not (Is-Private (Read-OwnedAcl $file))) { throw 'Archive file ACL is not private' }
  if ($file -is [System.IO.DirectoryInfo]) {
    foreach ($child in $file.GetFileSystemInfos()) { $pending.Push($child) }
  }
}
`;

export async function privateArchivePath(base: string): Promise<string> {
  const root = resolve(base);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(await realpath(root), "recovery-v1");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  const uid = process.getuid?.();
  if (!directoryStat.isDirectory() || (uid !== undefined && (directoryStat.uid !== uid || (directoryStat.mode & 0o077) !== 0))) {
    throw new Error("Recovery directory is not private");
  }

  const check = async (path: string, folder: boolean) => {
    const stat = await lstat(path);
    if ((folder ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) {
      throw new Error("Unexpected or non-private recovery entry");
    }
  };
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    if (archiveFiles.has(entry)) { await check(path, false); continue; }
    if (entry !== "sessions") throw new Error("Unexpected recovery entry");
    await check(path, true);
    for (const session of await readdir(path)) {
      if (!sessionDirectory.test(session)) throw new Error("Unexpected recovery session");
      const sessionPath = join(path, session);
      await check(sessionPath, true);
      for (const file of await readdir(sessionPath)) {
        if (!payloadFile.test(file)) throw new Error("Unexpected recovery payload");
        await check(join(sessionPath, file), false);
      }
    }
  }

  if (process.platform === "win32") {
    const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
    await runFile(join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", secureWindowsDirectory], {
        env: { SystemRoot: windowsRoot, OPENCODE_LIVE_COMPACT_ACL_DIR: directory },
        timeout: 5_000,
        windowsHide: true,
      });
  }

  const path = join(directory, filename);
  try {
    const file = await open(path, "wx", 0o600);
    await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return path;
}
