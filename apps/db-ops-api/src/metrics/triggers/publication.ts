import { createHash } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { ActorContext } from '../../auth/actor-context.js';
import { hasPermission } from '../../auth/require-permission.js';
import { TemplateTriggerPublishSchema, TriggerRuleVersionSchema } from '../../contracts/metrics/triggers.js';
import { TemplateDraftAggregateSchema } from '../../contracts/metrics/templates.js';
import { MySqlTemplateRepository } from '../templates/mysql-repository.js';
import { connectionTemplatePool } from '../templates/binding-service.js';
import type { BindingSqlConnection } from '../bindings/mysql-host.js';
import type { PackageRegistry } from '../packages/model.js';
import { stable } from '../packages/model.js';
import { MetricTemplateService } from '../templates/service.js';
import { triggerRuleContentHash } from './model.js';
import { rule } from '../policy/model.js';

export class TriggerPublicationService {
  constructor(
    private readonly pool: Pool,
    private readonly registry: PackageRegistry,
    private readonly reload: (
      actor: ActorContext,
      c: BindingSqlConnection,
      locking?: boolean,
    ) => Promise<ActorContext>,
  ) {}

  async publish(actor: ActorContext, templateId: string, raw: unknown) {
    const input = TemplateTriggerPublishSchema.parse(raw);
    const c = await this.pool.getConnection();
    let reusable = false,
      commitUnknown = false;
    try {
      await c.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await c.beginTransaction();
      const check = async (locking = true) => {
        const live = await this.reload(actor, c, locking);
        rule(hasPermission(new Set(live.permissions), 'metric:manage'), 'TRIGGER_FORBIDDEN', 403);
        return live;
      };
      await check(false);
      await c.execute('SELECT template_id FROM metric_templates_v2 WHERE template_id = ? FOR UPDATE', [
        templateId,
      ]);
      const live = await check();
      const repository = new MySqlTemplateRepository(connectionTemplatePool(c));
      const template = await repository.getTemplate(templateId);
      rule(template, 'TEMPLATE_NOT_FOUND', 404);
      rule(template.current_published_version === input.expected_version, 'TEMPLATE_REVISION_CONFLICT', 409);
      const current = await repository.getVersion(templateId, input.expected_version);
      rule(
        current && current.content_hash === input.expected_content_hash && current.status === 'published',
        'TEMPLATE_REVISION_CONFLICT',
        409,
      );
      const item = current.items.find((i) => i.item_id === input.item_id);
      rule(item, 'TRIGGER_ITEM_UNKNOWN', 422);
      const draft = await repository.getDraft(templateId);
      rule(draft, 'TEMPLATE_NOT_FOUND', 404);
      // Never discard someone else's unpublished edits.
      const { package_composition: _composition, ...aggregate } = current.aggregate;
      rule(stable(draft.aggregate) === stable(aggregate), 'TEMPLATE_DRAFT_CONFLICT', 409);
      const ruleId = `trg-${createHash('sha256').update(`${templateId}\0${item.item_id}`).digest('hex').slice(0, 40)}`;
      const [rows] = await c.execute<RowDataPacket[]>(
        'SELECT COALESCE(MAX(version),0) AS version FROM metric_trigger_rule_versions WHERE rule_id = ?',
        [ruleId],
      );
      const version = Number(rows[0].version) + 1;
      const body = {
        rule_id: ruleId,
        version,
        scope: `item:${item.item_id}`,
        metric: item.canonical_metric,
        unit: item.unit,
        parameters: input.parameters,
        problem: input.problem,
        recovery: input.recovery,
        quality: input.quality,
        clock: input.clock,
      };
      const publishedRule = TriggerRuleVersionSchema.parse({
        ...body,
        content_hash: triggerRuleContentHash(body),
      });
      // Reuse the resolver's parameter/expression checks before publishing a reference.
      const { validatePublishedTrigger } = await import('./resolve.js');
      validatePublishedTrigger(publishedRule);
      await c.execute(
        'INSERT INTO metric_trigger_rule_versions(rule_id,version,template_id,payload) VALUES(?,?,?,?)',
        [ruleId, version, templateId, JSON.stringify(publishedRule)],
      );
      const next = TemplateDraftAggregateSchema.parse({
        ...aggregate,
        triggers: [
          ...aggregate.triggers.filter((r) => r.scope !== publishedRule.scope),
          { rule_id: ruleId, version, scope: publishedRule.scope },
        ].sort((a, b) => a.rule_id.localeCompare(b.rule_id) || a.scope.localeCompare(b.scope)),
      });
      const service = new MetricTemplateService(repository, this.registry);
      const updated = await service.updateDraft(live, templateId, {
        expected_draft_revision: draft.revision,
        aggregate: next,
      });
      const publication = await service.publish(live, templateId, {
        expected_draft_revision: updated.revision,
        expected_revision: template.revision,
      });
      await check();
      await c.execute('INSERT INTO metric_policy_audit(target,payload) VALUES(?,?)', [
        `template:${templateId}`,
        JSON.stringify({
          action: 'trigger_published',
          actor_id: actor.userId,
          rule_id: ruleId,
          rule_version: version,
          template_version: publication.version,
          request_id: actor.requestId,
        }),
      ]);
      await check();
      try {
        await c.commit();
        reusable = true;
      } catch {
        commitUnknown = true;
        throw new Error('TRIGGER_PUBLICATION_OUTCOME_UNKNOWN');
      }
      return {
        template_id: templateId,
        version: publication.version,
        content_hash: publication.content_hash,
        rule: publishedRule,
      };
    } catch (error) {
      if (!reusable && !commitUnknown) {
        try {
          await c.rollback();
          reusable = true;
        } catch {
          /* discard */
        }
      }
      throw error;
    } finally {
      if (reusable) c.release();
      else c.destroy();
    }
  }
}
