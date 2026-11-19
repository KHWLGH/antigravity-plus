import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { KeychainStore } from "./accounts.ts";

const run = promisify(execFile);
const security = "/usr/bin/security";

function requireMacOS() {
  if (process.platform !== "darwin") throw new Error("Antigravity accounts require macOS");
}

function itemArgs(service: string, account: string) {
  return ["-s", service, "-a", account];
}

export class MacKeychainStore implements KeychainStore {
  async read(service: string, account: string): Promise<string | null> {
    requireMacOS();
    try {
      const { stdout } = await run(security, ["find-generic-password", ...itemArgs(service, account), "-w"], { timeout: 5000 });
      return stdout.replace(/\r?\n$/, "");
    } catch (error) {
      if ((error as { code?: number }).code === 44) return null; // errSecItemNotFound
      throw new Error("Could not read the Antigravity Keychain item");
    }
  }

  async write(service: string, account: string, value: string): Promise<void> {
    requireMacOS();
    // security -i parses its own command language. All three operands have a
    // restricted alphabet, including the opaque go-keyring envelope.
    if (![service, account].every((s) => /^[a-zA-Z0-9._-]+$/.test(s)) ||
        !/^go-keyring-base64:[A-Za-z0-9+/]+=*$/.test(value)) {
      throw new Error("Unsupported Antigravity Keychain item format");
    }
    const command = `add-generic-password -U -s "${service}" -a "${account}" -w "${value}"\n`;
    // Apple's SecurityTool reads interactive input into a 4096-byte buffer.
    // Reject oversized writes before they can truncate an existing item.
    if (Buffer.byteLength(command) >= 4096) throw new Error("Credential exceeds the macOS security interactive input limit");
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error("Could not write the Antigravity Keychain item"));
      const child = execFile(security, ["-i"], { timeout: 5000 }, error => error ? fail() : resolve());
      child.stdin?.on("error", fail);
      child.stdin?.end(command);
    });
    // Verify the exact bytes for vault writes as well as the active slot.
    if (await this.read(service, account) !== value) throw new Error("Antigravity Keychain write verification failed");
  }

  async remove(service: string, account: string): Promise<void> {
    requireMacOS();
    try {
      await run(security, ["delete-generic-password", ...itemArgs(service, account)], { timeout: 5000 });
    } catch (error) {
      if ((error as { code?: number }).code !== 44) throw new Error("Could not remove the Antigravity Keychain item");
    }
  }
}
