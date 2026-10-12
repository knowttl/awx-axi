import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { AxiError } from "axi-sdk-js";

type AclAction = "restrict" | "verify" | "check";
export interface PrivateFileOptions {
  readonly platform?: NodeJS.Platform;
  readonly acl?: (path: string, action: AclAction, directory: boolean) => void;
  readonly uid?: number;
  readonly rename?: typeof renameSync;
  readonly wait?: (ms: number) => void;
}

/** All credential/config filesystem access passes through this boundary. */
export class PrivateFiles {
  readonly #options: PrivateFileOptions;
  readonly #windows: boolean;

  constructor(options: PrivateFileOptions = {}) {
    this.#options = options;
    this.#windows = (options.platform ?? process.platform) === "win32";
  }

  #acl(path: string, action: AclAction, directory = false): void {
    (this.#options.acl ?? windowsAcl)(path, action, directory);
  }

  #insecure(path: string): AxiError {
    return new AxiError(`insecure file permissions or type: ${path}`, "CONFIG_INSECURE", [
      this.#windows ? `Re-run the tool's write to protect ${path}` : `chmod 600 '${path.replaceAll("'", "'\\''")}'`,
    ]);
  }

  read(path: string, secret = false, verifyAcl = false): string | undefined {
    let fd: number | undefined;
    try {
      let info;
      try { info = lstatSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      if (!info.isFile() || info.isSymbolicLink()) throw this.#insecure(path);
      if (this.#windows) {
        this.#acl(path, "check");
        if (verifyAcl) this.#acl(path, "verify");
      } else if (info.uid !== (this.#options.uid ?? process.getuid?.()) ||
        (info.mode & (secret ? 0o077 : 0o022)) !== 0) {
        throw this.#insecure(path);
      }
      fd = openSync(path, constants.O_RDONLY | (this.#windows ? 0 : constants.O_NOFOLLOW));
      const opened = fstatSync(fd);
      if (opened.ino !== info.ino || opened.dev !== info.dev) throw this.#insecure(path);
      if (!this.#windows && (opened.uid !== (this.#options.uid ?? process.getuid?.()) ||
        (opened.mode & (secret ? 0o077 : 0o022)) !== 0)) throw this.#insecure(path);
      return readFileSync(fd, "utf8");
    } catch (error) {
      if (error instanceof AxiError) throw error;
      throw this.#insecure(path);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  write(path: string, content: string): void {
    try {
      this.#write(path, content);
    } catch {
      throw this.#insecure(path);
    }
  }

  #write(path: string, content: string): void {
    const directory = dirname(resolve(path));
    const missing: string[] = [];
    for (let current = directory; !existsSync(current); current = dirname(current)) missing.push(current);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const current of [...missing.reverse(), directory]) {
      if (this.#windows) this.#acl(realpathSync(current), "restrict", true);
      else chmodSync(current, 0o700);
    }
    // Reject a hostile existing target before replacing it, without reading its value.
    let target;
    try { target = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (target && (!target.isFile() || target.isSymbolicLink())) {
      throw this.#insecure(path);
    }
    if (this.#windows && target) this.#acl(path, "check");
    const temporary = join(directory, `.credentials-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", this.#windows ? undefined : 0o600);
      if (this.#windows) this.#acl(temporary, "restrict");
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      const rename = this.#options.rename ?? renameSync;
      for (let attempt = 0; ; attempt += 1) {
        try { rename(temporary, path); break; } catch (error) {
          if (!this.#windows || attempt === 4 ||
            !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          (this.#options.wait ?? wait)(50 * 2 ** attempt);
        }
      }
    } catch {
      throw this.#insecure(path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }
}

function wait(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** SID-based grants avoid localized account names and inherited broad access. */
function windowsAcl(path: string, action: AclAction, directory: boolean): void {
  const literal = `'${path.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference = 'Stop'
$path = ${literal}
$item = Get-Item -LiteralPath $path -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
${action === "check" ? "" : `
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
${action === "restrict" ? `
$acl = New-Object Security.AccessControl.${directory ? "DirectorySecurity" : "FileSecurity"}
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($id in $allowed) {
  $identity = New-Object Security.Principal.SecurityIdentifier($id)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', '${directory ? "ContainerInherit, ObjectInherit" : "None"}', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $path -AclObject $acl
` : `
$acl = Get-Acl -LiteralPath $path
if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unprotected ACL' }
$seen = @()
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { throw 'Unexpected grant' }
  $seen += $rule.IdentityReference.Value
}
foreach ($id in $allowed) { if ($id -notin $seen) { throw 'Missing grant' } }
`}`}`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "pipe" });
}
