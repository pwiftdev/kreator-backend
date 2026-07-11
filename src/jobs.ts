/** Persistent job store (Supabase) for async generation - survives dyno restarts */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

export type JobStatus = "pending" | "running" | "done" | "error";

export interface JobResult {
  id?: string;
  url?: string;
  storagePath?: string;
  base64Data?: string;
  prompt?: string;
  aspectRatio?: string;
  imageSize?: string;
}

export interface Job {
  status: JobStatus;
  result?: JobResult;
  error?: string;
}

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for jobs",
      );
    }
    client = createClient(url, key);
  }
  return client;
}

export async function createJob(userId: string): Promise<string> {
  const { data, error } = await getClient().rpc("start_generation_job", {
    p_user_id: userId,
    p_max_concurrent: 3,
  });

  if (error) {
    console.error("[jobs] createJob failed:", error.message);
    throw new Error("Failed to create job");
  }
  const result = data as { jobId?: string; error?: string };
  if (result.error) throw new Error(result.error);
  if (!result.jobId) throw new Error("Failed to create job");
  return result.jobId;
}

export async function getJob(
  jobId: string,
  userId: string,
): Promise<Job | undefined> {
  const { data, error } = await getClient()
    .from("generation_jobs")
    .select("status, result, error_message")
    .eq("id", jobId)
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    return undefined;
  }

  return {
    status: data.status as JobStatus,
    result: (data.result as JobResult) ?? undefined,
    error: data.error_message ?? undefined,
  };
}

export async function setJobRunning(jobId: string): Promise<void> {
  const { error } = await getClient()
    .from("generation_jobs")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw new Error(`Failed to update job: ${error.message}`);
}

export async function setJobResult(
  jobId: string,
  result: JobResult,
): Promise<void> {
  const { error } = await getClient()
    .from("generation_jobs")
    .update({
      status: "done",
      result,
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);
  if (error) throw new Error(`Failed to save job result: ${error.message}`);
}

export async function setJobError(jobId: string, error: string): Promise<void> {
  const { error: updateError } = await getClient()
    .from("generation_jobs")
    .update({
      status: "error",
      error_message: error,
      result: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);
  if (updateError)
    throw new Error(`Failed to save job error: ${updateError.message}`);
}

export async function reconcileStaleJobs(): Promise<number> {
  const { data, error } = await getClient().rpc(
    "reconcile_stale_generation_jobs",
  );
  if (error)
    throw new Error(`Failed to reconcile stale jobs: ${error.message}`);
  return Number(data ?? 0);
}
