import {Type,type Static} from '@sinclair/typebox';
const strict={additionalProperties:false} as const;
const version=Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER});
const ref=Type.Object({type:Type.Union([Type.Literal('instance'),Type.Literal('server'),Type.Literal('network_device')]),id:Type.Integer({minimum:1,maximum:4294967295})},strict);
export const InvestigationScopeCommand=Type.Object({expectedVersion:version,confirmed:Type.Literal(true),
  add:Type.Array(Type.Object({relationId:Type.String({pattern:'^[1-9][0-9]{0,15}$'}),version:Type.Integer({minimum:0}),hash:Type.String({pattern:'^[a-f0-9]{64}$'})},strict),{maxItems:20}),
  remove:Type.Array(ref,{maxItems:20})},{$id:'InvestigationScopeCommand',...strict});
export const InvestigationRetestCommand=Type.Object({expectedVersion:version,eventId:Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER}),
  from:Type.String({minLength:20,maxLength:32}),to:Type.String({minLength:20,maxLength:32}),confirmed:Type.Literal(true)},{$id:'InvestigationRetestCommand',...strict});
export type ScopeCommand=Static<typeof InvestigationScopeCommand>;
export type RetestCommand=Static<typeof InvestigationRetestCommand>;
export const InvestigationWorkflowSchemas={InvestigationScopeCommand,InvestigationRetestCommand};
