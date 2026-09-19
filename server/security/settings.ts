import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { atomicWrite, inside } from '../core/util.js';
import { AppError } from '../core/types.js';
export const settingsSchema = z
  .object({
    name: z.string().trim().min(1).max(100).default('My brain'),
    onboarded: z.boolean().default(false),
    local_only: z.boolean().default(true),
    background: z.boolean().default(true),
    ai_background: z.boolean().default(false),
    provider: z.enum(['disabled', 'openai-compatible', 'ollama']).default('disabled'),
    endpoint: z.string().max(2000).default('http://127.0.0.1:11434'),
    model: z.string().max(200).default(''),
    embedding_model: z.string().max(200).default(''),
    context_budget: z.number().int().min(300).max(32000).default(3000),
    backup_directory: z.string().max(2000).default(''),
    backup_retention: z.number().int().min(1).max(1000).default(20),
    backup_interval_hours: z.number().int().min(0).max(8760).default(0),
    consolidation_interval_hours: z.number().int().min(0).max(8760).default(24),
    auto_accept_links: z.boolean().default(false),
    reduced_motion: z.boolean().default(false),
  })
  .strict();
export type SettingsData = z.infer<typeof settingsSchema>;
export function isLoopback(endpoint: string) {
  try {
    const u = new URL(endpoint);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}
export function validateEndpoint(endpoint: string, localOnly: boolean) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AppError(400, 'Invalid model endpoint');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new AppError(400, 'Endpoint must be an HTTP(S) URL without credentials, query, or fragment');
  if (localOnly && !isLoopback(endpoint))
    throw new AppError(403, 'Local-only mode blocks external model endpoints');
  if (!isLoopback(endpoint) && url.protocol !== 'https:')
    throw new AppError(400, 'External endpoints require HTTPS');
  return url;
}
export class Settings {
  data: SettingsData;
  constructor(readonly root: string) {
    const path = inside(root, 'config/settings.json');
    this.data = existsSync(path)
      ? settingsSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      : settingsSchema.parse({});
  }
  update(input: unknown) {
    const next = settingsSchema.parse(input);
    if (next.provider !== 'disabled') validateEndpoint(next.endpoint, next.local_only);
    atomicWrite(inside(this.root, 'config/settings.json'), JSON.stringify(next, null, 2) + '\n');
    this.data = next;
    return this.data;
  }
  reload() {
    const path = inside(this.root, 'config/settings.json');
    if (existsSync(path)) this.data = settingsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  }
  public() {
    return {
      ...this.data,
      key_configured:
        !!process.env.MNEME_API_KEY || existsSync(inside(this.root, 'config/provider-key.dpapi')),
      key_storage:
        process.platform === 'win32' ? 'Windows DPAPI (current user)' : 'MNEME_API_KEY environment variable',
    };
  }
  secret(value?: string) {
    if (value === undefined && process.env.MNEME_API_KEY) return process.env.MNEME_API_KEY;
    const path = inside(this.root, 'config/provider-key.dpapi');
    if (value === undefined && !existsSync(path)) return '';
    if (process.platform !== 'win32') {
      if (value !== undefined)
        throw new AppError(400, 'Set MNEME_API_KEY using your OS secret manager before starting the service');
      return '';
    }
    if (value && value.length > 10000) throw new AppError(400, 'API key too long');
    const encode = value !== undefined;
    // Fixed executable and script; the secret is passed via stdin, never interpolated or placed in argv.
    const script = `Add-Type -AssemblyName System.Security; $inputValue = [Console]::In.ReadToEnd(); $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser; ${encode ? '$bytes = [Text.Encoding]::UTF8.GetBytes($inputValue); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)))' : '$bytes = [Convert]::FromBase64String($inputValue); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)))'}`;
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        input: encode ? value : readFileSync(path, 'utf8'),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
      },
    );
    if (result.status !== 0) throw new AppError(500, 'Windows credential protection failed');
    if (encode) {
      atomicWrite(path, result.stdout);
      return '';
    }
    return result.stdout;
  }
}
