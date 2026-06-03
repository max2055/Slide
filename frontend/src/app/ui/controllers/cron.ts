import type { CronJob, CronStatus } from "../types.ts";

export type { CronJob, CronStatus };

export type CronState = {
  cronLoading: boolean;
  cronJobsLoadingMore: boolean;
  cronJobs: CronJob[];
  cronJobsTotal: number;
  cronJobsHasMore: boolean;
  cronJobsNextOffset: number;
  cronJobsLimit: number;
  cronJobsQuery: string;
  cronJobsEnabledFilter: string | null;
  cronJobsScheduleKindFilter: string | null;
  cronJobsLastStatusFilter: string | null;
  cronJobsSortBy: string;
  cronJobsSortDir: "asc" | "desc";
  cronStatus: CronStatus;
  cronError: string | null;
  cronForm: Record<string, unknown> | null;
  cronFieldErrors: Record<string, string> | null;
  cronEditingJobId: string | null;
  cronRunsJobId: string | null;
  cronRunsLoadingMore: boolean;
  cronRuns: unknown[];
  cronRunsTotal: number;
  cronRunsHasMore: boolean;
  cronRunsNextOffset: number;
  cronRunsLimit: number;
  cronRunsScope: string;
  cronRunsStatuses: string[];
  cronRunsDeliveryStatuses: string[];
  cronRunsStatusFilter: string | null;
  cronRunsQuery: string;
  cronRunsSortDir: "asc" | "desc";
  cronBusy: boolean;
};

export type CronModelSuggestionsState = { cronModelSuggestions: unknown };
