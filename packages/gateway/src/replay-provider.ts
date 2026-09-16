/**
 * ReplayProvider: replays recorded provider responses so regression suites run without spend; refuses unknown
 * prompts (a silent live call would be spend and non-determinism). Recordings are plain JSON files keyed by
 *   * the prompt hash (`promptKey`: model + system + user), or
 *   * `activity:<activityId>` — the workflow's deterministic activity id carried in `ProviderRequest.trace`
 *     (Checkpoint 5 replay fixtures, whose prompts embed run-specific ids; ADR-0046).
 * Prompt-hash recordings win; an activity recording is a fallback and is reported in `served`.
 *
 * Recordings may contain `{{name}}` placeholders bound at replay time (entity/proposition/version ids the
 * real model would have copied from the prompt). An unbound placeholder is an error, never silently emitted.
 */
import { readFileSync } from 'node:fs';
import { promptKey } from './mock-provider.js';
import {
  type FinishReason,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from './types.js';

export interface Recording {
  readonly text?: string | undefined;
  readonly json?: unknown;
  readonly finishReason?: FinishReason | undefined;
  readonly modelId?: string | undefined;
  readonly usage?: ProviderResponse['usage'] | undefined;
}

export interface ReplayOptions {
  readonly name?: string | undefined;
  /** Placeholder bindings, read at each call so a workflow can extend them as it creates ids. */
  readonly bindings?: (() => Readonly<Record<string, string>>) | undefined;
}

export const ACTIVITY_KEY_PREFIX = 'activity:';
const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;
/** `"{{int:name}}"` (quoted) is replaced by the bare number so recordings can carry pinned integers. */
const INT_PLACEHOLDER = /"\{\{int:([^{}]+)\}\}"/g;

export class ReplayProvider implements Provider {
  readonly name: string;
  private readonly recordings: Map<string, Recording>;
  private readonly bindings: (() => Readonly<Record<string, string>>) | undefined;
  readonly misses: string[] = [];
  /** Every served request: which key matched (for tests proving no prompt went unrecorded). */
  readonly served: { key: string; by: 'prompt_hash' | 'activity'; activityId?: string }[] = [];

  constructor(
    recordings: Record<string, Recording> | Map<string, Recording>,
    options: string | ReplayOptions = 'replay',
  ) {
    const opts: ReplayOptions = typeof options === 'string' ? { name: options } : options;
    this.name = opts.name ?? 'replay';
    this.bindings = opts.bindings;
    this.recordings = recordings instanceof Map ? recordings : new Map(Object.entries(recordings));
  }

  static fromFile(path: string, options: string | ReplayOptions = 'replay'): ReplayProvider {
    return new ReplayProvider(
      JSON.parse(readFileSync(path, 'utf8')) as Record<string, Recording>,
      options,
    );
  }

  has(activityId: string): boolean {
    return this.recordings.has(`${ACTIVITY_KEY_PREFIX}${activityId}`);
  }

  /** Add or replace recordings (tests use this to inject a failing variant). */
  override(recordings: Record<string, Recording>): this {
    for (const [k, v] of Object.entries(recordings)) this.recordings.set(k, v);
    return this;
  }

  /** Serve the recording stored under `fromKey` for `toKey` (select a test variant). */
  alias(toKey: string, fromKey: string): this {
    const rec = this.recordings.get(fromKey);
    if (!rec) throw new Error(`ReplayProvider: no recording ${fromKey}`);
    this.recordings.set(toKey, rec);
    return this;
  }

  /**
   * Remove a recording and return it, so a test can create a GENUINE replay miss on the context that is
   * actually executing and restore it afterwards. Returns `undefined` when the key was not recorded.
   */
  remove(key: string): Recording | undefined {
    const rec = this.recordings.get(key);
    this.recordings.delete(key);
    return rec;
  }

  /** Restore a recording removed by `remove`. */
  restore(key: string, recording: Recording): this {
    this.recordings.set(key, recording);
    return this;
  }

  private bind(rec: Recording): Recording {
    const table = this.bindings?.() ?? {};
    const serialized = JSON.stringify(rec);
    if (!serialized.includes('{{')) return rec;
    const unbound: string[] = [];
    const ints = serialized.replace(INT_PLACEHOLDER, (m, name: string) => {
      const v = table[name];
      if (v === undefined || !/^-?\d+$/.test(v)) {
        unbound.push(`int:${name}`);
        return m;
      }
      return v;
    });
    const bound = ints.replace(PLACEHOLDER, (m, name: string) => {
      const v = table[name];
      if (v === undefined) {
        unbound.push(name);
        return m;
      }
      return v;
    });
    if (unbound.length > 0)
      throw new Error(
        `ReplayProvider: recording has unbound placeholders ${[...new Set(unbound)].map((u) => `{{${u}}}`).join(', ')}`,
      );
    return JSON.parse(bound) as Recording;
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const key = promptKey(req);
    let rec = this.recordings.get(key);
    let by: 'prompt_hash' | 'activity' = 'prompt_hash';
    let matched = key;
    if (!rec && req.trace) {
      matched = `${ACTIVITY_KEY_PREFIX}${req.trace.activityId}`;
      rec = this.recordings.get(matched);
      by = 'activity';
    }
    if (!rec) {
      this.misses.push(key);
      throw new Error(
        `ReplayProvider: no recording for prompt ${key.slice(0, 12)}…${req.trace ? ` / activity ${req.trace.activityId}` : ''} (model ${req.modelId}); refusing to call a live provider`,
      );
    }
    const out = this.bind(rec);
    this.served.push({
      key: matched,
      by,
      ...(req.trace ? { activityId: req.trace.activityId } : {}),
    });
    return {
      modelId: out.modelId ?? req.modelId,
      provider: this.name,
      text: out.text,
      json: out.json,
      finishReason: out.finishReason ?? 'stop',
      usage: out.usage ?? { input: 0, output: 0, cached: 0 },
      latencyMs: 0,
    };
  }
}
