-- Register codes only. Never grant new authority to existing roles.
INSERT IGNORE INTO permissions(code,name,description,resource,action) VALUES
('operations:context:view','Read operations context','Explicit grant required; no automatic role assignment','operations:context','view'),
('operations:context:manage','Manage operations context','Explicit grant required; no automatic role assignment','operations:context','manage'),
('operations:cases:view','Read trusted cases','Explicit grant required; no automatic role assignment','operations:cases','view'),
('operations:cases:manage','Manage case candidates','Explicit grant required; no automatic role assignment','operations:cases','manage'),
('operations:cases:review','Review exact case versions','Explicit grant required; no automatic role assignment','operations:cases','review'),
('operations:actions:view','Read action plans','Explicit grant required; no automatic role assignment','operations:actions','view'),
('operations:actions:propose','Propose action plans','Explicit grant required; no automatic role assignment','operations:actions','propose'),
('operations:actions:approve','Approve exact action plans','Explicit grant required; no automatic role assignment','operations:actions','approve'),
('operations:actions:execute','Execute approved action plans','Explicit grant required; no automatic role assignment','operations:actions','execute');
