import {expect,it} from 'vitest';
import {TemplateAuthoringRequests} from './template-authoring.js';
it('rejects caller identities, unknown fields, unsafe operation keys and missing CAS',()=>{
 expect(TemplateAuthoringRequests.copy.safeParse({operation_key:'retry-1',name:'副本',created_by:1}).success).toBe(false);
 expect(TemplateAuthoringRequests.copy.safeParse({operation_key:'../other',name:'副本'}).success).toBe(false);
 expect(TemplateAuthoringRequests.publish.safeParse({operation_key:'retry-1',expected_revision:0}).success).toBe(false);
 expect(TemplateAuthoringRequests.publish.safeParse({operation_key:'retry-1',expected_revision:0,expected_draft_revision:0}).success).toBe(true);
});
