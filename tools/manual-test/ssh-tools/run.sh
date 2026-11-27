#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.."
sshd=$(command -v sshd || printf '%s' /usr/sbin/sshd)
if [[ ! -x "$sshd" ]]; then
  printf '%s\n' "This test requires OpenSSH sshd." >&2
  exit 1
fi

fixture=$(mktemp -d /tmp/pi-ssh-fixture.XXXXXX)
trap 'rm -rf -- "$fixture"' EXIT
ssh-keygen -q -t ed25519 -N '' -f "$fixture/host"
ssh-keygen -q -t ed25519 -N '' -f "$fixture/client"
printf 'pi-ssh-test %s\n' "$(< "$fixture/host.pub")" > "$fixture/known_hosts"
printf '%s\n' \
  "HostKey $fixture/host" "AuthorizedKeysFile $fixture/client.pub" \
  'StrictModes no' 'UsePAM no' 'PasswordAuthentication no' \
  'KbdInteractiveAuthentication no' 'PermitUserRC no' "AllowUsers $(id -un)" > "$fixture/sshd.conf"
printf '%s\n' \
  'Host pi-ssh-test' '  HostName localhost' "  User $(id -un)" '  HostKeyAlias pi-ssh-test' \
  "  UserKnownHostsFile $fixture/known_hosts" "  IdentityFile $fixture/client" '  IdentitiesOnly yes' \
  "  ProxyCommand \"$sshd\" -i -f \"$fixture/sshd.conf\"" > "$fixture/ssh.conf"

PI_SSH_TEST_CONFIG="$fixture/ssh.conf" npm exec -- vitest run extensions/ssh-tools/index.test.ts
