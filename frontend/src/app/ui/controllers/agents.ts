import type { DirectGatewayClient } from "../direct-gateway.ts";
import type { AgentsListResult } from "../types.ts";

export type AgentsState = {
  client: DirectGatewayClient | null;
  connected: boolean;
  agentsLoading: boolean;
  agentsError: string | null;
  agentsList: AgentsListResult | null;
  agentsSelectedId: string | null;
  agentsPanel?: "overview" | "files" | "tools" | "skills" | "cron";
};

export type AgentsConfigSaveState = AgentsState;

export async function loadAgents(state: AgentsState) {
  if (state.agentsLoading) return;
  state.agentsLoading = true;
  state.agentsError = null;
  try {
    const token = (window as any).__apiClient?.getToken?.() || '';
    const res = await fetch('/api/agents', {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as AgentsListResult;
    state.agentsList = data;
    const selected = state.agentsSelectedId;
    if (!selected || !data.agents.some((entry) => entry.id === selected)) {
      state.agentsSelectedId = data.defaultId ?? data.agents[0]?.id ?? null;
    }
  } catch (err) {
    state.agentsError = String(err);
  } finally {
    state.agentsLoading = false;
  }
}

export async function saveAgentsConfig(state: AgentsConfigSaveState) {
  const selectedBefore = state.agentsSelectedId;
  await loadAgents(state);
  if (selectedBefore && state.agentsList?.agents.some((entry) => entry.id === selectedBefore)) {
    state.agentsSelectedId = selectedBefore;
  }
}
