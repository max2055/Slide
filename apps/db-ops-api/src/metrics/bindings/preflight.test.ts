import { describe, expect, it, vi } from 'vitest';
import {
  type PackageCompositionEntry, type ResourceBindingCandidate, type SourceChain, type TemplateItemVersion,
  type TemplateParameters, type TemplatePin, type TemplateVersion, type VersionNumber,
} from '../../contracts/metrics/templates.js';
import { templateContentHash } from '../templates/model.js';
import {
  BindingPreflightError, preflightResourceBinding, type TemplateVersionReadPort,
} from './preflight.js';

const T0 = '2026-10-01T00:00:00Z';
const T1 = '2026-10-02T00:00:00Z';
const T2 = '2026-10-03T00:00:00Z';

const release = (id: string, version = '1.0.0', seed = 'a'): string =>
  `${id}@${version}#sha256:${seed.repeat(64).slice(0, 64)}`;

const capabilities = () => ({
  discovery: { contract_version: '1.0.0', ref: null, executable: false as const },
  graphs: { contract_version: '1.0.0', ref: null, executable: false as const },
});

interface ItemSpec {
  template_id: string;
  item_id: string;
  metric: { id: string; semantic_version: string };
  release: string;
  version?: VersionNumber;
  display_name?: string;
  unit?: TemplateItemVersion['unit'];
  dimensions?: Record<string, string>;
  params?: Record<string, number | string | boolean>;
}

function item(spec: ItemSpec): TemplateItemVersion {
  return {
    template_id: spec.template_id,
    item_id: spec.item_id,
    version: spec.version ?? 1,
    display_name: spec.display_name ?? spec.item_id,
    canonical_metric: spec.metric,
    unit: spec.unit ?? '1',
    dimensions: spec.dimensions ?? {},
    collector_ref: { package_release: spec.release, implementation_id: `impl-${spec.item_id}` },
    params_default: spec.params ?? {},
    source_chain: {
      actor_id: 1, request_id: `req-item-${spec.template_id}-${spec.item_id}`, base: null,
      created_at: T0, published_at: T1, retired_at: null, migration_ref: null,
    },
  };
}

interface VersionSpec {
  template_id: string;
  items: TemplateItemVersion[];
  version?: VersionNumber;
  status?: 'published' | 'retired';
  parameters?: TemplateParameters;
  triggers?: TemplateVersion['aggregate']['triggers'];
  source_chain?: Partial<SourceChain>;
  published_at?: string;
  retired_at?: string;
}

function templateVersion(spec: VersionSpec): TemplateVersion {
  const published_at = spec.published_at ?? T1;
  const retired_at = spec.status === 'retired' ? spec.retired_at ?? T2 : null;
  const byRelease = new Map<string, string[]>();
  for (const stored of spec.items) {
    const ids = byRelease.get(stored.collector_ref.package_release) ?? [];
    ids.push(stored.item_id);
    byRelease.set(stored.collector_ref.package_release, ids);
  }
  const composition: PackageCompositionEntry[] = [...byRelease.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([entryRelease, ids]) => ({ release: entryRelease, items: [...ids].sort() }));
  const aggregate = {
    template_id: spec.template_id,
    base: null,
    items: spec.items.map(stored => ({ item_id: stored.item_id, version: stored.version }))
      .sort((left, right) => left.item_id < right.item_id ? -1 : left.item_id > right.item_id ? 1 : 0),
    triggers: spec.triggers ?? [],
    parameters: spec.parameters ?? { schema: {}, defaults: {} },
    capabilities: capabilities(),
    package_composition: composition,
  };
  return {
    template_id: spec.template_id,
    version: spec.version ?? 1,
    status: spec.status ?? 'published',
    content_hash: templateContentHash(aggregate),
    aggregate,
    items: spec.items,
    package_composition: composition,
    source_chain: {
      actor_id: 1, request_id: `req-${spec.template_id}`, base: null,
      created_at: T0, published_at, retired_at, migration_ref: null,
      ...spec.source_chain,
    },
    published_at,
    retired_at,
  };
}

const legacyPackage = { id: 'legacy-package', version: '2.3.4', digest: `sha256:${'c'.repeat(64)}` };

function binding(overrides: Partial<ResourceBindingCandidate> = {}): ResourceBindingCandidate {
  return {
    resource: { type: 'instance', id: 7 },
    package: null,
    group_id: 'web',
    overrides: { interval_ms: { mode: 'set', value: 30000 } },
    revision: 4,
    template_pins: [],
    ...overrides,
  };
}

function pin(template_id: string, version: VersionNumber, content_hash: string): TemplatePin {
  return { template_id, version, content_hash };
}

function portOf(versions: TemplateVersion[]) {
  const getVersion = vi.fn(async (templateId: string, version: VersionNumber) =>
    versions.find(entry => entry.template_id === templateId && entry.version === version) ?? null);
  const port = { getVersion } satisfies TemplateVersionReadPort;
  return { port, getVersion };
}

async function failure(promise: Promise<unknown>): Promise<BindingPreflightError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BindingPreflightError);
    return error as BindingPreflightError;
  }
  throw new Error('expected the preflight to reject');
}

const metric = (id: string, semantic_version = '1.0.0') => ({ id, semantic_version });

describe('MAX-238 B1 fixed template pin preflight', () => {
  it('resolves multiple pins keeping each item, release and parameter set under its own template', async () => {
    const versionA = templateVersion({
      template_id: 'tpl-a',
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
      parameters: { schema: { interval_ms: { type: 'integer' } }, defaults: { interval_ms: 1000 } },
      triggers: [{ rule_id: 'rule-a', scope: 'item:cpu', version: 1 }],
    });
    const versionB = templateVersion({
      template_id: 'tpl-b',
      items: [item({ template_id: 'tpl-b', item_id: 'conn', metric: metric('pg.connections'), release: release('pkg-b', '2.0.0', 'b') })],
      parameters: { schema: { interval_ms: { type: 'integer' } }, defaults: { interval_ms: 2000 } },
    });
    const { port, getVersion } = portOf([versionA, versionB]);
    const input = binding({
      template_pins: [pin('tpl-a', 1, versionA.content_hash), pin('tpl-b', 1, versionB.content_hash)],
      package: legacyPackage,
    });
    const before = JSON.stringify(input);

    const outcome = await preflightResourceBinding(input, port);

    expect(outcome.kind).toBe('template_preflight');
    expect(outcome.compiled).toBe(false);
    expect(getVersion).toHaveBeenNthCalledWith(1, 'tpl-a', 1);
    expect(getVersion).toHaveBeenNthCalledWith(2, 'tpl-b', 1);
    if (outcome.kind !== 'template_preflight') throw new Error('unreachable');
    expect(outcome.pins).toHaveLength(2);

    const [a, b] = outcome.pins;
    expect(a.pin).toEqual({ template_id: 'tpl-a', version: 1, content_hash: versionA.content_hash });
    expect(a.items.map(stored => [stored.template_id, stored.item_id]))
      .toEqual([['tpl-a', 'cpu']]);
    expect(a.package_composition).toEqual([{ release: release('pkg-a'), items: ['cpu'] }]);
    expect(a.items[0].collector_ref.package_release).toBe(release('pkg-a'));
    expect(a.parameters.defaults).toEqual({ interval_ms: 1000 });
    expect(a.triggers).toEqual([{ rule_id: 'rule-a', scope: 'item:cpu', version: 1 }]);
    expect(a.source_chain.request_id).toBe('req-tpl-a');

    expect(b.items.map(stored => [stored.template_id, stored.item_id]))
      .toEqual([['tpl-b', 'conn']]);
    expect(b.package_composition).toEqual([{ release: release('pkg-b', '2.0.0', 'b'), items: ['conn'] }]);
    expect(b.parameters.defaults).toEqual({ interval_ms: 2000 });

    // Binding snapshot is carried unchanged; the legacy package stays a compatibility field.
    expect(outcome.binding.revision).toBe(4);
    expect(outcome.binding.resource).toEqual({ type: 'instance', id: 7 });
    expect(outcome.binding.group_id).toBe('web');
    expect(outcome.binding.package).toEqual(legacyPackage);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('does not collide equal item ids that belong to different templates', async () => {
    const versionA = templateVersion({
      template_id: 'tpl-a',
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
    });
    const versionB = templateVersion({
      template_id: 'tpl-b',
      items: [item({ template_id: 'tpl-b', item_id: 'cpu', metric: metric('pg.connections'), release: release('pkg-b') })],
    });
    const { port } = portOf([versionA, versionB]);

    const outcome = await preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, versionA.content_hash), pin('tpl-b', 1, versionB.content_hash)],
    }), port);

    if (outcome.kind !== 'template_preflight') throw new Error('unreachable');
    expect(outcome.pins.map(resolved => resolved.items[0].template_id)).toEqual(['tpl-a', 'tpl-b']);
    expect(outcome.pins.map(resolved => resolved.items[0].item_id)).toEqual(['cpu', 'cpu']);
  });

  it('rejects a cross-template canonical overlap even when values are identical', async () => {
    const versionA = templateVersion({
      template_id: 'tpl-a',
      items: [item({
        template_id: 'tpl-a', item_id: 'cpu', display_name: 'MySQL running', metric: metric('mysql.threads_running'),
        release: release('pkg-a'),
      })],
    });
    const versionB = templateVersion({
      template_id: 'tpl-b',
      items: [item({
        template_id: 'tpl-b', item_id: 'threads', display_name: 'MySQL running (copy)',
        metric: metric('mysql.threads_running'), release: release('pkg-b'),
      })],
    });
    const { port } = portOf([versionA, versionB]);

    const error = await failure(preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, versionA.content_hash), pin('tpl-b', 1, versionB.content_hash)],
    }), port));

    expect(error.code).toBe('PREFLIGHT_CANONICAL_CONFLICT');
    expect(error.conflicts).toHaveLength(1);
    expect(error.conflicts[0].canonical_metric).toEqual({ id: 'mysql.threads_running', semantic_version: '1.0.0' });
    expect(error.conflicts[0].providers.map(provider => `${provider.template_id}/${provider.item_id}`))
      .toEqual(['tpl-a/cpu', 'tpl-b/threads']);
    expect(error.conflicts[0].providers.map(provider => provider.pin_version)).toEqual([1, 1]);
  });

  it('rejects unit and dimension differences as the same canonical overlap', async () => {
    const versionA = templateVersion({
      template_id: 'tpl-a',
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
    });
    const versionB = templateVersion({
      template_id: 'tpl-b',
      items: [item({
        template_id: 'tpl-b', item_id: 'cpu_pct', metric: metric('mysql.threads_running'),
        release: release('pkg-b'), unit: '%', dimensions: { mount: '/data' },
      })],
    });
    const { port } = portOf([versionA, versionB]);

    const error = await failure(preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, versionA.content_hash), pin('tpl-b', 1, versionB.content_hash)],
    }), port));

    expect(error.code).toBe('PREFLIGHT_CANONICAL_CONFLICT');
    expect(error.conflicts[0].providers.map(provider => provider.unit)).toEqual(['1', '%']);
    expect(error.conflicts[0].providers[1].dimensions).toEqual({ mount: '/data' });
  });

  it('keeps different semantic versions as distinct identities', async () => {
    const versionA = templateVersion({
      template_id: 'tpl-a',
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running', '1.0.0'), release: release('pkg-a') })],
    });
    const versionB = templateVersion({
      template_id: 'tpl-b',
      items: [item({ template_id: 'tpl-b', item_id: 'cpu', metric: metric('mysql.threads_running', '1.0.1'), release: release('pkg-b') })],
    });
    const { port } = portOf([versionA, versionB]);

    const outcome = await preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, versionA.content_hash), pin('tpl-b', 1, versionB.content_hash)],
    }), port);

    expect(outcome.kind).toBe('template_preflight');
  });

  it('reads the pinned version even after the current pointer moved on', async () => {
    const published = templateVersion({
      template_id: 'tpl-a',
      version: 1,
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
    });
    const newer = templateVersion({
      template_id: 'tpl-a',
      version: 2,
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running', '1.0.1'), release: release('pkg-a', '1.0.1', 'b') })],
    });
    const { port, getVersion } = portOf([newer, published]);

    const outcome = await preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, published.content_hash)],
    }), port);

    if (outcome.kind !== 'template_preflight') throw new Error('unreachable');
    expect(getVersion).toHaveBeenCalledWith('tpl-a', 1);
    expect(getVersion).not.toHaveBeenCalledWith('tpl-a', 2);
    expect(outcome.pins[0].version).toBe(1);
    expect(outcome.pins[0].items[0].canonical_metric.semantic_version).toBe('1.0.0');
  });

  it('rejects a missing pinned version', async () => {
    const { port, getVersion } = portOf([]);

    const error = await failure(preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 9, `sha256:${'a'.repeat(64)}`)],
    }), port));

    expect(error.code).toBe('PREFLIGHT_VERSION_MISSING');
    expect(getVersion).toHaveBeenCalledWith('tpl-a', 9);
  });

  it('rejects a retired version', async () => {
    const retired = templateVersion({
      template_id: 'tpl-a',
      status: 'retired',
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
    });
    const { port } = portOf([retired]);

    const error = await failure(preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, retired.content_hash)],
    }), port));

    expect(error.code).toBe('PREFLIGHT_VERSION_RETIRED');
  });

  it('rejects a returned version with a different identity', async () => {
    const swapped = templateVersion({
      template_id: 'tpl-other',
      items: [item({ template_id: 'tpl-other', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
    });
    const port = { getVersion: async () => swapped } satisfies TemplateVersionReadPort;

    const error = await failure(preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, swapped.content_hash)],
    }), port));

    expect(error.code).toBe('PREFLIGHT_VERSION_IDENTITY');
  });

  it('rejects a returned version number that differs from the pin', async () => {
    const versionTwo = templateVersion({
      template_id: 'tpl-a',
      version: 2,
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
    });
    const port = { getVersion: async () => versionTwo } satisfies TemplateVersionReadPort;

    const error = await failure(preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, versionTwo.content_hash)],
    }), port));

    expect(error.code).toBe('PREFLIGHT_VERSION_IDENTITY');
  });

  it('rejects a pin hash that differs from the stored version', async () => {
    const stored = templateVersion({
      template_id: 'tpl-a',
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
    });
    const { port } = portOf([stored]);

    const error = await failure(preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, `sha256:${'d'.repeat(64)}`)],
    }), port));

    expect(error.code).toBe('PREFLIGHT_CONTENT_HASH_MISMATCH');
  });

  it('rejects a stored hash that does not match the stored identity hash', async () => {
    const stored = templateVersion({
      template_id: 'tpl-a',
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
    });
    const forged = { ...stored, content_hash: `sha256:${'e'.repeat(64)}` };
    const { port } = portOf([forged]);

    const error = await failure(preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, forged.content_hash)],
    }), port));

    expect(error.code).toBe('PREFLIGHT_CONTENT_HASH_MISMATCH');
  });

  it('rejects a tampered aggregate whose hash was not recomputed', async () => {
    const stored = templateVersion({
      template_id: 'tpl-a',
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
      parameters: { schema: { interval_ms: { type: 'integer' } }, defaults: { interval_ms: 1000 } },
    });
    const tampered: TemplateVersion = {
      ...stored,
      aggregate: { ...stored.aggregate, parameters: { ...stored.aggregate.parameters, defaults: { interval_ms: 60000 } } },
    };
    const { port } = portOf([tampered]);

    const error = await failure(preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, tampered.content_hash)],
    }), port));

    expect(error.code).toBe('PREFLIGHT_CONTENT_HASH_MISMATCH');
  });

  it('collapses a port failure into a stable code without leaking the original error', async () => {
    const getVersion = vi.fn(async () => { throw new Error('password=super-secret host=db-1'); });
    const port = { getVersion } satisfies TemplateVersionReadPort;

    const error = await failure(preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, `sha256:${'a'.repeat(64)}`)],
    }), port));

    expect(error.code).toBe('PREFLIGHT_READ_FAILED');
    expect(error.message).toBe('PREFLIGHT_READ_FAILED');
    expect(JSON.stringify(error)).not.toContain('super-secret');
    expect(String(error)).not.toContain('super-secret');
    expect(error.stack ?? '').not.toContain('super-secret');
  });

  it('does not return a partial combination when a later pin fails', async () => {
    const first = templateVersion({
      template_id: 'tpl-a',
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
    });
    const getVersion = vi.fn(async (templateId: string) => {
      if (templateId === 'tpl-a') return first;
      throw new Error('storage offline');
    });
    const port = { getVersion } satisfies TemplateVersionReadPort;

    const error = await failure(preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, first.content_hash), pin('tpl-b', 1, first.content_hash)],
    }), port));

    expect(error.code).toBe('PREFLIGHT_READ_FAILED');
    expect(getVersion).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate, out-of-order, zero and empty bindings through the existing schema', async () => {
    const stored = templateVersion({
      template_id: 'tpl-a',
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
    });
    const other = templateVersion({
      template_id: 'tpl-b',
      items: [item({ template_id: 'tpl-b', item_id: 'cpu', metric: metric('pg.connections'), release: release('pkg-b') })],
    });
    const { port, getVersion } = portOf([stored, other]);

    const duplicate = await failure(preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, stored.content_hash), pin('tpl-a', 1, stored.content_hash)],
    }), port));
    const outOfOrder = await failure(preflightResourceBinding(binding({
      template_pins: [pin('tpl-b', 1, other.content_hash), pin('tpl-a', 1, stored.content_hash)],
    }), port));
    const zeroVersion = await failure(preflightResourceBinding(binding({
      template_pins: [{ template_id: 'tpl-a', version: 0, content_hash: stored.content_hash }],
    }), port));
    const empty = await failure(preflightResourceBinding(binding({ template_pins: [], package: null }), port));

    for (const error of [duplicate, outOfOrder, zeroVersion, empty]) {
      expect(error.code).toBe('PREFLIGHT_INPUT_INVALID');
    }
    expect(getVersion).not.toHaveBeenCalled();
  });

  it('accepts base revision 0, the first binding of an unbound resource', async () => {
    const stored = templateVersion({
      template_id: 'tpl-a',
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
    });
    const { port } = portOf([stored]);

    const outcome = await preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, stored.content_hash)], revision: 0,
    }), port);

    expect(outcome).toMatchObject({ kind: 'template_preflight', binding: { revision: 0 } });
  });

  it('keeps an explicit legacy binding without reading the template port', async () => {
    const { port, getVersion } = portOf([]);

    const outcome = await preflightResourceBinding(binding({ template_pins: [], package: legacyPackage }), port);

    expect(outcome.kind).toBe('legacy');
    expect(outcome.compiled).toBe(false);
    if (outcome.kind !== 'legacy') throw new Error('unreachable');
    expect(outcome.package).toEqual(legacyPackage);
    expect(outcome.binding.revision).toBe(4);
    expect(getVersion).not.toHaveBeenCalled();
  });

  it('does not use the legacy package to replace pins and claims no apply or health state', async () => {
    const stored = templateVersion({
      template_id: 'tpl-a',
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
    });
    const { port } = portOf([stored]);

    const outcome = await preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, stored.content_hash)],
      package: legacyPackage,
    }), port);

    expect(outcome.kind).toBe('template_preflight');
    if (outcome.kind !== 'template_preflight') throw new Error('unreachable');
    expect(outcome.pins).toHaveLength(1);
    expect(outcome.binding.package).toEqual(legacyPackage);
    const serialised = JSON.stringify(outcome);
    for (const forbidden of ['applied', 'healthy', 'first_sample', 'cas_applied', 'authorized']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('leaves the content hash unchanged when only source_chain metadata changes', async () => {
    const original = templateVersion({
      template_id: 'tpl-a',
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
    });
    const reattributed: TemplateVersion = {
      ...original,
      source_chain: { ...original.source_chain, actor_id: 99, request_id: 'another-request' },
    };
    expect(templateContentHash(reattributed.aggregate)).toBe(templateContentHash(original.aggregate));
    const { port } = portOf([reattributed]);

    const outcome = await preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, original.content_hash)],
    }), port);

    if (outcome.kind !== 'template_preflight') throw new Error('unreachable');
    expect(outcome.pins[0].source_chain.actor_id).toBe(99);
    expect(outcome.pins[0].content_hash).toBe(original.content_hash);
  });

  it('does not mutate the binding snapshot or the objects returned by the port', async () => {
    const stored = templateVersion({
      template_id: 'tpl-a',
      items: [item({ template_id: 'tpl-a', item_id: 'cpu', metric: metric('mysql.threads_running'), release: release('pkg-a') })],
      triggers: [{ rule_id: 'rule-a', scope: 'item:cpu', version: 1 }],
      parameters: { schema: { interval_ms: { type: 'integer' } }, defaults: { interval_ms: 1000 } },
    });
    const input = binding({ template_pins: [pin('tpl-a', 1, stored.content_hash)] });
    const inputBefore = JSON.stringify(input), storedBefore = JSON.stringify(stored);
    const { port } = portOf([stored]);

    await preflightResourceBinding(input, port);

    expect(JSON.stringify(input)).toBe(inputBefore);
    expect(JSON.stringify(stored)).toBe(storedBefore);
    expect(stored.items[0].collector_ref.package_release).toBe(release('pkg-a'));
    expect(stored.aggregate.triggers).toEqual([{ rule_id: 'rule-a', scope: 'item:cpu', version: 1 }]);
  });

  it('orders multiple conflicts and their providers deterministically', async () => {
    const versionA = templateVersion({
      template_id: 'tpl-a',
      items: [
        item({ template_id: 'tpl-a', item_id: 'a1', metric: metric('mysql.threads_running'), release: release('pkg-a') }),
        item({ template_id: 'tpl-a', item_id: 'a2', metric: metric('pg.connections'), release: release('pkg-a') }),
      ],
    });
    const versionB = templateVersion({
      template_id: 'tpl-b',
      items: [
        item({ template_id: 'tpl-b', item_id: 'b1', metric: metric('pg.connections'), release: release('pkg-b') }),
        item({ template_id: 'tpl-b', item_id: 'b2', metric: metric('mysql.threads_running'), release: release('pkg-b') }),
      ],
    });
    const { port } = portOf([versionA, versionB]);

    const error = await failure(preflightResourceBinding(binding({
      template_pins: [pin('tpl-a', 1, versionA.content_hash), pin('tpl-b', 1, versionB.content_hash)],
    }), port));

    expect(error.conflicts.map(conflict =>
      `${conflict.canonical_metric.id}@${conflict.canonical_metric.semantic_version}`))
      .toEqual(['mysql.threads_running@1.0.0', 'pg.connections@1.0.0']);
    expect(error.conflicts.map(conflict => conflict.providers.map(provider => provider.template_id)))
      .toEqual([['tpl-a', 'tpl-b'], ['tpl-a', 'tpl-b']]);
  });
});
