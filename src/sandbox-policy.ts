import { homedir } from "node:os";
import { join } from "node:path";

const USER_NAMESPACE_DENIED =
  /nested userns is capability-restricted|bwrap: (?:No permissions to create new namespace|setting up uid map: Permission denied)/;

const DENIAL_SCAN_CHARS = 512;

export const USER_NAMESPACE_DENIED_REMEDY =
  "the host denies the user namespaces it needs. " +
  "On Ubuntu 24.04+, run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`; " +
  "on Ubuntu 26.04 also unload the bwrap profile with " +
  "`sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict`.";

export const USER_NAMESPACE_DENIED_MESSAGE =
  `The shell sandbox could not start: ${USER_NAMESPACE_DENIED_REMEDY}`;

export function createUserNamespaceDenialDetector() {
  let tail = "";
  let denied = false;

  return {
    push(chunk: string) {
      if (denied) return;
      tail = (tail + chunk).slice(-DENIAL_SCAN_CHARS);
      denied = isUserNamespaceDenied(tail);
    },
    get denied() {
      return denied;
    },
  };
}

export function isUserNamespaceDenied(output: string): boolean {
  return USER_NAMESPACE_DENIED.test(output);
}

export function protectedHomePaths(home: string = homedir()): string[] {
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".config", "gcloud"),
    join(home, ".netrc"),
    join(home, ".npmrc"),
  ];
}
