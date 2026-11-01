/**
 * MAX-237 / T1 — helpers over the accepted template schemas.
 *
 * The template schemas are **not** defined here. They come from
 * `contracts/metrics/templates.ts`, the accepted MAX-236 D1 source candidate,
 * extracted byte-for-byte from
 * `afa5b3d25d1bf4f72d017a8cf6a952d7591356b0` (blob `bdd455ccc218c9e8543eaee6ad5bc5686f414170`,
 * sha256 `76bcdfebd5af681e84453fc59e2da05b50f36ca2c8aeadecef8844e80c579a45`).
 * This file only adds what a domain service needs on top of it:
 * derived type aliases, release-reference helpers, `content_hash`, the empty
 * draft and the non-executable capability placeholders.
 *
 * Field-level provenance and the D1 subset this package implements are in
 * `docs/slide/development/MAX-237/README.md`. Not implemented here on purpose:
 * resource bindings and multi-pin resolution, triggers/rule versions, preview
 * estimates, retirement of published versions and every database/DDL shape.
 *
 * `parse` proves shape only. Permission, atomicity, immutability across rows and
 * hash recomputation are repository/service responsibilities.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { MetricRefSchema } from '../../contracts/metrics/index.js';
import {
  HashIdSchema, ItemIdSchema, PackageCompositionEntrySchema, ParameterValueSchema, RevisionSchema,
  SourceChainSchema, TemplateCapabilitiesSchema, TemplateDraftAggregateSchema, TemplateDraftSchema,
  TemplateIdSchema, TemplateItemVersionSchema, TemplateParametersSchema, TemplatePublishedAggregateSchema,
  TemplateRecordSchema, TemplateStatusSchema, TemplateVersionSchema, TemplateVersionSummarySchema,
  VersionNumberSchema,
} from '../../contracts/metrics/templates.js';
import type {
  HashId, PackageCompositionEntry, Revision, SourceChain, TemplateCapabilities, TemplateDraft,
  TemplateDraftAggregate, TemplateItemVersion, TemplateParameters, TemplatePublishedAggregate,
  TemplateRecord, TemplateVersion, VersionNumber,
} from '../../contracts/metrics/templates.js';
import { stable } from '../packages/model.js';

export {
  HashIdSchema, ItemIdSchema, PackageCompositionEntrySchema, RevisionSchema, SourceChainSchema,
  TemplateCapabilitiesSchema, TemplateDraftAggregateSchema, TemplateDraftSchema, TemplateIdSchema,
  TemplateItemVersionSchema, TemplateParametersSchema, TemplatePublishedAggregateSchema,
  TemplateRecordSchema, TemplateStatusSchema, TemplateVersionSchema, TemplateVersionSummarySchema,
  VersionNumberSchema,
};
export type {
  HashId, PackageCompositionEntry, Revision, SourceChain, TemplateCapabilities, TemplateDraft,
  TemplateDraftAggregate, TemplateItemVersion, TemplateParameters, TemplatePublishedAggregate,
  TemplateRecord, TemplateVersion, VersionNumber,
};

/** Aliases the accepted file does not spell out — types only, never a second schema. */
export type MetricRef = z.infer<typeof MetricRefSchema>;
export type ParameterValue = z.infer<typeof ParameterValueSchema>;
export type TemplateStatus = z.infer<typeof TemplateStatusSchema>;
export type TemplateVersionSummary = z.infer<typeof TemplateVersionSummarySchema>;

/** `${package.id}@${version}#${digest}` split into its three validated parts. */
export type PackageReleaseRef = { id: string; version: string; digest: HashId };

export const canonicalKey = (ref: MetricRef): string => `${ref.id}@${ref.semantic_version}`;

export const packageReleaseRef = (pin: { id: string; version: string; digest: string }): string =>
  `${pin.id}@${pin.version}#${pin.digest}`;

/** Inverse of {@link packageReleaseRef}; shape was already validated by the schema. */
export function parsePackageReleaseRef(ref: string): PackageReleaseRef {
  const at = ref.lastIndexOf('@');
  const hash = ref.lastIndexOf('#');
  return { id: ref.slice(0, at), version: ref.slice(at + 1, hash), digest: ref.slice(hash + 1) };
}

export const placeholderCapabilities = (): TemplateCapabilities => ({
  discovery: { contract_version: '1.0.0', ref: null, executable: false },
  graphs: { contract_version: '1.0.0', ref: null, executable: false },
});

export function emptyDraftAggregate(templateId: string): TemplateDraftAggregate {
  return {
    template_id: templateId,
    base: null,
    items: [],
    triggers: [],
    parameters: { schema: {}, defaults: {} },
    capabilities: placeholderCapabilities(),
  };
}

/** `content_hash = "sha256:" + sha256(stable(aggregate))` — the hash boundary is the whole aggregate. */
export function templateContentHash(aggregate: TemplatePublishedAggregate): HashId {
  return `sha256:${createHash('sha256').update(stable(aggregate)).digest('hex')}`;
}
