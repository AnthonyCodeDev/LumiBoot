// The v64 SMC patch (`scripts/patches/v64-smc-device.patch`) has to stay the
// fourth patch of the build plan, add the device to the closure bundles, and
// behave as QEMU's isa-applesmc. Everything here runs without a VM: the device
// is extracted from the patch and driven through a stub CPU in a child node
// process (the jsdom test environment has no dynamic import).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// (`pnpm test` runs from the repository root; tests/**/*.test.ts is included)
const repoRoot = resolve(process.cwd());
const patchDir = join(repoRoot, 'scripts', 'patches');
const lockPath = join(repoRoot, 'scripts', 'v64-assets.lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
  revision: string;
  patchFile: string[];
  build: { base: string; patches: string[] };
};
const PATCHES = [
  'v64-ioapic-irq0-gsi2.patch',
  'v64-ata-power-management.patch',
  'v64-usb-keyboard.patch',
  'v64-smc-device.patch',
];
const smcPatchPath = join(patchDir, 'v64-smc-device.patch');
const smcPatch = readFileSync(smcPatchPath, 'utf8');

/** The body of a patch's `diff --git a/<path>` section, without its header. */
function patchSection(path: string): string {
  const lines = smcPatch.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`diff --git a/${path} b/${path}`));
  if (start === -1) throw new Error(`${path} is not in ${basename(smcPatchPath)}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith('diff --git ')) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** A file the patch adds (`new file mode`), rebuilt from its `+` lines. */
function addedFile(path: string): string {
  const section = patchSection(path);
  expect(section).toContain('new file mode');
  const added: string[] = [];
  for (const line of section.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1));
  }
  return added.join('\n');
}

const RUNNER = `
import { SMC, APPLESMC_DEFAULT_OSK } from './smc.mjs';

const ports = new Map();
const entry = (port) => {
  if (!ports.has(port)) ports.set(port, {});
  return ports.get(port);
};
const cpu = {
  io: {
    // v86 calls a port's handler with the device as this
    register_read: (port, device, r8, r16, r32) => {
      const handlers = entry(port);
      if (r8) handlers.r8 = r8.bind(device);
      if (r16) handlers.r16 = r16.bind(device);
      if (r32) handlers.r32 = r32.bind(device);
    },
    register_write: (port, device, w8, w16, w32) => {
      const handlers = entry(port);
      if (w8) handlers.w8 = w8.bind(device);
      if (w16) handlers.w16 = w16.bind(device);
      if (w32) handlers.w32 = w32.bind(device);
    },
  },
};
const device = new SMC(cpu);

function readKey(_device, key) {
  device.cmd_write(0x10);
  for (const character of key) device.data_write(character.charCodeAt(0));
  device.data_write(0);
  const data = [];
  for (let index = 0; index < device.data_len; index += 1) data.push(device.data_read());
  return data;
}
const text = (bytes) => String.fromCharCode(...bytes);

const result = {
  defaultOsk: APPLESMC_DEFAULT_OSK,
  keys: Object.keys(device.keys).sort(),
  osk0: text(readKey(device, 'OSK0')),
  osk1: text(readKey(device, 'OSK1')),
  rev: readKey(device, 'REV '),
  natj: readKey(device, 'NATJ'),
};

device.cmd_write(0x10);
for (const character of '$Num') device.data_write(character.charCodeAt(0));
device.data_write(0);
result.unknownKey = { status: device.status, err: device.err_read(), cmd: device.cmd_read() };

result.badCommands = [];
for (const command of [0x11, 0x12, 0x13]) {
  device.cmd_write(command);
  result.badCommands.push({ command, status: device.status, err: device.err_read() });
}

// a READ while the previous answer is still waiting: "command interrupted"
device.cmd_write(0x10);
for (const character of 'OSK0') device.data_write(character.charCodeAt(0));
device.data_write(32);
result.readReady = device.status;
device.cmd_write(0x10);
result.interrupted = { status: device.status, err: device.err_read() };

// wide accesses: the 32-bit write of 'RE' + 'V ', then the length byte
const data = ports.get(0x300);
const command = ports.get(0x304);
command.w8(0x10);
data.w16(0x4552);
data.w16(0x2056);
data.w8(6);
result.wide = { status: device.status, len: device.data_len, read32: data.r32(), read16: data.r16(), cmd32: command.r32() };
result.wideStatus = device.status;
result.handlers = {
  data: ['r8', 'r16', 'r32', 'w8', 'w16', 'w32'].every((name) => typeof data[name] === 'function'),
  command: ['r8', 'r16', 'r32', 'w8', 'w16'].every((name) => typeof command[name] === 'function'),
  error: ['r8', 'w8'].every((name) => typeof ports.get(0x31e)[name] === 'function'),
};

const saved = device.get_state();
device.reset();
result.afterReset = { len: device.get_state()[7], status: device.status, key: device.key.join(',') };
device.set_state(saved);
result.afterRestore = { len: device.data_len, status: device.status };

process.stdout.write(JSON.stringify(result));
`;

interface Observations {
  defaultOsk: string;
  keys: string[];
  osk0: string;
  osk1: string;
  rev: number[];
  natj: number[];
  unknownKey: { status: number; err: number; cmd: number };
  badCommands: Array<{ command: number; status: number; err: number }>;
  readReady: number;
  interrupted: { status: number; err: number };
  wide: { status: number; len: number; read32: number; read16: number; cmd32: number };
  wideStatus: number;
  handlers: { data: boolean; command: boolean; error: boolean };
  afterReset: { len: number; status: number; key: string };
  afterRestore: { len: number; status: number };
}

let observations: Observations | undefined;

/** Runs the device (as the patch adds it) in a child node process. */
function deviceObservations(): Observations {
  if (observations) return observations;
  const dir = mkdtempSync(join(tmpdir(), 'lumiboot-smc-'));
  try {
    const source = addedFile('src/smc.js')
      // (the type-only import of cpu.js, and its "For Types Only" comment)
      .replace(/^\/\/ For Types Only\nimport \{ CPU \} from "\.\/cpu\.js";\n\n/, '');
    writeFileSync(join(dir, 'smc.mjs'), `${source}\n`, 'utf8');
    writeFileSync(join(dir, 'runner.mjs'), RUNNER, 'utf8');
    const run = spawnSync(process.execPath, [join(dir, 'runner.mjs')], {
      cwd: dir,
      encoding: 'utf8',
    });
    if (run.status !== 0) throw new Error(`the SMC device failed: ${run.stderr || run.stdout}`);
    observations = JSON.parse(run.stdout) as Observations;
    return observations;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the v64 SMC patch', () => {
  it('is the last patch of the build plan, in the lock and in patchFile', () => {
    expect(lock.build.patches.map((path) => basename(path))).toEqual(PATCHES);
    expect(lock.patchFile.map((path) => basename(path))).toEqual(PATCHES);
    expect(lock.build.base).toBe(lock.revision);
    for (const name of PATCHES) expect(existsSync(join(patchDir, name))).toBe(true);
  });

  it('keeps the device in the closure bundles and in the snapshot', () => {
    // (without this, the closure compiler cannot load ./smc.js: "Failed to load module")
    const makefile = patchSection('Makefile');
    expect(makefile).toMatch(/^\+.*ps2\.js rtc\.js smc\.js uart\.js/m);
    expect(patchSection('src/cpu.js')).toContain('state[112] = this.devices.smc;');
    expect(patchSection('src/browser/cpu_worker.js')).toContain('"smc": o.smc');
    expect(patchSection('src/browser/starter.js')).toContain('settings.smc = options.smc;');
  });

  it('describes APP0001 and IRQ 6 only when smc is on, and refuses the NE2000', () => {
    const acpi = patchSection('src/acpi_tables.js');
    expect(acpi).toContain('...platform.smc ? [');
    expect(acpi).toContain(
      'isa_device("SMC", "APP0001", aml_resources(res_io(0x300, 0x20), res_irq_noflags([6])))',
    );
    // (q35's FDC0 gives IRQ 6 up; i440FX keeps it)
    expect(acpi).toContain('platform.machine === "q35" ? [] : res_irq_noflags([6])');
    const options = patchSection('src/machine_options.js');
    expect(options).toContain(
      'smc: true and the NE2000 (net_device type \\"ne2k\\", the default) both use the I/O',
    );
    expect(options).toContain('"smc"');
    expect(patchSection('src/platform.js')).toContain('smc requires machine_type \\"q35\\"');
  });

  it('serves the OSK key, REV and the error codes as QEMU does', () => {
    const seen = deviceObservations();

    expect(seen.keys).toEqual(['MSSD', 'MSSP', 'NATJ', 'OSK0', 'OSK1', 'REV ']);
    expect(seen.defaultOsk).toHaveLength(64);
    expect(seen.osk0 + seen.osk1).toBe(seen.defaultOsk);
    expect(seen.osk0).toBe('ourhardworkbythesewordsguardedpl');
    expect(seen.osk1).toBe('easedontsteal(c)AppleComputerInc');
    expect(seen.rev).toEqual([0x01, 0x13, 0x0f, 0x00, 0x00, 0x03]);
    expect(seen.natj).toEqual([0x00]);

    // an unknown key: status done, error "no such key"
    expect(seen.unknownKey).toEqual({ status: 0x00, err: 0x84, cmd: 0x00 });

    // WRITE, GET_KEY_BY_INDEX and GET_KEY_TYPE are not implemented, as in QEMU 8.2
    expect(seen.badCommands).toEqual([
      { command: 0x11, status: 0x08, err: 0x82 },
      { command: 0x12, status: 0x08, err: 0x82 },
      { command: 0x13, status: 0x08, err: 0x82 },
    ]);

    // data ready for a READ that was not consumed, then another READ: "command
    // interrupted" (QEMU's ST_1E_CMD_INTRUPTED)
    expect(seen.readReady).toBe(0x05);
    expect(seen.interrupted).toEqual({ status: 0x08, err: 0x80 });
  });

  it('splits wide accesses into byte accesses, and snapshots its registers', () => {
    const seen = deviceObservations();

    expect(seen.handlers).toEqual({ data: true, command: true, error: true });
    // 'REV ' (6 bytes) asked for with 16-bit writes: data ready with 6 bytes,
    // then 4 bytes in one 32-bit read and the last two in one 16-bit read
    expect(seen.wide).toEqual({
      status: 0x05,
      len: 6,
      read32: 0x000f1301,
      read16: 0x0300,
      cmd32: 0,
    });
    expect(seen.wideStatus).toBe(0x00);

    expect(seen.afterReset).toEqual({ len: 0, status: 0, key: '0,0,0,0' });
    expect(seen.afterRestore).toEqual({ len: 6, status: 0x00 });
  });

  it('applies after the other three patches, in a scratch tree', () => {
    // (needs the pinned upstream tree: a `scripts/build-v64-assets.sh` run, or
    // V64_PATCH_CHECK_CLONE=<a clone of the v64 repository>)
    const candidates = [
      process.env.V64_PATCH_CHECK_CLONE,
      join(tmpdir(), 'lumiboot-v64-build', 'v64'),
    ].filter((value): value is string => Boolean(value));
    const clone = candidates.find((value) => existsSync(join(value, '.git')));
    if (!clone) {
      // No upstream tree on this machine: `git apply` cannot run offline, and
      // the patch is still checked above.
      expect(smcPatch).toContain('diff --git a/src/smc.js b/src/smc.js');
      return;
    }
    const worktree = mkdtempSync(join(tmpdir(), 'lumiboot-v64-apply-'));
    rmSync(worktree, { recursive: true, force: true });
    const git = (args: string[], cwd: string) =>
      spawnSync('git', ['-c', 'core.autocrlf=false', ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      });
    try {
      const added = git(['worktree', 'add', '--detach', worktree, lock.revision], clone);
      expect(added.status, added.stderr).toBe(0);
      for (const name of PATCHES) {
        const checked = git(['apply', '--check', join(patchDir, name)], worktree);
        expect(checked.status, `${name}: ${checked.stderr}`).toBe(0);
        const applied = git(['apply', join(patchDir, name)], worktree);
        expect(applied.status, `${name}: ${applied.stderr}`).toBe(0);
      }
      expect(readFileSync(join(worktree, 'src', 'smc.js'), 'utf8')).toContain(
        'export function SMC(cpu, osk)',
      );

      // The ACPI device itself, from the patched sources: Device(SMC_) _HID
      // APP0001 (the EISA DWord 0x01001006), _CRS IO 0x300 length 0x20 and IRQ
      // 6, only when smc is on; FDC0's _CRS has no IRQ 6 either way on q35.
      const dsdtCheck = `
import { create_platform } from './src/platform.js';
import { build_acpi_tables } from './src/acpi_tables.js';
const dump = (smc) => {
  const platform = create_platform({ machine_type: 'q35', acpi: true, cpu_cores: 1, pcie_root_ports: 2, smc }, 2048 * 1024 * 1024);
  const { tables } = build_acpi_tables(platform, 0x600);
  return Array.from(tables).map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
};
const on = dump(true);
const off = dump(false);
const fdcCrs = '47 01 f2 03 f2 03 01 04 47 01 f7 03 f7 03 01 01 2a 04 00';
process.stdout.write(JSON.stringify({
  smcDeviceOn: on.includes('5b 82 25 53 4d 43 5f'),
  hid: on.includes('53 4d 43 5f 08 5f 48 49 44 0c 06 10 00 01'),
  crs: on.includes('47 01 00 03 00 03 01 20 22 40 00'),
  smcDeviceOff: off.includes('53 4d 43 5f'),
  fdcWithoutIrq: on.includes(fdcCrs) && off.includes(fdcCrs),
}));
`;
      writeFileSync(join(worktree, 'smc-dsdt-check.mjs'), dsdtCheck, 'utf8');
      const run = spawnSync(process.execPath, [join(worktree, 'smc-dsdt-check.mjs')], {
        cwd: worktree,
        encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        smcDeviceOn: true,
        hid: true,
        crs: true,
        smcDeviceOff: false,
        fdcWithoutIrq: true,
      });
    } finally {
      git(['worktree', 'remove', '--force', worktree], clone);
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
