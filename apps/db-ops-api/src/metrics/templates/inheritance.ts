import type { TemplateRepository } from './repository.js';
import type { TemplateDraftAggregate, TemplateItemVersion } from './model.js';
import { TemplateError } from './errors.js';
import { stable } from '../packages/model.js';

/** Immutable single-parent snapshots, at most three inheritance edges. No runtime engine. */
export async function inheritTemplate(
  repository: TemplateRepository,
  id: string,
  draft: TemplateDraftAggregate,
) {
  const seen = new Set([id]);
  let pointer = draft.base;
  let depth = 0;
  while (pointer) {
    if (seen.has(pointer.template_id))
      throw new TemplateError('TEMPLATE_INHERITANCE_INVALID', 'cycle');
    seen.add(pointer.template_id);
    if (++depth > 3) throw new TemplateError('TEMPLATE_INHERITANCE_INVALID', 'depth');
    const version = await repository.getVersion(pointer.template_id, pointer.version);
    if (!version || version.status !== 'published')
      throw new TemplateError('TEMPLATE_INHERITANCE_INVALID', 'base missing');
    pointer = version.aggregate.base;
  }
  const base = draft.base
    ? await repository.getVersion(draft.base.template_id, draft.base.version)
    : null;
  const inherited = new Map<string, TemplateItemVersion>();
  for (const item of base?.items ?? [])
    inherited.set(item.item_id, {
      ...item,
      template_id: id,
      source_chain: {
        ...item.source_chain,
        base: {
          kind: 'item',
          template_id: item.template_id,
          id: item.item_id,
          version: item.version,
        },
      },
    });
  for (const local of draft.items) inherited.delete(local.item_id);
  const merge = <T>(a: T[], b: T[], key: (v: T) => string) =>
    [...new Map([...a, ...b].map((v) => [key(v), v])).values()].sort((a, b) =>
      key(a).localeCompare(key(b), 'en'),
    );
  const parent = base?.aggregate.parameters ?? { schema: {}, defaults: {} };
  for (const [name, spec] of Object.entries(draft.parameters.schema)) {
    if (parent.schema[name] && stable(parent.schema[name]) !== stable(spec))
      throw new TemplateError('TEMPLATE_INHERITANCE_INVALID', `parameter schema conflict: ${name}`);
  }
  const source = { template_id: id, version: null as number | null };
  const inheritedSource = base ? { template_id: base.template_id, version: base.version } : source;
  const pinned = (value: { template_id: string; version?: number | null } | undefined) =>
    value ? { ...value, version: value.version ?? base!.version } : inheritedSource;
  const origins = {
    items: Object.fromEntries(
      [...inherited.keys()].map((k) => [k, pinned(base?.aggregate.inheritance?.items[k])]),
    ),
    parameters: Object.fromEntries(
      Object.keys(parent.schema).map((k) => [
        k,
        pinned(base?.aggregate.inheritance?.parameters[k]),
      ]),
    ) as Record<string, typeof source>,
    triggers: Object.fromEntries(
      (base?.aggregate.triggers ?? []).map((t) => [
        `${t.rule_id}:${t.scope}`,
        pinned(base?.aggregate.inheritance?.triggers[`${t.rule_id}:${t.scope}`]),
      ]),
    ) as Record<string, typeof source>,
  };
  for (const item of draft.items) origins.items[item.item_id] = source;
  for (const key of Object.keys(draft.parameters.schema))
    if (!origins.parameters[key]) origins.parameters[key] = source;
  for (const key of Object.keys(draft.parameters.defaults)) origins.parameters[key] = source;
  for (const trigger of draft.triggers)
    origins.triggers[`${trigger.rule_id}:${trigger.scope}`] = source;
  return {
    inherited,
    aggregate: {
      ...draft,
      ...((base?.aggregate.discovery_rules?.length || draft.discovery_rules?.length) ? {
        discovery_rules: merge(base?.aggregate.discovery_rules ?? [], draft.discovery_rules ?? [], v => v.rule_id),
      } : {}),
      items: merge(base?.aggregate.items ?? [], draft.items, (v) => v.item_id),
      triggers: merge(
        base?.aggregate.triggers ?? [],
        draft.triggers,
        (v) => `${v.rule_id}\u0000${v.scope}`,
      ),
      parameters: {
        schema: { ...parent.schema, ...draft.parameters.schema },
        defaults: { ...parent.defaults, ...draft.parameters.defaults },
      },
    },
    origins,
  };
}
