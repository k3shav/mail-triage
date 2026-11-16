import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const dataDir = mkdtempSync(path.join(tmpdir(), 'mail-triage-cli-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** Run the CLI from source with a clean environment: no model, no Google client, a throwaway database. */
function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'src/cli/index.ts', ...args],
      { cwd: root, env: { PATH: process.env.PATH ?? '', HOME: dataDir, DATA_DIR: dataDir, ...env }, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe('CLI', () => {
  it('prints help and rejects bad usage', async () => {
    const [help, both, unknown, interval] = await Promise.all([
      cli(['--help']),
      cli(['tag', '--dry-run', '--apply']),
      cli(['frobnicate']),
      cli(['watch', '--interval', '1']),
    ]);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/tag \[--dry-run \| --apply\]/);
    expect(help.stdout).toMatch(/watch/);
    expect(both).toMatchObject({ code: 2, stderr: expect.stringMatching(/cannot be used together/) });
    expect(unknown).toMatchObject({ code: 2, stderr: expect.stringMatching(/Unknown command/) });
    expect(interval).toMatchObject({ code: 2, stderr: expect.stringMatching(/--interval/) });
  });

  it('reports an unconfigured setup honestly', async () => {
    const [status, tag, apply] = await Promise.all([cli(['status']), cli(['tag']), cli(['tag', '--apply', '--json'])]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/Mode: dry-run \(nothing is written to Gmail\)/);
    expect(status.stdout).toMatch(/Model: not configured: MODEL_PROVIDER is not set/);
    expect(status.stdout).toMatch(/Gmail: not configured: Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MAIL_TRIAGE_ENCRYPTION_KEY/);
    expect(status.stdout).toMatch(/Not ready:/);

    expect(tag.code).toBe(1);
    expect(tag.stdout).toMatch(/^\[dry-run\] not_ready: Model not configured/);
    expect(apply.code).toBe(1);
    expect(JSON.parse(apply.stdout)).toMatchObject({ status: 'not_ready', mode: 'apply', sync: null, tag: null });
  });

  it('validates categories files without saving them', async () => {
    const bad = path.join(dataDir, 'bad.json');
    writeFileSync(bad, '{"categories": []}');
    const [good, broken, setup] = await Promise.all([cli(['categories', 'check', 'examples/categories.json']), cli(['categories', 'check', bad]), cli(['setup'])]);
    expect(good).toMatchObject({ code: 0, stdout: expect.stringMatching(/valid, 7 categories/) });
    expect(broken).toMatchObject({ code: 1, stderr: expect.stringMatching(/categories/) });
    expect(setup.stdout).toMatch(/Web application/);
    expect(setup.stdout).toMatch(/http:\/\/localhost:8787\/api\/gmail\/oauth\/callback/);
  });
});
