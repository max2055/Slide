import { z } from 'zod';

// Exact pilot addresses only. Inclusion never replaces a signed registration,
// server-row binding, pinned SSH identity or a fresh independently approved plan.
export const DEMO_TARGET_HOSTS = ['192.168.49.130', '172.16.51.128'] as const;
export type DemoTargetHost = (typeof DEMO_TARGET_HOSTS)[number];
export const demoTargetHostSchema = z.enum(DEMO_TARGET_HOSTS);
