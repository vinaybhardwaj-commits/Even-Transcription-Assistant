// macho-uuid.mjs <file> -- print the LC_UUID (load command 0x1b) of a THIN 64-bit little-endian Mach-O as 32 lowercase hex digits.
// install.sh ad-hoc re-signs the installed binary (codesign --force -s -), so its bytes and sha256 change; the LC_UUID does not.
// Pure parser, no tools on the kiosk: kh-rollout.sh copies the installed binary to the Air and reads it here.
// Any problem (not a Mach-O, fat/universal, 32-bit, big-endian, truncated, no LC_UUID) -> stderr "error: ..." and exit 2.
import fs from 'node:fs';

const LC_UUID = 0x1b;
function fail(msg) { console.error('error: ' + msg); process.exit(2); }

try {
  const file = process.argv[2];
  if (!file) fail('usage: node macho-uuid.mjs <file>');
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(32);
  if (fs.readSync(fd, head, 0, 32, 0) < 32) fail('file too short to be a Mach-O');
  const magicBE = head.readUInt32BE(0);
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf || magicBE === 0xbebafeca || magicBE === 0xbfbafeca) {
    fail('fat (universal) binary: refusing to guess which slice; the package is expected to be a thin arm64 binary');
  }
  if (head.readUInt32LE(0) !== 0xfeedfacf) {
    if (magicBE === 0xfeedfacf || magicBE === 0xfeedface || head.readUInt32LE(0) === 0xfeedface) fail('not a little-endian 64-bit Mach-O (32-bit or big-endian)');
    fail('not a Mach-O file');
  }
  const ncmds = head.readUInt32LE(16), sizeofcmds = head.readUInt32LE(20);
  if (32 + sizeofcmds > size || sizeofcmds > 4 * 1024 * 1024) fail('load commands run past the end of the file');
  const cmds = Buffer.alloc(sizeofcmds);
  if (fs.readSync(fd, cmds, 0, sizeofcmds, 32) < sizeofcmds) fail('truncated load commands');
  let off = 0, found = null;
  for (let i = 0; i < ncmds; i++) {
    if (off + 8 > sizeofcmds) fail('malformed load command table');
    const cmd = cmds.readUInt32LE(off), cmdsize = cmds.readUInt32LE(off + 4);
    if (cmdsize < 8 || off + cmdsize > sizeofcmds) fail('malformed load command');
    if (cmd === LC_UUID) {
      if (cmdsize < 24) fail('malformed LC_UUID');
      if (found) fail('more than one LC_UUID');
      found = cmds.subarray(off + 8, off + 24).toString('hex');
    }
    off += cmdsize;
  }
  if (!found) fail('no LC_UUID in this Mach-O');
  console.log(found);
} catch (e) {
  fail(String((e && e.message) || e).slice(0, 120));
}
